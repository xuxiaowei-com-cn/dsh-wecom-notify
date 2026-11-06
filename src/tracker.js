/**
 * 按会话折叠 turn 事件，产出「一次任务」的摘要。
 *
 * 纯状态机（不碰 ctx、不碰网络），便于单测覆盖。
 *
 * 为什么按 durable 事件而不是 `agent/status`：
 * Harness 的实践是「等待 turn/end、assistant/message 这类 durable 事件，
 * 不要轮询 agent/status」。turn 也是 Web UI 里「一个任务」的自然边界。
 *
 * 一次通知窗口（window）可以包含多轮 turn：目标（goal）自动续跑、
 * 或 turn/end 之后 settle 窗口内紧接着开始下一轮时，把内容合并成一条推送；
 * 一旦出现**新的人类请求**（`user/message` 且 `source.kind === 'user'`），
 * 插件会先把上一段窗口推出去，再为这次请求开新窗口。
 */
import { assistantText, cleanText, textFromMessage } from './events.js';

/** 单会话最多保留多少轮（防止长时间运行的目标无限增长）。 */
const DEFAULT_MAX_TURNS = 20;
/** 最多跟踪多少个会话（进程里可能有大量子会话）。 */
const DEFAULT_MAX_SESSIONS = 400;

/** 事件时间：优先用事件自带的 time。 */
function timeOf(event) {
  const time = Number(event?.time);
  return Number.isFinite(time) ? time : Date.now();
}

/** 新建一个还需要收尾的 turn 累加器。 */
function newTurn(startedAt, turn) {
  return {
    turn: Number.isSafeInteger(turn) ? turn : undefined,
    startedAt,
    userText: '',
    steps: new Map(),
    attempts: new Map(),
    tools: [],
    toolErrors: 0,
  };
}

/**
 * 取本轮最后一条有内容的 assistant 文本。
 *
 * 一个 turn 里每个 step 都会产出一条 assistant/message（工具调用前的旁白、
 * 最后的总结…）。通知里的「结果」应该是**最后一轮的最终答复**，而不是把
 * 所有旁白拼起来——否则正文会先被旁白占满，真正的结论反而被截断。
 *
 * 同一 step 里 `assistant/message` 的定稿优先于 `assistant/attempt` 的中间态。
 */
function finalText(turn) {
  const indexes = [...new Set([...turn.attempts.keys(), ...turn.steps.keys()])].sort((a, b) => b - a);
  for (const index of indexes) {
    const text = cleanText(turn.steps.has(index) ? turn.steps.get(index) : turn.attempts.get(index));
    if (text) return text;
  }
  return '';
}

/**
 * 汇总多轮 turn 成一条通知窗口。
 *
 * @param {Array<ReturnType<typeof newTurn> & { endedAt: number, reason: object, text: string }>} turns 已收尾的 turn
 * @param {string} windowUserText 窗口内第一条人类请求
 * @returns {object} 供 format.js 使用的摘要
 */
function summarize(turns, windowUserText) {
  const first = turns[0];
  const last = turns[turns.length - 1];
  const tools = [];
  let toolErrors = 0;
  let durationMs = 0;
  for (const turn of turns) {
    for (const tool of turn.tools) tools.push(tool);
    toolErrors += turn.toolErrors;
    durationMs += Math.max(0, (turn.endedAt ?? 0) - (turn.startedAt ?? 0));
  }

  const lastNonEmpty = [...turns].reverse().find((turn) => turn.text.trim().length > 0);
  // 正常结束时用最后一轮回答；若最后一轮没有文本（例如只有工具调用），回退到最近的非空回答。
  // 非正常结束则只认最后一轮，避免「本轮失败」配上一轮的旧答案。
  const answerText = last.reason?.kind === 'completed'
    ? (last.text.trim() ? last.text : (lastNonEmpty?.text ?? ''))
    : last.text;

  return {
    turnsCount: turns.length,
    userText: windowUserText || first.userText || '',
    answerText: answerText ?? '',
    kind: last.reason?.kind ?? 'completed',
    reason: last.reason,
    tools,
    toolErrors,
    durationMs,
    startedAt: first.startedAt,
    endedAt: last.endedAt,
    lastTurn: last.turn,
  };
}

/**
 * 创建一个按会话跟踪 turn 的 tracker。
 *
 * @param {{ maxTurns?: number, maxSessions?: number }} [options] 容量上限
 * @returns {{
 *   observe(sessionId: string, event: object): 'turn-start' | 'user' | 'turn-end' | undefined,
 *   takeWindow(sessionId: string): object | undefined,
 *   hasCompleted(sessionId: string): boolean,
 *   currentHasUserText(sessionId: string): boolean,
 *   forget(sessionId: string): void,
 *   size(): number,
 * }} tracker
 */
