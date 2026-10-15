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
