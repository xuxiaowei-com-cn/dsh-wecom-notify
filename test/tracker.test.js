import assert from 'node:assert/strict';
import test from 'node:test';
import { createTurnTracker } from '../src/tracker.js';

const SESSION = 'session-1';

function userMessage(text) {
  return {
    type: 'user/message',
    time: 1001,
    data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
  };
}

function assistantMessage(turn, step, text) {
  return {
    type: 'assistant/message',
    time: 1100 + step,
    data: {
      turn,
      step,
      message: { role: 'assistant', content: [{ type: 'text', text }] },
      stream: [],
    },
  };
}

function pushTurn(tracker, { turn = 1, request = '帮我做一件事', answers = ['做完了'], reason = { kind: 'completed' }, start = 1000, end = 2000 } = {}) {
  tracker.observe(SESSION, { type: 'turn/start', time: start, data: { turn } });
  tracker.observe(SESSION, userMessage(request));
  answers.forEach((text, index) => tracker.observe(SESSION, assistantMessage(turn, index, text)));
  tracker.observe(SESSION, { type: 'turn/end', time: end, data: { turn, reason } });
}

test('完整一轮：抽取请求、最终答复、工具计数与时长', () => {
  const tracker = createTurnTracker();
  tracker.observe(SESSION, { type: 'turn/start', time: 1000, data: { turn: 1 } });
  tracker.observe(SESSION, userMessage('查一下天气'));
  tracker.observe(SESSION, assistantMessage(1, 0, '先查。'));
  tracker.observe(SESSION, { type: 'tool/call', time: 1200, data: { turn: 1, step: 0, name: 'web_search' } });
  tracker.observe(SESSION, { type: 'tool/result', time: 1300, data: { turn: 1, step: 0, error: { name: 'X' } } });
  tracker.observe(SESSION, { type: 'tool/call', time: 1400, data: { turn: 1, step: 1, name: 'web_fetch' } });
  tracker.observe(SESSION, assistantMessage(1, 2, '今天晴。'));
  const boundary = tracker.observe(SESSION, { type: 'turn/end', time: 3000, data: { turn: 1, reason: { kind: 'completed' } } });

  assert.equal(boundary, 'turn-end');
  const summary = tracker.takeWindow(SESSION);
  assert.equal(summary.turnsCount, 1);
  assert.equal(summary.userText, '查一下天气');
  assert.equal(summary.answerText, '今天晴。', '只取最后一个有内容的 step');
  assert.equal(summary.tools.length, 2);
  assert.equal(summary.toolErrors, 1);
  assert.equal(summary.durationMs, 2000);
  assert.equal(summary.kind, 'completed');
  assert.equal(summary.lastTurn, 1);
});

test('没有 assistant/message 时用 assistant/attempt 的中间态兜底', () => {
  const tracker = createTurnTracker();
  tracker.observe(SESSION, { type: 'turn/start', time: 1000, data: { turn: 1 } });
  tracker.observe(SESSION, {
    type: 'assistant/attempt',
    time: 1100,
    data: { turn: 1, step: 0, stream: [{ type: 'text-delta', index: 0, text: '中断前的内容' }] },
  });
  tracker.observe(SESSION, { type: 'turn/end', time: 1200, data: { turn: 1, reason: { kind: 'interrupted' } } });

  const summary = tracker.takeWindow(SESSION);
  assert.equal(summary.answerText, '中断前的内容');
  assert.equal(summary.kind, 'interrupted');
});

test('多轮窗口的摘要', () => {
  const tracker = createTurnTracker();
  pushTurn(tracker, { turn: 1, request: '先做 A', answers: ['A 完成'], start: 1000, end: 2000 });
  tracker.observe(SESSION, { type: 'turn/start', time: 3000, data: { turn: 2 } });
  // 目标续跑注入的提示不是人类请求，不应该覆盖 window.userText
  tracker.observe(SESSION, {
    type: 'user/message',
    time: 3001,
    data: { role: 'user', source: { kind: 'goal' }, content: [{ type: 'text', text: '继续' }] },
  });
  tracker.observe(SESSION, assistantMessage(2, 0, 'B 完成'));
  tracker.observe(SESSION, { type: 'turn/end', time: 5000, data: { turn: 2, reason: { kind: 'completed' } } });

  const summary = tracker.takeWindow(SESSION);
  assert.equal(summary.turnsCount, 2);
  assert.equal(summary.userText, '先做 A');
  assert.equal(summary.answerText, 'B 完成');
  assert.equal(summary.durationMs, 3000);
  assert.equal(summary.lastTurn, 2);
});

