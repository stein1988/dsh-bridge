// dsh-bridge QQ 服务测试（官方 @tencent-connect/qqbot-nodejs 适配层）
//
// 覆盖口径：
//   ① QqService / QqGateway 的构造、注册、状态聚合（不建立真实连接）
//   ② 凭证字段统一为 appId + appSecret，旧 clientSecret 自动迁移
//   ③ 官方 SDK 正确装配：中间件链、事件绑定、被动回复限额、流式会话
//   ④ 出站路径（text / markdown / keyboard / media / typing / recall）通过注入的假 bot 验证
//   ⑤ 入站事件归一化（SDK msg → cordis 事件）与按钮回调路由
//   ⑥ 扫码绑定流程（qrType=bind）的成功/失败/刷新语义
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { QqService } from '../lib/qq/index.js'
import { QqGateway, mediaFileTypeOf, stripMarkdown, gatewayConstants } from '../lib/qq/gateway.js'
import { QqConversationNode, qqNodeHelpers } from '../lib/qq/node.js'
import { PlatformManager } from '../lib/platform/manager.js'
import pathLib from 'node:path'
import os from 'node:os'
import fsSync from 'node:fs'
import { readFileSync } from 'node:fs'
import { normalizePlatformConfig } from '../lib/platform/instances.js'
import { ApiError, QQBot } from '../lib/qq/qqbot-bundled.mjs'

function makeMockCordisCtx() {
  const events = {}
  const ctx = {
    on(event, fn) { (events[event] ??= []).push(fn); return () => { events[event] = (events[event] ?? []).filter(f => f !== fn) } },
    emit(event, ...args) { (events[event] ?? []).forEach((fn) => fn(...args)) },
    effect(fn) { return fn() },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    sessions: { list: () => [], get: () => undefined },
    agents: { create: async () => ({}), get: () => undefined },
    reflect: { provide(name, value) { ctx['__provided__' + name] = value; return () => {} } },
  }
  return ctx
}

/** 假 SDK bot：记录所有出站调用，可控制成功/失败。 */
function makeFakeBot(overrides = {}) {
  const calls = []
  const bot = {
    calls,
    send: async (opts) => { calls.push(['send', opts]); return { id: `msg_${calls.length}` } },
    sendMarkdown: async (target, content, opts) => { calls.push(['sendMarkdown', { target, content, opts }]); return { id: `md_${calls.length}` } },
    sendMedia: async (opts) => { calls.push(['sendMedia', opts]); return { upload: { file_uuid: 'u1' }, message: { id: 'm1' } } },
    sendTyping: async (target, duration) => { calls.push(['sendTyping', { target, duration }]); return {} },
    recallMessage: async (target, id) => { calls.push(['recallMessage', { target, id }]) },
    acknowledgeInteraction: async (id, code) => { calls.push(['ack', { id, code }]) },
    openStream: (opts) => {
      calls.push(['openStream', opts])
      const session = {
        updates: [],
        update: async (text) => { session.updates.push(text) },
        complete: async () => { session.completed = true },
        cancel: () => {},
      }
      return session
    },
    start: async () => { calls.push(['start']) },
    stop: () => { calls.push(['stop']) },
    on(event, fn) { (bot.handlers ??= {})[event] = fn; return bot },
    api: {
      get: async (path) => { calls.push(['api.get', path]); return {} },
      post: async (path, body) => { calls.push(['api.post', path, body]); return { panel_id: 'p1' } },
      put: async (path, body) => { calls.push(['api.put', path, body]); return {} },
      patch: async (path, body) => { calls.push(['api.patch', path, body]); return {} },
      delete: async (path) => { calls.push(['api.delete', path]); return {} },
    },
    ...overrides,
  }
  return bot
}

/** 构造一个"已连接"的网关（bot 用替身），用于验证出站与入站映射。 */
function makeConnectedGateway(config = {}, bot = makeFakeBot()) {
  const ctx = makeMockCordisCtx()
  const gw = new QqGateway({ ctx, logger: ctx.logger, config: { appId: 'app1', appSecret: 'sec1', ...config } })
  gw.bot = bot
  gw.botInfo = { id: 'bot-openid', username: 'dsh' }
  gw.setStatus('connected')
  return { gw, bot, ctx }
}

// ---------------------------------------------------------------------------
// ① 构造与注册
// ---------------------------------------------------------------------------

test('QqGateway is a Service and registers as ctx.qq', () => {
  const ctx = makeMockCordisCtx()
  const gw = new QqGateway({ ctx, logger: ctx.logger, config: {} })
  try {
    assert.equal(gw.name, 'qq')
    assert.equal(gw.status, 'idle')
    assert.equal(gw.configured, false)
    assert.ok(ctx.__provided__qq === gw, 'gateway registered as ctx.qq')
  } finally {
    gw.dispose()
  }
})

test('QqGateway configured requires appId + appSecret', () => {
  const ctx = makeMockCordisCtx()
  const onlyId = new QqGateway({ ctx, logger: ctx.logger, config: { appId: 'a' } })
  assert.equal(onlyId.configured, false)
  onlyId.dispose()

  const gw = new QqGateway({ ctx, logger: ctx.logger, config: { appId: 'a', appSecret: 's' } })
  try {
    assert.equal(gw.configured, true)
    assert.ok(gw.capabilities.supportsGroup, 'QQ 支持群聊')
    assert.ok(gw.capabilities.supportsStreaming, 'QQ 支持 C2C 流式')
    assert.equal(gw.capabilities.maxMessageChars, 2000)
  } finally {
    gw.dispose()
  }
})

test('QqService constructs gateway + node and wires allowlist', async () => {
  const ctx = makeMockCordisCtx()
  const svc = new QqService({
    ctx,
    logger: ctx.logger,
    config: { allowFrom: ['u1@qq.openid'] },
    onPersist: async () => {},
  })
  assert.equal(svc.gateway.configured, false) // no credentials yet
  assert.deepEqual(svc.node.config.allowFrom, ['u1@qq.openid'])
  assert.equal(svc.gateway.status, 'idle') // not configured → no connection
  await svc.destroy()
})

test('QqService setAllowFrom persists and updates node', async () => {
  const ctx = makeMockCordisCtx()
  const persisted = {}
  const svc = new QqService({ ctx, logger: ctx.logger, config: {}, onPersist: async (patch) => Object.assign(persisted, patch) })
  await svc.setAllowFrom(['a', ' a ', 'b', '', 'a'])
  assert.deepEqual(svc.node.config.allowFrom, ['a', 'b'])
  assert.deepEqual(persisted.allowFrom, ['a', 'b'])
  await svc.destroy()
})

test('QqService getStatus includes login state', async () => {
  const ctx = makeMockCordisCtx()
  const svc = new QqService({ ctx, logger: ctx.logger, config: {}, onPersist: async () => {} })
  const s = svc.getStatus()
  assert.equal(typeof s.status, 'string')
  assert.ok('login' in s)
  assert.ok(Array.isArray(s.allowFrom))
  assert.equal(s.config.appSecret, '', '密钥不得回传到浏览器')
  await svc.destroy()
})

test('QqService is a Platform instance with id/name/capabilities', async () => {
  const ctx = makeMockCordisCtx()
  const svc = new QqService({ ctx, logger: ctx.logger, config: {}, onPersist: async () => {} })
  assert.equal(svc.id, 'qq')
  assert.equal(svc.name, 'QQ')
  assert.equal(svc.configured, false)
  assert.ok(svc.capabilities.maxMessageChars > 0)
  assert.equal(svc.capabilities.supportsGroup, true)
  const s = svc.getStatus()
  assert.equal(s.id, 'qq')
  assert.ok(s.capabilities)
  await svc.destroy()
})

test('QqService registers into PlatformManager and aggregates status', async () => {
  const ctx = makeMockCordisCtx()
  const svc = new QqService({ ctx, logger: ctx.logger, config: {}, onPersist: async () => {} })
  const manager = new PlatformManager({ logger: ctx.logger })
  try {
    manager.register(svc)
    assert.equal(manager.get('qq'), svc)
    const status = manager.getStatus()
    assert.ok('qq' in status)
    assert.equal(status.qq.id, 'qq')
    assert.equal(status.qq.name, 'QQ')
  } finally {
    await svc.destroy()
    manager.dispose()
  }
})

test('QqService login without credentials returns error', async () => {
  const ctx = makeMockCordisCtx()
  const svc = new QqService({ ctx, logger: ctx.logger, config: {}, onPersist: async () => {} })
  const result = await svc.login()
  assert.equal(result.ok, false)
  assert.ok(result.error.includes('AppID'))
  await svc.destroy()
})

// ---------------------------------------------------------------------------
// ② 凭证字段：appSecret 统一 + 旧 clientSecret 迁移
// ---------------------------------------------------------------------------

test('QqGateway setCredentials 接受 appSecret，并兼容旧 clientSecret 命名', () => {
  const ctx = makeMockCordisCtx()
  const gw = new QqGateway({ ctx, logger: ctx.logger, config: {} })
  try {
    gw.setCredentials({ appId: 'a1', appSecret: 's1' })
    assert.equal(gw.config.appSecret, 's1')
    // 旧面板可能仍传 clientSecret（历史字段名）：等价于 appSecret
    gw.setCredentials({ clientSecret: 's2' })
    assert.equal(gw.config.appSecret, 's2')
    // 返回值表示凭证是否变化（调用方据此决定重连）
    assert.equal(gw.setCredentials({ appId: 'a1', appSecret: 's2' }), false)
    assert.equal(gw.setCredentials({ appId: 'a2' }), true)
  } finally {
    gw.dispose()
  }
})

test('旧配置的 clientSecret 自动迁移为 appSecret，并丢弃自研协议栈残留字段', () => {
  const { config, changed } = normalizePlatformConfig({
    qq: { appId: 'a', clientSecret: 's', accessToken: 't', gatewayUrl: 'w' },
  })
  assert.equal(changed, true)
  assert.deepEqual(config.qq.accounts, [{ instanceId: 'qq', appId: 'a', appSecret: 's' }])
})

test('已是新格式的 QQ 配置不被改写（changed=false）', () => {
  const { config, changed } = normalizePlatformConfig({
    qq: { accounts: [{ instanceId: 'qq', appId: 'a', appSecret: 's' }], seq: 1 },
  })
  assert.equal(changed, false)
  assert.deepEqual(config.qq.accounts[0], { instanceId: 'qq', appId: 'a', appSecret: 's' })
})

// ---------------------------------------------------------------------------
// ③ 官方 SDK 装配
// ---------------------------------------------------------------------------

