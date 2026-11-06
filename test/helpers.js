/** 测试用的最小 cordis 上下文与 fetch 桩。 */

/** 一个够插件用的假 ctx：事件总线 + 效果清理 + 可选服务。 */
export function createFakeCtx(services = {}) {
  const listeners = new Map();
  const cleanups = [];
  const logs = [];

  const ctx = {
    logger: {
      debug: (...args) => logs.push({ level: 'debug', args }),
      info: (...args) => logs.push({ level: 'info', args }),
      warn: (...args) => logs.push({ level: 'warn', args }),
      error: (...args) => logs.push({ level: 'error', args }),
    },
    logs,
    on(name, callback) {
      const set = listeners.get(name) ?? new Set();
      set.add(callback);
      listeners.set(name, set);
      const off = () => set.delete(callback);
      cleanups.push(off);
      return off;
    },
    effect(factory) {
      const dispose = factory();
      if (typeof dispose === 'function') cleanups.push(dispose);
      return dispose;
    },
    get(name) {
      return services[name];
    },
    emit(name, ...args) {
      for (const callback of [...(listeners.get(name) ?? [])]) callback(...args);
    },
    dispose() {
      for (const cleanup of [...cleanups].reverse()) {
        try {
          cleanup();
        } catch {
          // 清理逻辑不应影响测试
        }
      }
      cleanups.length = 0;
      listeners.clear();
    },
  };
  return ctx;
}

/** 记录请求的 fetch 桩；handler 可决定每次响应的 HTTP 状态与 JSON。 */
export function createFetchStub(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ url, body, headers: init?.headers });
    const reply = handler
      ? handler(calls.length, body)
      : { status: 200, payload: { errcode: 0, errmsg: 'ok' } };
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      text: async () => (typeof reply.payload === 'string' ? reply.payload : JSON.stringify(reply.payload)),
    };
  };
  return { fetchImpl, calls };
}

/** 轮询等待条件成立。 */
export async function waitFor(predicate, timeoutMs = 2000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('等待条件超时');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** 睡一小会儿，用于断言「没有发送」。 */
export function settle(ms = 80) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
