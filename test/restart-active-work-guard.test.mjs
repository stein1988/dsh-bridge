// test/restart-active-work-guard.test.mjs
// 回归用例：重启前「正在跑的任务」探测与二次确认。
// 目标：有任务在跑时不静默打断（需显式确认）；探测失败也绝不阻断重启（重启是救急能力）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { BridgeService } from '../lib/index.js'
import { describeOpenTurn } from '../lib/platform/conversation-bridge.js'

const quietLogger = { info() {}, warn() {}, error() {}, debug() {} }
const makeService = () => new BridgeService({ dshPort: 3080, proxyPort: 3082, home: {}, logger: quietLogger })

const session = (id, { open = false, origin, title } = {}) => ({
  id,
  title,
  origin,
  header: { cwd: '/tmp/ws', origin },
  events: open
    ? [{ type: 'turn/start', data: { turn: 1 } }, { type: 'tool/call', data: { name: 'bash' } }]
    : [{ type: 'turn/start', data: { turn: 1 } }, { type: 'turn/end', data: {} }],
})

test('describeOpenTurn：未闭合 turn 判为在跑，已闭合判为不在跑', () => {
  assert.equal(describeOpenTurn([]), null)
  assert.equal(describeOpenTurn(undefined), null)
  assert.equal(describeOpenTurn([{ type: 'turn/start', data: { turn: 1 } }, { type: 'turn/end', data: {} }]), null)
  const open = describeOpenTurn([{ type: 'turn/start', data: { turn: 3 } }, { type: 'tool/call', data: { name: 'grep' } }])
  assert.equal(open.turn, 3)
  assert.equal(open.tools, 1)
  assert.equal(open.lastTool, 'grep')
})

test('已结束的会话不计入运行中任务', () => {
  const svc = makeService()
  svc.runtimeCtx = { sessions: { list: () => [session('s1', { open: false }), session('s2', { open: true })] } }
  const w = svc.getActiveWork()
  assert.equal(w.total, 1)
  assert.equal(w.sessions.length, 1)
  assert.equal(w.sessions[0].id, 's2')
})

test('子代理会话单独归类（嵌套委托最易被遗忘）', () => {
  const svc = makeService()
  svc.runtimeCtx = {
    sessions: {
      list: () => [session('m', { open: true }), session('sub', { open: true, origin: 'subagent' })],
    },
  }
  const w = svc.getActiveWork()
  assert.equal(w.sessions.length, 1)
  assert.equal(w.subagentSessions.length, 1)
  assert.equal(w.subagentSessions[0].id, 'sub')
  assert.equal(w.total, 2)
})

test('IM 待审批请求被计入（重启会丢掉待审批状态）', () => {
  const svc = makeService()
  const pending = new Map([[1, { summary: '执行危险命令' }], [2, { tool: 'write' }]])
  svc.platformManager = { list: () => [{ id: 'telegram', bridge: { pending } }] }
  const w = svc.getActiveWork()
  assert.equal(w.pendingApprovals.length, 2)
  assert.equal(w.total, 2)
  assert.match(w.pendingApprovals[0].summary, /执行危险命令/)
})

test('无任务时 total 为 0（重启无需确认）', () => {
  const svc = makeService()
  svc.runtimeCtx = { sessions: { list: () => [session('s', { open: false })] } }
  assert.equal(svc.getActiveWork().total, 0)
})

// ---- 以下为「探测失败不得阻断重启」的护栏 ----

test('无运行时引用时安全返回空（不抛错）', () => {
  assert.deepEqual(makeService().getActiveWork(), {
    sessions: [], subagentSessions: [], pendingApprovals: [], total: 0,
  })
})

test('sessions.list 抛错时降级为空，不阻断重启', () => {
  const svc = makeService()
  svc.runtimeCtx = { sessions: { list: () => { throw new Error('boom') } } }
  assert.equal(svc.getActiveWork().total, 0)
})

test('platformManager.list 抛错时仍保留会话探测结果', () => {
  const svc = makeService()
  svc.runtimeCtx = { sessions: { list: () => [session('s', { open: true })] } }
  svc.platformManager = { list: () => { throw new Error('boom') } }
  const w = svc.getActiveWork()
  assert.equal(w.sessions.length, 1)
  assert.equal(w.pendingApprovals.length, 0)
  assert.equal(w.total, 1)
})

test('事件流缺失或含 null 元素时不抛错', () => {
  const svc = makeService()
  svc.runtimeCtx = { sessions: { list: () => [{ id: 'a', events: [] }, { id: 'b' }, null, undefined] } }
  assert.equal(svc.getActiveWork().total, 0)
})

test('会话缺 id 时跳过（避免生成不可用于展示的条目）', () => {
  const svc = makeService()
  svc.runtimeCtx = {
    sessions: { list: () => [{ events: [{ type: 'turn/start', data: { turn: 1 } }] }, session('ok', { open: true })] },
  }
  const w = svc.getActiveWork()
  assert.equal(w.sessions.length, 1)
  assert.equal(w.sessions[0].id, 'ok')
})
