/**
 * dsh-wecom-notify 的浏览器端：在 Web 侧栏「插件」页给本包的插件行加一个
 * 「配置」入口，形如企业微信 Webhook 地址、开关与消息选项。
 *
 * 只依赖浏览器模块表里的 react；不 import 任何 Harness Client 包，控件用
 * 原生 input/select/button + 主题 token 手写，避免宿主包升级把页面打挂。
 *
 * 配置读写走插件管理页注入的 `form`（ConfigPageForm）：`form.state` 是 Host
 * 侧 Config 表单快照，`form.mutate(ops, revision)` 一次性提交改动并写回 profile。
 */
window.__ModuleLoader__.load({
  id: 'dsh-wecom-notify',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** 本包在 profile patch 里的行 id；slot key 必须是 `<包名>#<行 id>`。 */
    const ROW_KEY = 'dsh-wecom-notify#wecom-notify';
    /** 浏览器端 locale 命名空间。 */
    const NS = 'wecomNotify';

    const DICT = {
      zh: {
        summaryOn: '任务完成时推送到企业微信',
        summaryOff: '已关闭推送',
        summaryNoUrl: '尚未配置 Webhook 地址',
        webhookUrl: 'Webhook 地址',
        webhookPlaceholder: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…',
        enabled: '启用推送',
        format: '消息格式',
        formatMarkdown: 'Markdown',
        formatText: '纯文本',
        includeContent: '附带需求与结果正文',
        notifyFailures: '失败 / 中断时也推送',
        notifySubagents: '子代理会话也推送',
        mentionAll: '纯文本消息 @所有人',
        save: '保存',
        saving: '保存中…',
        saved: '已保存，下一轮任务结束时生效',
        saveFailed: '保存失败，请重试',
        unavailable: '配置服务不可用',
        loading: '正在读取配置…',
        readonly: '当前连接不支持写入配置',
        hint: 'Webhook 地址来自企业微信群机器人；超时、重试、合并窗口等调优项可在 profile 的 cordis.patch.yml 中配置。',
        openDocs: '企业微信：群设置 → 群机器人 → 添加 → 复制 Webhook 地址',
      },
      en: {
        summaryOn: 'Pushes a WeCom message when a task finishes',
        summaryOff: 'Notifications are off',
        summaryNoUrl: 'No webhook configured yet',
        webhookUrl: 'Webhook URL',
        webhookPlaceholder: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…',
        enabled: 'Enable notifications',
        format: 'Message format',
        formatMarkdown: 'Markdown',
        formatText: 'Plain text',
        includeContent: 'Include the request and result',
        notifyFailures: 'Also notify on failure or interruption',
        notifySubagents: 'Also notify for subagent sessions',
        mentionAll: 'Mention @all in plain-text messages',
        save: 'Save',
        saving: 'Saving…',
        saved: 'Saved; applies from the next finished task',
        saveFailed: 'Save failed, please retry',
        unavailable: 'Configuration service unavailable',
        loading: 'Reading configuration…',
        readonly: 'This connection cannot write configuration',
        hint: 'The webhook comes from a WeCom group robot. Timeouts, retries and the merge window stay in the profile cordis.patch.yml.',
        openDocs: 'WeCom: Group settings → Group robot → Add → Copy webhook URL',
      },
    };

    const colors = {
      primary: 'var(--dsw-alias-label-primary)',
      secondary: 'var(--dsw-alias-label-secondary)',
      border: 'var(--dsw-alias-border-l1)',
      field: 'var(--dsw-alias-bg-layer-2)',
      brand: 'var(--dsw-alias-brand-primary)',
      success: 'var(--dsw-alias-state-success-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
    };

    const inputStyle = {
      width: '100%',
      boxSizing: 'border-box',
      padding: '7px 10px',
      borderRadius: '6px',
      border: `1px solid ${colors.border}`,
      background: colors.field,
      color: colors.primary,
      font: 'inherit',
      fontSize: '13px',
    };

    const labelStyle = { fontSize: '12px', color: colors.secondary };

    const rowStyle = { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: colors.primary, cursor: 'pointer' };

    const buttonStyle = {
      justifySelf: 'start',
      padding: '6px 16px',
      borderRadius: '6px',
      border: `1px solid ${colors.brand}`,
      background: 'transparent',
      color: colors.brand,
      font: 'inherit',
      fontSize: '13px',
      cursor: 'pointer',
    };

    /** 可编辑字段；顺序即页面顺序。 */
    const FIELDS = [
      { key: 'webhookUrl', kind: 'text' },
      { key: 'enabled', kind: 'boolean' },
      { key: 'format', kind: 'select', options: ['markdown', 'text'] },
      { key: 'includeContent', kind: 'boolean' },
      { key: 'notifyFailures', kind: 'boolean' },
      { key: 'notifySubagents', kind: 'boolean' },
      { key: 'mentionAll', kind: 'boolean' },
    ];

    /** 浅比较（值都是字符串/布尔/数组这类 JSON 形状）。 */
    function same(left, right) {
      if (left === right) return true;
      if (left === undefined || right === undefined) return false;
      return JSON.stringify(left) === JSON.stringify(right);
    }

    /** 翻译；字典缺失时退回中文，再退回 key，永不抛错。 */
    function translate(t) {
      return (key) => {
        try {
          if (typeof t === 'function') {
            const value = t(key);
            if (typeof value === 'string' && value !== key) return value;
          }
        } catch {
          // 落到字典
        }
        return DICT.zh[key] ?? key;
      };
    }

    /** 摘要行：列表页一栏和行详情页的 description 都用它。 */
    function summaryOf(tr, value) {
      if (!value) return tr('summaryNoUrl');
      if (value.enabled === false) return tr('summaryOff');
      return value.webhookUrl ? tr('summaryOn') : tr('summaryNoUrl');
    }

    /** 一个字段控件。 */
    function FieldControl(props) {
      const { field, value, disabled, tr, onChange } = props;
      if (field.kind === 'boolean') {
        return h('label', { style: rowStyle },
          h('input', {
            type: 'checkbox',
            checked: value === true,
            disabled,
            onChange: (event) => onChange(event.target.checked),
          }),
          h('span', null, tr(field.key)));
      }
      if (field.kind === 'select') {
        return h('label', { style: { display: 'grid', gap: '6px' } },
          h('span', { style: labelStyle }, tr(field.key)),
          h('select', {
            style: inputStyle,
            value: typeof value === 'string' ? value : field.options[0],
            disabled,
            onChange: (event) => onChange(event.target.value),
          }, field.options.map((option) => h('option', { key: option, value: option },
            tr(option === 'markdown' ? 'formatMarkdown' : 'formatText')))),
        );
      }
      return h('label', { style: { display: 'grid', gap: '6px' } },
        h('span', { style: labelStyle }, tr(field.key)),
        h('input', {
          style: inputStyle,
          type: 'text',
          value: typeof value === 'string' ? value : '',
          placeholder: tr('webhookPlaceholder'),
          disabled,
          spellCheck: false,
          autoComplete: 'off',
          onChange: (event) => onChange(event.target.value),
        }),
      );
    }

    /** 配置页 / 摘要。 */
    function ConfigPage(props) {
      const { view, form, t } = props;
      const tr = translate(t);
      const snapshot = form?.state;
      const value = snapshot?.value ?? {};
      const revision = snapshot?.revision;
      const [draft, setDraft] = React.useState(() => ({ ...value }));
      const [busy, setBusy] = React.useState(false);
      const [notice, setNotice] = React.useState(undefined);
      const seenRevision = React.useRef(revision);

      React.useEffect(() => {
        if (seenRevision.current === revision) return;
        seenRevision.current = revision;
        setDraft({ ...(snapshot?.value ?? {}) });
      }, [revision]);

      // 摘要视图可能在没有 form 的地方被当作 description 兜底渲染；
      // 读不到配置时返回 null，让宿主回落到本包的 locale 描述。
      if (view === 'summary') return form ? summaryOf(tr, value) : null;
      if (!form) return h('p', { style: { ...labelStyle, margin: 0 } }, tr('unavailable'));
      if (snapshot?.status === 'loading' || snapshot?.status === 'idle') {
        return h('p', { style: { ...labelStyle, margin: 0 } }, tr('loading'));
      }

      const writable = snapshot?.writable !== false;
      const dirty = FIELDS.some((field) => !same(draft[field.key], value[field.key]));

      const save = async () => {
        if (busy || !writable) return;
        const ops = [];
        for (const field of FIELDS) {
          const before = value[field.key];
          const after = draft[field.key];
          if (same(before, after)) continue;
          if (after === undefined) ops.push({ op: 'unset', path: [field.key] });
          else ops.push({ op: 'set', path: [field.key], value: after });
        }
        if (ops.length === 0) return;
        setBusy(true);
        setNotice(undefined);
        let accepted = false;
        try {
          accepted = await form.mutate(ops, snapshot?.revision);
        } catch {
          accepted = false;
        } finally {
          setBusy(false);
        }
        setNotice(accepted ? 'saved' : 'saveFailed');
      };

      const noticeLine = notice === 'saved'
        ? h('span', { style: { color: colors.success } }, tr('saved'))
        : notice === 'saveFailed'
          ? h('span', { style: { color: colors.error } }, tr('saveFailed'))
          : null;

      return h('div', { style: { display: 'grid', gap: '12px', maxWidth: '640px' } },
        FIELDS.map((field) => h(FieldControl, {
          key: field.key,
          field,
          value: draft[field.key],
          disabled: busy || !writable,
          tr,
          onChange: (next) => setDraft((previous) => ({ ...previous, [field.key]: next })),
        })),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' } },
          h('button', {
            type: 'button',
            style: { ...buttonStyle, opacity: dirty && writable && !busy ? 1 : 0.5, cursor: dirty && writable && !busy ? 'pointer' : 'not-allowed' },
            disabled: !dirty || !writable || busy,
            onClick: () => { void save(); },
          }, tr(busy ? 'saving' : 'save')),
          noticeLine,
          writable ? null : h('span', { style: { color: colors.secondary, fontSize: '12px' } }, tr('readonly')),
        ),
        h('p', { style: { ...labelStyle, margin: 0, lineHeight: 1.6 } }, tr('hint')),
        h('p', { style: { ...labelStyle, margin: 0, lineHeight: 1.6 } }, tr('openDocs')),
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        try {
          ctx.locale.register(NS, DICT);
        } catch {
          // 命名空间已注册（HMR 重载）时忽略
        }
        ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
          name: 'plugins.row.config',
          key: ROW_KEY,
          locale: NS,
        }, ConfigPage));
      },
    };
  },
});
