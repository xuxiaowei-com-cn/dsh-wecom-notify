import assert from 'node:assert/strict';
import test from 'node:test';
import { apply } from '../index.js';
import { createFakeCtx, createFetchStub, settle, waitFor } from './helpers.js';

let clock = 1000;

function config(overrides = {}) {
  return {
    webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test',
    enabled: true,
    format: 'markdown',
    mentionAll: false,
    includeContent: true,
    notifyFailures: true,
    notifySubagents: false,
    settleMs: 0,
    timeoutMs: 1000,
    maxAttempts: 1,
    retryDelayMs: 1,
    minIntervalMs: 0,
    ...overrides,
  };
}

function session(id = 'session-1', header = { cwd: '/tmp/project' }) {
  return { id, header };
}

function turnEvents({ turn = 1, request = '帮我做一件事', answer = '已经做完了', reason = { kind: 'completed' } } = {}) {
  const start = (clock += 1000);
  return [
    { type: 'turn/start', time: start, data: { turn } },
    { type: 'user/message', time: start + 1, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: request }] } },
    { type: 'assistant/message', time: start + 500, data: { turn, step: 0, message: { role: 'assistant', content: [{ type: 'text', text: answer }] }, stream: [] } },
    { type: 'turn/end', time: start + 900, data: { turn, reason } },
  ];
}

function emit(ctx, target, events) {
  for (const event of events) ctx.emit('session/event', target, event);
}

async function withPlugin(configOverrides, run) {
  const original = globalThis.fetch;
  const stub = createFetchStub();
  globalThis.fetch = stub.fetchImpl;
  const ctx = createFakeCtx();
  try {
    apply(ctx, config(configOverrides));
    await run({ ctx, calls: stub.calls });
  } finally {
    ctx.dispose();
    globalThis.fetch = original;
  }
}

test('turn/end 后推送一条 markdown 通知', async () => {
  await withPlugin({}, async ({ ctx, calls }) => {
    const target = session();
    emit(ctx, target, turnEvents());

    await waitFor(() => calls.length === 1);
    const body = calls[0].body;
    assert.equal(body.msgtype, 'markdown');
    assert.match(body.markdown.content, /^### ✅ DSH 任务完成/);
    assert.match(body.markdown.content, /帮我做一件事/);
    assert.match(body.markdown.content, /已经做完了/);
    assert.match(body.markdown.content, /> 会话：session-/);
    assert.match(body.markdown.content, /> 目录：\/tmp\/project/);
  });
});

test('插件中途加载（没有 turn/start）也能从 assistant/message + turn/end 收口', async () => {
  await withPlugin({}, async ({ ctx, calls }) => {
    const target = session();
    const start = (clock += 1000);
    emit(ctx, target, [
      { type: 'assistant/message', time: start + 10, data: { turn: 1, step: 0, message: { role: 'assistant', content: [{ type: 'text', text: '半路接上的答案' }] }, stream: [] } },
      { type: 'turn/end', time: start + 20, data: { turn: 1, reason: { kind: 'completed' } } },
    ]);

    await waitFor(() => calls.length === 1);
    assert.match(calls[0].body.markdown.content, /半路接上的答案/);
  });
});

test('enabled=false 时不发送', async () => {
  await withPlugin({ enabled: false }, async ({ ctx, calls }) => {
    emit(ctx, session(), turnEvents());
    await settle(120);
    assert.equal(calls.length, 0);
  });
});

test('没配置 Webhook 地址时不发送', async () => {
  await withPlugin({ webhookUrl: '' }, async ({ ctx, calls }) => {
    emit(ctx, session(), turnEvents());
    await settle(120);
    assert.equal(calls.length, 0);
  });
});

test('notifyFailures=false 时失败轮次不发送', async () => {
  await withPlugin({ notifyFailures: false }, async ({ ctx, calls }) => {
    emit(ctx, session(), turnEvents({ reason: { kind: 'error', error: { message: 'boom' } } }));
    await settle(120);
    assert.equal(calls.length, 0);
  });
});

test('notifyFailures=true 时失败轮次带原因发送', async () => {
  await withPlugin({}, async ({ ctx, calls }) => {
    emit(ctx, session(), turnEvents({
      answer: '',
      reason: { kind: 'error', error: { message: 'llm: no API key' } },
    }));
    await waitFor(() => calls.length === 1);
    assert.match(calls[0].body.markdown.content, /^### ❌ DSH 任务失败/);
    assert.match(calls[0].body.markdown.content, /原因：llm: no API key/);
  });
});

test('子代理会话默认跳过，notifySubagents=true 时发送', async () => {
  await withPlugin({}, async ({ ctx, calls }) => {
    emit(ctx, session('child-1', { cwd: '/tmp', parentSession: 'parent-1' }), turnEvents());
    await settle(120);
    assert.equal(calls.length, 0);
  });

  await withPlugin({ notifySubagents: true }, async ({ ctx, calls }) => {
    emit(ctx, session('child-2', { cwd: '/tmp', origin: 'subagent' }), turnEvents());
    await waitFor(() => calls.length === 1);
    assert.equal(calls.length, 1);
  });
});

test('新的人类请求会立刻推送上一段窗口，而不是合并', async () => {
  await withPlugin({ settleMs: 5000 }, async ({ ctx, calls }) => {
    const target = session();
    emit(ctx, target, turnEvents({ turn: 1, request: '先做 A', answer: 'A 完成' }));
    await settle(80);
    assert.equal(calls.length, 0, 'settle 窗口内先不发送');

    const start = (clock += 1000);
    emit(ctx, target, [
      { type: 'turn/start', time: start, data: { turn: 2 } },
      { type: 'user/message', time: start + 1, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '再做 B' }] } },
    ]);

    await waitFor(() => calls.length === 1);
    assert.match(calls[0].body.markdown.content, /先做 A/);
    assert.match(calls[0].body.markdown.content, /A 完成/);
    assert.doesNotMatch(calls[0].body.markdown.content, /再做 B/);
  });
});