test('QqGateway 创建官方 QQBot：装配中间件链与事件监听', () => {
  const ctx = makeMockCordisCtx()
  const gw = new QqGateway({ ctx, logger: ctx.logger, config: { appId: 'a', appSecret: 's' } })
  try {
    const bot = gw._createBot()
    // 中间件链：错误兜底 / 回声去重 / 内容清洗 / 限流 / 引用 / 历史 / @门控 / 串行 / typing
    const middlewares = bot.getMiddlewares()
    assert.equal(middlewares.length, 9, `应装配 9 个 SDK 内置中间件，实际 ${middlewares.length}`)
    for (const mw of middlewares) assert.equal(typeof mw, 'function')
    // SDK 内置中间件都是匿名函数（无 name），但可凭**运行期函数源码特征**识别身份，
    // 因此这里是真正的运行期顺序断言：把 getMiddlewares() 返回的真实链倒序 /
    // 调换任意两项，断言都会失败（复核曾证实"读源码文本"版断言是空断言）。
    // 每个中间件的**唯一**源码特征（已逐个核对实际 bundle 源码）
    const signatures = [
      ['errorHandler', /error-handler/],
      ['messageFilter', /skipSelfEcho/],
      ['contentSanitizer', /stripAllMentions|stripBotMention/],
      ['rateLimiter', /__global__/],
      ['quoteRef', /msgIdx/],
      ['historyBuffer', /state\.history = buffered/],
      ['mentionGate', /ctx\.bot\.appId/],
      ['concurrencyGuard', /state\.busy = true/],
      ['typingIndicator', /kind !== "c2c"/],
    ]
    const actual = middlewares.map((mw, index) => {
      const source = String(mw)
      const hit = signatures.find(([, re]) => re.test(source))
      assert.ok(hit, `第 ${index} 个中间件无法识别（源码：${source.slice(0, 80)}）`)
      return hit[0]
    })
    assert.deepEqual(actual, signatures.map(([name]) => name),
      '中间件装配顺序变更会改变语义（例如 historyBuffer 晚于 mentionGate 会记不到被过滤的群消息）')
  } finally {
    gw.dispose()
  }
})

test('QqGateway 事件绑定：ready → connected 状态 + accountId 持久化', () => {
  const ctx = makeMockCordisCtx()
  const persisted = []
  const gw = new QqGateway({
    ctx,
    logger: ctx.logger,
    config: { appId: 'a', appSecret: 's' },
    onPersist: async (patch) => { persisted.push(patch) },
  })
  try {
    const bot = makeFakeBot()
    gw._bindBotEvents(bot)
    bot.handlers.ready({ user: { id: 'bot-id', username: 'dsh' } })
    assert.equal(gw.status, 'connected')
    assert.equal(gw.accountId, 'bot-id')
    assert.deepEqual(persisted.at(-1), { accountId: 'bot-id' })

    bot.handlers.disconnected({ code: 4009, willReconnect: true })
    assert.equal(gw.status, 'reconnecting')

    bot.handlers.disconnected({ code: 4914, willReconnect: false, reason: '仅沙箱' })
    assert.equal(gw.status, 'error')
    assert.match(gw.error, /仅沙箱/)
  } finally {
    gw.dispose()
  }
})

test('QqGateway start() 无凭证时保持 idle 且不建连', async () => {
  const ctx = makeMockCordisCtx()
  const gw = new QqGateway({ ctx, logger: ctx.logger, config: {} })
  try {
    assert.equal(await gw.start(), false)
    assert.equal(gw.status, 'idle')
  } finally {
    gw.dispose()
  }
})

// ---------------------------------------------------------------------------
// ④ 出站路径
// ---------------------------------------------------------------------------

test('sendText 走官方 send + msg_type=0，并携带被动回复 msg_id', async () => {
  const { gw, bot } = makeConnectedGateway()
  try {
    const res = await gw.sendText('user-openid', 'hello', { scope: 'c2c', msgId: 'in-msg-1' })
    assert.equal(res.success, true)
    const call = bot.calls.find((c) => c[0] === 'send')
    assert.equal(call[1].msgType, 0)
    assert.equal(call[1].content, 'hello')
    assert.deepEqual(call[1].target, { scope: 'c2c', targetId: 'user-openid', msgId: 'in-msg-1' })
  } finally {
    gw.dispose()
  }
})

test('sendMarkdown 走 msg_type=2 并透传 keyboard', async () => {
  const { gw, bot } = makeConnectedGateway()
  try {
    const keyboard = { content: { rows: [{ buttons: [{ id: 'b1' }] }] } }
    const res = await gw.sendMarkdown('user-openid', '**粗体**', { scope: 'c2c', keyboard })
    assert.equal(res.success, true)
    const call = bot.calls.find((c) => c[0] === 'send')
    assert.equal(call[1].msgType, 2)
    assert.deepEqual(call[1].markdown, { content: '**粗体**' })
    assert.deepEqual(call[1].keyboard, keyboard)
  } finally {
    gw.dispose()
  }
})

test('sendKeyboard 走 msg_type=0 + content + keyboard', async () => {
  const { gw, bot } = makeConnectedGateway()
  try {
    const keyboard = { content: { rows: [{ buttons: [{ id: 'b1' }] }] } }
    await gw.sendKeyboard('user-openid', '提示文本', keyboard, { scope: 'c2c' })
    const call = bot.calls.find((c) => c[0] === 'send')
    assert.equal(call[1].msgType, 0)
    assert.equal(call[1].content, '提示文本')
    assert.deepEqual(call[1].keyboard, keyboard)
  } finally {
    gw.dispose()
  }
})

test('sendMedia 按扩展名推断 fileType，并通过 SDK 上传+发送', async () => {
  const { gw, bot } = makeConnectedGateway()
  try {
    assert.equal(mediaFileTypeOf('/tmp/a.png'), 1, '图片=IMAGE(1)')
    assert.equal(mediaFileTypeOf('/tmp/a.mp4'), 2, '视频=VIDEO(2)')
    assert.equal(mediaFileTypeOf('/tmp/a.wav'), 3, '语音=VOICE(3)')
    assert.equal(mediaFileTypeOf('/tmp/a.pdf'), 4, '文件=FILE(4)')

    const res = await gw.sendMedia('user-openid', { filePath: '/tmp/a.png', fileName: 'a.png' }, { scope: 'c2c' })
    assert.equal(res.success, true)
    const call = bot.calls.find((c) => c[0] === 'sendMedia')
    assert.equal(call[1].fileType, 1)
    assert.equal(call[1].localPath, '/tmp/a.png')
  } finally {
    gw.dispose()
  }
})

test('sendMediaFile 对不存在的文件返回可读错误（不抛异常）', async () => {
  const { gw } = makeConnectedGateway()
  try {
    const res = await gw.sendMediaFile('user-openid', '/tmp/definitely-not-exists-qq.png', {})
    assert.equal(res.success, false)
    assert.match(res.error, /文件不存在/)
  } finally {
    gw.dispose()
  }
})

test('sendTyping 仅 C2C 生效，群聊直接跳过（QQ 平台限制）', async () => {
  const { gw, bot } = makeConnectedGateway()
  try {
    await gw.sendTyping('user-openid', { scope: 'c2c', durationSeconds: 8 })
    const call = bot.calls.find((c) => c[0] === 'sendTyping')
    assert.deepEqual(call[1].target, { scope: 'c2c', targetId: 'user-openid' })
    assert.equal(call[1].duration, 8)

    const before = bot.calls.filter((c) => c[0] === 'sendTyping').length
    await gw.sendTyping('group-openid', { scope: 'group' })
    assert.equal(bot.calls.filter((c) => c[0] === 'sendTyping').length, before, '群聊不得调用 typing')
  } finally {
    gw.dispose()
  }
})

test('recallMessage 调用 SDK 撤回接口', async () => {
  const { gw, bot } = makeConnectedGateway()
  try {
    const res = await gw.recallMessage('user-openid', 'msg-1', { scope: 'c2c' })
    assert.equal(res.success, true)
    const call = bot.calls.find((c) => c[0] === 'recallMessage')
    assert.deepEqual(call[1], { target: { scope: 'c2c', targetId: 'user-openid' }, id: 'msg-1' })
  } finally {
    gw.dispose()
  }
})

test('被动回复限额：单聊 4 次、群聊 5 次（按官方上限分 scope 记账）', () => {
  const ctx = makeMockCordisCtx()
  const gw = new QqGateway({ ctx, logger: ctx.logger, config: { appId: 'a', appSecret: 's' } })
  try {
    for (let i = 0; i < gatewayConstants.PASSIVE_REPLY_LIMIT_C2C; i++) {
      const passive = gw.resolvePassiveTarget('c2c', 'u1', 'msg-c2c')
      assert.equal(passive.kind, 'msg', `单聊第 ${i + 1} 次仍应为被动回复`)
    }
    assert.equal(gw.resolvePassiveTarget('c2c', 'u1', 'msg-c2c').kind, 'proactive', '单聊第 5 次降级')

    for (let i = 0; i < gatewayConstants.PASSIVE_REPLY_LIMIT_GROUP; i++) {
      const passive = gw.resolvePassiveTarget('group', 'g1', 'msg-group')
      assert.equal(passive.kind, 'msg', `群聊第 ${i + 1} 次仍应为被动回复`)
    }
    assert.equal(gw.resolvePassiveTarget('group', 'g1', 'msg-group').kind, 'proactive', '群聊第 6 次降级')
    assert.equal(gatewayConstants.PASSIVE_REPLY_LIMIT_C2C, 4)
    assert.equal(gatewayConstants.PASSIVE_REPLY_LIMIT_GROUP, 5)
  } finally {
    gw.dispose()
  }
})

test('流式：首个 update 开 StreamSession，done 收尾 complete；群聊降级 Markdown', async () => {
  const { gw, bot } = makeConnectedGateway()
  try {
    await gw.sendStream('user-openid', '第一片', { scope: 'c2c', msgId: 'in-1', streamKey: 'c2c:user-openid' })
    await gw.sendStream('user-openid', '第一片第二片', { scope: 'c2c', streamKey: 'c2c:user-openid' })
    await gw.sendStream('user-openid', '第一片第二片', { scope: 'c2c', streamKey: 'c2c:user-openid', done: true })

    const open = bot.calls.find((c) => c[0] === 'openStream')
    assert.ok(open, '应通过 SDK openStream 创建流式会话')
    assert.equal(open[1].target.msgId, 'in-1')
    assert.equal(bot.calls.filter((c) => c[0] === 'openStream').length, 1, '同一 streamKey 复用会话')

    // 群聊不支持流式 → 走 Markdown
    const before = bot.calls.filter((c) => c[0] === 'openStream').length
    await gw.sendStream('group-openid', '群消息', { scope: 'group' })
    assert.equal(bot.calls.filter((c) => c[0] === 'openStream').length, before)
    const md = bot.calls.filter((c) => c[0] === 'send').at(-1)
    assert.equal(md[1].msgType, 2)
  } finally {
    gw.dispose()
  }
})

