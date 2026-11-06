#!/usr/bin/env node
/**
 * 向真实企业微信群机器人发送一条示例通知，用来验证 Webhook 与排版。
 *
 * 用法：
 *   WECOM_WEBHOOK_URL='https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…' node scripts/live-check.mjs
 *   node scripts/live-check.mjs 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…'
 *
 * 只手动运行，不参与 `npm test`（测试全部离线，不会往群里发消息）。
 */
import { homedir } from 'node:os';
import { sep } from 'node:path';
import { buildPayload } from '../src/format.js';
import { postWecom } from '../src/webhook.js';

const url = process.argv[2] || process.env.WECOM_WEBHOOK_URL || '';
if (!url) {
  console.error('缺少 Webhook 地址：node scripts/live-check.mjs <url> 或设置 WECOM_WEBHOOK_URL');
  process.exit(1);
}

const now = Date.now();
const cwd = process.cwd().startsWith(homedir()) ? `~${process.cwd().slice(homedir().length)}` : process.cwd();
const payload = buildPayload({
  turnsCount: 1,
  userText: '给「企业微信任务通知」插件做一次连通性自检',
  answerText: '看到这条消息，说明 Webhook 地址可用、Markdown 排版正常。之后每个任务结束时都会收到类似的通知。',
  kind: 'completed',
  reason: { kind: 'completed' },
  tools: [{ name: 'write' }, { name: 'test' }],
  toolErrors: 0,
  durationMs: 42_000,
  startedAt: now - 42_000,
  endedAt: now,
  lastTurn: 1,
}, {
  format: 'markdown',
  includeContent: true,
  sessionTitle: '插件自检',
  sessionId: 'live-check',
  cwd,
  hostname: 'dsh-wecom-notify',
  now,
});

console.log('--- 将发送 ---');
console.log(payload.content);
console.log(`--- ${Buffer.byteLength(payload.content)} 字节（上限 4096）---`);

const result = await postWecom(url, payload.body, {
  timeoutMs: 10_000,
  maxAttempts: 2,
  retryDelayMs: 1_000,
});
console.log('企业微信回执:', result);
