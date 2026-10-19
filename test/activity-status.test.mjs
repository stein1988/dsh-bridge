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
import { activityOf, activityText, activityParts, escapeMarkdown, formatActivityLine, toolDetail } from '../lib/platform/activity.js'

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
  // showActivity 默认关闭，此用例在测节流逻辑 → 显式开启
  const bridge = new ConversationBridge({ ctx: root, logger, config: { activityIntervalSec: 0, showActivity: true }, platform })
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

test('[活动] 飞书：桥调用的 this.platform 必须真的暴露 setActivityStatus（曾写错在节点上）', async () => {
  // 真机前自查发现的错：能力只定义在 FeishuConversationNode 上，而桥调用的是
  // `this.platform.setActivityStatus`（makePlatform 返回的包装对象）——两者不是同一对象，
  // 于是桥的鸭子类型探测失败、**状态永远不显示**（静默，无报错）。
  // 这条用例锁住"钩子确实挂在 platform 上"，防止再退化。
  const { Context } = await import('@deepseek-ai/cordis')
  const app = new Context()
  const root = app.isolate('hook-check')
  for (const [n, v] of Object.entries({
    sessions: { list: () => [], get: () => undefined },
    agents: { get: () => undefined, create: async () => ({}), resume: async () => ({}), roots: () => [] },
    approval: {},
    workspaceRegistry: { archivedSessionIds: [], list: async () => [] },
    sessionPersistence: {},
  })) root.provide(n, v)
  root.provide('feishu', {
    status: 'online', configured: true, botInfo: { openId: 'x' },
    async openStream() { return { setContent: async () => {}, finish: async () => {} } },
    async sendText() { return { success: true } },
    async sendCard() { return { success: true } },
    async createCard() { return null },
  })
  const { FeishuConversationNode } = await import('../lib/feishu/node.js')
  const node = new FeishuConversationNode(root, { allowFrom: ['x'], changesDigest: false },
    { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} })
  assert.equal(typeof node.platform?.setActivityStatus, 'function',
    'platform 上必须有 setActivityStatus，否则桥会静默跳过状态推送')
})

test('[活动] 飞书：轮次结束后卡片必须去掉状态行（否则显示"仍在进行中"）', async () => {
  // 真机前自查发现的第二处 bug：只清空 _activityLine 而不重渲染，卡片会**保留最后一次
  // 带状态的版本** → 任务已结束却仍显示「正在运行命令（…）」，误导用户。
  const { Context } = await import('@deepseek-ai/cordis')
  const app = new Context()
  const root = app.isolate('end-clear')
  for (const [n, v] of Object.entries({
    sessions: { list: () => [], get: () => undefined },
    agents: { get: () => undefined, create: async () => ({}), resume: async () => ({}), roots: () => [] },
    approval: {},
    workspaceRegistry: { archivedSessionIds: [], list: async () => [] },
    sessionPersistence: {},
  })) root.provide(n, v)

  const written = []
  let finishedWith = null
  root.provide('feishu', {
    status: 'online', configured: true, botInfo: { openId: 'x' },
    async openStream() {
      return {
        setContent: async (t) => { written.push(t) },
        finish: async () => { finishedWith = written.at(-1) },
      }
    },
    async sendText() { return { success: true } },
    async sendCard() { return { success: true } },
    async createCard() { return null },
  })
  const { FeishuConversationNode } = await import('../lib/feishu/node.js')
  const node = new FeishuConversationNode(root, { allowFrom: ['x'], changesDigest: false },
    { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} })
  node.peerId = 'oc'; node.activeSessionId = 's1'

  await root.emit('session/event', { id: 's1' }, { type: 'turn/start', data: { turn: 1 } })
  await node.sendText('正文内容')
  await node.platform.setActivityStatus('⌨️ 正在运行命令（npm test） · 第 1 轮')
  assert.match(written.at(-1), /正在运行命令/, '轮次中应显示状态')

  await root.emit('session/event', { id: 's1' }, { type: 'turn/end', data: { reason: { kind: 'complete' } } })
  await new Promise((r) => setTimeout(r, 20))
  assert.ok(!/正在运行命令/.test(finishedWith ?? ''), `结束后不得残留状态行，实际: ${finishedWith}`)
  assert.match(finishedWith ?? '', /正文内容/, '正文必须保留')
})