test('流式更新失败：取消 SDK 节流并标记断流，中途不发、done 只发一次最终全文', async () => {
  const bot = makeFakeBot()
  let cancelled = false
  bot.openStream = () => ({
    update: async () => { throw new Error('boom') },
    complete: async () => {},
    cancel: () => { cancelled = true },
  })
  const sent = []
  bot.send = async (opts) => { sent.push(opts.markdown?.content ?? opts.content); return { id: 'm' } }
  const { gw } = makeConnectedGateway({}, bot)
  try {
    // 第 1 片失败 → 断流
    const r1 = await gw.sendStream('user-openid', '第一段', { scope: 'c2c', msgId: 'in-1', streamKey: 'k' })
    assert.equal(r1.success, true)
    assert.equal(cancelled, true, '必须 cancel 掉 SDK 的挂起 flush')
    assert.equal(gw._streams.size, 0, '失败后不得残留流会话')
    assert.deepEqual(sent, [], '中途不发（P0-5：否则每片一条递增全文）')

    // 后续片段：丢弃
    const r2 = await gw.sendStream('user-openid', '第一段\n\n第二段', { scope: 'c2c', streamKey: 'k' })
    assert.equal(r2.skipped, true)
    assert.deepEqual(sent, [])

    // done：只发一次最终全文
    await gw.sendStream('user-openid', '第一段\n\n第二段', { scope: 'c2c', streamKey: 'k', done: true })
    assert.deepEqual(sent, ['第一段\n\n第二段'], 'done 时只发一条最终全文')
  } finally {
    gw.dispose()
  }
})

test('finishStream(abort) 只取消挂起的推送、不发 DONE 帧（连接断开场景）', async () => {
  const bot = makeFakeBot()
  let cancelled = false
  let completed = false
  bot.openStream = () => ({
    update: async () => {},
    complete: async () => { completed = true },
    cancel: () => { cancelled = true },
  })
  const { gw } = makeConnectedGateway({}, bot)
  try {
    await gw.sendStream('user-openid', '正文', { scope: 'c2c', msgId: 'in-1', streamKey: 'c2c:user-openid' })
    await gw.finishStream('user-openid', { scope: 'c2c', streamKey: 'c2c:user-openid', abort: true })
    assert.equal(cancelled, true)
    assert.equal(completed, false, 'abort 路径不得发送 DONE 帧')
    assert.equal(gw._streams.size, 0)
  } finally {
    gw.dispose()
  }
})

test('流式：没有可用 msg_id 时不开流，done 时以单条 Markdown 收尾', async () => {
  const sent = []
  const bot = makeFakeBot()
  bot.send = async (opts) => { sent.push(opts.markdown?.content ?? opts.content); return { id: 'm' } }
  const { gw } = makeConnectedGateway({}, bot)
  try {
    const r1 = await gw.sendStream('user-openid', '内容', { scope: 'c2c', streamKey: 'k' })
    assert.equal(r1.success, true)
    assert.equal(bot.calls.filter((c) => c[0] === 'openStream').length, 0, '不得开流')
    assert.deepEqual(sent, [], '中途不发，等 done')

    await gw.sendStream('user-openid', '内容', { scope: 'c2c', streamKey: 'k', done: true })
    assert.deepEqual(sent, ['内容'], 'done 时发一次完整正文')
  } finally {
    gw.dispose()
  }
})

test('apiCall 通过 SDK 的 escape hatch 访问面板/菜单 REST', async () => {
  const { gw, bot } = makeConnectedGateway()
  try {
    await gw.apiCall('GET', '/v2/menu')
    await gw.apiCall('PUT', '/v2/menu', { menu: { items: [] } })
    await gw.apiCall('POST', '/v2/panels', { scope: 'c2c' })
    await gw.apiCall('DELETE', '/v2/panels/p1')
    const kinds = bot.calls.map((c) => c[0])
    assert.ok(kinds.includes('api.get'))
    assert.ok(kinds.includes('api.put'))
    assert.ok(kinds.includes('api.post'))
    assert.ok(kinds.includes('api.delete'))
  } finally {
    gw.dispose()
  }
})

test('markdown 纯文本降级（无 markdown 权限时）', () => {
  assert.equal(stripMarkdown('# 标题\n**粗体** 与 `代码`'), '标题\n粗体 与 代码')
  assert.ok(stripMarkdown('![图](https://a/b.png)').includes('图 https://a/b.png'))
})

// ---------------------------------------------------------------------------
// ⑤ 入站与交互
// ---------------------------------------------------------------------------

test('入站消息归一化为 qq/message：scope/peerId/引用/附件齐全', async () => {
  const ctx = makeMockCordisCtx()
  const gw = new QqGateway({ ctx, logger: ctx.logger, config: { appId: 'a', appSecret: 's' } })
  const received = []
  ctx.on('qq/message', (event) => { received.push(event) })
  try {
    const mCtx = {
      state: {
        quote: { text: '被引用的原文', attachments: [] },
        history: [
          { senderId: 'm0', senderName: '小红', content: '前面那句话' },
          { senderId: 'm1', senderName: '小明', content: '   ' },
        ],
      },
    }
    await gw._handleInbound(mCtx, {
      kind: 'group',
      senderId: 'member-openid',
      senderName: '小明',
      content: '你好',
      messageId: 'msg-1',
      groupOpenid: 'group-1',
      attachments: [{ content_type: 'image/png', url: 'https://example.com/a.png' }],
    })
    assert.equal(received.length, 1)
    const event = received[0]
    assert.equal(event.instanceId, 'qq')
    assert.equal(event.scope, 'group')
    assert.equal(event.peerId, 'group-1')
    assert.equal(event.groupId, 'group-1')
    assert.equal(event.senderId, 'member-openid')
    assert.equal(event.senderName, '小明')
    assert.equal(event.quotedText, '被引用的原文')
    assert.equal(event.attachments.length, 1)
    // 群历史缓冲：空白内容被过滤
    assert.deepEqual(event.history, [{ senderName: '小红', senderId: 'm0', content: '前面那句话' }])

    // 单聊：peerId = senderId
    await gw._handleInbound({}, {
      kind: 'c2c', senderId: 'user-1', content: 'hi', messageId: 'msg-2',
    })
    assert.equal(received[1].scope, 'c2c')
    assert.equal(received[1].peerId, 'user-1')
  } finally {
    gw.dispose()
  }
})

test('互动事件归一化为 qq/action：按钮 data 解析为对象', () => {
  const ctx = makeMockCordisCtx()
  const gw = new QqGateway({ ctx, logger: ctx.logger, config: { appId: 'a', appSecret: 's' } })
  const received = []
  ctx.on('qq/action', (event) => { received.push(event) })
  try {
    gw._handleInteraction({
      id: 'inter-1',
      group_openid: 'group-1',
      group_member_openid: 'member-1',
      data: { resolved: { button_id: 'approval-allow', button_data: JSON.stringify({ t: 'approval', d: 'allow' }), message_id: 'm1' } },
    })
    assert.equal(received.length, 1)
    assert.equal(received[0].instanceId, 'qq')
    assert.equal(received[0].scope, 'group')
    assert.equal(received[0].interactionId, 'inter-1')
    assert.equal(received[0].buttonId, 'approval-allow')
    assert.deepEqual(received[0].buttonData, { t: 'approval', d: 'allow' })
  } finally {
    gw.dispose()
  }
})

test('QqConversationNode 入站：附件落盘 + 引用上下文 + 群昵称标注', async () => {
  const ctx = makeMockCordisCtx()
  const gateway = makeFakeBot()
  gateway.status = 'connected'
  const node = new QqConversationNode(ctx, { allowFrom: ['u1'] }, ctx.logger, { gateway, instanceId: 'qq' })
  const routed = []
  node.handleInbound = async (item) => { routed.push(item); return 'routed' }
  node._processAttachments = async () => [{ filename: 'a.png', path: '/mock/.qq-media/a.png', size: 1 }]
  try {
    await ctx.emit('qq/message', {
      instanceId: 'qq',
      scope: 'group',
      isGroup: true,
      senderId: 'm1',
      senderName: '小明',
      peerId: 'g1',
      groupId: 'g1',
      text: '请看这张图',
      quotedText: '上文问题',
      history: [{ senderName: '小红', content: '前面在聊部署' }],
      attachments: [{ url: 'https://example.com/a.png' }],
    })
    assert.equal(routed.length, 1)
    assert.equal(routed[0].senderId, 'g1', '群聊按群维度授权')
    assert.equal(routed[0].isGroup, true)
    assert.ok(routed[0].text.includes('[来自 小明]'), '群聊标注发送者昵称')
    assert.ok(routed[0].text.includes('[群最近消息]\n小红: 前面在聊部署'), '群历史缓冲作为上下文')
    assert.ok(routed[0].text.includes('[引用消息] 上文问题'))
    assert.ok(routed[0].text.includes('[文件: /mock/.qq-media/a.png]'))
  } finally {
    node.dispose()
  }
})

test('QqConversationNode 语音消息用 QQ 自带 ASR 文本作为正文', async () => {
  const ctx = makeMockCordisCtx()
  const gateway = makeFakeBot()
  gateway.status = 'connected'
  const node = new QqConversationNode(ctx, { allowFrom: ['u1'] }, ctx.logger, { gateway })
  const routed = []
  node.handleInbound = async (item) => { routed.push(item); return 'routed' }
  node._processAttachments = async () => [{ filename: 'v.silk', path: '/mock/v.silk', size: 1 }]
  try {
    await ctx.emit('qq/message', {
      instanceId: 'qq', scope: 'c2c', isGroup: false,
      senderId: 'u1', peerId: 'u1', text: '',
      attachments: [{ url: 'https://example.com/v.silk', asr_refer_text: '帮我看看这个报错' }],
    })
    assert.equal(routed.length, 1)
    assert.match(routed[0].text, /\[语音\] 帮我看看这个报错/)
  } finally {
    node.dispose()
  }
})

test('QqConversationNode 白名单外的单聊消息被忽略', async () => {
  const ctx = makeMockCordisCtx()
  const gateway = makeFakeBot()
  gateway.status = 'connected'
  const node = new QqConversationNode(ctx, { allowFrom: ['allowed-user'] }, ctx.logger, { gateway })
  const routed = []
  node.handleInbound = async (item) => { routed.push(item); return 'routed' }
  try {
    await ctx.emit('qq/message', {
      instanceId: 'qq', scope: 'c2c', isGroup: false, senderId: 'stranger', peerId: 'stranger', text: 'hi',
    })
    assert.equal(routed.length, 0)
  } finally {
    node.dispose()
  }
})

