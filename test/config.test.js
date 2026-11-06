import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isHttpUrl,
  pickBoolean,
  pickInt,
  pickString,
  resolveSettings,
  unwrap,
} from '../src/config.js';

test('unwrap 解引用 volatile 活引用', () => {
  let value = 'a';
  const ref = { get: () => value };
  assert.equal(unwrap(ref), 'a');
  value = 'b';
  assert.equal(unwrap(ref), 'b');
  assert.equal(unwrap('plain'), 'plain');
  assert.equal(unwrap(undefined), undefined);
});

test('pickString：config 非空优先，其次环境变量，最后默认值', () => {
  const env = { WECOM_WEBHOOK_URL: 'https://env.example/hook' };
  assert.equal(pickString({ get: () => 'https://cfg.example/hook' }, 'WECOM_WEBHOOK_URL', '', env), 'https://cfg.example/hook');
  assert.equal(pickString('   ', 'WECOM_WEBHOOK_URL', '', env), 'https://env.example/hook');
  assert.equal(pickString('', 'MISSING', 'fallback', env), 'fallback');
  assert.equal(pickString(undefined, 'WECOM_WEBHOOK_URL', '', {}), '');
});

test('pickBoolean：显式布尔优先，环境变量只认 1/true/yes/on', () => {
  assert.equal(pickBoolean(false, 'X', true, { X: 'true' }), false);
  assert.equal(pickBoolean(undefined, 'X', false, { X: 'YES' }), true);
  assert.equal(pickBoolean(undefined, 'X', true, { X: '0' }), false);
  assert.equal(pickBoolean(undefined, 'X', true, {}), true);
});

test('pickInt 夹到范围内并取整', () => {
  assert.equal(pickInt(500, 800, 0, 10_000), 500);
  assert.equal(pickInt(-5, 800, 0, 10_000), 0);
  assert.equal(pickInt(999_999, 800, 0, 10_000), 10_000);
  assert.equal(pickInt('120', 800, 0, 10_000), 800);
  assert.equal(pickInt({ get: () => 1500 }, 800, 0, 10_000), 1500);
});

test('isHttpUrl 只接受 http(s) 绝对地址', () => {
  assert.equal(isHttpUrl('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x'), true);
  assert.equal(isHttpUrl('http://127.0.0.1:8080/hook'), true);
  assert.equal(isHttpUrl('ftp://example.com'), false);
  assert.equal(isHttpUrl('qyapi.weixin.qq.com'), false);
  assert.equal(isHttpUrl(''), false);
});

test('resolveSettings 合并与兜底', () => {
  const settings = resolveSettings(
    { webhookUrl: 'https://cfg.example/hook', enabled: false, format: 'TEXT', settleMs: 0 },
    {},
  );
  assert.equal(settings.enabled, false);
  assert.equal(settings.format, 'text');
  assert.equal(settings.settleMs, 0);
  assert.equal(settings.includeContent, true);
  assert.equal(settings.notifyFailures, true);
  assert.equal(settings.notifySubagents, false);
  assert.equal(settings.timeoutMs, 10_000);
  assert.equal(settings.maxAttempts, 3);
});

test('resolveSettings：非法的 Webhook 地址视为未配置', () => {
  const settings = resolveSettings({ webhookUrl: 'qyapi.weixin.qq.com/send?key=x' }, {});
  assert.equal(settings.webhookUrl, '');
});

test('resolveSettings：支持环境变量回落', () => {
  const settings = resolveSettings({}, {
    WECOM_WEBHOOK_URL: 'https://env.example/hook',
    WECOM_NOTIFY_FORMAT: 'text',
    WECOM_NOTIFY_SUBAGENTS: '1',
  });
  assert.equal(settings.webhookUrl, 'https://env.example/hook');
  assert.equal(settings.format, 'text');
  assert.equal(settings.notifySubagents, true);
});

test('resolveSettings：未知 format 回落到 markdown', () => {
  assert.equal(resolveSettings({ format: 'html' }, {}).format, 'markdown');
});
