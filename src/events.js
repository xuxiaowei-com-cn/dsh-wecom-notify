/**
 * 从 DSH 的 SessionEvent 里抽取可读文本。
 *
 * 纯函数：不碰进程、不碰网络，所以能用 node:test 直接覆盖。
 *
 * `assistant/message.data.stream` 的形状是「带时间戳的记录数组」，文本可能出现在
 * 三种位置：
 *   { type: 'text-chunks', time0, index, dt, texts: string[] }   ← 紧凑型，最常见
 *   { type: 'text-delta', index, text }                          ← 展开型
 *   { type: 'chunk', time, chunk: { ... } }                      ← 信封型
 *       其中 chunk.type 可能是 block-start / text-chunks / text-delta /
 *       block-end（block.type === 'text' 时带完整文本）/ usage / finish
 *
 * 注意：同一条流里 `text-chunks` 与 `block-end.block.text` 会**同时**出现，
 * 前者是增量和、后者是该块全文，两者相加会翻倍——所以必须二选一。
 */

/**
 * 取出一条流记录里可能承载文本的负载（拍平信封）。
 *
 * @param {unknown} record 一条 AssistantStreamRecord
 * @returns {Record<string, any> | undefined} 记录本身或信封里的 chunk
 */
function payloadOf(record) {
  if (!record || typeof record !== 'object') return undefined;
  if (record.type === 'chunk') {
    return record.chunk && typeof record.chunk === 'object' ? record.chunk : undefined;
  }
  return record;
}

/**
 * 从 stream 记录里拼出某个 step 的完整文本。
 *
 * 优先用增量记录（text-chunks / text-delta）；只有当流里完全没有增量时，
 * 才回退到 block-end 的整块文本。
 *
 * @param {unknown} stream AssistantStreamRecord[]
 * @returns {string} 文本（可能为空串）
 */
export function textFromStream(stream) {
  if (!Array.isArray(stream)) return '';
  const deltas = [];
  const blocks = [];
  for (const record of stream) {
    const payload = payloadOf(record);
    if (!payload) continue;
    switch (payload.type) {
      case 'text-chunks':
        if (Array.isArray(payload.texts)) {
          for (const chunk of payload.texts) if (typeof chunk === 'string') deltas.push(chunk);
        }
        break;
      case 'text-delta':
        if (typeof payload.text === 'string') deltas.push(payload.text);
        break;
      case 'block-end':
        if (payload.block?.type === 'text' && typeof payload.block.text === 'string') {
          blocks.push(payload.block.text);
        }
        break;
      default:
        // reasoning-* / tool-call-* / usage / finish / block-start 一律不进用户可见文本
        break;
    }
  }
  if (deltas.length > 0) return deltas.join('');
  if (blocks.length > 0) return blocks.join('');
  return '';
}

/**
 * 从一条消息的 content blocks 里拼出文本。
 *
 * `assistant/message` 的 `message.content` 是 step 定稿值，
 * `user/message` 的 data 本身也是同形状的 UserMessage。
 *
 * @param {{ content?: unknown }} message 消息对象
 * @returns {string} 文本（可能为空串）
 */
export function textFromMessage(message) {
  if (!message || !Array.isArray(message.content)) return '';
  let out = '';
  for (const block of message.content) {
    if (block && block.type === 'text' && typeof block.text === 'string') out += block.text;
  }
  return out;
}

/**
 * 抽出一个 assistant 事件的文本。
 *
 * 优先用 `stream`（step 定稿时也带），缺失时回退到 `message.content`。
 *
 * @param {{ stream?: unknown, message?: unknown }} data assistant/attempt 或 assistant/message 的 data
 * @returns {string} 文本（可能为空串）
 */
export function assistantText(data) {
  if (!data || typeof data !== 'object') return '';
  if (Array.isArray(data.stream)) {
    const text = textFromStream(data.stream);
    if (text) return text;
  }
  return textFromMessage(data.message);
}

/**
 * 清理一段要发出去的自然语言文本。
 *
 * 统一换行、去掉行尾空白、把 3 个以上连续空行压成 1 个空行，并去掉首尾空白。
 *
 * @param {unknown} value 原始文本
 * @returns {string} 清理后的文本
 */
export function cleanText(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