export function createTurnTracker(options = {}) {
  const maxTurns = Number.isSafeInteger(options.maxTurns) && options.maxTurns > 0 ? options.maxTurns : DEFAULT_MAX_TURNS;
  const maxSessions = Number.isSafeInteger(options.maxSessions) && options.maxSessions > 0 ? options.maxSessions : DEFAULT_MAX_SESSIONS;
  const sessions = new Map();

  /** 淘汰最久未活动的会话。 */
  function prune() {
    if (sessions.size <= maxSessions) return;
    const entries = [...sessions.entries()].sort((a, b) => (a[1].lastAt ?? 0) - (b[1].lastAt ?? 0));
    const excess = sessions.size - maxSessions;
    for (let index = 0; index < excess; index += 1) sessions.delete(entries[index][0]);
  }

  /** 取（或创建）会话状态。 */
  function stateFor(sessionId) {
    let state = sessions.get(sessionId);
    if (!state) {
      state = { startedAt: 0, lastAt: 0, userText: '', turns: [], current: undefined };
      sessions.set(sessionId, state);
      prune();
    }
    return state;
  }

  /** 收尾当前 turn 并放进窗口；没有内容（空 turn）则只丢弃。 */
  function finalize(state, endedAt, reason) {
    const current = state.current;
    state.current = undefined;
    if (!current) return;
    const text = finalText(current);
    if (!current.userText && !text && current.tools.length === 0) return;
    const record = {
      turn: current.turn,
      startedAt: current.startedAt,
      endedAt: Number.isFinite(endedAt) ? endedAt : current.startedAt,
      reason: reason ?? { kind: 'unknown' },
      userText: current.userText,
      text,
      tools: current.tools,
      toolErrors: current.toolErrors,
    };
    state.turns.push(record);
    if (state.turns.length > maxTurns) state.turns.splice(0, state.turns.length - maxTurns);
    state.lastAt = Math.max(state.lastAt, record.endedAt);
  }

  /** 取当前 turn；缺失时按事件补一个（例如插件中途加载，没看到 turn/start）。 */
  function turnFor(state, time, turn) {
    if (state.current) return state.current;
    state.current = newTurn(time, turn);
    if (!state.startedAt) state.startedAt = time;
    return state.current;
  }

  return {
    /**
     * 吃进一个 session 事件。
     *
     * @param {string} sessionId 会话 id
     * @param {object} event SessionEvent
     * @returns {'turn-start' | 'user' | 'turn-end' | undefined} 调用方需要处理的边界
     */
    observe(sessionId, event) {
      const state = stateFor(sessionId);
      const time = timeOf(event);
      state.lastAt = Math.max(state.lastAt, time);
      const data = event?.data;

      switch (event?.type) {
        case 'turn/start': {
          // 上一轮没见到 turn/end（插件中途加载 / 事件缺失）时先收尾，避免丢内容。
          if (state.current) finalize(state, state.current.startedAt, { kind: 'unknown' });
          state.current = newTurn(time, data?.turn);
          if (!state.startedAt) state.startedAt = time;
          return 'turn-start';
        }
        case 'user/message': {
          const text = cleanText(textFromMessage(data));
          const turn = turnFor(state, time, data?.turn);
          if (text && !turn.userText) turn.userText = text;
          if (text && !state.userText && data?.source?.kind === 'user') state.userText = text;
          return 'user';
        }
        case 'assistant/message': {
          const turn = turnFor(state, time, data?.turn);
          const step = Number.isSafeInteger(data?.step) ? data.step : 0;
          turn.steps.set(step, assistantText(data));
          return undefined;
        }
        case 'assistant/attempt': {
          const turn = turnFor(state, time, data?.turn);
          const step = Number.isSafeInteger(data?.step) ? data.step : 0;
          turn.attempts.set(step, assistantText(data));
          return undefined;
        }
        case 'tool/call': {
          const turn = turnFor(state, time, data?.turn);
          if (turn.tools.length < 200) turn.tools.push({ name: String(data?.name ?? 'tool') });
          return undefined;
        }
        case 'tool/result': {
          const turn = turnFor(state, time, data?.turn);
          if (data?.error) turn.toolErrors += 1;
          return undefined;
        }
        case 'turn/end': {
          finalize(state, time, data?.reason);
          return 'turn-end';
        }
        default:
          return undefined;
      }
    },

    /**
     * 取走已完成的窗口并重置（正在进行的 turn 保留）。
     *
     * @param {string} sessionId 会话 id
     * @returns {object | undefined} 摘要；没有已完成 turn 时返回 undefined
     */
    takeWindow(sessionId) {
      const state = sessions.get(sessionId);
      if (!state || state.turns.length === 0) return undefined;
      const turns = state.turns;
      const userText = state.userText;
      state.turns = [];
      state.userText = '';
      state.startedAt = 0;
      return summarize(turns, userText);
    },

    /** 窗口里是否已有收尾的 turn。 */
    hasCompleted(sessionId) {
      return (sessions.get(sessionId)?.turns.length ?? 0) > 0;
    },

    /** 当前进行中的 turn 是否已经收到人类请求文本。 */
    currentHasUserText(sessionId) {
      return Boolean(sessions.get(sessionId)?.current?.userText);
    },

    /** 丢掉一个会话的全部状态。 */
    forget(sessionId) {
      sessions.delete(sessionId);
    },

    /** 当前跟踪的会话数（测试 / 诊断用）。 */
    size() {
      return sessions.size;
    },
  };
}
