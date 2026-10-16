// test/activity-status.test.mjs
// 轮次进行中的「活动状态」：把 agent 正在做什么实时反映到 IM。
//
// 背景（2026-10-16 用户反馈 + Web 端对照截图）：Web 端会显示「思考」「运行命令」这类
// 过程状态，而 IM 侧此前只有 5 分钟一次的心跳，长任务期间用户不知道 agent 在干什么。
//
// 关键约束：工具→活动的映射**必须对齐宿主**（dsh-client-ui-chat 的 activity()），
// 否则同一工具在 Web 与 IM 会给出不同说法。这里用宿主的口径逐条锁住。
import test from 'node:test'
import assert from 'node:assert/strict'
import { activityOf, activityText, formatActivityLine, toolDetail } from '../lib/platform/activity.js'

test('[活动] 工具→活动种类与宿主 activity() 逐条对齐', () => {
  // 逐条对照宿主 dsh-client-ui-chat 的实现（本机核实）
  assert.equal(activityOf('read'), 'read')
  assert.equal(activityOf('read_image'), 'readImage')
  for (const n of ['grep', 'glob', 'fs_inspect', 'x_inspect']) assert.equal(activityOf(n), 'search', n)
  assert.equal(activityOf('write'), 'write')
  assert.equal(activityOf('edit'), 'edit')
  assert.equal(activityOf('apply_patch'), 'edit')
  for (const n of ['bash', 'pwsh', 'exec_command', 'write_stdin', 'terminal_run']) {
    assert.equal(activityOf(n), 'commands', n)
  }
  assert.equal(activityOf('run_code'), 'code')
  assert.equal(activityOf('web_search'), 'webSearch')
  assert.equal(activityOf('web_fetch'), 'webFetch')
  for (const n of ['subagent', 'subagent_control']) assert.equal(activityOf(n), 'subagents', n)
  for (const n of ['todo_write', 'create_goal', 'update_goal', 'get_goal']) assert.equal(activityOf(n), 'plan', n)
  for (const n of ['ask_user_question', 'request_user_input']) assert.equal(activityOf(n), 'questions', n)
  // 兜底
  assert.equal(activityOf('unknown_tool'), 'tools')
  assert.equal(activityOf(''), 'tools')
  assert.equal(activityOf(undefined), 'tools')
})

test('[活动] 文案对齐宿主 message.stepProcess.* 的中文口径', () => {
  assert.equal(activityText('thinking'), '正在分析请求')
  assert.equal(activityText('commands'), '正在运行命令')
  assert.equal(activityText('edit'), '正在编辑文件')
  assert.equal(activityText('read'), '正在读取文件')
  assert.equal(activityText('search'), '正在搜索代码')
  assert.equal(activityText('webSearch'), '正在搜索网页')
  assert.equal(activityText('subagents'), '正在协调子智能体')
  assert.equal(activityText('plan'), '正在更新计划')
  assert.equal(activityText('questions'), '等待你的操作')
  // 未知种类兜底不抛错
  assert.equal(activityText('nope'), '正在调用工具')
})

test('[活动] 细节提取：优先 description/command/路径等，且做长度截断', () => {
  assert.equal(toolDetail({ command: 'npm test' }), 'npm test')
  assert.equal(toolDetail({ file_path: '/a/b.js' }), '/a/b.js')
  assert.equal(toolDetail({ pattern: 'foo' }), 'foo')
  // 数组型 query 合并
  assert.equal(toolDetail({ queries: ['a', 'b'] }), 'a, b')
  // 换行压成单行（状态行必须一行）
  assert.equal(toolDetail({ command: 'line1\nline2' }), 'line1 line2')
  // 未知键 → 空串（不硬造内容）
  assert.equal(toolDetail({ other: 'x' }), '')
  assert.equal(toolDetail(null), '')
  assert.equal(toolDetail('not-json'), '')
  // 超长截断
  const long = toolDetail({ command: 'x'.repeat(400) })
  assert.ok(long.length <= 160, `应截断到 160 内，实际 ${long.length}`)
  assert.match(long, /…$/)
})

