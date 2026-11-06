import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assistantText,
  cleanText,
  textFromMessage,
  textFromStream,
} from '../src/events.js';

test('textFromStream 取紧凑型 text-chunks', () => {
  const stream = [
    { type: 'text-chunks', time0: 0, index: 0, dt: [1, 1], texts: ['你', '好'] },
    { type: 'reasoning-chunks', time0: 0, index: 1, dt: [1], texts: ['不该出现'] },
    { type: 'text-chunks', time0: 0, index: 2, dt: [1], texts: ['！'] },
  ];
  assert.equal(textFromStream(stream), '你好！');
});

test('textFromStream 支持展开型 text-delta 与信封型 chunk', () => {
  const stream = [
    { type: 'text-delta', index: 0, text: 'A' },
    { type: 'chunk', time: 1, chunk: { type: 'text-delta', index: 0, text: 'B' } },
    { type: 'chunk', time: 2, chunk: { type: 'reasoning-delta', index: 1, text: 'C' } },
  ];
  assert.equal(textFromStream(stream), 'AB');
});

test('textFromStream 没有增量时回退 block-end 整块文本', () => {
  const stream = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'block-end', index: 0, block: { type: 'text', text: '完整一段' } },
  ];
  assert.equal(textFromStream(stream), '完整一段');
});

test('textFromStream 有增量时不重复叠加 block-end 全文', () => {
  const stream = [
    { type: 'text-chunks', time0: 0, index: 0, dt: [1], texts: ['增量'] },
    { type: 'block-end', index: 0, block: { type: 'text', text: '增量' } },
  ];
  assert.equal(textFromStream(stream), '增量');
});

test('textFromStream 对非法输入返回空串', () => {
  assert.equal(textFromStream(undefined), '');
  assert.equal(textFromStream(null), '');
  assert.equal(textFromStream({}), '');
});

test('textFromMessage 只拼 text block', () => {
  const message = {
    content: [
      { type: 'text', text: '第一段' },
      { type: 'reasoning', text: '思考' },
      { type: 'text', text: '第二段' },
    ],
  };
  assert.equal(textFromMessage(message), '第一段第二段');
  assert.equal(textFromMessage({}), '');
});

test('assistantText 优先用 stream，缺失时回退 message', () => {
  const data = {
    stream: [{ type: 'text-chunks', time0: 0, index: 0, dt: [1], texts: ['流式'] }],
    message: { content: [{ type: 'text', text: '定稿' }] },
  };
  assert.equal(assistantText(data), '流式');
  assert.equal(assistantText({ message: { content: [{ type: 'text', text: '定稿' }] } }), '定稿');
  assert.equal(assistantText(undefined), '');
});

test('cleanText 统一换行、去行尾空白、压缩空行', () => {
  assert.equal(cleanText('  a  \r\n\r\n\r\n\r\nb\t\n'), 'a\n\nb');
  assert.equal(cleanText(null), '');
});