// ---------- 样式：状态行要与正文区分 ----------

test('[活动] 结构化片段：受控文案与用户可控 detail 分开', () => {
  const p = activityParts({ turn: 3, toolName: 'bash', args: { command: 'npm test' } })
  assert.equal(p.icon, '⌨️')
  assert.equal(p.text, '正在运行命令')
  assert.equal(p.detail, 'npm test')
  assert.equal(p.suffix, ' · 第 3 轮')
  // 无轮次时 suffix 为空
  assert.equal(activityParts({ toolName: 'read', args: { file_path: 'a.js' } }).suffix, '')
})

test('[活动] 转义：命令里的 markdown 元字符不得破坏样式', () => {
  // 不加转义时 `echo *bold*` 会让外层斜体提前闭合、甚至吞掉后续正文
  assert.equal(escapeMarkdown('echo *bold*'), 'echo \\*bold\\*')
  assert.equal(escapeMarkdown('a_b'), 'a\\_b')
  assert.equal(escapeMarkdown('`code`'), '\\`code\\`')
  assert.equal(escapeMarkdown('~~del~~'), '\\~\\~del\\~\\~')
  assert.equal(escapeMarkdown('[x](y)'), '\\[x\\]\\(y\\)')
  // 普通文本不受影响
  assert.equal(escapeMarkdown('npm test'), 'npm test')
  assert.equal(escapeMarkdown('中文命令 --flag'), '中文命令 \\-\\-flag')
})

test('[活动] 飞书：状态行用引用块+斜体（与正文区分），且 detail 被转义', async () => {
  const { Context } = await import('@deepseek-ai/cordis')
  const { activityParts } = await import('../lib/platform/activity.js')
  const app = new Context()
  const root = app.isolate('style-check')
  for (const [n, v] of Object.entries({
    sessions: { list: () => [], get: () => undefined },
    agents: { get: () => undefined, create: async () => ({}), resume: async () => ({}), roots: () => [] },
    approval: {},
    workspaceRegistry: { archivedSessionIds: [], list: async () => [] },
    sessionPersistence: {},
  })) root.provide(n, v)
  const written = []
  root.provide('feishu', {
    status: 'online', configured: true, botInfo: { openId: 'x' },
    async openStream() { return { setContent: async (t) => { written.push(t) }, finish: async () => {} } },
    async sendText() { return { success: true } },
    async sendCard() { return { success: true } },
    async createCard() { return null },
  })
  const { FeishuConversationNode } = await import('../lib/feishu/node.js')
  const node = new FeishuConversationNode(root, { allowFrom: ['x'], changesDigest: false },
    { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} })
  node.peerId = 'oc'; node.activeSessionId = 's1'
  await root.emit('session/event', { id: 's1' }, { type: 'turn/start', data: { turn: 1 } })
  await node.sendText('这是正文。')

  await node.setActivityStatus(null, null, activityParts({ turn: 3, toolName: 'bash', args: { command: 'npm test' } }))
  const out = written.at(-1)
  // 样式：引用块 + 斜体（飞书原生支持，见官方 md 文档）
  assert.match(out, /^> _/, '状态行应以引用块+斜体开头')
  assert.match(out, /_\n\n这是正文。/, '引用块后必须空行再接正文（官方硬性要求）')
  assert.match(out, /正在运行命令/, '应含活动文案')
  assert.doesNotMatch(out, /（\s*）/, '无细节时不应出现空括号')

  // 恶意命令：元字符必须被转义，不能破坏斜体
  await node.setActivityStatus(null, null, activityParts({
    turn: 3, toolName: 'bash', args: { command: 'echo *bold* _x_ `code`' },
  }))
  const evil = written.at(-1)
  assert.match(evil, /echo \\\*bold\\\*/, '星号必须转义')
  assert.match(evil, /\\_x\\_/, '下划线必须转义')
  assert.match(evil, /\\`code\\`/, '反引号必须转义')
  // 结构仍然完好（外层斜体闭合在行尾）
  assert.match(evil, /^> _[\s\S]*_\n\n这是正文。$/, '转义后样式结构应保持完整')
})

