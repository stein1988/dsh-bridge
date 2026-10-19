// 更新提示内容归一化（issue #78/#79 发布后用户反馈：旧 releaseNotes 是一整段长文，卡片里显示成一坨）
//
// 被测函数 `formatReleaseNotes` 位于 client/index.js（客户端 bundle 由 esbuild 打包，
// 不能直接 import），这里沿用仓库既有做法：从源码抽取函数体后 `new Function` 执行，
// 断言纯函数行为，不依赖 React/DOM。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const clientSource = readFileSync(resolve(repoRoot, 'client/index.js'), 'utf8')

/** 从源码里按大括号配对抽出 `function formatReleaseNotes(...) { ... }` 的完整源码。 */
function extractFormatReleaseNotes(source) {
  const anchor = 'function formatReleaseNotes('
  const start = source.indexOf(anchor)
  assert.notEqual(start, -1, 'client/index.js 必须包含 formatReleaseNotes 函数')
  const bodyStart = source.indexOf('{', start)
  assert.notEqual(bodyStart, -1, 'formatReleaseNotes 必须有函数体')
  let depth = 0
  for (let i = bodyStart; i < source.length; i += 1) {
    const ch = source[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error('formatReleaseNotes 函数体不完整（大括号未闭合）')
}

const formatReleaseNotes = new Function(`${extractFormatReleaseNotes(clientSource)}; return formatReleaseNotes;`)()

test('formatReleaseNotes：去掉【vX.Y.Z】版本前缀（卡片标题已有版本号，避免重复）', () => {
  assert.deepEqual(formatReleaseNotes('【v2.15.0】\n• 支持英文界面'), ['支持英文界面'])
  assert.deepEqual(formatReleaseNotes('【 v2.14.0 】新增功能'), ['新增功能'])
})

test('formatReleaseNotes：新格式按行返回要点，去掉项目符号与首尾空白', () => {
  const notes = '【v2.15.0】\n• 同平台多账号\n• 英文界面\n\n• 桌面端修复'
  assert.deepEqual(formatReleaseNotes(notes), ['同平台多账号', '英文界面', '桌面端修复'])
})

test('formatReleaseNotes：旧格式一整段（超过 80 字）按分号拆句，去掉句末句号', () => {
  // 历史版本的 releaseNotes 是 300+ 字一整段（无换行），面板里会挤成一坨；
  // 超过 80 字时按分号拆成多条要点，短段（< 80 字）保持单条不拆。
  const legacy = '【v2.14.0】飞书链路整体重做：底层从自写协议栈全面替换为飞书官方 Channel SDK，长连接、事件归一化、消息渲染与分片、流式卡片全部官方实现；接入方式从进开发者后台逐项配置变成手机扫码一键创建应用；并修复单聊出站全量丢失、鸿蒙端表格不渲染等问题。'
  const lines = formatReleaseNotes(legacy)
  assert.ok(lines.length >= 2, `旧格式长段应拆成多条，实际: ${JSON.stringify(lines)}`)
  assert.equal(lines[0], '飞书链路整体重做：底层从自写协议栈全面替换为飞书官方 Channel SDK，长连接、事件归一化、消息渲染与分片、流式卡片全部官方实现')
  assert.ok(lines.every((line) => !line.endsWith('。')), '句末句号应被去掉')
})

test('formatReleaseNotes：去掉 Markdown 强调符、合并多余空白', () => {
  assert.deepEqual(formatReleaseNotes('【v2.14.2】\n• **同一轮内容被覆盖**  已修复'), ['同一轮内容被覆盖 已修复'])
})

test('formatReleaseNotes：最多 8 条、每条最多 120 字（超出省略）', () => {
  const many = Array.from({ length: 12 }, (_, i) => `• 第 ${i + 1} 条`).join('\n')
  assert.equal(formatReleaseNotes(many).length, 8)
  const long = '一'.repeat(300)
  const [only] = formatReleaseNotes(long)
  assert.equal(only.length, 119, '超长条目应截断为 118 字 + 省略号')
  assert.ok(only.endsWith('…'))
})

test('formatReleaseNotes：空值/非字符串返回空数组（面板不渲染更新亮点块）', () => {
  for (const value of [null, undefined, '', '   ', 42, {}, []]) {
    assert.deepEqual(formatReleaseNotes(value), [])
  }
})
