// issue #77 ②③：飞书「实时活动状态」的卡片载体与出站目标解析。
//
// 背景（issue #77 真机复现，DSH 0.2.1-rc.2）：
//   ② 状态行没有载体——setActivityStatus 只在已有流式卡片时刷新，而卡片要等助手正文
//     到达才创建；长任务里正文往往最后才出，整段时间 _stream 为 null，状态行只存在
//     变量里、无处渲染（用户全程看不到"正在运行命令"）。
//   ③ 预热卡与正文卡目标不一致 + 复用判定过严——this.peerId 在单聊里是 senderId
//     （open_id, ou_…）而非 chat_id（oc_…）；`_sendTurnOutput` 又要求
//     `_stream.to === peerId` 严格相等，一旦不一致就把预热卡收掉、正文退化成普通消息。
//
// 本套件锁住：轮次内无卡片时建「预热卡」、正文到达复用同一张卡、并发/竞态
// 不产生双卡/空卡、出站目标永远不落到发送者 open_id。
import test from 'node:test'
import assert from 'node:assert/strict'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const silentLogger = { info() {}, warn() {}, error() {}, debug() {} }

/**
 * 建一个真实 FeishuConversationNode + 假网关。
 * @param {{ openStream?: (rec: object) => Promise<object> }} [opts]
 *   openStream 可注入「建卡慢」等竞态时序；不传则立即返回控制器。
 */
async function makeNode(opts = {}) {
  const { Context } = await import('@deepseek-ai/cordis')
  const app = new Context()
  const root = app.isolate('feishu-warm-card')
  for (const [n, v] of Object.entries({
    sessions: { list: () => [], get: () => undefined },
    agents: { get: () => undefined, create: async () => ({}), resume: async () => ({}), roots: () => [] },
    approval: {},
    workspaceRegistry: { archivedSessionIds: [], list: async () => [] },
    sessionPersistence: {},
  })) root.provide(n, v)

  const streams = []
  const texts = []
  const gateway = {
    status: 'online',
    configured: true,
    botInfo: { openId: 'ou_bot' },
    async openStream(peer, replyOpts) {
      const rec = { peer, replyOpts, contents: [], finished: 0 }
      streams.push(rec)
      if (opts.openStream) return opts.openStream(rec)
      return {
        setContent: async (t) => { rec.contents.push(t) },
        finish: async () => { rec.finished += 1 },
      }
    },
    async sendText(peer, text) { texts.push({ peer, text }); return { success: true } },
    async sendCard() { return { success: true } },
    async createCard() { return null },
  }
  root.provide('feishu', gateway)

  const { FeishuConversationNode } = await import('../lib/feishu/node.js')
  // warmCardDelayMs: 0 → 立即建卡（生产默认 400ms 的"观察窗口"见 lib/feishu/node.js 的
  // WARM_CARD_DELAY_MS），这样用例里的 await setActivityStatus 之后卡片一定已建好，
  // 断言不用依赖挂钟；需要测窗口行为时用 opts.warmCardDelayMs 覆盖。
  const nodeConfig = { allowFrom: ['oc_chat'], changesDigest: false }
  // 传了 warmCardDelayMs 就显式覆盖（0 = 立即建卡）；useDefaultDelay 则不设置，走生产默认 400ms
  if (!opts.useDefaultDelay) nodeConfig.warmCardDelayMs = opts.warmCardDelayMs ?? 0
  const node = new FeishuConversationNode(root, nodeConfig, silentLogger)
  node.activeSessionId = 's1'
  return { app, node, gateway, streams, texts }
}

const OUTBOUND = { peerId: 'oc_chat', isGroup: false }
const PARTS = { icon: '⌨️', text: '正在运行命令', detail: 'npm test', suffix: ' · 第 1 轮' }

