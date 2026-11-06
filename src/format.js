/**
 * 把一次任务窗口渲染成企业微信群机器人消息。
 *
 * 纯函数：输入摘要，输出 `{ msgtype, content, body }`，不碰网络。
 *
 * 企业微信的硬限制（字节，不是字符）：
 *   text     content ≤ 2048 字节
 *   markdown content ≤ 4096 字节
 * 中文一个字占 3 字节，所以必须按 UTF-8 字节截断，并按优先级压缩正文：
 * 先压「需求」，再压「结果」，最后才硬切整条消息。
 */
import { cleanText } from './events.js';

/** 两种消息类型的官方上限。 */
const LIMITS = { text: 2048, markdown: 4096 };
/** 预留安全边距：给转义、省略号和服务端统计留余量。 */
const SAFETY_MARGIN = 128;
/** 「结果」至少保留的字节数，避免被「需求」挤没。 */
const RESULT_MIN_BYTES = 60;
const TRUNCATED = '…（已截断）';

const TITLES = {
  completed: '✅ DSH 任务完成',
  error: '❌ DSH 任务失败',
  aborted: '⏹ DSH 任务已中止',
  blocked: '⛔ DSH 任务被阻止',
  'max-tokens': '⚠️ DSH 任务达到 Token 上限',
  interrupted: '⏹ DSH 任务被中断',
  forked: '⑂ DSH 会话已分叉',
  unknown: '📩 DSH 任务结束',
};

const encoder = new TextEncoder();

/**
 * UTF-8 字节长度。
 *
 * @param {unknown} value 文本
 * @returns {number} 字节数；非字符串按 0 计
 */
export function byteLength(value) {
  if (typeof value !== 'string' || value.length === 0) return 0;
  return encoder.encode(value).length;
}

/**
 * 按 UTF-8 字节安全截断，并按 code point 遍历避免切出半个多字节字符。
 *
 * @param {string} text 原文
 * @param {number} maxBytes 允许的最大字节数（含后缀）
 * @param {string} [suffix] 截断后缀
 * @returns {string} 截断后的文本
 */
export function truncateUtf8(text, maxBytes, suffix = '…') {
  if (typeof text !== 'string') return '';
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return '';
  if (byteLength(text) <= maxBytes) return text;

  const suffixBytes = byteLength(suffix);
  if (suffixBytes >= maxBytes) {
    let out = '';
    let used = 0;
    for (const char of suffix) {
      const size = byteLength(char);
      if (used + size > maxBytes) break;
      out += char;
      used += size;
    }
    return out;
  }

  const budget = maxBytes - suffixBytes;
  let out = '';
  let used = 0;
  for (const char of text) {
    const size = byteLength(char);
    if (used + size > budget) break;
    out += char;
    used += size;
  }
  return out + suffix;
}

/**
 * 人类可读的时长。
 *
 * @param {number} ms 毫秒
 * @returns {string} 例如「不到 1 秒」「1 分 23 秒」
 */