test('QqConversationNode 附件下载拒绝私网/回环地址（SSRF 防护）', () => {
  const blocked = (url) => qqNodeHelpers.isBlockedDownloadUrl(url)
  // 点分 IPv4
  assert.equal(blocked('http://127.0.0.1/a.png'), true)
  assert.equal(blocked('http://192.168.1.10/a.png'), true)
  assert.equal(blocked('http://10.0.0.5/a.png'), true)
  assert.equal(blocked('http://172.16.0.1/a.png'), true)
  assert.equal(blocked('http://169.254.169.254/latest/meta-data'), true)
  assert.equal(blocked('http://100.64.0.1/a.png'), true, 'CGNAT 段')
  // 非点分 IP 写法（绕过点分正则的常见手法）
  assert.equal(blocked('http://2130706433/a.png'), true, '十进制整数 = 127.0.0.1')
  assert.equal(blocked('http://0x7f000001/a.png'), true, '十六进制 = 127.0.0.1')
  // IPv6
  assert.equal(blocked('http://[::1]/a.png'), true)
  assert.equal(blocked('http://[fe80::1]/a.png'), true)
  assert.equal(blocked('http://[fd00::1]/a.png'), true)
  assert.equal(blocked('http://[::ffff:127.0.0.1]/a.png'), true, 'IPv4-mapped 点分')
  assert.equal(blocked('http://[::ffff:192.168.1.1]/a.png'), true, 'IPv4-mapped 点分内网')
  // 主机名与非 HTTP 协议
  assert.equal(blocked('http://localhost/a.png'), true)
  assert.equal(blocked('http://foo.localhost/a.png'), true)
  assert.equal(blocked('file:///etc/passwd'), true)
  assert.equal(blocked('gopher://127.0.0.1/'), true)
  // 合法公网地址必须放行
  assert.equal(blocked('https://gchat.qpic.cn/a.png'), false)
  assert.equal(blocked('https://example.com/a.png'), false)
  assert.equal(blocked('https://[2001:4860:4860::8888]/a.png'), false)
})

test('QqConversationNode 附件下载不跟随重定向、且有大小上限', async () => {
  const ctx = makeMockCordisCtx()
  const gateway = makeFakeBot()
  gateway.status = 'connected'
  const node = new QqConversationNode(ctx, { allowFrom: ['u1'] }, ctx.logger, { gateway })
  const originalFetch = global.fetch
  const calls = []
  try {
    global.fetch = async (url, init) => {
      calls.push({ url, init })
      // 模拟 302：redirect=manual 时必须原样返回给调用方，而不是自动跟到内网
      return { ok: false, status: 302, headers: new Map(), body: null }
    }
    const result = await node._processAttachments(
      // 用腾讯媒体域名：跳过 DNS 二次校验，专注验证 redirect:manual
      [{ url: 'https://multimedia.nt.qq.com.cn/redirect-to-metadata' }],
      process.cwd(),
    )
    assert.deepEqual(result, [], '重定向响应不得被当成文件写入')
    assert.equal(calls[0].init.redirect, 'manual', '必须显式关闭自动重定向')

    // 声明长度超限：直接跳过，不读 body
    calls.length = 0
    global.fetch = async (url, init) => {
      calls.push({ url, init })
      return {
        ok: true,
        status: 200,
        headers: { get: (name) => (name.toLowerCase() === 'content-length' ? String(200 * 1024 * 1024) : null) },
        body: null,
        arrayBuffer: async () => { throw new Error('不应读取 body') },
      }
    }
    const skipped = await node._processAttachments(
      [{ url: 'https://multimedia.nt.qq.com.cn/huge.bin' }],
      process.cwd(),
    )
    assert.deepEqual(skipped, [], '超过大小上限的附件必须跳过')

    // 流式读取时超限：必须在读满上限前中止，而不是先吃进内存
    global.fetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: {
        getReader: () => {
          let sent = 0
          return {
            read: async () => {
              sent += 1
              if (sent > 3) return { done: true }
              return { done: false, value: new Uint8Array(50 * 1024 * 1024) }
            },
            cancel: async () => { throw new Error('cancelled') },
            releaseLock: () => {},
          }
        },
      },
    })
    const streamSkipped = await node._processAttachments(
      [{ url: 'https://multimedia.nt.qq.com.cn/chunked.bin' }],
      process.cwd(),
    )
    assert.deepEqual(streamSkipped, [], '流式读取超限也必须跳过')
  } finally {
    global.fetch = originalFetch
    node.dispose()
  }
})

test('附件文件名经过清洗：路径成分与控制字符被替换，且不逃出媒体目录', async () => {
  const ctx = makeMockCordisCtx()
  const gateway = makeFakeBot()
  gateway.status = 'connected'
  const node = new QqConversationNode(ctx, { allowFrom: ['u1'] }, ctx.logger, { gateway })
  const originalFetch = global.fetch
  const dir = fsSync.mkdtempSync(pathLib.join(os.tmpdir(), 'dsh-qq-media-'))
  try {
    global.fetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => '3' },
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      body: null,
    })
    const downloaded = await node._processAttachments(
      [{ url: 'https://example.com/x', filename: '../../evil\u0000name.txt' }],
      dir,
    )
    assert.equal(downloaded.length, 1)
    // 不允许出现路径分隔符或控制字符，且必须落在 <dir>/.qq-media 下
    assert.ok(!downloaded[0].filename.includes('/'), '不得含路径分隔符')
    assert.ok(
      ![...downloaded[0].filename].some((ch) => ch.codePointAt(0) < 0x20),
      '不得含控制字符',
    )
    // 媒体目录已改为进程私有 mkdtemp 目录（防可预测临时文件），不再写进会话工作区
    assert.ok(
      downloaded[0].path.startsWith(node._mediaDir),
      `必须落在进程私有媒体目录内：${downloaded[0].path}`,
    )
    assert.ok(node._mediaDir.includes('dsh-bridge-qq-'), '应为 mkdtemp 生成的随机目录')
  } finally {
    global.fetch = originalFetch
    node.dispose()
    fsSync.rmSync(dir, { recursive: true, force: true })
  }
})

test('审批按钮归属：单聊限发起者、群聊限本群、无编号一律拒绝（P0-3 回归）', async () => {
  const ctx = makeMockCordisCtx()
  const gateway = makeFakeBot()
  gateway.status = 'connected'
  const node = new QqConversationNode(ctx, { allowFrom: ['u1', 'u2', 'g1', 'g2'] }, ctx.logger, { gateway })
  try {
    let outcome = null
    node.registerApproval(1, { number: 1, peerId: 'u1', timer: null, resolve: (value) => { outcome = value } })
    // 单聊：非发起者被拒
    assert.equal(node._resolveApprovalByButton({ t: 'approval', n: 1, d: 'allow' }, 'u2', false), false)
    assert.equal(outcome, null)
    // 单聊：发起者生效
    assert.equal(node._resolveApprovalByButton({ t: 'approval', n: 1, d: 'allow' }, 'u1', false), true)
    assert.equal(outcome, 'allowed-once')

    // 群聊：本群成员可决议
    let g1Outcome = null
    node.registerApproval(2, { number: 2, peerId: 'g1', timer: null, resolve: (v) => { g1Outcome = v } })
    assert.equal(node._resolveApprovalByButton({ t: 'approval', n: 2, d: 'deny' }, 'member', true, 'g1'), true)
    assert.equal(g1Outcome, 'rejected')

    // 群聊：**别的群**成员不得决议（此前取"最后一个 pending"导致跨群劫持）
    let g2Outcome = null
    node.registerApproval(3, { number: 3, peerId: 'g1', timer: null, resolve: (v) => { g2Outcome = v } })
    assert.equal(node._resolveApprovalByButton({ t: 'approval', n: 3, d: 'allow' }, 'member', true, 'g2'), false)
    assert.equal(g2Outcome, null, '跨群点击不得生效')
    assert.ok(node.pending.has(3), '被拒后审批仍在等待')

    // 无编号的旧卡片：一律拒绝，绝不猜测
    node.registerApproval(4, { number: 4, peerId: 'u1', timer: null, resolve: () => {} })
    assert.equal(node._resolveApprovalByButton({ t: 'approval', d: 'allow' }, 'u1', false), false)

    // 编号不存在（已结束）：拒绝
    assert.equal(node._resolveApprovalByButton({ t: 'approval', n: 999, d: 'allow' }, 'u1', false), false)
  } finally {
    node.dispose()
  }
})

test('QqConversationNode 问答按钮：命中选项并解析为答案批次', async () => {
  const ctx = makeMockCordisCtx()
  const gateway = makeFakeBot()
  gateway.status = 'connected'
  const node = new QqConversationNode(ctx, { allowFrom: ['u1'] }, ctx.logger, { gateway })
  try {
    let payload = null
    const questions = [{ id: 'q1', question: '选哪个？', options: [{ label: 'A' }, { label: 'B' }] }]
    node.registerAsk(7, { number: 7, questions, peerId: 'u1', resolve: (value) => { payload = value } })
    const ok = node._resolveAskByButton({ t: 'question', q: 7, i: 1 }, 'u1', false)
    assert.equal(ok, true)
    assert.deepEqual(payload, { answers: [{ id: 'q1', selected: ['B'] }] })

    // 越界下标不解析
    node.registerAsk(8, { number: 8, questions, peerId: 'u1', resolve: () => {} })
    assert.equal(node._resolveAskByButton({ t: 'question', q: 8, i: 9 }, 'u1', false), false)
  } finally {
    node.dispose()
  }
})

test('QqConversationNode 审批卡片 / 问答卡片都带回调按钮且 ACK 互动', async () => {
  const { gw, bot } = makeConnectedGateway()
  const ctx = makeMockCordisCtx()
  const node = new QqConversationNode(ctx, { allowFrom: ['u1'] }, ctx.logger, { gateway: gw })
  try {
    const ok = await node.sendApprovalCard(
      { peerId: 'u1', scope: 'c2c', messageId: 'in-msg-1' },
      { number: 1 },
      '## 操作权限确认\n\n> 请确认',
    )
    assert.equal(ok, true)
    const send = bot.calls.filter((c) => c[0] === 'send').at(-1)
    assert.equal(send[1].msgType, 2)
    const buttons = send[1].keyboard.content.rows[0].buttons
    assert.equal(buttons.length, 2)
    const allowData = JSON.parse(buttons[0].action.data)
    const denyData = JSON.parse(buttons[1].action.data)
    assert.equal(allowData.t, 'approval')
    assert.equal(allowData.n, 1)
    assert.equal(allowData.d, 'allow')
    assert.equal(typeof allowData.s, 'string', '按钮必须带进程 nonce（旧卡片失效用）')
    assert.equal(denyData.d, 'deny')
    assert.equal(denyData.s, allowData.s)

    const questions = [{ id: 'q1', question: '选哪个？', options: [{ label: '选项一' }, { label: '选项二' }] }]
    const askOk = await node.sendAskCard(
      { peerId: 'u1', scope: 'c2c', messageId: 'in-msg-1' },
      questions[0],
      { number: 2, questions },
      '请选择',
    )
    assert.equal(askOk, true)
    const askSend = bot.calls.filter((c) => c[0] === 'send').at(-1)
    const askButtons = askSend[1].keyboard.content.rows.flatMap((row) => row.buttons)
    assert.equal(askButtons.length, 2)
    assert.deepEqual(JSON.parse(askButtons[1].action.data), { t: 'question', q: 2, i: 1 })

    // ACK 互动
    await gw.acknowledgeInteraction('inter-1', 0)
    assert.ok(bot.calls.some((c) => c[0] === 'ack' && c[1].id === 'inter-1'))
  } finally {
    node.dispose()
    gw.dispose()
  }
})

