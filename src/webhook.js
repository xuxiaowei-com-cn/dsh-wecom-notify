/**
 * 企业微信群机器人 Webhook 客户端。
 *
 * 纯 Node（只依赖全局 fetch / AbortSignal），不 import 任何 `@deepseek-ai/*`，
 * 便于用假 fetch 覆盖测试。
 *
 * 行为：
 *   - 串行排队：后一条等前一条结束，保持通知顺序；
 *   - 最小间隔：两次发送之间至少 minIntervalMs，避免短时间刷屏；
 *   - 超时：AbortSignal.timeout；
 *   - 重试：网络错误、HTTP 429/5xx、企业微信 -1 / 45009 / 45033 这类可恢复错误，
 *     指数退避；配置错误、内容非法这类 4xx 直接报错，不做无意义重试。
 */

/** 值得重试的企业微信 errcode。 */
const RETRIABLE_ERRCODES = new Set([-1, 45009, 45033]);
/** 单次退避的上限。 */
const MAX_BACKOFF_MS = 30_000;

const defaultSleep = (ms) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  timer.unref?.();
});

/** 响应体只用于报错，截短避免日志刷屏。 */
function preview(body) {
  if (typeof body !== 'string') return '';
  return body.length > 300 ? `${body.slice(0, 300)}…` : body;
}

/** 解析 JSON；失败返回 undefined。 */
function parseJson(body) {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/** HTTP 层错误。 */
function httpError(status, body) {
  const error = new Error(`企业微信 Webhook 返回 HTTP ${status}：${preview(body) || '无响应体'}`);
  error.status = status;
  error.retriable = status === 429 || status >= 500;
  return error;
}

/** 企业微信业务错误。 */
function wecomError(parsed) {
  const error = new Error(`企业微信返回错误 ${parsed.errcode}：${parsed.errmsg || '未知错误'}`);
  error.errcode = parsed.errcode;
  error.retriable = RETRIABLE_ERRCODES.has(parsed.errcode);
  return error;
}

/** 判断一个异常是否值得重试；保留显式声明的 retriable。 */
function markRetriable(error) {
  if (error && typeof error.retriable === 'boolean') return error;
  const normalized = error instanceof Error ? error : new Error(String(error));
  normalized.retriable = normalized.name === 'TimeoutError'
    || normalized.name === 'AbortError'
    || normalized.name === 'TypeError';
  return normalized;
}

/**
 * 向企业微信群机器人发送一条消息。
 *
 * @param {string} webhookUrl Webhook 地址
 * @param {object} payload `{ msgtype, ... }` 请求体
 * @param {{
 *   timeoutMs?: number,
 *   maxAttempts?: number,
 *   retryDelayMs?: number,
 *   fetchImpl?: typeof fetch,
 *   sleep?: (ms: number) => Promise<void>,
 * }} [options] 发送选项
 * @returns {Promise<{ errcode: 0, errmsg: string }>} 成功回执
 */
export async function postWecom(webhookUrl, payload, options = {}) {
  if (typeof webhookUrl !== 'string' || !/^https?:\/\/\S+/i.test(webhookUrl)) {
    throw new Error('未配置有效的企业微信 Webhook 地址');
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('当前运行环境没有 fetch');

  const sleep = options.sleep ?? defaultSleep;
  const timeoutMs = Math.max(1, Math.min(60_000, Number(options.timeoutMs) || 10_000));
  const maxAttempts = Math.max(1, Number(options.maxAttempts) || 1);
  const retryDelayMs = Math.max(0, Number(options.retryDelayMs) || 0);

  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetchImpl(webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = await response.text();
      if (!response.ok) throw httpError(response.status, body);

      const parsed = parseJson(body);
      if (!parsed || typeof parsed.errcode !== 'number') {
        throw new Error(`企业微信返回了无法解析的响应：${preview(body) || '空响应体'}`);
      }
      if (parsed.errcode === 0) return { errcode: 0, errmsg: parsed.errmsg ?? 'ok' };
      throw wecomError(parsed);
    } catch (error) {
      lastError = markRetriable(error);
      if (attempt >= maxAttempts || !lastError.retriable) break;
      await sleep(Math.min(retryDelayMs * 2 ** (attempt - 1), MAX_BACKOFF_MS));
    }
  }
  throw lastError ?? new Error('企业微信通知发送失败');
}

/**
 * 创建带串行队列与节流的发送客户端。
 *
 * @param {{
 *   getSettings: () => { webhookUrl: string, timeoutMs: number, maxAttempts: number, retryDelayMs: number, minIntervalMs: number },
 *   fetchImpl?: typeof fetch,
 *   sleep?: (ms: number) => Promise<void>,
 *   now?: () => number,
 * }} options 依赖注入（测试用）
 * @returns {{ send: (payload: object) => Promise<{ errcode: 0, errmsg: string }> }} 发送客户端
 */
export function createWebhookClient(options) {
  const getSettings = options.getSettings;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  let tail = Promise.resolve();
  let lastSendAt = 0;

  /**
   * 串行执行：永不因为前一个任务失败而中断队列。
   *
   * @param {() => Promise<any>} task 任务
   * @returns {Promise<any>} 任务结果
   */
  function enqueue(task) {
    const run = tail.then(task, task);
    tail = run.then(() => undefined, () => undefined);
    return run;
  }

  return {
    send(payload) {
      return enqueue(async () => {
        const settings = getSettings();
        const spacing = lastSendAt + (settings?.minIntervalMs ?? 0) - now();
        if (spacing > 0) await sleep(spacing);
        lastSendAt = now();
        return postWecom(settings?.webhookUrl, payload, {
          timeoutMs: settings?.timeoutMs,
          maxAttempts: settings?.maxAttempts,
          retryDelayMs: settings?.retryDelayMs,
          fetchImpl: options.fetchImpl,
          sleep,
        });
      });
    },
  };
}
