# dsh-wecom-notify

**任务完成时，把结果推送到企业微信群机器人 Webhook。**

装进 DSH profile 后，每次 Agent 跑完一轮任务（`turn/end`），插件会把
「会话、目录、轮次 / 工具次数 / 用时、需求、结果」拼成一条消息发给群机器人。
Webhook 地址在 Web 侧栏「插件」页里直接改，也可写在 profile 的 `cordis.patch.yml`
或环境变量里。

```
DSH Agent ── turn/end ──▶ dsh-wecom-notify ── POST JSON ──▶ 企业微信群机器人
                                   │
                                   └─ 合并窗口 / 去重 / 重试 / 按字节截断
```

## 推送什么

Markdown（默认，上限 4096 字节）：

```
### ✅ DSH 任务完成
> 会话：优化首页性能
> 目录：~/Documents/deepseek-harness/default-workspace
> 2 轮 · 工具 6 次 · 用时 1 分 23 秒

**需求**
帮我把首页改快一点

**结果**
已优化：图片懒加载 + 接口缓存，首屏从 2.4s 降到 0.9s。

<font color="comment">2026-11-05 21:03:10 · MacBook-Pro</font>
```

纯文本（`format: text`，上限 2048 字节，可 `@所有人`）：

```
【✅ DSH 任务完成】
会话：优化首页性能
目录：~/Documents/deepseek-harness/default-workspace
工具 6 次 · 用时 1 分 23 秒

需求：
帮我把首页改快一点

结果：
已优化：图片懒加载 + 接口缓存。
```

标题随结束原因变化：`✅ 完成` / `❌ 失败` / `⏹ 中止` / `⛔ 被阻止` /
`⚠️ 达到 Token 上限` / `⏹ 被中断`。失败类消息会多一行 `原因：…`。

## 什么时候推

- **按 durable 事件触发**：监听 `session/event` 里的 `turn/end`（一个 turn 就是
  Web UI 里的一次任务），不轮询 `agent/status`。
- **合并窗口**：`turn/end` 之后等 `settleMs`（默认 800ms）再发。目标自动续跑、
  或紧接着又开了一轮时，把这几轮合并成一条（标题里写 `N 轮`，结果取**最后一轮最后一步**的最终答复，不把中间旁白拼进来）。
- **新请求先结账**：窗口还没发出去时如果来了**新的人类消息**，先立刻把上一段任务
  推出去，再为新请求开新窗口——两次任务不会被搅成一条。
- **同一 turn 只推一次**：新请求触发的即时推送与 settle 定时器撞车时按 turn 号去重。
- **只推主会话**：子代理（`header.parentSession` / `origin: 'subagent'`）默认跳过，
  `notifySubagents: true` 可打开。
- **失败不拖垮 DSH**：发送异常只写日志，不抛回事件总线；网络错误 / HTTP 5xx /
  企业微信 `-1`、`45009`、`45033` 会指数退避重试，配置类错误直接放弃。

## 安装

### 方式 A：从工作区目录安装（开发中）

在 DSH 里用 `plugin_manager` 的 `install_bundle`，`target` 传本目录的绝对路径，
例如：

```
/Users/xuxiaowei/Documents/deepseek-harness/default-workspace/dsh-wecom-notify
```

安装会把本包链接进 profile 的 `node_modules`，并把 bundle patch 纳入层栈。

改完源码后，把插件行**关掉再打开**（`plugin_manager` 的 `set_plugin`，或插件页上的开关）
就会重新 import 模块、重新 `apply`，不用重启 DSH；改 `package.json` / patch 之类
的包元数据则重装一次更稳妥。

### 方式 B：`dsh plugin add`

```sh
dsh plugin --profile web add /绝对路径/dsh-wecom-notify
# 或者发布/推到 git 之后
dsh plugin --profile web add git+https://…/dsh-wecom-notify.git
```

> `desktop` profile 由桌面应用独占，CLI 不接受给它执行 `plugin add`；
> 桌面版请用方式 A。

## 配置

### 在浏览器里改（推荐）

侧栏 **插件** → `dsh-wecom-notify` → 插件行右侧的 **配置**：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| Webhook 地址 | 空 | 群机器人地址；留空回落到 `WECOM_WEBHOOK_URL` |
| 启用推送 | 开 | 关掉后不再发送 |
| 消息格式 | Markdown | `markdown` 或 `text` |
| 附带需求与结果正文 | 开 | 关闭后只发摘要行 |
| 失败 / 中断时也推送 | 开 | 关闭后只推 `completed` |
| 子代理会话也推送 | 关 | 打开后子代理结束也推 |
| 纯文本消息 @所有人 | 关 | 仅 `text` 格式生效 |