// ---------- Telegram：同一套状态呈现 ----------

test('[活动] Telegram：状态行同样是引用块+斜体，且能正确转成 HTML', async () => {
  const { TelegramConversationNode } = await import('../lib/telegram/node.js')
  const { activityParts } = await import('../lib/platform/activity.js')
  const { formatTelegramHtml } = await import('../lib/telegram/gateway.js')

  const events = {}
  const ctx = {
    on(e, f) { (events[e] ??= []).push(f); return () => {} },
    async emit(e, ...a) { for (const f of [...(events[e] ?? [])]) await f(...a) },
    effect(f) { return f() },
    logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
    sessions: { list: () => [], get: () => undefined },
    agents: { create: async () => ({}), get: () => undefined },
  }
  const edited = []
  ctx.telegram = {
    sendText: async () => ({ message_id: 1 }),
    editMessageText: async (c, m, t) => { edited.push(t); return {} },
  }
  const node = new TelegramConversationNode(ctx, { allowFrom: ['1003'], sendChunkDelayMs: 1 }, ctx.logger())
  node._lastPeer = { chatId: '1003' }
  node.activeSessionId = 's1'

  // 桥调的是 platform 上的方法（与飞书同一约定）
  assert.equal(typeof node.platform?.setActivityStatus, 'function')

  await ctx.emit('session/event', { id: 's1' }, { type: 'turn/start', data: { turn: 1 } })
  await node.sendText('第一段正文')
  await node.setActivityStatus(null, null, activityParts({ turn: 3, toolName: 'bash', args: { command: 'npm test' } }))

  const md = edited.at(-1)
  assert.match(md, /^> _/, '状态行应为引用块+斜体')
  assert.match(md, /第一段正文/, '正文不能丢')
  // 关键：Telegram 若不支持 `_斜体_` 会把下划线原样显示（实测过），这里锁住转换结果
  const html = formatTelegramHtml(md)
  assert.match(html, /<blockquote><i>/, `应转成 blockquote+italic，实际: ${html}`)
  assert.doesNotMatch(html, /_⌨️/, '不得把下划线原样显示出来')

  // 结束后状态消失
  await ctx.emit('session/event', { id: 's1' }, { type: 'turn/end', data: { reason: { kind: 'complete' } } })
  await new Promise((r) => setTimeout(r, 10))
  assert.ok(!/正在运行命令/.test(edited.at(-1) ?? ''), '结束后不应残留状态')
})

test('[活动] Telegram 的 HTML 转换：单下划线成斜体，但 my_var / __bold__ 不受影响', async () => {
  const { formatTelegramHtml } = await import('../lib/telegram/gateway.js')
  assert.equal(formatTelegramHtml('> _状态_'), '<blockquote><i>状态</i></blockquote>')
  assert.equal(formatTelegramHtml('普通的 _斜体_ 文本'), '普通的 <i>斜体</i> 文本')
  // 词内下划线（变量名）不能被当成斜体
  assert.equal(formatTelegramHtml('my_var'), 'my_var')
  assert.equal(formatTelegramHtml('a_b_c'), 'a_b_c')
  // 双下划线是加粗，不是斜体
  assert.equal(formatTelegramHtml('__bold__'), '<b>bold</b>')
})