test('settle 窗口内连续两轮合并成一条，取最后一轮答案', async () => {
  await withPlugin({ settleMs: 30 }, async ({ ctx, calls }) => {
    const target = session();
    emit(ctx, target, turnEvents({ turn: 1, request: '目标 A', answer: 'A 完成' }));
    const start = (clock += 1000);
    emit(ctx, target, [
      { type: 'turn/start', time: start, data: { turn: 2 } },
      { type: 'assistant/message', time: start + 100, data: { turn: 2, step: 0, message: { role: 'assistant', content: [{ type: 'text', text: 'B 完成' }] }, stream: [] } },
      { type: 'turn/end', time: start + 200, data: { turn: 2, reason: { kind: 'completed' } } },
    ]);

    await waitFor(() => calls.length === 1);
    const content = calls[0].body.markdown.content;
    assert.match(content, /2 轮/);
    assert.match(content, /B 完成/);
    assert.equal(calls.length, 1);
  });
});

test('纯文本格式与 @所有人', async () => {
  await withPlugin({ format: 'text', mentionAll: true, includeContent: false }, async ({ ctx, calls }) => {
    emit(ctx, session(), turnEvents());
    await waitFor(() => calls.length === 1);
    const body = calls[0].body;
    assert.equal(body.msgtype, 'text');
    assert.deepEqual(body.text.mentioned_list, ['@all']);
    assert.doesNotMatch(body.text.content, /已经做完了/);
  });
});

test('agent 被释放时把挂起的通知发出去', async () => {
  await withPlugin({ settleMs: 5000 }, async ({ ctx, calls }) => {
    const target = session();
    emit(ctx, target, turnEvents());
    await settle(80);
    assert.equal(calls.length, 0);

    ctx.emit('agent/disposed', { agent: { session: target } });
    await waitFor(() => calls.length === 1);
    assert.match(calls[0].body.markdown.content, /已经做完了/);
  });
});

test('发送失败不影响插件继续工作', async () => {
  const original = globalThis.fetch;
  const ctx = createFakeCtx();
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    throw new TypeError('网络断了');
  };
  try {
    apply(ctx, config({ maxAttempts: 1 }));
    const target = session();
    emit(ctx, target, turnEvents({ turn: 1 }));
    await waitFor(() => attempts === 1);
    emit(ctx, target, turnEvents({ turn: 2, answer: '第二轮' }));
    await waitFor(() => attempts === 2);
    assert.ok(ctx.logs.some((entry) => entry.level === 'warn' && String(entry.args[0]).includes('推送失败')));
  } finally {
    ctx.dispose();
    globalThis.fetch = original;
  }
});