表单写回的是该 profile 的 Cordis patch，保存后**下一轮任务**即生效，无需重启。

### 在 profile 里改

`cordis.patch.yml`：

```yaml
- id: wecom-notify
  name: dsh-wecom-notify
  config:
    webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…'
    enabled: true
    format: markdown
    mentionAll: false
    includeContent: true
    notifyFailures: true
    notifySubagents: false
    settleMs: 800
    timeoutMs: 10000
    maxAttempts: 3
    retryDelayMs: 1000
    minIntervalMs: 300
```

调优项（`settleMs` / `timeoutMs` / `maxAttempts` / `retryDelayMs` / `minIntervalMs`）
不进浏览器表单，只从配置文件和 schema 默认值读取。

### 环境变量

| 变量 | 作用 |
| --- | --- |
| `WECOM_WEBHOOK_URL` | `webhookUrl` 为空时的回落值（适合只把凭据放 shell 里） |
| `WECOM_NOTIFY_FORMAT` | `markdown` / `text` |
| `WECOM_NOTIFY_ENABLED` | `1/true/yes/on` 为开 |
| `WECOM_NOTIFY_MENTION_ALL` | 纯文本 @所有人 |
| `WECOM_NOTIFY_INCLUDE_CONTENT` | 是否附带正文 |
| `WECOM_NOTIFY_FAILURES` | 失败也推 |
| `WECOM_NOTIFY_SUBAGENTS` | 子代理也推 |

## 企业微信的限制

- `text` 消息 content ≤ **2048 字节**，`markdown` ≤ **4096 字节**，且按 **UTF-8 字节**
  计算（一个汉字 3 字节）。插件按字节截断，并优先压缩「需求」、给「结果」留空间，
  截断处标 `…（已截断）`。
- 每个机器人 **20 条/分钟**。插件串行发送并保持 `minIntervalMs` 间隔；遇到
  `45009` 会退避重试。
- Markdown 不支持 `mentioned_list`；要 `@所有人` 请把格式切成 `text`。

## 本地验证

```sh
cd dsh-wecom-notify
npm test          # 66 个离线用例：事件解析 / 合并窗口 / 字节截断 / 重试 / 插件接线
npm run check     # 语法检查

# 往真实群机器人发一条示例通知（会真的发消息）
node scripts/live-check.mjs 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…'
```

## 目录

```
dsh-wecom-notify/
├── package.json          # dsh.bundle.patch + dsh.client（web）
├── cordis.patch.yml      # 默认配置（含给出的 Webhook 地址）
├── index.js              # Host 插件：监听 session/event，调度与发送
├── client.js             # 浏览器端：插件配置页
├── src/
│   ├── config.js         # 解引用 volatile 字段 + 夹取范围
│   ├── events.js         # 从 SessionEvent / stream 抽取文本
│   ├── tracker.js        # 按会话折叠 turn → 通知窗口
│   ├── format.js         # 渲染 markdown/text，按字节截断
│   ├── webhook.js        # 串行队列 + 超时 + 退避重试
│   └── schema.js         # Config schema（volatile 字段 = 可编辑表单）
├── locale/{zh,en}.json   # 插件标题 / 描述
├── icon.svg              # 插件图标
├── scripts/live-check.mjs
└── test/                 # node:test，全离线
```

## 实现要点

- **触发**：`session/event` 是 post-commit 的追加流，`turn/end` 是 durable 的
  「本轮结束」信号；`assistant/message` 的 `stream`（增量）与 `message.content`
  （定稿）是同一份文本的两种投影，按 step 去重后拼接。
- **不读 `agent/status`**：目标续跑会在两轮之间把状态压回 idle，按状态推会重复刷屏；
  durable 的 `turn/end` + settle 窗口才是「任务」的边界。
- **volatile 字段是活引用**：`{ get() }` 指向当前配置，插件在每次使用时解引用，
  所以浏览器里改完立即生效。`src/config.js` 用鸭子类型判断，不硬依赖 cosmokit。
- **配置表单**通过 `plugins.row.config` 槽注册，key 是 `<包名>#<行 id>`
  （`dsh-wecom-notify#wecom-notify`）；读写走宿主注入的 `form.state` / `form.mutate`。