// ---------- 并发写竞态：状态刷新不得跳到"完整目标" ----------
//
// 真机反馈（2026-10-16）："流好像一直在被反复覆盖…中间的完全没输出出来"。
// 根因：首片打字机是**逐片推进**的，而 `_stream.text` 存的是**本轮完整目标**。
// 若状态刷新渲染 text，卡片会直接跳到全文，紧接着打字机又把内容**倒回**更小的片
// → 用户看到内容反复覆盖。修复：状态刷新只渲染 `rendered`（已真正上屏的部分）。
//
// 这里做**确定性**断言（不依赖时序）：构造"目标很长、已渲染很短"的状态，
// 观察状态刷新后卡片上出现的是哪一份。
test('[活动] 应用层不再自行做打字机：每次写入都是完整累积文本（避免与飞书原生动画叠加）', async () => {
  // 真凶（2026-10-17）：飞书流式卡片自带逐字动画（print_frequency_ms=70/print_step=1）。
  // 应用层若再切片 + sleep + setContent，每次更新都会让飞书**从头重播**整段动画
  // → 用户看到"反复覆盖、重复打字"。故应用层只写入完整文本，一次调用一次写入。
  const { Context } = await import('@deepseek-ai/cordis')
  const app = new Context()
  const root = app.isolate('no-app-anim')
  for (const [n, v] of Object.entries({
    sessions: { list: () => [], get: () => undefined },
    agents: { get: () => undefined, create: async () => ({}), resume: async () => ({}), roots: () => [] },
    approval: {},
    workspaceRegistry: { archivedSessionIds: [], list: async () => [] },
    sessionPersistence: {},
  })) root.provide(n, v)
  const written = []
  root.provide('feishu', {
    status: 'online', configured: true, botInfo: { openId: 'x' },
    async openStream() { return { setContent: async (t) => { written.push(t) }, finish: async () => {} } },
    async sendText() { return { success: true } },
    async sendCard() { return { success: true } },
    async createCard() { return null },
  })
  const { FeishuConversationNode } = await import('../lib/feishu/node.js')
  const node = new FeishuConversationNode(root, { allowFrom: ['x'], changesDigest: false, showActivity: false },
    { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} })
  node._lastPeer = { peerId: 'oc', isGroup: false }
  node.activeSessionId = 's1'
  await root.emit('session/event', { id: 's1' }, { type: 'turn/start', data: { turn: 1 } })

  // 一个很长的块：只应产生 **1 次**写入（不再被应用层切成几十片）
  const longText = '这是一段很长的回复，用来确认应用层不再自行分片。'.repeat(80)
  written.length = 0
  await node.sendText(longText)
  assert.equal(written.length, 1, `长块应只写 1 次（实际 ${written.length} 次 → 会与飞书原生动画叠加成"反复打字"）`)
  assert.equal(written[0], longText, '写入内容应是完整正文')

  // 后续块同样是"累积后完整写入"、单次
  written.length = 0
  await node.sendText('第二段。')
  assert.equal(written.length, 1)
  assert.ok(written[0].includes('第二段。') && written[0].includes('这是一段很长的回复'), '两次内容都应保留')
})

// ---------- 节流不得丢状态（真机反馈：只有第一句有状态） ----------