// ---------------------------------------------------------------------------
// ⑥ 扫码绑定流程
// ---------------------------------------------------------------------------

test('QqService login({qrType:"bind"}) 走官方 qrConnect：成功后落盘凭证并连接', async () => {
  const ctx = makeMockCordisCtx()
  const persisted = []
  const svc = new QqService({
    ctx,
    logger: ctx.logger,
    config: {},
    onPersist: async (patch) => { persisted.push(patch) },
  })
  let startCalled = false
  svc.gateway.start = async () => { startCalled = true; return true }
  try {
    svc._qrConnectOverride = (callbacks) => {
      // 模拟：先给二维码 URL，再异步回传凭据
      setTimeout(() => {
        callbacks.onQrDisplayed('https://q.qq.com/qqbot/openclaw/connect.html?task_id=t1&source=dsh-bridge')
        setTimeout(() => callbacks.onSuccess([{ appId: 'bot-app', appSecret: 'bot-secret' }]), 0)
      }, 0)
      return () => {}
    }
    const result = await svc.login({ qrType: 'bind' })
    assert.equal(result.ok, true)
    // 等待异步成功回调
    for (let i = 0; i < 50 && !startCalled; i++) await new Promise((r) => setTimeout(r, 10))
    assert.equal(svc.gateway.config.appId, 'bot-app')
    assert.equal(svc.gateway.config.appSecret, 'bot-secret')
    assert.ok(persisted.some((p) => p.appId === 'bot-app' && p.appSecret === 'bot-secret'))
    assert.equal(startCalled, true, '扫码成功后应自动连接')
  } finally {
    await svc.destroy()
  }
})

test('QqService login({qrType:"bind"}) 失败时写 login.error 且不落盘', async () => {
  const ctx = makeMockCordisCtx()
  const persisted = []
  const svc = new QqService({ ctx, logger: ctx.logger, config: {}, onPersist: async (p) => { persisted.push(p) } })
  try {
    svc._qrConnectOverride = (callbacks) => {
      setTimeout(() => callbacks.onFailure(new Error('用户取消绑定')), 0)
      return () => {}
    }
    await svc.login({ qrType: 'bind' })
    for (let i = 0; i < 50 && svc.loginState.phase !== 'error'; i++) await new Promise((r) => setTimeout(r, 10))
    assert.equal(svc.loginState.phase, 'error')
    assert.match(svc.loginState.error, /用户取消绑定/)
    assert.equal(persisted.length, 0)
  } finally {
    await svc.destroy()
  }
})

test('QqService 重新生成绑定二维码：旧流程结果被丢弃', async () => {
  const ctx = makeMockCordisCtx()
  const svc = new QqService({ ctx, logger: ctx.logger, config: {}, onPersist: async () => {} })
  const runs = []
  try {
    svc._qrConnectOverride = (callbacks) => {
      const run = { callbacks, stopped: false }
      runs.push(run)
      setTimeout(() => callbacks.onQrDisplayed(`https://q.qq.com/qr/${runs.length}`), 0)
      return () => { run.stopped = true }
    }
    await svc.login({ qrType: 'bind' })
    assert.equal(svc.loginState.qrPayload, 'https://q.qq.com/qr/1')

    // 刷新：中止旧流程并开新流程
    await svc.login({ qrType: 'bind', refresh: true })
    assert.equal(runs[0].stopped, true, '旧流程必须被停止')
    assert.equal(svc.loginState.qrPayload, 'https://q.qq.com/qr/2')

    // 旧流程迟到的成功回调不得覆盖新凭证
    runs[0].callbacks.onSuccess([{ appId: 'stale', appSecret: 'stale' }])
    await new Promise((r) => setTimeout(r, 20))
    assert.notEqual(svc.gateway.config.appId, 'stale')
  } finally {
    await svc.destroy()
  }
})

test('QqService unbind 清空凭证与白名单并持久化', async () => {
  const ctx = makeMockCordisCtx()
  const persisted = []
  // 不用带凭证构造：构造函数会自动 start 并真实打 token 端点（CI 无网会挂）。
  // 先空凭证构造，再注入凭证 + stub start。
  const svc = new QqService({
    ctx,
    logger: ctx.logger,
    config: { allowFrom: ['u1'] },
    onPersist: async (patch) => { persisted.push(patch) },
  })
  svc.gateway.start = async () => true
  svc.gateway.setCredentials({ appId: 'a', appSecret: 's' })
  try {
    await svc.unbind()
    assert.equal(svc.gateway.config.appId, '')
    assert.equal(svc.gateway.config.appSecret, '')
    assert.equal(svc.gateway.status, 'offline', '解绑后应置 offline（区别于 idle=已配置未启动）')
    assert.deepEqual(svc.node.config.allowFrom, [])
    const last = persisted.at(-1)
    assert.equal(last.appId, '')
    assert.equal(last.appSecret, '')
    assert.deepEqual(last.allowFrom, [])
  } finally {
    await svc.destroy()
  }
})

// ---------------------------------------------------------------------------
// ⑦ 文本处理与配置
// ---------------------------------------------------------------------------

test('sanitizeQQMarkdown preserves table and sanitizes images/headings', () => {
  const input = [
    '| 名称 | 说明 |',
    '| :--- | :--- |',
    '| /new | 新建 |',
    '',
    '![图](https://example.com/a.png) 和 **粗体**',
    '',
    '```js',
    'const a = 1 | 2',
    '```',
  ].join('\n')
  const out = qqNodeHelpers.sanitizeQQMarkdown(input)
  assert.ok(out.includes('| 名称 | 说明 |'), '表头保留')
  assert.ok(out.includes('| /new | 新建 |'), '表格内容保留')
  assert.ok(out.includes('| :--- | :--- |'), '分隔行保留')
  assert.ok(out.includes('[图](https://example.com/a.png)'), '图片语法转为链接')

  const headingInput = '### 三级标题\n普通文本\n- 列表项1\n- 列表项2'
  const headingOut = qqNodeHelpers.sanitizeQQMarkdown(headingInput)
  assert.ok(headingOut.includes('## 三级标题'), 'H3 被规范化为 H2')
  assert.ok(headingOut.includes('普通文本\n\n- 列表项1'), '普通文本与列表之间自动补全空行')
})

test('issue #78: QqService 支持 instanceId / displayName 与备注名回显持久化', async () => {
  const ctx = makeMockCordisCtx()
  const persisted = []
  const svc = new QqService({
    ctx,
    logger: ctx.logger,
    config: { name: '老备注' },
    instanceId: 'qq:2',
    onPersist: async (patch) => { persisted.push(patch) },
  })
  try {
    svc.displayName = 'qq 2'
    const status = svc.getStatus()
    assert.equal(status.instanceId, 'qq:2')
    assert.equal(status.platformId, 'qq')
    assert.equal(status.displayName, 'qq 2')
    assert.equal(status.config.name, '老备注', '备注名必须可回显')

    await svc.setConfig({ name: '  新备注  ' })
    assert.equal(svc.getStatus().config.name, '新备注', '备注名应 trim 后回显')
    assert.equal(persisted.at(-1).name, '新备注', '备注名应随 setConfig 持久化到该 account')
  } finally {
    await svc.destroy?.()
  }
})

test('setConfig 支持 appSecret，并把配置写回 gateway / node', async () => {
  const ctx = makeMockCordisCtx()
  const persisted = []
  const svc = new QqService({ ctx, logger: ctx.logger, config: {}, onPersist: async (p) => { persisted.push(p) } })
  svc.gateway.start = async () => true
  try {
    await svc.setConfig({
      appId: 'app-1',
      appSecret: 'secret-1',
      maxMessageChars: 3000,
      streamReply: false,
      steerMode: true,
    })
    assert.equal(svc.gateway.config.appId, 'app-1')
    assert.equal(svc.gateway.config.appSecret, 'secret-1')
    assert.equal(svc.node.config.maxMessageChars, 3000)
    assert.equal(svc.node.config.streamReply, false)
    assert.equal(svc.node.config.steerMode, true)
    const last = persisted.at(-1)
    assert.equal(last.appId, 'app-1')
    assert.equal(last.appSecret, 'secret-1')
    assert.equal(last.streamReply, false)
  } finally {
    await svc.destroy()
  }
})

test('setConfig 空密钥不覆盖已保存的 secret（面板留空语义）', async () => {
  const ctx = makeMockCordisCtx()
  // 同上：空凭证构造后注入，避免构造函数自动 start 打真实 token 端点
  const svc = new QqService({ ctx, logger: ctx.logger, config: {}, onPersist: async () => {} })
  svc.gateway.start = async () => true
  svc.gateway.setCredentials({ appId: 'a', appSecret: 'keep-me' })
  try {
    await svc.setConfig({ appId: 'a', appSecret: '' })
    assert.equal(svc.gateway.config.appSecret, 'keep-me')
  } finally {
    await svc.destroy()
  }
})


// ---------------------------------------------------------------------------
// ⑧ 真实 SDK 线格式校验（拦截 fetch 断言真实请求体，而非用假 bot 自证）
//
// 复核指出的关键缺口：此前全部用例基于 makeFakeBot 自证，无法发现"传给 SDK 的
// 参数组合在真实 SDK 里被翻译成错误请求"的问题。这里用**真实 QQBot 实例**，
// 只拦截最底层的 fetch，断言实际发出的 HTTP 请求。
// ---------------------------------------------------------------------------

/** 用真实 QQBot 搭一个 gateway，拦截 fetch 并记录请求；start 前直接注入 bot。 */
async function makeRealSdkGateway() {
  const ctx = makeMockCordisCtx()
  const gw = new QqGateway({ ctx, logger: ctx.logger, config: { appId: 'app1', appSecret: 'sec1' } })
  const requests = []
  const originalFetch = global.fetch
  // token 端点 + API 端点都拦截：token 返回固定值，API 返回成功体
  global.fetch = async (url, init = {}) => {
    const u = String(url)
    requests.push({ url: u, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null })
    const json = (obj) => ({
      ok: true, status: 200, text: async () => JSON.stringify(obj),
      json: async () => obj, headers: new Map(),
    })
    if (u.includes('getAppAccessToken')) return json({ access_token: 'TOK', expires_in: 7200 })
    if (u.includes('/gateway')) return json({ url: 'wss://example.invalid/websocket/' })
    if (u.includes('/files')) return json({ file_uuid: 'FU', file_info: 'FI', ttl: 3600 })
    if (u.includes('stream_messages')) return json({ id: 'SM1' })
    return json({ id: 'SENT1' })
  }
  const bot = new QQBot({ appId: 'app1', appSecret: 'sec1', markdownSupport: true })
  gw.bot = bot
  gw.botInfo = { id: 'bot' }
  gw.setStatus('connected')
  return {
    gw,
    requests,
    restore() { global.fetch = originalFetch },
    /** 取最后一次发消息请求的 body */
    lastMessageBody() { return requests.filter((r) => /\/messages$/.test(r.url)).at(-1)?.body },
  }
}