test('[#77②] 轮次内无卡片时先建预热卡承载状态行，正文到达复用同一张卡', async () => {
  const { node, streams } = await makeNode()
  try {
    // 模拟单聊：基类 peerId = 发送者 open_id（不是出站目标）
    node.peerId = 'ou_sender'
    await node.ctx.emit('session/event', { id: 's1' }, { type: 'turn/start', data: { turn: 1 } })
    // 状态先到：必须立刻有一张卡承载它（旧实现此时 _stream 为 null，永远不显示）
    await node.platform.setActivityStatus('⌨️ 正在运行命令（npm test） · 第 1 轮', { outboundPeer: OUTBOUND }, PARTS)
    assert.equal(streams.length, 1, '状态行应触发一张预热卡')
    assert.equal(streams[0].peer, 'oc_chat', '预热卡必须发到 chat_id（oc_…），不能是 open_id')
    assert.match(streams[0].contents.at(-1), /正在运行命令/, '预热卡应包含状态行')
    assert.match(streams[0].contents.at(-1), /npm test/, '结构化 detail 应渲染出来')

    // 正文到达：必须复用预热卡，不能另建卡、也不能退化成普通消息
    await node.sendText('正文第一段', { outboundPeer: OUTBOUND })
    assert.equal(streams.length, 1, '正文必须复用预热卡')
    assert.match(streams[0].contents.at(-1), /正文第一段/)
    assert.match(streams[0].contents.at(-1), /正在运行命令/, '正文到达后状态行仍在同一张卡顶部')

    await node.sendText('正文第二段', { outboundPeer: OUTBOUND })
    assert.equal(streams.length, 1, '同一轮内继续累积，不新建卡')
    assert.match(streams[0].contents.at(-1), /正文第一段[\s\S]*正文第二段/, '正文必须累积')

    // 轮次结束：状态行消失、只留正文、卡片收尾
    await node.ctx.emit('session/event', { id: 's1' }, { type: 'turn/end', data: { reason: { kind: 'complete' } } })
    await sleep(20)
    assert.equal(streams[0].finished, 1, '轮次结束应 finish 卡片')
    assert.doesNotMatch(streams[0].contents.at(-1), /正在运行命令/, '结束后不得残留状态行')
    assert.match(streams[0].contents.at(-1), /正文第二段/, '最终卡片必须保留正文')
  } finally {
    node.dispose?.()
  }
})

test('[#77③] 出站目标解析：绝不把发送者 open_id 当目标；优先 outboundPeer → _lastPeer', async () => {
  const { node, streams } = await makeNode()
  try {
    node.peerId = 'ou_sender'
    await node.ctx.emit('session/event', { id: 's1' }, { type: 'turn/start', data: { turn: 1 } })

    // 既没有 outboundPeer、也没有 _lastPeer：只剩 open_id → 宁可不发，也不能发错
    assert.equal(node.resolveSendTarget({}), '', '单聊的 this.peerId(open_id) 不能作为出站目标')
    await node.platform.setActivityStatus('状态', {}, null)
    assert.equal(streams.length, 0, '解析不到合法目标时不得建卡')

    // 最近一次入站提供 chat_id 后恢复
    node._lastPeer = { peerId: 'oc_chat', senderId: 'ou_sender', isGroup: false }
    assert.equal(node.resolveSendTarget({}), 'oc_chat')
    await node.platform.setActivityStatus('状态2', {}, null)
    assert.equal(streams.length, 1)
    assert.equal(streams[0].peer, 'oc_chat')

    // 显式 outboundPeer 优先（本轮目标与最近入站不一致的场景）
    assert.equal(node.resolveSendTarget({ outboundPeer: { peerId: 'oc_other', isGroup: false } }), 'oc_other')
  } finally {
    node.dispose?.()
  }
})

test('[#77②] 并发状态推送只建一张预热卡（_warmOpening 合并）', async () => {
  const { node, streams } = await makeNode()
  try {
    node.peerId = 'ou_sender'
    await node.ctx.emit('session/event', { id: 's1' }, { type: 'turn/start', data: { turn: 1 } })
    await Promise.all([
      node.platform.setActivityStatus('状态 A', { outboundPeer: OUTBOUND }, null),
      node.platform.setActivityStatus('状态 B', { outboundPeer: OUTBOUND }, null),
      node.platform.setActivityStatus('状态 C', { outboundPeer: OUTBOUND }, null),
    ])
    assert.equal(streams.length, 1, '并发推送不得重复建卡')
    assert.match(streams[0].contents.at(-1), /状态 C/, '最后一张渲染应是最新状态')
  } finally {
    node.dispose?.()
  }
})

