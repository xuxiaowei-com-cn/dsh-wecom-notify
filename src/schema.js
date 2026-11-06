/**
 * 插件 Config schema。
 *
 * 带 `.volatile()` 的字段会被 DSH 的 settings 服务投影成浏览器表单
 * （`configForms.describe()`），Web 侧栏「插件」页 → 本包 → 配置 里可改，
 * 保存后写回该 profile 的 Cordis patch，**无需重启**。
 *
 * 这些字段在运行时是**活引用**（`{ get() }`），插件必须在每次使用时解引用
 * （见 `config.js` 的 `unwrap`），不能在 apply 时把值拷走。
 *
 * 刻意只把「用户会想改」的字段设为 volatile；超时 / 重试 / 节流这类调优项
 * 留在配置文件里，避免把表单撑成运维面板。
 *
 * @param {object} Schema `@deepseek-ai/schemastery` 的默认导出
 * @returns {object} Config schema
 */
export function createConfigSchema(Schema) {
  return Schema.object({
    webhookUrl: Schema.string()
      .default('')
      .volatile()
      .description('企业微信群机器人 Webhook 地址（群设置 → 群机器人 → 添加 → 复制地址）；留空时回落到环境变量 WECOM_WEBHOOK_URL'),

    enabled: Schema.boolean()
      .default(true)
      .volatile()
      .description('关闭后不再推送（仍保留已配置的地址）'),

    format: Schema.union(['markdown', 'text'])
      .default('markdown')
      .volatile()
      .description('markdown：支持标题/引用/加粗（4096 字节）；text：纯文本（2048 字节，可 @所有人）'),

    mentionAll: Schema.boolean()
      .default(false)
      .volatile()
      .description('仅 text 格式生效：附带的 mentioned_list 为 @all'),

    includeContent: Schema.boolean()
      .default(true)
      .volatile()
      .description('是否附带需求与结果正文（关闭后只发会话/轮次/用时等摘要）'),

    notifyFailures: Schema.boolean()
      .default(true)
      .volatile()
      .description('失败、被阻止、中断、Token 耗尽等非正常结束也推送'),

    notifySubagents: Schema.boolean()
      .default(false)
      .volatile()
      .description('子代理会话（subagent）结束时也推送；默认只推主会话'),

    settleMs: Schema.number()
      .default(800)
      .min(0)
      .max(10000)
      .step(100)
      .description('turn/end 后等待多久再发：把紧接着开始的下一轮合并成一次通知'),

    timeoutMs: Schema.number()
      .default(10000)
      .min(1000)
      .max(60000)
      .step(1000)
      .description('单次 Webhook 请求超时（毫秒）'),

    maxAttempts: Schema.number()
      .default(3)
      .min(1)
      .max(5)
      .step(1)
      .description('发送失败时的最大尝试次数（含首次）'),

    retryDelayMs: Schema.number()
      .default(1000)
      .min(100)
      .max(30000)
      .step(100)
      .description('重试的基础退避时间（毫秒），按 1×、2×、4× 递增'),

    minIntervalMs: Schema.number()
      .default(300)
      .min(0)
      .max(5000)
      .step(100)
      .description('两次发送之间的最小间隔（毫秒），避免短时间连续刷屏'),
  });
}
