/**
 * 配置解析：把 Cordis patch 里的 config 解引用并夹到安全范围。
 *
 * 纯函数（不 import 任何 `@deepseek-ai/*`），便于 `node --test` 直接覆盖。
 *
 * 约定：config 值优先；空字符串 / 空值回落到同名环境变量；再回落默认值。
 * 这样密钥既可以写进 profile，也可以只放在 shell 环境里。
 */

/** 支持的消息类型。 */
const FORMATS = new Set(['markdown', 'text']);

/**
 * 解引用 volatile 字段。
 *
 * Loader 会把 schema 里声明 `.volatile()` 的字段换成稳定活引用
 * `{ get(): T }`（见 @deepseek-ai/cosmokit），浏览器改完配置后引用就地更新。
 * 所以插件必须在**使用时**读取，不能在 apply 时把值拷走。
 *
 * 用鸭子类型而不是 cosmokit 的 `isVolatile()`：少一个 peer 依赖，
 * 拿不到它也不会让整个插件加载失败。
 *
 * @param {unknown} value 可能是活引用，也可能是普通值
 * @returns {unknown} 解引用后的值
 */
export function unwrap(value) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
    return value.get();
  }
  return value;
}

/**
 * 读字符串。
 *
 * @param {unknown} value 配置字段（可能是活引用）
 * @param {string} envName 回落的环境变量名
 * @param {string} fallback 默认值
 * @param {Record<string, string | undefined>} env 环境变量表
 * @returns {string} 去掉首尾空白的值
 */
export function pickString(value, envName, fallback, env) {
  const fromConfig = unwrap(value);
  if (typeof fromConfig === 'string' && fromConfig.trim() !== '') return fromConfig.trim();
  const raw = env?.[envName];
  if (typeof raw === 'string' && raw.trim() !== '') return raw.trim();
  return fallback;
}

/**
 * 读布尔：配置里是布尔就用它；否则环境变量只有 1/true/yes/on 算真。
 *
 * @param {unknown} value 配置字段
 * @param {string} envName 回落的环境变量名
 * @param {boolean} fallback 默认值
 * @param {Record<string, string | undefined>} env 环境变量表
 * @returns {boolean} 布尔值
 */
export function pickBoolean(value, envName, fallback, env) {
  const fromConfig = unwrap(value);
  if (typeof fromConfig === 'boolean') return fromConfig;
  const raw = env?.[envName];
  if (typeof raw !== 'string' || raw.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/**
 * 读整数并夹到 [min, max]。
 *
 * @param {unknown} value 配置字段
 * @param {number} fallback 默认值（也用于非数字输入）
 * @param {number} min 下界
 * @param {number} max 上界
 * @returns {number} 整数
 */
export function pickInt(value, fallback, min, max) {
  const fromConfig = unwrap(value);
  if (!Number.isFinite(fromConfig)) return fallback;
  const rounded = Math.round(fromConfig);
  return Math.min(max, Math.max(min, rounded));
}

/**
 * 是否是可用的 http(s) 地址。
 *
 * @param {string} value 候选地址
 * @returns {boolean} 是否以 http:// 或 https:// 开头
 */
export function isHttpUrl(value) {
  return typeof value === 'string' && /^https?:\/\/\S+/i.test(value);
}

/**
 * 把插件 config + 环境变量解析成运行时设置。
 *
 * @param {Record<string, unknown> | undefined} config 插件 Config（字段可能是活引用）
 * @param {Record<string, string | undefined>} [env] 环境变量表
 * @returns {{
 *   enabled: boolean,
 *   webhookUrl: string,
 *   format: 'markdown' | 'text',
 *   mentionAll: boolean,
 *   includeContent: boolean,
 *   notifyFailures: boolean,
 *   notifySubagents: boolean,
 *   settleMs: number,
 *   timeoutMs: number,
 *   maxAttempts: number,
 *   retryDelayMs: number,
 *   minIntervalMs: number,
 * }} 运行时设置
 */
export function resolveSettings(config, env = process.env) {
  const url = pickString(config?.webhookUrl, 'WECOM_WEBHOOK_URL', '', env);
  const format = pickString(config?.format, 'WECOM_NOTIFY_FORMAT', 'markdown', env).toLowerCase();

  return {
    enabled: pickBoolean(config?.enabled, 'WECOM_NOTIFY_ENABLED', true, env),
    webhookUrl: isHttpUrl(url) ? url : '',
    format: FORMATS.has(format) ? format : 'markdown',
    mentionAll: pickBoolean(config?.mentionAll, 'WECOM_NOTIFY_MENTION_ALL', false, env),
    includeContent: pickBoolean(config?.includeContent, 'WECOM_NOTIFY_INCLUDE_CONTENT', true, env),
    notifyFailures: pickBoolean(config?.notifyFailures, 'WECOM_NOTIFY_FAILURES', true, env),
    notifySubagents: pickBoolean(config?.notifySubagents, 'WECOM_NOTIFY_SUBAGENTS', false, env),
    settleMs: pickInt(config?.settleMs, 800, 0, 10_000),
    timeoutMs: pickInt(config?.timeoutMs, 10_000, 1_000, 60_000),
    maxAttempts: pickInt(config?.maxAttempts, 3, 1, 5),
    retryDelayMs: pickInt(config?.retryDelayMs, 1_000, 100, 30_000),
    minIntervalMs: pickInt(config?.minIntervalMs, 300, 0, 5_000),
  };
}