/** 造一个记录推送的桥，用于节流测试。 */
async function makeThrottleHarness(config = {}) {
  // 注意：showActivity 现已**默认关闭**；测节流逻辑的用例需显式开启（除非用例本身在测开关）。
  config = { showActivity: true, ...config }
  const { Context } = await import('@deepseek-ai/cordis')
  const { ConversationBridge } = await import('../lib/platform/conversation-bridge.js')
  const { Platform } = await import('../lib/platform/base.js')
  const app = new Context()
  const root = app.isolate('throttle-' + Math.random().toString(36).slice(2, 8))
  for (const [n, v] of Object.entries({
    sessions: { list: () => [], get: () => undefined },
    agents: { get: () => undefined, create: async () => ({}), resume: async () => ({}), roots: () => [] },
    approval: {},
    workspaceRegistry: { archivedSessionIds: [], list: async () => [] },
    sessionPersistence: {},
  })) root.provide(n, v)
  const pushed = []
  class P extends Platform {
    constructor(o) { super(o); this.id = 'mock'; this.name = 'M'; this.status = 'connected' }
    get configured() { return true }
    get capabilities() { return { supportsGroup: true, supportsMedia: true, supportsVoice: false, supportsTyping: true, maxMessageChars: 2000 } }
    async sendText() { return { success: true } }
    async sendMediaFile() { return { success: true } }
    async sendTyping() { return { success: true } }
    async setActivityStatus(line) { pushed.push(line) }
  }
  const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
  const platform = new P({ ctx: root, logger })
  const bridge = new ConversationBridge({ ctx: root, logger, config, platform })
  bridge.activeSessionId = 's1'
  bridge._turnPeers.set('s1', { outboundPeer: { peerId: 'chat', isGroup: false }, senderId: 'u1' })
  bridge._digestState.set('s1', { startedTurns: new Set(), createdFiles: new Set() })
  const emitTool = (name, args) => root.emit('session/event', { id: 's1' }, { type: 'tool/call', data: { turn: 2, name, arguments: JSON.stringify(args) } })
  return { root, bridge, pushed, emitTool }
}

test('[活动] 节流窗口内的状态必须**延迟补发**，绝不丢弃（真机反馈：只有第一句有状态）', async () => {
  // 窗口 10 秒（确保测试期间不会到点），发 3 个不同状态
  const h = await makeThrottleHarness({ activityIntervalSec: 10 })
  h.emitTool('bash', { command: 'npm test' })     // 前缘：立即推
  h.emitTool('read', { file_path: 'a.js' })        // 窗口内 → 记为待补发
  h.emitTool('edit', { file_path: 'b.md' })        // 窗口内 → 覆盖待补发（保留最新）
  await new Promise((r) => setTimeout(r, 50))

  // 前缘 1 条已发；后 2 条合并为"最新那一条"等待补发
  assert.equal(h.pushed.length, 1, `前缘应只推 1 条，实际 ${JSON.stringify(h.pushed)}`)
  const state = h.bridge._digestState.get('s1')
  assert.ok(state.pendingActivity, '窗口内的变化必须记为待补发（不能直接丢弃）')
  assert.match(state.pendingActivity.line, /b\.md/, '待补发的应是**最新**状态')
  h.bridge.dispose()
})

test('[活动] 后缘补发：窗口到点后把最新状态发出去（不会永久丢失）', async () => {
  // 窗口 0.15 秒，便于快速验证后缘
  const h = await makeThrottleHarness({ activityIntervalSec: 0.15 })
  h.emitTool('bash', { command: 'npm test' })
  await new Promise((r) => setTimeout(r, 20))
  h.emitTool('read', { file_path: 'a.js' })
  h.emitTool('edit', { file_path: 'b.md' })
  assert.equal(h.pushed.length, 1, '前缘 1 条')
  await new Promise((r) => setTimeout(r, 220))   // 等窗口到点
  assert.equal(h.pushed.length, 2, `后缘应补发 1 条，实际 ${JSON.stringify(h.pushed)}`)
  assert.match(h.pushed.at(-1), /b\.md/, '补发的必须是最新状态')
  h.bridge.dispose()
})

test('[活动] 默认节流足够灵敏：一轮内多次工具调用可看到多条不同状态', async () => {
  // 真机反馈：默认 5 秒会把一轮的工具调用压成首尾两条 → "中间没状态"。
  // 现在默认 1 秒（且 SDK 自身按 100ms 限流、卡片原地更新不刷屏）。
  const h = await makeThrottleHarness({})   // 用默认配置
  const seq = [
    ['bash', { command: 'npm test' }, 150],
    ['read', { file_path: 'a.js' }, 150],
    ['edit', { file_path: 'b.md' }, 1200],
    ['bash', { command: 'git status' }, 1200],
  ]
  for (const [name, args, gap] of seq) {
    h.emitTool(name, args)
    await new Promise((r) => setTimeout(r, gap))
  }
  await new Promise((r) => setTimeout(r, 1200))
  assert.ok(h.pushed.length >= 3, `应看到多条状态，实际只有 ${h.pushed.length} 条：${JSON.stringify(h.pushed)}`)
  assert.match(h.pushed.at(-1), /git status/, '最后一条应对应最后一次操作')
  h.bridge.dispose()
})

