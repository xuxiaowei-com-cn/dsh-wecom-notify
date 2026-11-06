import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebhookClient, postWecom } from '../src/webhook.js';

function reply(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  };
}

function jsonReply(value, status = 200) {
  return reply(status, JSON.stringify(value));
}

const URL = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test';
const PAYLOAD = { msgtype: 'text', text: { content: 'hi' } };

test('errcode 0 视为成功', async () => {
  const calls = [];
  const result = await postWecom(URL, PAYLOAD, {
    fetchImpl: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return jsonReply({ errcode: 0, errmsg: 'ok' });
    },
  });
  assert.deepEqual(result, { errcode: 0, errmsg: 'ok' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.msgtype, 'text');
});

test('HTTP 5xx 重试后成功', async () => {
  let attempt = 0;
  const delays = [];
  const result = await postWecom(URL, PAYLOAD, {
    maxAttempts: 3,
    retryDelayMs: 100,
    sleep: async (ms) => { delays.push(ms); },
    fetchImpl: async () => {
      attempt += 1;
      return attempt === 1 ? reply(502, 'bad gateway') : jsonReply({ errcode: 0, errmsg: 'ok' });
    },
  });
  assert.equal(result.errcode, 0);
  assert.equal(attempt, 2);
  assert.deepEqual(delays, [100]);
});

test('企业微信 -1 / 45009 这类可恢复错误会重试', async () => {
  let attempt = 0;
  const delays = [];
  const result = await postWecom(URL, PAYLOAD, {
    maxAttempts: 3,
    retryDelayMs: 200,
    sleep: async (ms) => { delays.push(ms); },
    fetchImpl: async () => {
      attempt += 1;
      if (attempt === 1) return jsonReply({ errcode: -1, errmsg: 'system busy' });
      if (attempt === 2) return jsonReply({ errcode: 45009, errmsg: 'api freq out of limit' });
      return jsonReply({ errcode: 0, errmsg: 'ok' });
    },
  });
  assert.equal(result.errcode, 0);
  assert.equal(attempt, 3);
  assert.deepEqual(delays, [200, 400], '指数退避');
});

test('配置类错误（93000）不重试', async () => {
  let attempt = 0;
  await assert.rejects(
    postWecom(URL, PAYLOAD, {
      maxAttempts: 3,
      retryDelayMs: 1,
      sleep: async () => {},
      fetchImpl: async () => {
        attempt += 1;
        return jsonReply({ errcode: 93000, errmsg: 'invalid webhook url' });
      },
    }),
    /93000/,
  );
  assert.equal(attempt, 1);
});

test('HTTP 4xx 不重试', async () => {
  let attempt = 0;
  await assert.rejects(
    postWecom(URL, PAYLOAD, {
      maxAttempts: 3,
      retryDelayMs: 1,
      sleep: async () => {},
      fetchImpl: async () => {
        attempt += 1;
        return reply(400, 'bad request');
      },
    }),
    /HTTP 400/,
  );
  assert.equal(attempt, 1);
});

test('网络错误重试到上限后抛出', async () => {
  let attempt = 0;
  await assert.rejects(
    postWecom(URL, PAYLOAD, {
      maxAttempts: 2,
      retryDelayMs: 1,
      sleep: async () => {},
      fetchImpl: async () => {
        attempt += 1;
        throw new TypeError('fetch failed');
      },
    }),
    /fetch failed/,
  );
  assert.equal(attempt, 2);
});

test('无法解析的响应体报错', async () => {
  await assert.rejects(
    postWecom(URL, PAYLOAD, {
      maxAttempts: 1,
      fetchImpl: async () => reply(200, '<html>oops</html>'),
    }),
    /无法解析/,
  );
});

test('空响应体报错', async () => {
  await assert.rejects(
    postWecom(URL, PAYLOAD, { maxAttempts: 1, fetchImpl: async () => reply(200, '') }),
    /无法解析/,
  );
});

test('非法 Webhook 地址直接拒绝', async () => {
  await assert.rejects(postWecom('', PAYLOAD, { fetchImpl: async () => jsonReply({ errcode: 0 }) }), /未配置有效的企业微信 Webhook 地址/);
  await assert.rejects(postWecom('ftp://example.com', PAYLOAD, { fetchImpl: async () => jsonReply({ errcode: 0 }) }), /未配置有效的企业微信 Webhook 地址/);
});

test('发送队列串行执行并保持最小间隔', async () => {
  let clock = 0;
  const delays = [];
  const order = [];
  const client = createWebhookClient({
    getSettings: () => ({
      webhookUrl: URL,
      timeoutMs: 1000,
      maxAttempts: 1,
      retryDelayMs: 1,
      minIntervalMs: 300,
    }),
    now: () => clock,
    sleep: async (ms) => { delays.push(ms); clock += ms; },
    fetchImpl: async () => {
      order.push(`start@${clock}`);
      clock += 25;
      order.push(`end@${clock}`);
      return jsonReply({ errcode: 0, errmsg: 'ok' });
    },
  });

  await Promise.all([client.send(PAYLOAD), client.send(PAYLOAD)]);
  assert.deepEqual(order, ['start@300', 'end@325', 'start@600', 'end@625']);
  assert.deepEqual(delays, [300, 275], '两次请求开始的间隔是 300ms，第二次只需补足剩余时间');
});

test('队列不因一次失败而中断', async () => {
  let attempt = 0;
  const client = createWebhookClient({
    getSettings: () => ({
      webhookUrl: URL,
      timeoutMs: 1000,
      maxAttempts: 1,
      retryDelayMs: 1,
      minIntervalMs: 0,
    }),
    fetchImpl: async () => {
      attempt += 1;
      if (attempt === 1) throw new TypeError('network down');
      return jsonReply({ errcode: 0, errmsg: 'ok' });
    },
  });

  await assert.rejects(client.send(PAYLOAD), /network down/);
  const result = await client.send(PAYLOAD);
  assert.equal(result.errcode, 0);
  assert.equal(attempt, 2);
});