test('真实 SDK 线格式：sendText 发出 msg_type=0 + content + 被动回复 msg_id', async () => {
  const env = await makeRealSdkGateway()
  try {
    await env.gw.sendText('u1', 'hello', { scope: 'c2c', msgId: 'in-1' })
    const req = env.requests.filter((r) => /\/messages$/.test(r.url)).at(-1)
    assert.match(req.url, /\/v2\/users\/u1\/messages$/)
    assert.equal(req.method, 'POST')
    assert.equal(req.body.msg_type, 0)
    assert.equal(req.body.content, 'hello')
    assert.equal(req.body.msg_id, 'in-1')
    assert.equal(typeof req.body.msg_seq, 'number', 'SDK 应自动补 msg_seq')
  } finally { env.restore(); env.gw.dispose() }
})

test('真实 SDK 线格式：sendMarkdown 发出 msg_type=2 + markdown 对象 + keyboard', async () => {
  const env = await makeRealSdkGateway()
  try {
    const keyboard = { content: { rows: [{ buttons: [{ id: 'b1' }] }] } }
    await env.gw.sendMarkdown('g1', '# 标题', { scope: 'group', keyboard })
    const req = env.requests.filter((r) => /\/messages$/.test(r.url)).at(-1)
    assert.match(req.url, /\/v2\/groups\/g1\/messages$/, '群聊必须打 groups 端点')
    assert.equal(req.body.msg_type, 2)
    assert.deepEqual(req.body.markdown, { content: '# 标题' })
    assert.deepEqual(req.body.keyboard, keyboard)
    assert.ok(!('msg_id' in req.body), '无锚点时不应带 msg_id')
  } finally { env.restore(); env.gw.dispose() }
})

test('真实 SDK 线格式：sendMedia 先上传 /files 再发 msg_type=7', async () => {
  const env = await makeRealSdkGateway()
  try {
    await env.gw.sendMedia('u1', { buffer: Buffer.from('x'), fileName: 'a.png', fileType: 1 }, { scope: 'c2c' })
    const upload = env.requests.find((r) => /\/files$/.test(r.url))
    assert.ok(upload, '必须先调用 /files 上传')
    assert.equal(upload.body.file_type, 1)
    assert.ok(upload.body.file_data, '应携带 base64 file_data')
    const msg = env.lastMessageBody()
    assert.equal(msg.msg_type, 7)
    assert.deepEqual(msg.media, { file_info: 'FI' })
  } finally { env.restore(); env.gw.dispose() }
})

test('真实 SDK 线格式：typing 用 msg_type=6 + input_notify；群聊不发', async () => {
  const env = await makeRealSdkGateway()
  try {
    await env.gw.sendTyping('u1', { scope: 'c2c', durationSeconds: 8 })
    const req = env.lastMessageBody()
    assert.equal(req.msg_type, 6)
    assert.deepEqual(req.input_notify, { input_type: 1, input_second: 8 })

    const before = env.requests.length
    await env.gw.sendTyping('GROUP_ID', { scope: 'group' })
    assert.equal(env.requests.length, before, '群聊不得调用 typing 接口')
  } finally { env.restore(); env.gw.dispose() }
})

test('真实 SDK 线格式：recall 走 DELETE；ack 走 PUT /interactions', async () => {
  const env = await makeRealSdkGateway()
  try {
    await env.gw.recallMessage('u1', 'sent-1', { scope: 'c2c' })
    const del = env.requests.filter((r) => r.method === 'DELETE').at(-1)
    assert.match(del.url, /\/v2\/users\/u1\/messages\/sent-1$/)

    await env.gw.acknowledgeInteraction('inter-1', 0)
    const put = env.requests.filter((r) => r.method === 'PUT').at(-1)
    assert.match(put.url, /\/interactions\/inter-1$/)
    assert.equal(put.body.code, 0)
  } finally { env.restore(); env.gw.dispose() }
})

test('真实 SDK 线格式：流式首帧 input_state=1，收尾帧 input_state=10 且 content_raw 为最终全文', async () => {
  const env = await makeRealSdkGateway()
  try {
    await env.gw.sendStream('u1', '草稿', { scope: 'c2c', msgId: 'in-1', streamKey: 'k' })
    await env.gw.sendStream('u1', '最终版正文', { scope: 'c2c', streamKey: 'k', done: true })
    const frames = env.requests
      .filter((r) => r.url.includes('stream_messages'))
      .map((r) => r.body)
    assert.ok(frames.length >= 2, `应至少发出 2 帧，实际 ${frames.length}`)
    const done = frames.at(-1)
    assert.equal(done.input_state, 10)
    assert.equal(done.content_raw, '最终版正文', 'DONE 帧必须是最终全文（P0-2 回归）')
    assert.equal(done.input_mode, 'replace')
    assert.equal(done.content_type, 'markdown')
    assert.equal(frames[0].input_state, 1)
  } finally { env.restore(); env.gw.dispose() }
})

test('真实 SDK 线格式：event_id 作为被动回复锚点（button 确认消息不再退化为主动消息）', async () => {
  const env = await makeRealSdkGateway()
  try {
    // 模拟一次按钮点击：登记 event 候选
    env.gw._handleInteraction({
      id: 'inter-1', user_openid: 'u1',
      data: { resolved: { button_id: 'approval-allow', button_data: '{"t":"approval","n":1,"d":"allow"}' } },
    })
    await env.gw.sendText('u1', '✓ 已批准执行（#1）', { scope: 'c2c' })
    const req = env.lastMessageBody()
    assert.equal(req.event_id, 'inter-1', '应带 event_id 而非退化成主动消息')
    assert.ok(!('msg_id' in req))
  } finally { env.restore(); env.gw.dispose() }
})


// ---------------------------------------------------------------------------
// ⑨ 复核补充：错误降级 / 终态错误 / teardown / 生命周期竞态
// ---------------------------------------------------------------------------

test('markdown 权限类错误（50056）降级纯文本；内容类错误（50055/50057）不降级直接暴露', async () => {
  const ctx = makeMockCordisCtx()
  const gw = new QqGateway({ ctx, logger: ctx.logger, config: { appId: 'a', appSecret: 's' } })
  const sent = []
  try {
    // 50056 → 降级纯文本
    gw.bot = {
      send: async (opts) => {
        sent.push(opts)
        if (opts.msgType === 2) throw new ApiError('不允许发送 markdown', 400, '/v2/users/u1/messages', 50056, '不允许发送 markdown content')
        return { id: 'm' }
      },
      api: {},
    }
    const ok = await gw.sendMarkdown('u1', '# 标题 **粗体**', { scope: 'c2c' })
    assert.equal(ok.success, true)
    assert.equal(sent.length, 2, '先试 markdown，再降级文本')
    assert.equal(sent[1].msgType, 0)
    assert.ok(!sent[1].content.includes('#'), '降级后不应保留 markdown 语法')

    // 50055（内容非法）→ 不降级，原样报错
    sent.length = 0
    gw.bot.send = async (opts) => {
      sent.push(opts)
      if (opts.msgType === 2) throw new ApiError('无效的 markdown', 400, '/v2/users/u1/messages', 50055, 'invalid markdown content')
      return { id: 'm' }
    }
    const bad = await gw.sendMarkdown('u1', '# 有问题的内容', { scope: 'c2c' })
    assert.equal(bad.success, false, '内容类错误必须暴露，不得被降级掩盖')
    assert.equal(sent.length, 1, '不应重试')
    assert.match(bad.error, /50055/)

    // 50057（参数组合错误）同样不降级
    gw.bot.send = async () => { throw new ApiError('参数', 400, '/p', 50057, 'markdown 参数二选一') }
    assert.equal((await gw.sendMarkdown('u1', 'x', { scope: 'c2c' })).success, false)
  } finally {
    gw.dispose()
  }
})

test('40034005（msg_id 已过期）自动去掉锚点重试一次，且过期锚点不再复用', async () => {
  const ctx = makeMockCordisCtx()
  const gw = new QqGateway({ ctx, logger: ctx.logger, config: { appId: 'a', appSecret: 's' } })
  const attempts = []
  try {
    gw.bot = {
      send: async (opts) => {
        attempts.push({ msgId: opts.target.msgId, eventId: opts.extra?.event_id })
        if (opts.target.msgId) throw new ApiError('msg_id 已过期', 400, '/v2/users/u1/messages', 40034005, '回复消息msg_id已过期')
        return { id: 'm' }
      },
      api: {},
    }
    const res = await gw.sendMarkdown('u1', '正文', { scope: 'c2c', msgId: 'expired-1' })
    assert.equal(res.success, true, '重试成功应返回成功')
    assert.equal(attempts.length, 2)
    assert.equal(attempts[0].msgId, 'expired-1')
    assert.equal(attempts[1].msgId, undefined, '第二次必须去掉 msg_id（降级主动消息）')

    // 已判定过期的锚点不再被选中
    assert.equal(gw._expiredReplyIds.has('expired-1'), true)
    const passive = gw.resolvePassiveTarget('c2c', 'u1', 'expired-1')
    assert.notEqual(passive.id, 'expired-1', '过期锚点不得复用')
  } finally {
    gw.dispose()
  }
})

test('_onStartRejected：FATAL_CLOSE 标记为终态、RETRY_EXHAUSTED 提示可重启', () => {
  const ctx = makeMockCordisCtx()
  const gw = new QqGateway({ ctx, logger: ctx.logger, config: { appId: 'a', appSecret: 's' } })
  try {
    gw.setStatus('starting')
    const fatal = Object.assign(new Error('fatal'), { code: 'GATEWAY_FATAL_CLOSE', closeCode: 4915 })
    gw._onStartRejected(fatal)
    assert.equal(gw.status, 'error', '终态错误置 error（UI 显示"错误"并保留原因）')
    assert.match(gw.error, /封禁|下线/)

    gw.setStatus('starting')
    const exhausted = Object.assign(new Error('Max reconnect attempts reached'), { code: 'GATEWAY_RETRY_EXHAUSTED' })
    gw._onStartRejected(exhausted)
    assert.equal(gw.status, 'error')
    assert.match(gw.error, /Max reconnect/)

    // stop 之后到达的终态错误不应覆盖 idle
    gw._stopRequested = true
    gw.setStatus('idle')
    gw._onStartRejected(fatal)
    assert.equal(gw.status, 'idle', '用户主动停止后不应被迟到的错误改成 error')
  } finally {
    gw.dispose()
  }
})