// ---------- 打字机节奏：不能"每片固定等 1 秒" ----------
//
// 真机反馈（2026-10-16）："流卡了一会然后一次性出来的所有内容"。
// 根因：首片打字机把 `sleep(delayMs)` 放在**每片之后**，而 delayMs =
// min(max(config.sendChunkDelayMs ?? 200, 100), 1000)，配置默认 **1500ms** 被截成
// **1000ms/片** → 600 字回复要 3 秒才显示完，片间呈现"卡住不动"。
// 修复：整体按片数均分总时长（每片 30–250ms），保证整段尽快可见。
test('[活动] 飞书：状态不得引入"孤儿空卡片"（曾显示为 "(no content)"）', async () => {
  // 真机截图（2026-10-17）：会话里出现一张只有 "(no content)" 的卡片，且上面的卡片不停覆盖重写。
  // 成因：曾尝试"有状态就先预热建卡"，但建卡异步，一旦与"文本到达建卡"竞态，
  // 预热那张会因 _stream 已被占用而被收尾成**空卡片**（本地已复现）。
  // 现行设计（issue #77 ②）：预热卡带 **400ms 观察窗口**——窗口内正文到达 / 轮次结束
  // 会取消建卡；窗口过后才真正建卡，且 openStream 网络往返期间若状态/轮次已变，会先把
  // 状态快照写进卡片再收尾。本用例锁住不变量：任何情况下都不得出现"从未写入内容"的卡片，
  // 且所有建出的卡片都必须被收尾。
  const { Context } = await import('@deepseek-ai/cordis')
  const { activityParts } = await import('../lib/platform/activity.js')
  const app = new Context()
  const root = app.isolate('no-orphan')
  for (const [n, v] of Object.entries({
    sessions: { list: () => [], get: () => undefined },
    agents: { get: () => undefined, create: async () => ({}), resume: async () => ({}), roots: () => [] },
    approval: {},
    workspaceRegistry: { archivedSessionIds: [], list: async () => [] },
    sessionPersistence: {},
  })) root.provide(n, v)

  const cards = []
  root.provide('feishu', {
    status: 'online', configured: true, botInfo: { openId: 'x' },
    async openStream() {
      // 模拟建卡耗时，放大竞态窗口
      const c = { writes: [], finished: false }
      cards.push(c)
      await new Promise((r) => setTimeout(r, 30))
      return { setContent: async (t) => { c.writes.push(t) }, finish: async () => { c.finished = true } }
    },
    async sendText() { return { success: true } },
    async sendCard() { return { success: true } },
    async createCard() { return null },
  })
  const { FeishuConversationNode } = await import('../lib/feishu/node.js')
  const node = new FeishuConversationNode(root, { allowFrom: ['x'], changesDigest: false, activityIntervalSec: 0, warmCardDelayMs: 0 },
    { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} })
  node._lastPeer = { peerId: 'oc', isGroup: false }
  node.activeSessionId = 's1'

  await root.emit('session/event', { id: 's1' }, { type: 'turn/start', data: { turn: 1 } })
  // 关键：**不 await** 状态推送（生产里桥就是 fire-and-forget 调用 `setActivityStatus`），
  // 这样才能复现"建卡异步进行中、轮次就结束"的竞态。若 await 就测不出该 bug。
  const pushing = node.setActivityStatus(null, null, activityParts({ turn: 1, toolName: 'bash', args: { command: 'npm test' } }))
  await new Promise((r) => setTimeout(r, 5))   // 让建卡进入 await（未完成）
  await root.emit('session/event', { id: 's1' }, { type: 'turn/end', data: { reason: { kind: 'complete' } } })
  await pushing
  await new Promise((r) => setTimeout(r, 120))

  const empty = cards.filter((c) => c.writes.every((w) => !w || !w.trim()))
  assert.equal(empty.length, 0, `不得出现空卡片（飞书显示为 "(no content)"），实际 ${empty.length} 张`)
  const hanging = cards.filter((c) => !c.finished)
  assert.equal(hanging.length, 0, '所有卡片都应被收尾')
})