export function formatDuration(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return '';
  if (value < 1000) return '不到 1 秒';
  const seconds = Math.round(value / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const restSeconds = seconds % 60;
  if (minutes < 60) return restSeconds === 0 ? `${minutes} 分` : `${minutes} 分 ${restSeconds} 秒`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes === 0 ? `${hours} 小时` : `${hours} 小时 ${restMinutes} 分`;
}

/**
 * 时间戳 → `YYYY-MM-DD HH:mm:ss`。
 *
 * @param {number} timestamp 毫秒时间戳
 * @param {string} [timeZone] IANA 时区；省略则用本机时区
 * @returns {string} 本地时间文本
 */
export function formatTime(timestamp, timeZone) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

/** 压成一行（用于会话标题、目录这类元信息）。 */
function oneLine(value, maxLength = 80) {
  if (typeof value !== 'string') return '';
  const line = value.replace(/\s+/g, ' ').trim();
  return line.length > maxLength ? `${line.slice(0, maxLength)}…` : line;
}

/** 把 turn 结束原因翻成一句人话。 */
function detailOf(reason) {
  if (!reason || typeof reason !== 'object') return '';
  switch (reason.kind) {
    case 'error': {
      const failure = reason.error;
      if (failure && typeof failure === 'object') {
        if (typeof failure.message === 'string' && failure.message.trim()) return failure.message.trim();
        if (typeof failure.code === 'string' && failure.code.trim()) return failure.code.trim();
      }
      return '模型调用失败';
    }
    case 'aborted': {
      const cause = reason.reason?.kind;
      if (cause === 'user') return '用户中止';
      if (cause === 'parent') return '父会话中止';
      if (cause === 'disposed') return '运行环境已释放';
      if (cause === 'hook') return reason.reason?.reason || '被钩子中止';
      return '已中止';
    }
    case 'blocked':
      return '被策略或钩子阻止';
    case 'max-tokens':
      return '达到最大 Token 限制';
    case 'interrupted':
      return '本轮被中断';
    default:
      return '';
  }
}

/** 组装元信息行。 */
function metaLines(summary, options) {
  const lines = [];
  const title = oneLine(options.sessionTitle);
  const sessionId = typeof options.sessionId === 'string' ? options.sessionId : '';
  if (title) lines.push(`会话：${title}`);
  else if (sessionId) lines.push(`会话：${sessionId.slice(0, 8)}`);

  const cwd = oneLine(options.cwd, 120);
  if (cwd) lines.push(`目录：${cwd}`);

  const stats = [];
  const turns = Number(summary?.turnsCount);
  if (Number.isSafeInteger(turns) && turns > 1) stats.push(`${turns} 轮`);
  const tools = Array.isArray(summary?.tools) ? summary.tools.length : 0;
  const toolErrors = Number(summary?.toolErrors) || 0;
  if (tools > 0) stats.push(`工具 ${tools} 次${toolErrors > 0 ? `（失败 ${toolErrors}）` : ''}`);
  const duration = formatDuration(summary?.durationMs);
  if (duration) stats.push(`用时 ${duration}`);
  if (stats.length > 0) lines.push(stats.join(' · '));

  const detail = oneLine(detailOf(summary?.reason), 200);
  if (detail) lines.push(`原因：${detail}`);
  return lines;
}

/** 拼正文；空块直接跳过。 */
function compose(head, blocks, foot, separator) {
  const parts = [];
  if (head) parts.push(head);
  for (const block of blocks) {
    if (typeof block.text !== 'string' || block.text.length === 0) continue;
    parts.push(`${block.label}\n${block.text}`);
  }
  if (foot) parts.push(foot);
  return parts.join(separator);
}

/**
 * 在字节预算内渲染：先压缩正文，实在放不下才硬切整条消息。
 */
function fit({ head, blocks, foot, separator, maxBytes }) {
  const full = compose(head, blocks, foot, separator);
  if (byteLength(full) <= maxBytes) return full;

  const active = blocks.filter((block) => typeof block.text === 'string' && block.text.length > 0);
  const flexible = active.filter((block) => (block.minBytes ?? 0) < byteLength(block.text));
  const overhead = byteLength(separator) * (active.length + (foot ? 1 : 0))
    + active.reduce((sum, block) => sum + byteLength(block.label) + 1, 0);
  const available = maxBytes - byteLength(head) - byteLength(foot) - overhead;

  if (available > 0 && flexible.length > 0) {
    const sizes = flexible.map((block) => byteLength(block.text));
    let total = active.reduce((sum, block) => sum + byteLength(block.text), 0);
    // 按 blocks 顺序压缩：先「需求」（minBytes 0），再「结果」（minBytes 60）。
    for (let index = 0; index < flexible.length && total > available; index += 1) {
      const minimum = Math.min(flexible[index].minBytes ?? 0, sizes[index]);
      const slack = sizes[index] - minimum;
      if (slack <= 0) continue;
      const cut = Math.min(slack, total - available);
      sizes[index] -= cut;
      total -= cut;
    }
    if (total <= available) {
      const trimmed = active.map((block) => {
        const position = flexible.indexOf(block);
        if (position < 0) return block;
        return sizes[position] < byteLength(block.text)
          ? { ...block, text: truncateUtf8(block.text, sizes[position], TRUNCATED) }
          : block;
      });
      const candidate = compose(head, trimmed, foot, separator);
      if (byteLength(candidate) <= maxBytes) return candidate;
    }
  }

  return truncateUtf8(full, maxBytes, '…');
}

/**
 * 渲染一条企业微信消息。
 *
 * @param {object} summary tracker.takeWindow() 的返回值
 * @param {{
 *   format?: 'markdown' | 'text',
 *   mentionAll?: boolean,
 *   includeContent?: boolean,
 *   sessionTitle?: string,
 *   sessionId?: string,
 *   cwd?: string,
 *   hostname?: string,
 *   now?: number,
 *   timeZone?: string,
 *   maxBytes?: number,
 * }} [options] 渲染选项
 * @returns {{ msgtype: 'markdown' | 'text', format: string, content: string, body: object }} 消息与请求体
 */
export function buildPayload(summary, options = {}) {
  const format = options.format === 'text' ? 'text' : 'markdown';
  const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes > 0
    ? options.maxBytes
    : LIMITS[format] - SAFETY_MARGIN;

  const kind = typeof summary?.kind === 'string' ? summary.kind : 'completed';
  const title = TITLES[kind] ?? TITLES.unknown;
  const meta = metaLines(summary, options);
  const time = formatTime(options.now ?? Date.now(), options.timeZone);
  const host = oneLine(options.hostname, 40);
  const footText = [time, host].filter(Boolean).join(' · ');

  const head = format === 'markdown'
    ? [`### ${title}`, ...meta.map((line) => `> ${line}`)].join('\n')
    : [`【${title}】`, ...meta].join('\n');

  const blocks = [];
  if (options.includeContent !== false) {
    const request = cleanText(summary?.userText);
    const answer = cleanText(summary?.answerText);
    if (request) {
      blocks.push({ key: 'request', label: format === 'markdown' ? '**需求**' : '需求：', text: request, minBytes: 0 });
    }
    if (answer) {
      blocks.push({ key: 'result', label: format === 'markdown' ? '**结果**' : '结果：', text: answer, minBytes: RESULT_MIN_BYTES });
    }
  }

  const foot = footText
    ? (format === 'markdown' ? `<font color="comment">${footText}</font>` : footText)
    : '';

  const content = fit({ head, blocks, foot, separator: '\n\n', maxBytes });

  if (format === 'text') {
    const text = { content };
    if (options.mentionAll === true) text.mentioned_list = ['@all'];
    return { msgtype: 'text', format, content, body: { msgtype: 'text', text } };
  }
  return { msgtype: 'markdown', format, content, body: { msgtype: 'markdown', markdown: { content } } };
}
