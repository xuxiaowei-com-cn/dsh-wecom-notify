import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPayload,
  byteLength,
  formatDuration,
  formatTime,
  truncateUtf8,
} from '../src/format.js';

const NOW = Date.UTC(2026, 10, 5, 13, 3, 10); // 2026-11-05T13:03:10Z

function summary(overrides = {}) {
  return {
    turnsCount: 2,
    userText: '帮我把首页改快一点',
    answerText: '已优化：图片懒加载 + 接口缓存。',
    kind: 'completed',
    reason: { kind: 'completed' },
    tools: [{ name: 'read' }, { name: 'edit' }],
    toolErrors: 0,
    durationMs: 83_000,
    startedAt: 1000,
    endedAt: 84_000,
    lastTurn: 2,
    ...overrides,
  };
}

function options(overrides = {}) {
  return {
    format: 'markdown',
    includeContent: true,
    sessionTitle: '优化首页性能',
    sessionId: 'abcdef1234567890',
    cwd: '~/Documents/deepseek-harness/default-workspace',
    hostname: 'mac-mini',
    now: NOW,
    timeZone: 'Asia/Shanghai',
    ...overrides,
  };
}

test('markdown 消息包含标题、元信息、需求、结果与页脚', () => {
  const payload = buildPayload(summary(), options());
  assert.equal(payload.msgtype, 'markdown');
  assert.equal(payload.body.msgtype, 'markdown');
  const content = payload.body.markdown.content;
  assert.match(content, /^### ✅ DSH 任务完成\n/);
  assert.match(content, /> 会话：优化首页性能/);
  assert.match(content, /> 目录：~/);
  assert.match(content, /> 2 轮 · 工具 2 次 · 用时 1 分 23 秒/);
  assert.match(content, /\*\*需求\*\*\n帮我把首页改快一点/);
  assert.match(content, /\*\*结果\*\*\n已优化/);
  assert.match(content, /<font color="comment">2026-11-05 21:03:10 · mac-mini<\/font>$/);
});

test('text 消息使用纯文本排版，mentionAll 附带 @all', () => {
  const payload = buildPayload(summary(), options({ format: 'text', mentionAll: true }));
  assert.equal(payload.msgtype, 'text');
  assert.deepEqual(payload.body.text.mentioned_list, ['@all']);
  const content = payload.body.text.content;
  assert.match(content, /^【✅ DSH 任务完成】/);
  assert.match(content, /需求：\n帮我把首页改快一点/);
  assert.match(content, /结果：\n已优化/);
  assert.doesNotMatch(content, /\*\*/);
});

test('text 格式默认不带 mentioned_list', () => {
  const payload = buildPayload(summary(), options({ format: 'text' }));
  assert.equal(payload.body.text.mentioned_list, undefined);
});

test('markdown 遵守 4096 字节上限，并优先保留结果、压缩需求', () => {
  const payload = buildPayload(summary({
    userText: '需'.repeat(5000),
    answerText: '结'.repeat(100),
  }), options());

  const content = payload.body.markdown.content;
  assert.ok(byteLength(content) <= 4096 - 128, `实际 ${byteLength(content)} 字节`);
  assert.match(content, /…（已截断）/);
  assert.ok(content.includes('结'.repeat(80)), '结果应尽量完整保留');
  assert.ok(!content.includes('需'.repeat(1200)), '需求应被压缩');
});

test('text 遵守 2048 字节上限', () => {
  const payload = buildPayload(summary({
    userText: '问'.repeat(3000),
    answerText: '答'.repeat(3000),
  }), options({ format: 'text' }));
  const content = payload.body.text.content;
  assert.ok(byteLength(content) <= 2048 - 128, `实际 ${byteLength(content)} 字节`);
});

test('标题与元信息本身超限时硬截断，仍不越界', () => {
  const payload = buildPayload(summary({
    userText: '',
    answerText: '',
  }), options({ sessionTitle: '长'.repeat(2000), maxBytes: 300 }));
  assert.ok(byteLength(payload.content) <= 300);
});

test('includeContent=false 只发摘要，不带需求/结果', () => {
  const payload = buildPayload(summary(), options({ includeContent: false }));
  assert.doesNotMatch(payload.content, /\*\*需求\*\*/);
  assert.doesNotMatch(payload.content, /\*\*结果\*\*/);
  assert.match(payload.content, /会话：优化首页性能/);
});

test('失败轮次把原因写进元信息，标题切到失败样式', () => {
  const payload = buildPayload(summary({
    kind: 'error',
    reason: { kind: 'error', error: { message: 'llm-deepseek: no API key', code: 'no-key' } },
    answerText: '',
  }), options());
  assert.match(payload.content, /^### ❌ DSH 任务失败/);
  assert.match(payload.content, /> 原因：llm-deepseek: no API key/);
});

test('中止原因按 AgentCancelCause 翻译', () => {
  const aborted = buildPayload(summary({
    kind: 'aborted',
    reason: { kind: 'aborted', reason: { kind: 'user' } },
    answerText: '',
  }), options());
  assert.match(aborted.content, /原因：用户中止/);
});

test('未知结束原因使用兜底标题', () => {
  const payload = buildPayload(summary({ kind: 'something-new', reason: { kind: 'something-new' } }), options());
  assert.match(payload.content, /^### 📩 DSH 任务结束/);
});

test('formatDuration', () => {
  assert.equal(formatDuration(0), '不到 1 秒');
  assert.equal(formatDuration(999), '不到 1 秒');
  assert.equal(formatDuration(1000), '1 秒');
  assert.equal(formatDuration(59_400), '59 秒');
  assert.equal(formatDuration(60_000), '1 分');
  assert.equal(formatDuration(83_000), '1 分 23 秒');
  assert.equal(formatDuration(3_600_000), '1 小时');
  assert.equal(formatDuration(3_660_000), '1 小时 1 分');
  assert.equal(formatDuration(-1), '');
  assert.equal(formatDuration('bad'), '');
});

test('formatTime 按指定时区渲染', () => {
  assert.equal(formatTime(NOW, 'Asia/Shanghai'), '2026-11-05 21:03:10');
  assert.equal(formatTime(NOW, 'UTC'), '2026-11-05 13:03:10');
  assert.equal(formatTime(Number.NaN, 'UTC'), '');
});

test('truncateUtf8 按字节切且不产生半个字符', () => {
  assert.equal(truncateUtf8('中文', 6), '中文');
  assert.equal(truncateUtf8('中文', 4, ''), '中');
  const cut = truncateUtf8('中文中文', 10, '…');
  assert.equal(cut, '中文…');
  assert.ok(byteLength(cut) <= 10);
  assert.equal(truncateUtf8('中文', 2, '…'), '');
});

test('空摘要也能成文，不会抛错', () => {
  const payload = buildPayload({}, options({ sessionTitle: undefined, cwd: undefined, hostname: undefined }));
  assert.match(payload.content, /^### ✅ DSH 任务完成/);
  assert.match(payload.content, /会话：abcdef12/);
});
