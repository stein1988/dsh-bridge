// 实时插话模式（steerMode）的路由回归测试（PR #84）
//
// 断言 handleInbound 在四个分支上的消息投递方式：
//   ① steerMode=true 且 Agent 支持 steer → 调 agent.steer（下一步边界注入）；
//   ② steerMode=false（或缺省）→ 调 agent.followup（轮次排队，与老版本一致）；
//   ③ steerMode=true 但 Agent 没有 steer 方法（老宿主）→ 回退 followup，不得丢消息；
//   ④ steer 同步抛错 → 向上报错并让用户可见（不得静默吞掉或把消息吞没）。
//
// 背景：steer 与 followup 的差异是「投递到哪个 inbox 边界」（next-step vs next-turn），
// 见 DSH dsh-agent 的 AgentInbox：followup → send(msg,'next-turn',true)、
// steer → send(msg,'next-step',true)。两者都会 wake driver，空闲时都能起一轮，
// 所以切换开关不会丢消息——本文件把这四条语义固化为守卫。
import test from 'node:test'
import assert from 'node:assert/strict'
import { Platform } from '../lib/platform/index.js'
import { ConversationBridge } from '../lib/platform/conversation-bridge.js'

class MockPlatform extends Platform {
  constructor({ ctx, logger, config = {} } = {}) {
    super({ ctx, logger, config })
    this.id = 'mock'
    this.name = 'Mock IM'
    this.status = 'connected'
    this.sent = []
  }
  get configured() { return true }
  get capabilities() {
    return { supportsGroup: true, supportsMedia: true, supportsVoice: false, supportsTyping: true, maxMessageChars: 2000 }
  }
  async sendText(peerId, text) { this.sent.push({ peerId, text }); return { success: true } }
  async sendTyping() { return { success: true } }
}

function makeCtx(agentFactory) {
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    on() { return () => {} },
    emit() {},
    sessions: { list: () => [{ id: 's1', events: [], header: {}, seq: 0 }], get: () => undefined },
    agents: { get: () => agentFactory(), list: () => [], create: async () => { throw new Error('not used') }, resume: async () => { throw new Error('not used') } },
    workspaceRegistry: { archivedSessionIds: [], list: async () => [] },
    sessionProjCache: {},
  }
  return ctx
}

/** 造一个记录调用次数的 Agent 桩。opts.steer 可为函数（用于抛错用例）或 false（无该方法）。 */
function makeAgent({ withSteer = true, steerThrows = false } = {}) {
  const calls = { followup: 0, steer: 0 }
  const agent = {
    session: { id: 's1' },
    status: 'running',
    cancel() {},
    followup() { calls.followup += 1 },
  }
  if (withSteer) {
    agent.steer = () => {
      calls.steer += 1
      if (steerThrows) throw new Error('inbox projection not active')
    }
  }
  return { agent, calls }
}

function makeBridge({ steerMode, agentOpts }) {
  const { agent, calls } = makeAgent(agentOpts)
  const ctx = makeCtx(() => agent)
  const platform = new MockPlatform({ ctx, logger: ctx.logger, config: { allowFrom: ['u1'] } })
  const config = { allowFrom: ['u1'] }
  if (steerMode !== undefined) config.steerMode = steerMode
  const bridge = new ConversationBridge({ ctx, logger: ctx.logger, config, platform })
  bridge.activeSessionId = 's1'
  return { bridge, platform, calls }
}

test('steerMode=true：入站消息走 agent.steer（下一步边界注入），不调 followup', async () => {
  const { bridge, platform, calls } = makeBridge({ steerMode: true })
  const out = await bridge.handleInbound({ senderId: 'u1', text: '换个思路' })
  assert.equal(out, 'routed')
  assert.equal(calls.steer, 1, 'steerMode 开启时应调用 agent.steer')
  assert.equal(calls.followup, 0, '不得同时调用 followup（避免重复投递）')
  bridge.dispose()
  platform.dispose()
})

test('steerMode=false：入站消息走 agent.followup（保持原有排队行为）', async () => {
  const { bridge, platform, calls } = makeBridge({ steerMode: false })
  const out = await bridge.handleInbound({ senderId: 'u1', text: '继续' })
  assert.equal(out, 'routed')
  assert.equal(calls.followup, 1, 'steerMode 关闭时应调用 agent.followup')
  assert.equal(calls.steer, 0, '不得调用 steer')
  bridge.dispose()
  platform.dispose()
})

test('steerMode 缺省（老配置）：同样走 followup，默认行为与老版本一致', async () => {
  const { bridge, platform, calls } = makeBridge({})
  assert.equal(bridge.config.steerMode, false, '未配置时 config.steerMode 必须为 false')
  await bridge.handleInbound({ senderId: 'u1', text: '继续' })
  assert.equal(calls.followup, 1)
  assert.equal(calls.steer, 0)
  bridge.dispose()
  platform.dispose()
})

test('steerMode=true 但 Agent 无 steer 方法（老宿主）：回退 followup，不丢消息', async () => {
  const { bridge, platform, calls } = makeBridge({ steerMode: true, agentOpts: { withSteer: false } })
  const out = await bridge.handleInbound({ senderId: 'u1', text: '继续' })
  assert.equal(out, 'routed')
  assert.equal(calls.followup, 1, 'Agent 不支持 steer 时必须回退 followup，消息不能丢')
  assert.equal(calls.steer, 0)
  bridge.dispose()
  platform.dispose()
})

test('steer 抛出异常：向上报错并让用户可见（不静默吞消息）', async () => {
  const { bridge, platform, calls } = makeBridge({ steerMode: true, agentOpts: { steerThrows: true } })
  const out = await bridge.handleInbound({ senderId: 'u1', text: '插话' })
  assert.equal(out, 'ignored', 'steer 抛错时 handleInbound 返回 ignored（与既有错误路径一致）')
  assert.equal(calls.steer, 1)
  assert.equal(calls.followup, 0, '当前实现不回退 followup（病态路径，但必须让用户知道失败）')
  const text = platform.sent.map((s) => s.text).join('\n')
  assert.match(text, /执行出错/, `用户应收到可读报错，实际发送：${text}`)
  assert.match(text, /inbox projection not active/, '报错应带上真实原因，便于排障')
  bridge.dispose()
  platform.dispose()
})

test('steerMode 与其他开关互不影响：changesDigest/showActivity 取值不改写 steerMode', async () => {
  const { agent } = makeAgent({})
  const ctx = makeCtx(() => agent)
  const platform = new MockPlatform({ ctx, logger: ctx.logger })
  const bridge = new ConversationBridge({
    ctx, logger: ctx.logger, platform,
    config: { allowFrom: ['u1'], steerMode: true, changesDigest: false, showActivity: true },
  })
  assert.equal(bridge.config.steerMode, true)
  assert.equal(bridge.config.changesDigest, false)
  assert.equal(bridge.config.showActivity, true)
  bridge.dispose()
  platform.dispose()
})
