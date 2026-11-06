/**
 * dsh-wecom-notify —— 任务完成时推送企业微信群机器人 Webhook。
 *
 * 触发点：`session/event` 里的 durable `turn/end`（一个 turn 就是 Web UI 里
 * 一次「任务」）。turn/end 之后等 `settleMs`，把紧接着开始的下一轮（目标续跑）
 * 合并掉；出现新的人类请求时先把上一段推出去。
 *
 * 为什么不用 `agent/status`：Harness 的实践是等待 durable 事件、不要轮询
 * agent 状态；而且目标续跑会在轮之间把状态压回 idle，按状态推会重复刷屏。
 *
 * 装载方式：
 *   1. 作为 profile 层：`plugin_manager` install_bundle / `dsh plugin add <本包>`
 *      （包声明了 dsh.bundle，会写进 profile 的 bundles）
 *   2. 手工在 profile 的 cordis.patch.yml 里 insert 一个 name: dsh-wecom-notify 的条目
 *
 * 契约：只导出具名成员、不导出 default（Loader 的 unwrapExports 依赖这一点）。
 */
import { homedir, hostname as osHostname } from 'node:os';
import { sep } from 'node:path';
import { resolveSettings } from './src/config.js';
import { createTurnTracker } from './src/tracker.js';
import { createWebhookClient } from './src/webhook.js';
import { buildPayload } from './src/format.js';
import { createConfigSchema } from './src/schema.js';

/**
 * schemastery 由 DSH 宿主在运行时提供（peerDependencies 里声明，profile 不装）。
 * 用动态 import + 兜底：万一解析不到（例如在 DSH 之外跑单测），插件仍然可用，
 * 只是没有可编辑的配置表单——配置退回 cordis.patch.yml / 环境变量。
 */
let Schema;
try {
  ({ default: Schema } = await import('@deepseek-ai/schemastery'));
} catch {
  Schema = undefined;
}

/** 稳定插件名。 */
export const name = 'wecom-notify';

/** Config schema；宿主没提供 schemastery 时为 undefined。 */
export const Config = Schema ? createConfigSchema(Schema) : undefined;