test('最后一轮失败时只认最后一轮答案，不回退旧答案', () => {
  const tracker = createTurnTracker();
  pushTurn(tracker, { turn: 1, answers: ['旧答案'], start: 1000, end: 2000 });
  tracker.observe(SESSION, { type: 'turn/start', time: 3000, data: { turn: 2 } });
  tracker.observe(SESSION, {
    type: 'user/message',
    time: 3001,
    data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '第二轮' }] },
  });
  tracker.observe(SESSION, {
    type: 'turn/end',
    time: 4000,
    data: { turn: 2, reason: { kind: 'error', error: { message: '模型调用失败', code: 'llm' } } },
  });

  const summary = tracker.takeWindow(SESSION);
  assert.equal(summary.kind, 'error');
  assert.equal(summary.answerText, '');
  assert.equal(summary.reason.error.message, '模型调用失败');
});

test('新请求判定：窗口有完成轮、当前轮还没有人类文本', () => {
  const tracker = createTurnTracker();
  pushTurn(tracker, { turn: 1 });

  assert.equal(tracker.hasCompleted(SESSION), true);
  assert.equal(tracker.currentHasUserText(SESSION), false);

  tracker.observe(SESSION, { type: 'turn/start', time: 3000, data: { turn: 2 } });
  assert.equal(tracker.hasCompleted(SESSION), true);
  assert.equal(tracker.currentHasUserText(SESSION), false);

  tracker.observe(SESSION, userMessage('再做一个'));
  assert.equal(tracker.currentHasUserText(SESSION), true);
});

test('takeWindow 只取走已完成轮，保留进行中的 turn', () => {
  const tracker = createTurnTracker();
  pushTurn(tracker, { turn: 1 });
  tracker.observe(SESSION, { type: 'turn/start', time: 3000, data: { turn: 2 } });
  tracker.observe(SESSION, userMessage('第二轮请求'));

  const summary = tracker.takeWindow(SESSION);
  assert.equal(summary.lastTurn, 1);
  assert.equal(tracker.hasCompleted(SESSION), false);
  assert.equal(tracker.currentHasUserText(SESSION), true);

  tracker.observe(SESSION, assistantMessage(2, 0, '第二轮答案'));
  tracker.observe(SESSION, { type: 'turn/end', time: 4000, data: { turn: 2, reason: { kind: 'completed' } } });
  const second = tracker.takeWindow(SESSION);
  assert.equal(second.userText, '第二轮请求');
  assert.equal(second.answerText, '第二轮答案');
});

test('turn/start 遇到未收尾的轮次时先收尾，避免内容丢失', () => {
  const tracker = createTurnTracker();
  tracker.observe(SESSION, { type: 'turn/start', time: 1000, data: { turn: 1 } });
  tracker.observe(SESSION, userMessage('孤儿请求'));
  tracker.observe(SESSION, assistantMessage(1, 0, '孤儿答案'));
  tracker.observe(SESSION, { type: 'turn/start', time: 2000, data: { turn: 2 } });

  const summary = tracker.takeWindow(SESSION);
  assert.equal(summary.turnsCount, 1);
  assert.equal(summary.kind, 'unknown');
  assert.equal(summary.answerText, '孤儿答案');
});

test('空 turn 不进窗口，forget 清空状态', () => {
  const tracker = createTurnTracker();
  tracker.observe(SESSION, { type: 'turn/start', time: 1000, data: { turn: 1 } });
  tracker.observe(SESSION, { type: 'turn/end', time: 1100, data: { turn: 1, reason: { kind: 'completed' } } });
  assert.equal(tracker.takeWindow(SESSION), undefined);
  assert.equal(tracker.size(), 1);

  tracker.forget(SESSION);
  assert.equal(tracker.size(), 0);
});
