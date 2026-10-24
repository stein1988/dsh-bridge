import test from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { QqGateway } from '../lib/qq/gateway.js'
import { QqConversationNode } from '../lib/qq/node.js'
import { FeishuConversationNode } from '../lib/feishu/node.js'
import { ConversationBridge } from '../lib/platform/conversation-bridge.js'

const require = createRequire(import.meta.url)

function makeMockCordisCtx() {
  const events = {}
  const ctx = {
    on(event, fn) { (events[event] ??= []).push(fn); return () => { events[event] = (events[event] ?? []).filter(f => f !== fn) } },
    async emit(event, ...args) {
      const fns = [...(events[event] ?? [])]
      for (const fn of fns) await fn(...args)
    },
    effect(fn) { return fn() },
    logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
    sessions: { list: () => [], get: () => undefined },
    agents: { create: async () => ({}), get: () => undefined },
    reflect: { provide(name, value) { ctx[name] = value; return () => {} } },
  }
  return ctx
}

test('QQ Gateway 把 RESUME 会话持久化交给官方 SDK（不再自管心跳/续连）', () => {
  const ctx = makeMockCordisCtx()
  const os = require('node:os')
  const path = require('node:path')
  const fs = require('node:fs')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-qq-session-'))
  const gw = new QqGateway({
    ctx,
    logger: ctx.logger(),
    config: { appId: '123', appSecret: 'abc' },
    dataDir: dir,
  })
  try {
    // 会话持久化：SDK 的 kvSessionPersistence 落盘到 <dataDir>/qq-session-<instance>.json
    const persistence = gw._sessionPersistence()
    assert.equal(typeof persistence?.load, 'function')
    assert.equal(typeof persistence?.save, 'function')
    assert.equal(typeof persistence?.clear, 'function')
    // 未写过时 load() 返回 null（SDK 会回退到 IDENTIFY 全量鉴权）
    assert.equal(persistence.load(), null)
    persistence.save({ sessionId: 'sess-1', lastSeq: 42 })
    const restored = persistence.load()
    assert.equal(restored?.sessionId, 'sess-1')
    assert.equal(restored?.lastSeq, 42)
  } finally {
    gw.dispose()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('QQ Gateway 状态映射：SDK 的状态值覆盖桥的在线判定集合', () => {
  const ctx = makeMockCordisCtx()
  const gw = new QqGateway({ ctx, logger: ctx.logger(), config: { appId: '123', appSecret: 'abc' } })
  try {
    // 桥的离线守卫认 idle/offline；连接中/已连/重连中都必须放行
    const statuses = []
    ctx.on('qq/status', (event) => { statuses.push(event) })
    gw.setStatus('starting')
    gw.setStatus('connected')
    gw.setStatus('reconnecting')
    assert.deepEqual(statuses.map((s) => s.status), ['starting', 'connected', 'reconnecting'])
    assert.ok(statuses.every((s) => s.instanceId === 'qq'), '状态事件必须带 instanceId（多账号隔离）')
    assert.ok(!['idle', 'offline'].includes(gw.status), '连接中不得被判为离线')
  } finally {
    gw.dispose()
  }
})

test('QQ Node processes attachments and appends file path', async () => {
  const ctx = makeMockCordisCtx()
  ctx.qq = new QqGateway({ ctx, logger: ctx.logger(), config: { appId: '123', appSecret: 'abc' } })
  ctx.qq.setStatus('connected')

  const node = new QqConversationNode(ctx, { allowFrom: ['user1'] }, ctx.logger())
  const events = []
  node.handleInbound = async (item) => {
    events.push(item)
    return 'routed'
  }

  node._processAttachments = async () => [
    { filename: 'photo.png', path: '/mock/.qq-media/photo.png', size: 1024 },
  ]

  await ctx.emit('qq/message', {
    type: 'message',
    scope: 'c2c',
    senderId: 'user1',
    peerId: 'user1',
    text: '请看这张图',
    attachments: [{ url: 'http://example.com/photo.png' }],
  })

  assert.equal(events.length, 1)
  assert.ok(events[0].text.includes('请看这张图'))
  assert.ok(events[0].text.includes('[文件: /mock/.qq-media/photo.png]'))
})

test('Feishu Node processes media messages and appends file path', async () => {
  const ctx = makeMockCordisCtx()
  ctx.feishu = {
    status: 'online',
    sendText: async () => ({ messageId: 'om_t' }),
    downloadResourceToFile: async () => ({ contentType: 'application/pdf', bytesWritten: 1024 }),
  }
  
  const node = new FeishuConversationNode(ctx, { allowFrom: ['user2'] }, ctx.logger())
  const events = []
  node.handleInbound = async (item) => {
    events.push(item)
    return 'routed'
  }

  node._processMedia = async () => [
    { filename: 'doc.pdf', path: '/mock/.feishu-media/doc.pdf', size: 2048 },
  ]

  await ctx.emit('feishu/message', {
    chatId: 'oc_user2',
    peerId: 'oc_user2',
    senderId: 'user2',
    isGroup: false,
    // SDK 对文件消息的归一化正文是占位标记，不应投喂给模型
    text: '<file key="fk_123" name="doc.pdf"/>',
    messageId: 'om_123',
    rawContentType: 'file',
    resources: [{ type: 'file', fileKey: 'fk_123', fileName: 'doc.pdf' }],
  })

  assert.equal(events.length, 1)
  assert.ok(events[0].text.includes('[文件: /mock/.feishu-media/doc.pdf]'))
})

test('ConversationBridge 解析 assistant 消息中的 [SEND_FILE: path] 指令并在正文中剔除', async () => {
  const ctx = makeMockCordisCtx()
  const sentTexts = []
  const bridge = new ConversationBridge({
    ctx,
    logger: ctx.logger(),
    config: { allowFrom: ['u1'] },
    platform: {
      id: 'mock',
      name: 'Mock',
      status: 'connected',
      capabilities: {},
      sendText: async (peer, text) => { sentTexts.push(text) },
    },
  })
  bridge.peerId = 'u1'
  bridge.activeSessionId = 'session-1'

  // 1. turn/start
  await ctx.emit('session/event', { id: 'session-1' }, { type: 'turn/start', data: { turn: 1 } })

  // 2. assistant/message with directive
  await ctx.emit('session/event', { id: 'session-1' }, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '已生成图片。\n[SEND_FILE: /project/result.png]' }] } },
  })

  // 3. turn/end
  await ctx.emit('session/event', { id: 'session-1' }, {
    type: 'turn/end',
    data: { reason: { kind: 'stop' } },
  })

  assert.ok(sentTexts.some(t => t.includes('已生成图片。')))
  assert.ok(!sentTexts.some(t => t.includes('SEND_FILE')))
})