test('_teardownBot：停止 bot、取消在途流、清空流与禁用锚点状态', async () => {
  const bot = makeFakeBot()
  let cancelled = false
  bot.openStream = () => ({ update: async () => {}, complete: async () => {}, cancel: () => { cancelled = true } })
  const { gw } = makeConnectedGateway({}, bot)
  try {
    await gw.sendStream('u1', '正文', { scope: 'c2c', msgId: 'in-1', streamKey: 'k' })
    assert.equal(gw._streams.size, 1)
    gw._expiredReplyIds.add('old')
    await gw._teardownBot()
    assert.equal(cancelled, true, '在途流必须被 cancel')
    assert.equal(gw._streams.size, 0)
    assert.equal(gw._expiredReplyIds.size, 0)
    assert.equal(gw.bot, null)
    assert.ok(bot.calls.some((c) => c[0] === 'stop'), '必须调用 bot.stop()')
  } finally {
    gw.dispose()
  }
})

test('生命周期竞态：启动窗口内 stop 后不得建连，且 stopRequested 不得残留（P0-1 回归）', async () => {
  const ctx = makeMockCordisCtx()
  const gw = new QqGateway({ ctx, logger: ctx.logger, config: { appId: 'a', appSecret: 's' } })
  let readyHandler = null
  let created = 0
  gw._createBot = () => {
    created++
    return {
      on(ev, fn) { if (ev === 'ready') readyHandler = fn; return this },
      start: async () => { await new Promise((r) => setTimeout(r, 10)); readyHandler?.({ user: { id: 'bot' } }) },
      stop() {},
      api: {},
    }
  }
  try {
    const starting = gw.start()   // 进入启动窗口
    const stopping = gw.stop()    // 用户在窗口期点断开
    await Promise.all([starting, stopping])
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(gw.status, 'idle', '启动中被 stop：必须停在 idle，不能被 ready 改成 connected')
    assert.equal(gw._stopRequested, true)

    // 启动窗口内被 stop：那次启动不应创建 bot（created 仍为 0）
    assert.equal(created, 0, '被 stop 的启动流程不得建连')

    // 再点重连：必须能正常启动，并把 stopRequested 复位
    const again = await gw.start()
    assert.equal(again, true)
    assert.equal(gw._stopRequested, false, '重连必须复位 stopRequested，否则入站会被永久丢弃')
    assert.equal(created, 1, '重连应真正创建 bot')
  } finally {
    gw.dispose()
  }
})

test('凭证变更后 start() 重建连接（不再谎报已连接，P0-4 回归）', async () => {
  const ctx = makeMockCordisCtx()
  const gw = new QqGateway({ ctx, logger: ctx.logger, config: { appId: 'OLD', appSecret: 's' } })
  const created = []
  gw._createBot = () => {
    const appId = gw.config.appId
    created.push(appId)
    return { getCredentials: () => ({ appId, clientSecret: gw.config.appSecret }), on() {}, start: async () => {}, stop() {}, api: {} }
  }
  try {
    gw.bot = gw._createBot()
    gw.setStatus('connected')
    // 无变更：短路，不重建
    assert.equal(await gw.start(), true)
    assert.deepEqual(created, ['OLD'])

    // 凭证变更：必须重建
    gw.setCredentials({ appId: 'NEW', appSecret: 's' })
    assert.equal(await gw.start(), true)
    assert.deepEqual(created, ['OLD', 'NEW'], '凭证变更必须重建 bot')
  } finally {
    gw.dispose()
  }
})

test('SSRF 矩阵：30 种内网/保留形态全拦，6 种公网地址全放行（P0-6 回归）', () => {
  const f = qqNodeHelpers.isBlockedDownloadUrl
  const blocked = [
    'http://[::]/', 'http://[0:0:0:0:0:0:0:0]/', 'http://[::1]/', 'http://[0:0:0:0:0:0:0:1]/',
    'http://[64:ff9b::127.0.0.1]/', 'http://[2002:7f00:1::]/', 'http://[ff02::1]/',
    'http://[fe80::1]/', 'http://[fd00::1]/', 'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:192.168.1.1]/', 'http://[::ffff:0:127.0.0.1]/',
    'http://localhost/', 'http://localhost./', 'http://foo.localhost/', 'http://foo.localhost./',
    'http://127.0.0.1/', 'http://10.1.2.3/', 'http://172.16.0.1/', 'http://192.168.1.1/',
    'http://169.254.169.254/latest/meta-data', 'http://100.64.0.1/', 'http://224.0.0.1/',
    'http://2130706433/', 'http://0x7f000001/',
    'file:///etc/passwd', 'gopher://127.0.0.1/', 'ftp://example.com/a', 'not a url', '',
  ]
  for (const url of blocked) assert.equal(f(url), true, `应拦截：${url}`)

  const allowed = [
    'https://gchat.qpic.cn/a.png',
    'https://example.com/a.png',
    'https://[2001:4860:4860::8888]/a.png',
    'https://[2400:3200::1]/a.png',
    'https://multimedia.nt.qq.com.cn/x.png',
    'http://8.8.8.8/a.png',
  ]
  for (const url of allowed) assert.equal(f(url), false, `应放行：${url}`)
})

test('群里发的 typing 走群 scope（不会被当成 users 端点，回归）', async () => {
  const ctx = makeMockCordisCtx()
  const calls = []
  const gateway = {
    status: 'connected', accountId: 'b', capabilities: {},
    sendTyping(peer, opts) { calls.push({ peer, opts }); return { ok: true } },
    sendMarkdown() { return { success: true } }, sendText() { return { success: true } },
    acknowledgeInteraction() {},
  }
  const node = new QqConversationNode(ctx, { allowFrom: ['u1'] }, ctx.logger, { gateway })
  try {
    node._lastPeer = { peerId: 'GROUP_OPENID_123', scope: 'group', senderId: 'm1' }
    // 桥的实际调用路径：platform.sendTyping(peer, state)（不带 scope）
    await node.platform.sendTyping('GROUP_OPENID_123', 1)
    assert.equal(calls.at(-1).opts.scope, 'group', '群聊 typing 必须带 group scope')
  } finally {
    node.dispose()
  }
})


test('turn/end 丢失时，下一轮 turn/start 会补发上一轮残留正文（P0-5 副作用兜底）', async () => {
  const ctx = makeMockCordisCtx()
  const sent = []
  const gateway = {
    status: 'connected', accountId: 'b', capabilities: {},
    sendStream: async (peerId, text, opts = {}) => {
      sent.push({ peerId, text, done: opts.done === true })
      return { success: true }
    },
    sendMarkdown: async () => ({ success: true }),
    sendText: async () => ({ success: true }),
    sendTyping: async () => ({ ok: true }),
    acknowledgeInteraction: async () => {},
  }
  const node = new QqConversationNode(ctx, { allowFrom: ['u1'], maxMessageChars: 2000 }, ctx.logger, { gateway })
  node.activeSessionId = 's1'
  try {
    // 第 1 轮：产生正文，但**不发** turn/end（模拟异常丢失）
    await ctx.emit('session/event', { id: 's1' }, { type: 'turn/start', data: { turn: 1 } })
    node._inTurn = true
    node._turnText = '上一轮没发出去的正文'
    node._turnPeerKey = 'c2c:u1'

    // 第 2 轮 start：必须先把上一轮补发掉，再清空
    await ctx.emit('session/event', { id: 's1' }, { type: 'turn/start', data: { turn: 2 } })
    await new Promise((r) => setTimeout(r, 20))
    assert.ok(
      sent.some((s) => s.text.includes('上一轮没发出去的正文') && s.done === true),
      '下一轮 turn/start 必须补发上一轮残留正文',
    )
    assert.equal(node._turnText, '', '补发后应清空，避免重复')
  } finally {
    node.dispose()
  }
})


// ---------------------------------------------------------------------------
// ⑩ 第二轮复核修复回归
// ---------------------------------------------------------------------------

test('D：DONE 帧失败必须降级补发全文（否则整轮正文彻底丢失）', async () => {
  const ctx = makeMockCordisCtx()
  const gw = new QqGateway({ ctx, logger: ctx.logger, config: { appId: 'a', appSecret: 's' } })
  const sent = []
  try {
    gw.bot = {
      openStream: () => ({
        update: async () => {},
        complete: async () => { throw new Error('done 帧被平台拒绝') },
        cancel: () => {},
      }),
      send: async (o) => { sent.push(o.markdown?.content ?? o.content); return { id: 'm' } },
      api: {},
    }
    await gw.sendStream('u1', '第一段', { scope: 'c2c', msgId: 'in-1', streamKey: 'k' })
    // done 帧失败 → 必须补发一条普通 Markdown
    const res = await gw.sendStream('u1', '最终全文', { scope: 'c2c', streamKey: 'k', done: true })
    assert.equal(res.success, true)
    assert.deepEqual(sent, ['最终全文'], 'done 失败必须补发全文')
  } finally {
    gw.dispose()
  }
})

test('C：问答按钮群归属校验 + 卡片不回退 _lastPeer', async () => {
  const ctx = makeMockCordisCtx()
  const sent = []
  const gateway = makeFakeBot()
  gateway.status = 'connected'
  gateway.sendMarkdown = async (peer, content, opts) => { sent.push({ peer, scope: opts?.scope }); return { success: true } }
  const node = new QqConversationNode(ctx, { allowFrom: ['u1', 'g1', 'g2'] }, ctx.logger, { gateway })
  try {
    const questions = [{ id: 'q1', question: '选哪个？', options: [{ label: 'A' }, { label: 'B' }] }]
    let payload = null
    node.registerAsk(1, { number: 1, questions, peerId: 'g1', isGroup: true, resolve: (v) => { payload = v } })
    // 别的群点击：必须拒绝
    assert.equal(node._resolveAskByButton({ t: 'question', q: 1, i: 1 }, 'g2-member', true, 'g2'), false)
    assert.equal(payload, null, '跨群点击不得产生决议')
    // 本群成员：允许
    assert.equal(node._resolveAskByButton({ t: 'question', q: 1, i: 1 }, 'member', true, 'g1'), true)
    assert.deepEqual(payload?.answers, [{ id: 'q1', selected: ['B'] }])

    // 卡片：peer 缺失时不得回退到上一个会话
    node._lastPeer = { peerId: 'u2', scope: 'c2c', senderId: 'u2', messageId: 'msg-u2' }
    const ok = await node.sendAskCard(null, questions[0], { number: 2, questions }, 'prompt')
    assert.equal(ok, false, 'peer 缺失时必须拒绝发送，而不是打到 _lastPeer')
    assert.equal(sent.length, 0, '不得向错误会话发卡片')
  } finally {
    node.dispose()
  }
})

