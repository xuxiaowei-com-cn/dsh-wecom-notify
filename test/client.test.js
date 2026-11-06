import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * 客户端半区的渲染冒烟测试。
 *
 * 浏览器里 `react` 来自宿主的模块表；这里用最小 shim 代替，只验证：
 *   - client.js 能被加载、factory 返回预期的 inject/apply；
 *   - apply 注册了 locale 字典和 `plugins.row.config` 槽（key 正确）；
 *   - 摘要视图与配置页都能渲染，不抛异常，字段值来自 form.state。
 * 不模拟 React 的更新循环，所以不覆盖「点保存」的交互。
 */

/** 极简 React shim：够渲染一次用。 */
const ReactShim = {
  createElement(type, props, ...children) {
    return { type, props: { ...(props ?? {}), children } };
  },
  useState(initial) {
    const value = typeof initial === 'function' ? initial() : initial;
    return [value, () => {}];
  },
  useEffect() {},
  useRef(initial) {
    return { current: initial };
  },
};

/** 把 createElement 树渲染成文本，并收集指定类型的节点。 */
function walk(node, collect) {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map((child) => walk(child, collect)).join('');
  const props = node.props ?? {};
  if (typeof node.type === 'function') {
    const rendered = node.type({ ...props, children: props.children?.length === 1 ? props.children[0] : props.children });
    return walk(rendered, collect);
  }
  collect?.push(node);
  return (props.children ?? []).map((child) => walk(child, collect)).join('');
}

function renderText(node) {
  return walk(node);
}

function collectElements(node) {
  const found = [];
  walk(node, found);
  return found;
}

/** 加载 client.js（ESM 只执行一次），拿到 factory。 */
let cached;
function loadClient() {
  if (cached) return cached;
  let loaded;
  globalThis.window = {
    __ModuleLoader__: {
      load(options) {
        loaded = options;
      },
    },
  };
  // client.js 是脚本形态：执行时调用 window.__ModuleLoader__.load
  cached = import('../client.js').then(() => {
    assert.ok(loaded, 'client.js 应该调用 window.__ModuleLoader__.load');
    assert.equal(loaded.id, 'dsh-wecom-notify');
    return { factory: loaded.factory };
  });
  return cached;
}

function createClientCtx() {
  const registered = { locale: [], slots: [] };
  const ctx = {
    locale: {
      register(namespace, dictionary) {
        registered.locale.push({ namespace, dictionary });
      },
    },
    slots: {
      inject(owner, callback) {
        registered.owner = owner;
        callback();
      },
      register(options, component) {
        registered.slots.push({ options, component });
        return () => {};
      },
    },
  };
  return { ctx, registered };
}

/** 表单快照：字段值与默认配置一致。 */
function formSnapshot(overrides = {}) {
  return {
    status: 'ready',
    value: {
      webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=smoke',
      enabled: true,
      format: 'markdown',
      mentionAll: false,
      includeContent: true,
      notifyFailures: true,
      notifySubagents: false,
      ...overrides,
    },
    base: undefined,
    user: {},
    revision: 7,
    writable: true,
    mode: 'host',
  };
}

test('client.js 注册 locale 字典与 plugins.row.config 槽', async () => {
  const { factory } = await loadClient();
  const plugin = factory((name) => {
    if (name === 'react') return ReactShim;
    throw new Error(`unexpected require: ${name}`);
  });

  assert.deepEqual(plugin.inject, ['slots', 'locale']);

  const { ctx, registered } = createClientCtx();
  plugin.apply(ctx);

  assert.equal(registered.owner, 'plugins.row.config');
  assert.equal(registered.locale.length, 1);
  const [dictionary] = registered.locale;
  assert.equal(dictionary.namespace, 'wecomNotify');
  assert.equal(typeof dictionary.dictionary.zh.summaryOn, 'string');
  assert.equal(typeof dictionary.dictionary.en.summaryOn, 'string');
  assert.deepEqual(Object.keys(dictionary.dictionary.zh).sort(), Object.keys(dictionary.dictionary.en).sort());

  assert.equal(registered.slots.length, 1);
  assert.equal(registered.slots[0].options.name, 'plugins.row.config');
  assert.equal(registered.slots[0].options.key, 'dsh-wecom-notify#wecom-notify');
  assert.equal(registered.slots[0].options.locale, 'wecomNotify');
});

test('摘要视图按配置状态给出提示', async () => {
  const { factory } = await loadClient();
  const plugin = factory((name) => {
    if (name === 'react') return ReactShim;
    throw new Error(`unexpected require: ${name}`);
  });
  const { ctx, registered } = createClientCtx();
  plugin.apply(ctx);
  const { component } = registered.slots[0];

  const t = (key) => key;
  assert.equal(renderText(component({ t, view: 'summary', form: { state: formSnapshot(), mutate: async () => true } })), '任务完成时推送到企业微信');
  assert.equal(renderText(component({ t, view: 'summary', form: { state: formSnapshot({ enabled: false }), mutate: async () => true } })), '已关闭推送');
  assert.equal(renderText(component({ t, view: 'summary', form: { state: formSnapshot({ webhookUrl: '' }), mutate: async () => true } })), '尚未配置 Webhook 地址');
});

test('配置页渲染出各字段，且不抛异常', async () => {
  const { factory } = await loadClient();
  const plugin = factory((name) => {
    if (name === 'react') return ReactShim;
    throw new Error(`unexpected require: ${name}`);
  });
  const { ctx, registered } = createClientCtx();
  plugin.apply(ctx);
  const { component } = registered.slots[0];

  const tree = component({
    t: (key) => key,
    view: 'page',
    form: { state: formSnapshot(), mutate: async () => true },
  });
  const text = renderText(tree);
  const elements = collectElements(tree);

  const inputs = elements.filter((node) => node.type === 'input');
  const urlInput = inputs.find((node) => node.props.type === 'text');
  assert.equal(urlInput.props.value, 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=smoke');
  assert.equal(urlInput.props.placeholder, 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…');

  const checkboxes = inputs.filter((node) => node.props.type === 'checkbox');
  assert.equal(checkboxes.length, 5, '五个布尔字段');
  assert.ok(checkboxes.some((node) => node.props.checked === true) && checkboxes.some((node) => node.props.checked === false));

  const select = elements.find((node) => node.type === 'select');
  assert.equal(select.props.value, 'markdown');
  assert.match(renderText(select), /Markdown/);
  assert.match(renderText(select), /纯文本/);

  const buttons = elements.filter((node) => node.type === 'button');
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].props.disabled, true, '没有改动时保存按钮禁用');

  assert.match(text, /Webhook 地址/);
  assert.match(text, /启用推送/);
  assert.match(text, /保存/);
});

test('配置服务不可用时给出提示而不是崩掉', async () => {
  const { factory } = await loadClient();
  const plugin = factory((name) => {
    if (name === 'react') return ReactShim;
    throw new Error(`unexpected require: ${name}`);
  });
  const { ctx, registered } = createClientCtx();
  plugin.apply(ctx);
  const { component } = registered.slots[0];

  assert.equal(renderText(component({ t: (key) => key, view: 'page', form: undefined })), '配置服务不可用');
});