/** 异常 → 一行日志。 */
function messageOf(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * 插件入口。
 *
 * @param {object} ctx 宿主 cordis 上下文
 * @param {Record<string, unknown>} config 本行配置（volatile 字段是活引用）
 */
export function apply(ctx, config) {
  /** 每次使用时重新解析：volatile 字段是活引用，浏览器里改完立即生效。 */
  const settings = () => resolveSettings(config);
  const tracker = createTurnTracker();
  const timers = new Map();
  const lastSent = new Map();
  const sender = createWebhookClient({ getSettings: settings });

  const log = (level, message) => {
    try {
      ctx.logger?.[level]?.(`[wecom-notify] ${message}`);
    } catch {
      // 日志永远不能影响通知本身
    }
  };

  /** 取消某会话待发送的定时器。 */
  function cancelTimer(sessionId) {
    const timer = timers.get(sessionId);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.delete(sessionId);
    }
  }

  /** 清掉某会话的全部运行期状态。 */
  function forgetSession(sessionId) {
    cancelTimer(sessionId);
    tracker.forget(sessionId);
    lastSent.delete(sessionId);
  }

  /** 会话是否是子代理会话。 */
  function isSubagent(session) {
    const header = session?.header;
    return Boolean(header?.parentSession) || header?.origin === 'subagent';
  }

  /** 读会话标题（sessionTitle 是可选服务）。 */
  function readTitle(session) {
    try {
      const service = ctx.get?.('sessionTitle');
      const snapshot = service?.get?.(session);
      const title = snapshot?.title;
      return typeof title === 'string' && title.trim() ? title.trim() : undefined;
    } catch {
      return undefined;
    }
  }

  /** 把 home 目录缩成 ~，让消息更短。 */
  function displayPath(cwd) {
    if (typeof cwd !== 'string' || cwd === '') return undefined;
    const home = homedir();
    if (home && (cwd === home || cwd.startsWith(`${home}${sep}`))) return `~${cwd.slice(home.length)}`;
    return cwd;
  }

  /** 这一轮的结束原因是否值得推送。 */
  function shouldNotify(reason) {
    const kind = typeof reason?.kind === 'string' ? reason.kind : 'completed';
    if (kind === 'forked') return false;
    if (kind === 'completed') return true;
    return settings().notifyFailures;
  }

  /** 真正发送：取走窗口 → 渲染 → 入队。 */
  function flush(session, trigger) {
    const sessionId = String(session.id);
    cancelTimer(sessionId);

    const current = settings();
    if (!current.enabled || !current.webhookUrl) {
      tracker.forget(sessionId);
      return;
    }

    const summary = tracker.takeWindow(sessionId);
    // 空窗口：例如本轮没有任何可见内容，直接丢掉，避免下次误发
    if (!summary) return;

    // 同一个 turn 只推一次：新请求触发的即时推送与 settle 定时器可能撞车。
    const dedupe = summary.lastTurn === undefined ? `at:${summary.endedAt}` : `turn:${summary.lastTurn}`;
    if (lastSent.get(sessionId) === dedupe) return;
    lastSent.set(sessionId, dedupe);

    const payload = buildPayload(summary, {
      format: current.format,
      mentionAll: current.mentionAll,
      includeContent: current.includeContent,
      sessionTitle: readTitle(session),
      sessionId,
      cwd: displayPath(session?.header?.cwd),
      hostname: safeHostname(),
      now: Date.now(),
    });

    const scope = summary.turnsCount > 1 ? `${summary.turnsCount} 轮` : '1 轮';
    sender.send(payload.body).then(
      () => log('info', `已推送（${trigger}，${scope}，${payload.msgtype}）：会话 ${sessionId.slice(0, 8)}`),
      (error) => log('warn', `推送失败（${trigger}，${scope}）：${messageOf(error)}`),
    );
  }

  /** 等 settleMs 再发，给紧接着的下一轮留出合并机会。 */
  function schedule(session) {
    const sessionId = String(session.id);
    cancelTimer(sessionId);
    const delay = settings().settleMs;
    const timer = setTimeout(() => {
      timers.delete(sessionId);
      flush(session, 'turn-end');
    }, delay);
    timers.set(sessionId, timer);
  }

  /** session/event：turn 边界的唯一入口。 */
  function onSessionEvent(session, event) {
    if (!session || !event) return;
    const sessionId = String(session.id);
    const current = settings();
    if (!current.enabled || !current.webhookUrl) return;
    if (!current.notifySubagents && isSubagent(session)) return;

    // 新的人类请求 = 新任务：先把上一段窗口推出去，避免两次任务被合并成一条。
    const startsNewTask = event.type === 'user/message'
      && event.data?.source?.kind === 'user'
      && tracker.hasCompleted(sessionId)
      && !tracker.currentHasUserText(sessionId);
    if (startsNewTask) flush(session, 'new-request');

    const boundary = tracker.observe(sessionId, event);
    if (boundary === 'turn-start') {
      cancelTimer(sessionId);
      return;
    }
    if (boundary === 'turn-end' && shouldNotify(event.data?.reason)) schedule(session);
  }

  /** 会话被移除：清掉状态。 */
  function onSessionDisposed(session) {
    if (session) forgetSession(String(session.id));
  }

  /** Agent 被释放：有挂起的通知就先发出去，再清状态。 */
  function onAgentDisposed(payload) {
    const session = payload?.agent?.session;
    if (!session) return;
    const sessionId = String(session.id);
    if (timers.has(sessionId)) flush(session, 'agent-disposed');
    forgetSession(sessionId);
  }

  ctx.effect(() => ctx.on('session/event', onSessionEvent));
  ctx.effect(() => ctx.on('session/disposed', onSessionDisposed));
  ctx.effect(() => ctx.on('agent/disposed', onAgentDisposed));
  ctx.effect(() => () => {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    lastSent.clear();
  });

  if (!Schema) log('warn', '未加载到 @deepseek-ai/schemastery：配置表单不可用，仅读取 cordis.patch.yml / 环境变量');
  const initial = settings();
  if (!initial.enabled) log('info', '已关闭（config.enabled = false）');
  else if (!initial.webhookUrl) log('warn', '未配置 Webhook 地址，通知处于待机状态');
  else log('info', `已就绪：${initial.format} 格式，任务结束时推送`);
}

/** os.hostname 可能抛（受限环境），单独兜一层。 */
function safeHostname() {
  try {
    return osHostname();
  } catch {
    return '';
  }
}