test('[#77②] 竞态：建预热卡期间正文先到 → 预热卡收掉，正文卡不受影响', async () => {
  let call = 0
  const { node, streams } = await makeNode({
    openStream: async (rec) => {
      call += 1
      if (call === 1) await sleep(30) // 预热卡建卡慢，给正文抢先的机会
      return {
        setContent: async (t) => { rec.contents.push(t) },
        finish: async () => { rec.finished += 1 },
      }
    },
  })
  try {
    node.peerId = 'ou_sender'
    await node.ctx.emit('session/event', { id: 's1' }, { type: 'turn/start', data: { turn: 1 } })
    const warm = node.platform.setActivityStatus('状态', { outboundPeer: OUTBOUND }, null)
    await sleep(5)
    await node.sendText('正文', { outboundPeer: OUTBOUND })
    await warm
    assert.equal(streams.length, 2, '正文抢先建卡后，预热卡应被收掉（共 2 个流：正文卡 + 被弃用的预热卡）')
    const body = streams.find((s) => s.contents.some((t) => t.includes('正文')))
    assert.ok(body, '正文卡必须存在')
    assert.match(body.contents.at(-1), /正文/)
    const warmRec = streams.find((s) => s !== body)
    assert.equal(warmRec.finished, 1, '多余的预热卡必须 finish 掉，不能留下空卡')
    assert.ok(warmRec.contents.length >= 1, '被弃用的预热卡也必须写入状态快照，绝不留零内容卡片')
  } finally {
    node.dispose?.()
  }
})

test('[#77②] 默认观察窗口：状态刚推来不急于建卡，窗口过后才建（锁默认常量）', async () => {
  const { node, streams } = await makeNode({ useDefaultDelay: true })
  try {
    node.peerId = 'ou_sender'
    await node.ctx.emit('session/event', { id: 's1' }, { type: 'turn/start', data: { turn: 1 } })
    const pending = node.platform.setActivityStatus('⌨️ 正在运行命令（npm test）', { outboundPeer: OUTBOUND }, null)
    await sleep(120)
    assert.equal(streams.length, 0, '观察窗口内不得建卡（默认 400ms）')
    await sleep(420)
    assert.equal(streams.length, 1, '窗口过后状态仍在 → 建预热卡')
    assert.match(streams[0].contents.at(-1), /正在运行命令/)
    await pending
  } finally {
    node.dispose?.()
  }
})

test('[#77③] warm 逃生口：预热卡存在且正文目标字段漂移时仍复用预热卡（不新建、不退化成普通消息）', async () => {
  const { node, streams, texts } = await makeNode()
  try {
    node.peerId = 'ou_sender'
    node._lastPeer = { peerId: 'oc_chat', senderId: 'ou_sender', isGroup: false }
    await node.ctx.emit('session/event', { id: 's1' }, { type: 'turn/start', data: { turn: 1 } })
    await node.platform.setActivityStatus('⌨️ 正在运行命令', {}, null) // 无 outboundPeer → 走 _lastPeer
    assert.equal(streams.length, 1)
    assert.equal(streams[0].peer, 'oc_chat')

    // 正文侧解析出另一个 peer（模拟 _turnPeers 漂移）：预热卡仍在 → 必须复用，渲染进卡片自身目标
    await node.sendText('正文', { outboundPeer: { peerId: 'oc_other', isGroup: false } })
    assert.equal(streams.length, 1, 'warm 卡存在时必须复用，不得新建卡')
    assert.equal(texts.length, 0, '不得退化成普通文本消息')
    assert.match(streams[0].contents.at(-1), /正文/)
  } finally {
    node.dispose?.()
  }
})

