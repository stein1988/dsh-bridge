// 改动摘要 / patch 文本生成（纯函数）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatChangesDigest, buildUnifiedPatch, changesPatchFileName } from '../lib/platform/changes-digest.js'

const summary = (over = {}) => ({
  turn: 3, cwd: '/w', total: 2, added: 12, deleted: 4,
  files: [
    { path: 'src/a.js', display: 'src/a.js', added: 10, deleted: 4 },
    { path: 'src/b.css', display: 'src/b.css', added: 2, deleted: 0 },
  ],
  ...over,
})

test('[改动摘要] 正常生成：头部统计 + 逐文件行', () => {
  const text = formatChangesDigest(summary())
  assert.match(text, /📝 \*\*本轮改动\*\* 2 个文件（\+12\/-4）/)
  assert.match(text, /- `src\/a\.js` \+10\/-4/)
  assert.match(text, /- `src\/b\.css` \+2\/-0/)
})

test('[改动摘要] 无改动 / 空数据 → 空串（调用方据此静默）', () => {
  assert.equal(formatChangesDigest(null), '')
  assert.equal(formatChangesDigest(undefined), '')
  assert.equal(formatChangesDigest({ total: 0, files: [] }), '')
})

test('[改动摘要] 超过上限时折成"共 N 个"，并标注二进制/过大', () => {
  const files = Array.from({ length: 12 }, (_, i) => ({ path: `f${i}`, display: `f${i}`, added: 1, deleted: 0 }))
  files[0] = { path: 'bin.png', display: 'bin.png', binary: true }
  files[1] = { path: 'big.zip', display: 'big.zip', oversized: true }
  const text = formatChangesDigest({ turn: 1, total: 12, added: 10, deleted: 0, files }, { maxFiles: 5 })
  assert.match(text, /12 个文件/)
  assert.match(text, /二进制/)
  assert.match(text, /过大，未统计/)
  assert.match(text, /…共 12 个（其余 7 个未逐条列出）/)
})

test('[改动摘要] 路径含反引号时不会破坏 Markdown', () => {
  const text = formatChangesDigest(summary({ files: [{ path: 'a`b.js', display: 'a`b.js', added: 1, deleted: 0 }], total: 1 }))
  assert.ok(!text.includes('`a`b.js`'), '路径里的反引号应被剔除')
})

test('[patch] 生成 diff --git / hunk；二进制与缺 diff 有说明', () => {
  const s = summary()
  const diffs = [
    { kind: 'text', path: 'src/a.js', display: 'src/a.js', hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, lines: [' ctx', '-old', '+new', '+more'] }] },
    { kind: 'binary', path: 'src/b.css', display: 'src/b.css' },
  ]
  const patch = buildUnifiedPatch(s, diffs)
  assert.match(patch, /diff --git a\/src\/a\.js b\/src\/a\.js/)
  assert.match(patch, /@@ -1,2 \+1,3 @@/)
  assert.match(patch, /\+new/)
  assert.match(patch, /二进制文件，无行级 diff/)
  assert.match(patch, /共 2 个文件，\+12\/-4/)
})

test('[patch] 文件名带轮次', () => {
  assert.equal(changesPatchFileName(7), 'changes-turn-7.patch')
  assert.equal(changesPatchFileName(undefined), 'changes-turn-0.patch')
})

// ---------------------------------------------------------------------------
// 时序回归：宿主 append() 同步广播、之后才 records.set()
//
// 真机现象：改动摘要从来没出现过。根因是 dsh-workspace-changes 的顺序——
//   const event = session.append('workspace/changes', ...)  // 同步通知我们
//   records.set(event.seq, { summary })                     // 通知之后才登记
// 我们的回调若「同步」调用 workspaceChanges.summary()，必然拿到 undefined，
// 于是每轮都被 `!summary?.total` 静默跳过。
//
// 本用例锁死：必须让出微任务后再读，才能拿到摘要。
// ---------------------------------------------------------------------------
test('[改动摘要] 时序：宿主先广播后登记，必须延后一个微任务读取', async () => {
  // 模拟宿主：records 在「广播返回之后」才写入
  const records = new Map()
  const workspaceChanges = { summary: (_sid, seq) => records.get(seq)?.summary }

  const broadcast = async (listener, event, summary) => {
    // 同步通知（宿主 commit 是同步的）
    const p = listener(event)
    // 通知返回后才登记
    records.set(event.seq, { summary })
    await p
  }

  const capturedSync = []
  const capturedAsync = []
  let announce = null
  const mkBridge = (read) => ({
    config: { changesDigest: true },
    _changesSvc: workspaceChanges,
    _lastChanges: new Map(),
    _changesAnnounced: new Map(),
    _rememberBounded(map, k, v) { map.set(k, v) },
    platform: { id: 'qq' },
    logger: { info() {}, debug() {} },
    async sendText() {},
    async _announceChanges(session, event) {
      const svc = this._changesSvc
      const seq = event?.seq
      if (!svc?.summary || !session?.id || seq == null) return
      if (read === 'defer') await Promise.resolve()   // 修复后的读法
      const summary = svc.summary(session.id, seq)
      if (!summary?.total) return
      ;(read === 'defer' ? capturedAsync : capturedSync).push(summary)
    },
  })

  const session = { id: 's1' }
  const event = { type: 'workspace/changes', seq: 100 }

  // 旧读法（同步）
  const oldBridge = mkBridge('sync')
  await broadcast((e) => oldBridge._announceChanges(session, e), event, { turn: 5, total: 2, files: [], added: 1, deleted: 0 })
  assert.equal(capturedSync.length, 0, '同步读取必然拿不到（这正是历史 bug 的成因）')

  // 新读法（延后一个微任务）
  const newBridge = mkBridge('defer')
  await broadcast((e) => newBridge._announceChanges(session, e), event, { turn: 5, total: 2, files: [], added: 1, deleted: 0 })
  assert.equal(capturedAsync.length, 1, '延后微任务后必须能拿到摘要')
  assert.equal(capturedAsync[0].turn, 5)
})