test('[活动] 状态行渲染：图标 + 文案 + 细节 + 轮次', () => {
  assert.equal(formatActivityLine({ turn: 3 }), '💭 正在分析请求 · 第 3 轮')
  assert.equal(
    formatActivityLine({ turn: 3, toolName: 'bash', args: { command: 'npm test' } }),
    '⌨️ 正在运行命令（npm test） · 第 3 轮',
  )
  assert.equal(
    formatActivityLine({ toolName: 'edit', args: { file_path: 'lib/feishu/node.js' } }),
    '📝 正在编辑文件（lib/feishu/node.js）',
  )
  // 无细节时不出现空括号
  assert.doesNotMatch(formatActivityLine({ toolName: 'todo_write' }), /（\s*）/)
})

test('[活动] 参数以 JSON 字符串传入也能解析（宿主 event.data.arguments 是字符串）', () => {
  const line = formatActivityLine({
    turn: 2,
    toolName: 'bash',
    args: JSON.stringify({ command: 'npm run lint' }),
  })
  assert.equal(line, '⌨️ 正在运行命令（npm run lint） · 第 2 轮')
})

// ---------- 桥侧节流 ----------

test('[活动] 桥只在状态变化且节流窗口外才推送（避免工具密集时刷屏）', async () => {
  const { Context } = await import('@deepseek-ai/cordis')
  const { ConversationBridge } = await import('../lib/platform/conversation-bridge.js')
  const { Platform } = await import('../lib/platform/base.js')

  const app = new Context()
  const root = app.isolate('act-test')
  for (const [n, v] of Object.entries({
    sessions: { list: () => [], get: () => undefined },
    agents: { get: () => undefined, create: async () => ({}), resume: async () => ({}), roots: () => [] },
    approval: {},
    workspaceRegistry: { archivedSessionIds: [], list: async () => [] },
    sessionPersistence: {},
  })) root.provide(n, v)

  class P extends Platform {
    constructor(o) {
      super(o)
      this.id = 'mock'; this.name = 'M'; this.status = 'connected'
      this.activities = []
    }
    get configured() { return true }
    get capabilities() { return { supportsGroup: true, supportsMedia: true, supportsVoice: false, supportsTyping: true, maxMessageChars: 2000 } }
    async sendText() { return { success: true } }
    async sendMediaFile() { return { success: true } }
    async sendTyping() { return { success: true } }
    async setActivityStatus(line) { this.activities.push(line) }
  }

  const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
  const platform = new P({ ctx: root, logger })
  // activityIntervalSec: 0 → 不做时间节流，专注验证"文本不变不重复推"
  const bridge = new ConversationBridge({ ctx: root, logger, config: { activityIntervalSec: 0 }, platform })
  bridge.activeSessionId = 's1'
  bridge._turnPeers.set('s1', { outboundPeer: { peerId: 'chat', isGroup: false }, senderId: 'u1' })
  const state = { startedTurns: new Set(), createdFiles: new Set() }
  bridge._digestState.set('s1', state)

  const emitTool = (name, args) => root.emit('session/event', { id: 's1' }, { type: 'tool/call', data: { turn: 2, name, arguments: JSON.stringify(args) } })
  emitTool('bash', { command: 'npm test' })
  emitTool('bash', { command: 'npm test' })   // 同状态 → 不重复推
  emitTool('edit', { file_path: 'a.js' })      // 状态变化 → 推
  await new Promise((r) => setTimeout(r, 20))

  assert.deepEqual(platform.activities, [
    '⌨️ 正在运行命令（npm test） · 第 2 轮',
    '📝 正在编辑文件（a.js） · 第 2 轮',
  ], `实际: ${JSON.stringify(platform.activities)}`)
  bridge.dispose()
})