test('[#77②] 短任务：正文在观察窗口内到达 → 不建预热卡，状态由正文卡承载', async () => {
  const { node, streams } = await makeNode({ warmCardDelayMs: 400 })
  try {
    node.peerId = 'ou_sender'
    await node.ctx.emit('session/event', { id: 's1' }, { type: 'turn/start', data: { turn: 1 } })
    // 生产里桥是 fire-and-forget 调用；窗口内正文到达应把待建预热卡取消掉
    const pending = node.platform.setActivityStatus('⌨️ 正在运行命令（npm test）', { outboundPeer: OUTBOUND }, null)
    await node.sendText('正文', { outboundPeer: OUTBOUND })
    await pending
    await sleep(60)
    assert.equal(streams.length, 1, '窗口内正文到达不得再冒出第二张预热卡')
    assert.match(streams[0].contents.at(-1), /正在运行命令/, '状态行由正文卡承载')
    assert.match(streams[0].contents.at(-1), /正文/)

    await node.ctx.emit('session/event', { id: 's1' }, { type: 'turn/end', data: { reason: { kind: 'complete' } } })
    await sleep(20)
    assert.equal(streams[0].finished, 1)
  } finally {
    node.dispose?.()
  }
})

test('[#77②] 轮次结束仍无正文：预热卡正常收尾（不悬挂）', async () => {
  const { node, streams } = await makeNode()
  try {
    node.peerId = 'ou_sender'
    await node.ctx.emit('session/event', { id: 's1' }, { type: 'turn/start', data: { turn: 1 } })
    await node.platform.setActivityStatus('⌨️ 正在运行命令（npm test）', { outboundPeer: OUTBOUND }, null)
    assert.equal(streams.length, 1)
    await node.ctx.emit('session/event', { id: 's1' }, { type: 'turn/end', data: { reason: { kind: 'aborted' } } })
    await sleep(20)
    assert.equal(streams[0].finished, 1, '无正文的预热卡也必须收尾，避免控制器悬挂')
    assert.equal(node._stream, null)
  } finally {
    node.dispose?.()
  }
})

test('[#77②] 首写失败（网络抖动）不得留下零写入卡片，后续正文仍能正常成卡', async () => {
  // 对应 F5：openStream 成功、但第一次 setContent 抛错时，卡片已经建出却内容为空。
  // 旧实现会把 _stream 留着，轮次结束时直接 finish → 飞书显示 "(no content)"。
  let firstWriteFailed = false
  const { node, streams, texts } = await makeNode({
    openStream: async (rec) => ({
      setContent: async (t) => {
        if (!firstWriteFailed) {
          firstWriteFailed = true
          throw new Error('network down')
        }
        rec.contents.push(t)
      },
      finish: async () => { rec.finished += 1 },
    }),
  })
  try {
    node.peerId = 'ou_sender'
    await node.ctx.emit('session/event', { id: 's1' }, { type: 'turn/start', data: { turn: 1 } })
    await node.platform.setActivityStatus('⌨️ 正在运行命令（npm test）', { outboundPeer: OUTBOUND }, null)

    assert.equal(streams.length, 1, '应已建出预热卡')
    assert.ok(streams[0].contents.length >= 1, '首写失败后必须用状态快照补写，不得留零内容卡片')
    assert.match(streams[0].contents.at(-1), /正在运行命令/)
    assert.equal(streams[0].finished, 1, '补写后必须收尾，不能悬挂')
    assert.equal(node._stream, null, '首写失败后必须清掉 _stream，避免后续被当作可用卡片')

    // 后续正文：正常新建卡片，内容不丢、不退化成普通文本消息
    await node.sendText('正文', { outboundPeer: OUTBOUND })
    assert.equal(streams.length, 2, '首写失败后正文应新建卡片')
    assert.equal(texts.length, 0, '不得退化成普通文本消息')
    assert.match(streams[1].contents.at(-1), /正文/)

    await node.ctx.emit('session/event', { id: 's1' }, { type: 'turn/end', data: { reason: { kind: 'complete' } } })
    await sleep(20)
    assert.equal(streams[1].finished, 1)
  } finally {
    node.dispose?.()
  }
})