test('[活动] 飞书：空轮次（无正文无活动）不得留下垃圾卡片', async () => {
  const { Context } = await import('@deepseek-ai/cordis')
  const app = new Context()
  const root = app.isolate('nowarm')
  for (const [n, v] of Object.entries({
    sessions: { list: () => [], get: () => undefined },
    agents: { get: () => undefined, create: async () => ({}), resume: async () => ({}), roots: () => [] },
    approval: {},
    workspaceRegistry: { archivedSessionIds: [], list: async () => [] },
    sessionPersistence: {},
  })) root.provide(n, v)
  let opened = 0
  root.provide('feishu', {
    status: 'online', configured: true, botInfo: { openId: 'x' },
    async openStream() { opened += 1; return { setContent: async () => {}, finish: async () => {} } },
    async sendText() { return { success: true } },
    async sendCard() { return { success: true } },
    async createCard() { return null },
  })
  const { FeishuConversationNode } = await import('../lib/feishu/node.js')
  const node = new FeishuConversationNode(root, { allowFrom: ['x'], changesDigest: false },
    { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} })
  node._lastPeer = { peerId: 'oc', isGroup: false }
  node.activeSessionId = 's1'
  await root.emit('session/event', { id: 's1' }, { type: 'turn/start', data: { turn: 1 } })
  await root.emit('session/event', { id: 's1' }, { type: 'turn/end', data: { reason: { kind: 'complete' } } })
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(opened, 0, '没有任何活动/正文时不应建卡（避免会话里留空卡片）')
})

// ---------- showActivity 开关 ----------

test('[活动] showActivity=false 时不推送任何状态（用户可自行关闭）', async () => {
  const h = await makeThrottleHarness({ showActivity: false })
  h.emitTool('bash', { command: 'npm test' })
  h.emitTool('edit', { file_path: 'a.js' })
  await new Promise((r) => setTimeout(r, 30))
  assert.deepEqual(h.pushed, [], '关闭后不得推送任何状态')
  h.bridge.dispose()
})

test('[活动] showActivity 默认关闭（用户要求"只要正文"）：不传配置时零推送', async () => {
  // 用户明确要求移出状态显示。需绕过 harness 的显式开启，直接构造默认配置。
  const { Context } = await import('@deepseek-ai/cordis')
  const { ConversationBridge } = await import('../lib/platform/conversation-bridge.js')
  const { Platform } = await import('../lib/platform/base.js')
  const app = new Context()
  const root = app.isolate('default-off')
  for (const [n, v] of Object.entries({
    sessions: { list: () => [], get: () => undefined },
    agents: { get: () => undefined, create: async () => ({}), resume: async () => ({}), roots: () => [] },
    approval: {},
    workspaceRegistry: { archivedSessionIds: [], list: async () => [] },
    sessionPersistence: {},
  })) root.provide(n, v)
  const pushed = []
  class P extends Platform {
    constructor(o) { super(o); this.id = 'mock'; this.name = 'M'; this.status = 'connected' }
    get configured() { return true }
    get capabilities() { return { supportsGroup: true, supportsMedia: true, supportsVoice: false, supportsTyping: true, maxMessageChars: 2000 } }
    async sendText() { return { success: true } }
    async sendMediaFile() { return { success: true } }
    async sendTyping() { return { success: true } }
    async setActivityStatus(l) { pushed.push(l) }
  }
  const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
  const bridge = new ConversationBridge({ ctx: root, logger, config: {}, platform: new P({ ctx: root, logger }) })
  bridge.activeSessionId = 's1'
  bridge._turnPeers.set('s1', { outboundPeer: { peerId: 'chat', isGroup: false }, senderId: 'u1' })
  bridge._digestState.set('s1', { startedTurns: new Set(), createdFiles: new Set() })
  root.emit('session/event', { id: 's1' }, { type: 'tool/call', data: { turn: 1, name: 'bash', arguments: '{"command":"npm test"}' } })
  await new Promise((r) => setTimeout(r, 30))
  assert.deepEqual(pushed, [], '默认必须零推送（只要正文）')
  bridge.dispose()
})