test('ConversationBridge triggers sendMediaFile on turn/end when [SEND_FILE: path] exists', async () => {
  const ctx = makeMockCordisCtx()
  const sentMedia = []
  const bridge = new ConversationBridge({
    ctx,
    logger: ctx.logger(),
    config: { allowFrom: ['u1'] },
    platform: {
      id: 'mock',
      name: 'Mock',
      status: 'connected',
      capabilities: {},
      sendText: async () => {},
      sendMediaFile: async (peer, filePath) => { sentMedia.push({ peer, filePath }) },
    },
  })
  bridge.peerId = 'u1'
  bridge.activeSessionId = 'session-1'

  const targetFile = 'package.json' // 用仓内稳定文件做夹具，避免依赖 docs/ 资源（其格式与打包策略会变）

  await ctx.emit('session/event', { id: 'session-1' }, { type: 'turn/start', data: { turn: 1 } })
  await ctx.emit('session/event', { id: 'session-1' }, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: `请查收：\n[SEND_FILE: ${targetFile}]` }] } },
  })
  await ctx.emit('session/event', { id: 'session-1' }, {
    type: 'turn/end',
    data: { reason: { kind: 'stop' } },
  })

  assert.equal(sentMedia.length, 1)
  assert.equal(sentMedia[0].peer, 'u1')
  assert.equal(sentMedia[0].filePath, resolve(process.cwd(), targetFile))
})