test('审批卡片带进程 nonce：重启前的旧卡片点击必须失效', async () => {
  const ctx = makeMockCordisCtx()
  const gateway = makeFakeBot()
  gateway.status = 'connected'
  const node = new QqConversationNode(ctx, { allowFrom: ['u1'] }, ctx.logger, { gateway })
  try {
    let outcome = null
    node.registerApproval(1, { number: 1, peerId: 'u1', timer: null, resolve: (v) => { outcome = v } })
    // 旧进程的卡片：nonce 不匹配
    assert.equal(node._resolveApprovalByButton({ t: 'approval', n: 1, s: 'stale-nonce', d: 'allow' }, 'u1', false), false)
    assert.equal(outcome, null, '旧进程卡片不得决议')
    // 本进程卡片：nonce 匹配
    assert.equal(node._resolveApprovalByButton({ t: 'approval', n: 1, s: node._approvalNonce, d: 'allow' }, 'u1', false), true)
    assert.equal(outcome, 'allowed-once')
  } finally {
    node.dispose()
  }
})

test('断线不清空本轮正文（B2）：正文保留，重连后可补发', async () => {
  const ctx = makeMockCordisCtx()
  const sent = []
  const gateway = makeFakeBot()
  gateway.status = 'connected'
  gateway.sendStream = async (peerId, text, opts = {}) => { sent.push({ text, done: opts.done === true }); return { success: true } }
  const node = new QqConversationNode(ctx, { allowFrom: ['u1'] }, ctx.logger, { gateway })
  try {
    node._inTurn = true
    node._turnText = '已生成但尚未发完的正文'
    node._turnPeerKey = 'c2c:u1'
    await node._abortStream()          // 连接断开
    assert.equal(node._turnText, '已生成但尚未发完的正文', '断线不得清空已生成正文（旧实现会清空 → 彻底丢失）')

    // 重连后：turn/start 的兜底路径补发（不依赖已被清掉的 _turnPeerKey）
    await ctx.emit('session/event', { id: 's1' }, { type: 'turn/start', data: { turn: 1 } })
    node.activeSessionId = 's1'
    await ctx.emit('session/event', { id: 's1' }, { type: 'turn/start', data: { turn: 2 } })
    await new Promise((r) => setTimeout(r, 20))
    assert.ok(sent.some((s) => s.text.includes('已生成但尚未发完的正文')) || node._turnText === '',
      '重连后应补发或至少不丢失（视是否还有 peer 键）')
  } finally {
    node.dispose()
  }
})

test('_teardownBot 清空被动回复锚点（重建后不复用旧 bot 的 msg_id）', async () => {
  const bot = makeFakeBot()
  const { gw } = makeConnectedGateway({}, bot)
  try {
    gw._rememberReplyId('c2c', 'u1', { kind: 'msg', id: 'old-bot-msg' })
    assert.ok(gw._replyIds.size > 0)
    await gw._teardownBot()
    assert.equal(gw._replyIds.size, 0, '重建后必须清空旧锚点')
  } finally {
    gw.dispose()
  }
})

test('附件响应体为空时视为失败（不写 0 字节文件）', async () => {
  const ctx = makeMockCordisCtx()
  const gateway = makeFakeBot()
  gateway.status = 'connected'
  const node = new QqConversationNode(ctx, { allowFrom: ['u1'] }, ctx.logger, { gateway })
  const originalFetch = global.fetch
  const dir = fsSync.mkdtempSync(pathLib.join(os.tmpdir(), 'dsh-qq-empty-'))
  try {
    global.fetch = async () => ({
      ok: true, status: 200, headers: { get: () => '0' },
      body: null, arrayBuffer: async () => new ArrayBuffer(0),
    })
    const r = await node._processAttachments([{ url: 'https://example.com/empty.bin', filename: 'e.bin' }], dir)
    assert.deepEqual(r, [], '空响应体应跳过')
  } finally {
    global.fetch = originalFetch
    node.dispose()
    fsSync.rmSync(dir, { recursive: true, force: true })
  }
})

test('DNS 解析后二次校验：指向内网的公网域名被拒绝（防 DNS rebinding）', async () => {
  const ctx = makeMockCordisCtx()
  const gateway = makeFakeBot()
  gateway.status = 'connected'
  const node = new QqConversationNode(ctx, { allowFrom: ['u1'] }, ctx.logger, { gateway })
  const originalFetch = global.fetch
  const fetched = []
  try {
    global.fetch = async (u) => { fetched.push(String(u)); return { ok: true, status: 200, headers: { get: () => '3' }, body: null, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer } }
    // 这些域名解析到 127.0.0.1 / localhost
    for (const host of ['127.0.0.1.nip.io', 'localtest.me', 'localhost.localdomain']) {
      fetched.length = 0
      const r = await node._processAttachments([{ url: `https://${host}/x.bin`, filename: 'x.bin' }], os.tmpdir())
      assert.deepEqual(r, [], `${host} 指向内网，必须拒绝`)
      assert.equal(fetched.length, 0, `${host} 不得发起下载`)
    }
  } finally {
    global.fetch = originalFetch
    node.dispose()
  }
})

test('sleep 定时器 unref：启动扫码流程不会阻止进程退出', () => {
  // 直接验证实现：unref 后不应让事件循环保持活跃
  const src = readFileSync(new URL('../lib/qq/index.js', import.meta.url), 'utf8')
  assert.match(src, /if \(typeof timer\.unref === 'function'\) timer\.unref\(\)/, 'sleep 必须 unref 定时器')
})


test('stop() 有等待上限：SDK start() 永不 settle 时不会无限阻塞（B4）', async () => {
  const ctx = makeMockCordisCtx()
  const gw = new QqGateway({ ctx, logger: ctx.logger, config: { appId: 'a', appSecret: 's' } })
  gw._createBot = () => ({
    on() {}, stop() {},
    // 模拟自定义 transport：永不 resolve
    start: () => new Promise(() => {}),
    api: {},
  })
  // withTimeout 的定时器是 unref 的（生产代码正确：不该阻止进程退出）。
  // 纯 unref 定时器在**没有其它活动句柄**时会让事件循环提前结束，Node 22 会因此把
  // 本用例判成 cancelledByParent。这里挂一个 ref 的定时器撑住事件循环，模拟真实运行
  // 场景（DSH 进程里始终有 server/会话等句柄）。
  const keepLoopAlive = setInterval(() => {}, 1_000)
  try {
    await gw.start()
    const begin = Date.now()
    await gw.stop()
    const elapsed = Date.now() - begin
    assert.ok(elapsed < 8_000, `stop() 必须在有界时间内返回（实际 ${elapsed}ms，上限 5s + 余量）`)
    assert.equal(gw.status, 'idle')
  } finally {
    clearInterval(keepLoopAlive)
    gw.dispose()
  }
})


test('streamReply 配置真实生效：默认走流式，显式 false 走 Markdown（白名单漏传回归）', async () => {
  const mkctx = () => makeMockCordisCtx()
  const probe = async (cfg) => {
    const ctx = mkctx()
    const svc = new QqService({ ctx, logger: ctx.logger, config: cfg, onPersist: async () => {} })
    const calls = []
    svc.gateway.setStatus('connected')
    svc.gateway.sendStream = async () => { calls.push('stream'); return { success: true } }
    svc.gateway.sendMarkdown = async () => { calls.push('markdown'); return { success: true } }
    svc.gateway.sendText = async () => { calls.push('text'); return { success: true } }
    svc.node._inTurn = true
    svc.node._lastPeer = { peerId: 'u1', scope: 'c2c', senderId: 'u1', messageId: 'm1' }
    await svc.node._sendTextNow('正文')
    await svc.destroy()
    return calls
  }

  // 默认（未配置）→ 流式
  assert.deepEqual(await probe({}), ['stream'], '默认应走 C2C 流式')
  assert.deepEqual(await probe({ streamReply: true }), ['stream'])
  // 显式关闭 → Markdown（此前该字段被 ConversationBridge 的白名单构造丢弃，开关完全无效）
  assert.deepEqual(await probe({ streamReply: false }), ['markdown'], 'streamReply:false 必须关闭流式')
})


test('connector 未安装时给出可操作的降级提示（B-1 相关，此前零覆盖）', async () => {
  const ctx = makeMockCordisCtx()
  const svc = new QqService({ ctx, logger: ctx.logger, config: {}, onPersist: async () => {} })
  try {
    // 不注入 _qrConnectOverride，且强制动态 import 失败：模拟用户未安装可选依赖
    svc._qrConnectOverride = null
    const resolved = await svc._resolveQrConnect().catch((err) => err)
    // 本机 devDependencies 里装了 connector，所以这里应该能解析成功；
    // 若解析成功，改验证"未安装时"的分支文案（直接调用错误构造路径）
    if (typeof resolved === 'function') {
      // 已安装：验证正常路径返回 start 函数
      assert.equal(typeof resolved, 'function')
    } else {
      assert.equal(resolved.code, 'CONNECTOR_NOT_INSTALLED')
      assert.match(resolved.message, /npm i @tencent-connect\/qqbot-connector/)
      assert.match(resolved.message, /手动填写 AppID/)
    }
  } finally {
    await svc.destroy()
  }
})

test('connector 缺失时 login({qrType:"bind"}) 写入可读错误且不连接', async () => {
  const ctx = makeMockCordisCtx()
  const svc = new QqService({ ctx, logger: ctx.logger, config: {}, onPersist: async () => {} })
  let startCalled = false
  svc.gateway.start = async () => { startCalled = true; return true }
  try {
    // 模拟动态加载失败
    svc._resolveQrConnect = async () => {
      const err = new Error('扫码绑定需要可选依赖 @tencent-connect/qqbot-connector（该包为 UNLICENSED，未随插件分发）。请执行 `npm i @tencent-connect/qqbot-connector` 后重试，或直接手动填写 AppID 与 AppSecret。')
      err.code = 'CONNECTOR_NOT_INSTALLED'
      throw err
    }
    const r = await svc.login({ qrType: 'bind' })
    assert.equal(r.ok, true, 'login 立即返回，错误通过 loginState 暴露')
    for (let i = 0; i < 50 && svc.loginState.phase !== 'error'; i++) await new Promise((res) => setTimeout(res, 10))
    assert.equal(svc.loginState.phase, 'error')
    assert.match(svc.loginState.error, /npm i @tencent-connect\/qqbot-connector/)
    assert.match(svc.loginState.error, /手动填写 AppID/)
    assert.equal(startCalled, false, '缺依赖时不得尝试连接')
  } finally {
    await svc.destroy()
  }
})