// ---------- 打字机开销：小块不再二次分片 ----------

test('[活动] 宿主常见的文本块长度只写一次卡片（避免"反复重写"与人为延迟）', async () => {
  // 真机反馈（2026-10-17）："还是会反复重写卡片内容，而且感觉打字效果超级慢。"
  // 根因：在**宿主已分块**的内容上再按 60 字切一遍 —— 1954 字的块会变成 33 次卡片更新
  // （每次一次飞书网络调用、且全量重发）。而宿主的块间隔本来就是天然节奏。
  // 修复：小块（≤240 字）不再二次分片；大块才动效且总延迟有上限。
  const { Context } = await import('@deepseek-ai/cordis')
  const app = new Context()
  const root = app.isolate('pacing')
  for (const [n, v] of Object.entries({
    sessions: { list: () => [], get: () => undefined },
    agents: { get: () => undefined, create: async () => ({}), resume: async () => ({}), roots: () => [] },
    approval: {},
    workspaceRegistry: { archivedSessionIds: [], list: async () => [] },
    sessionPersistence: {},
  })) root.provide(n, v)
  let writes = 0
  root.provide('feishu', {
    status: 'online', configured: true, botInfo: { openId: 'x' },
    async openStream() { return { setContent: async () => { writes += 1 }, finish: async () => {} } },
    async sendText() { return { success: true } },
    async sendCard() { return { success: true } },
    async createCard() { return null },
  })
  const { FeishuConversationNode } = await import('../lib/feishu/node.js')
  const node = new FeishuConversationNode(root, { allowFrom: ['x'], changesDigest: false },
    { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} })
  node._lastPeer = { peerId: 'oc', isGroup: false }
  node.activeSessionId = 's1'
  await root.emit('session/event', { id: 's1' }, { type: 'turn/start', data: { turn: 1 } })

  // 注意：打字机只作用于**本轮首块**（后续块走累积分支、天然单次写入）。
  // 因此必须**每块都从新流开始**（收尾后再写），否则用例是"空转"、测不到分片逻辑。
  for (const len of [23, 70, 97, 181, 105, 114, 159, 202]) {
    await node._finishStream()   // 结束上一张流，让下一块重新走"首块"路径
    writes = 0
    await node.sendText('字'.repeat(len))
    assert.equal(writes, 1, `${len} 字的块应只写 1 次（实际 ${writes} 次 → 表现为"反复重写"）`)
  }
})

test('[活动] 配置恢复：showActivity 显式 false 时关闭，缺省/显式 true 时保持开启', async () => {
  const { applyRestoredPlatformConfig } = await import('../lib/platform/config-restore.js')
  // 显式 false → 关闭
  const a = {}
  applyRestoredPlatformConfig(a, { showActivity: false }, {})
  assert.equal(a.showActivity, false, '显式 false 应写为 false')
  // 显式 true → 开启
  const b = {}
  applyRestoredPlatformConfig(b, { showActivity: true }, {})
  assert.equal(b.showActivity, true)
  // 缺省 → 不写（保留构造期默认：开启）
  const c = {}
  applyRestoredPlatformConfig(c, {}, {})
  assert.equal('showActivity' in c, false, '缺省时不应写入（构造函数按 !== false 视为开启）')
})