test('[活动] 平台未实现 setActivityStatus 时静默跳过（不报错、不影响既有行为）', async () => {
  const { Context } = await import('@deepseek-ai/cordis')
  const { ConversationBridge } = await import('../lib/platform/conversation-bridge.js')
  const { Platform } = await import('../lib/platform/base.js')

  const app = new Context()
  const root = app.isolate('act-test2')
  for (const [n, v] of Object.entries({
    sessions: { list: () => [], get: () => undefined },
    agents: { get: () => undefined, create: async () => ({}), resume: async () => ({}), roots: () => [] },
    approval: {},
    workspaceRegistry: { archivedSessionIds: [], list: async () => [] },
    sessionPersistence: {},
  })) root.provide(n, v)
  class P extends Platform {
    constructor(o) { super(o); this.id = 'mock'; this.name = 'M'; this.status = 'connected' }
    get configured() { return true }
    get capabilities() { return { supportsGroup: true, supportsMedia: true, supportsVoice: false, supportsTyping: true, maxMessageChars: 2000 } }
    async sendText() { return { success: true } }
    async sendMediaFile() { return { success: true } }
    async sendTyping() { return { success: true } }
  }
  const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
  const platform = new P({ ctx: root, logger })
  const bridge = new ConversationBridge({ ctx: root, logger, config: {}, platform })
  bridge.activeSessionId = 's1'
  bridge._turnPeers.set('s1', { outboundPeer: { peerId: 'chat', isGroup: false }, senderId: 'u1' })
  bridge._digestState.set('s1', { startedTurns: new Set(), createdFiles: new Set() })
  assert.doesNotThrow(() => {
    root.emit('session/event', { id: 's1' }, { type: 'tool/call', data: { turn: 1, name: 'bash', arguments: '{}' } })
  })
  bridge.dispose()
})

// ---------- 飞书侧：状态行进入流式卡片，且收尾后消失 ----------

test('[活动] 飞书：状态行拼在正文前，轮次结束清空（不留垃圾消息）', async () => {
  const { Context } = await import('@deepseek-ai/cordis')
  const app = new Context()
  const root = app.isolate('act-feishu')
  for (const [n, v] of Object.entries({
    sessions: { list: () => [], get: () => undefined },
    agents: { get: () => undefined, create: async () => ({}), resume: async () => ({}), roots: () => [] },
    approval: {},
    workspaceRegistry: { archivedSessionIds: [], list: async () => [] },
    sessionPersistence: {},
  })) root.provide(n, v)
  const sets = []
  root.provide('feishu', {
    status: 'online',
    configured: true,
    botInfo: { openId: 'x' },
    async openStream() {
      return { setContent: async (t) => { sets.push(t) }, finish: async () => {} }
    },
    async sendText() { return { success: true } },
    async sendCard() { return { success: true } },
    async createCard() { return null },
  })
  const { FeishuConversationNode } = await import('../lib/feishu/node.js')
  const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
  const node = new FeishuConversationNode(root, { allowFrom: ['ou_me'], changesDigest: false }, logger)
  node.peerId = 'oc_chat'
  node.activeSessionId = 's1'

  await root.emit('session/event', { id: 's1' }, { type: 'turn/start', data: { turn: 1 } })
  await node.sendText('这是正文第一段')
  // 桥推来活动状态 → 卡片原地更新（不再是纯正文）
  await node.setActivityStatus('⌨️ 正在运行命令（npm test） · 第 1 轮')
  assert.ok(sets.at(-1).includes('正在运行命令'), `状态行应出现在卡片里，实际: ${sets.at(-1)}`)
  assert.ok(sets.at(-1).includes('这是正文第一段'), '正文不能被状态行挤掉')

  // 轮次结束：状态清空，最终卡片只剩正文
  await root.emit('session/event', { id: 's1' }, { type: 'turn/end', data: { reason: { kind: 'complete' } } })
  assert.equal(node._activityLine, '', '收尾后状态应清空')
})
