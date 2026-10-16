// test/feishu-ask-card.test.mjs
// 飞书「Agent 提问」卡片的**结构**回归。
//
// 为什么单独测结构：卡片是纯数据（JSON），结构错误在单测里就能发现，不必等真机。
// 两个已发生过的真实问题：
//   1. 选项按钮塞进 column_set/column(weighted) → 按钮被压窄，长文字被截断成
//      「现在发布 …」（2026-10-16 真机截图确认）；应改用 width: 'fill' 整行铺满。
//   2. 图片附件无文件名时一律存成 .png，而飞书图片实为 JPEG → 扩展名与字节不符，
//      查看器报"格式不符"、用户打不开。应按魔数校正。
import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'

const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }

/** 起一个最小飞书节点（只验证卡片结构，不需要真实连接）。 */
async function makeFeishuNode() {
  const app = new Context()
  const root = app.isolate('feishu-card-test')
  for (const [n, v] of Object.entries({
    sessions: { list: () => [], get: () => undefined },
    agents: { get: () => undefined, create: async () => ({}), resume: async () => ({}), roots: () => [] },
    approval: {},
    workspaceRegistry: { archivedSessionIds: [], list: async () => [] },
    sessionPersistence: {},
  })) root.provide(n, v)

  const sent = []
  root.provide('feishu', {
    status: 'online',
    configured: true,
    botInfo: { openId: 'ou_bot' },
    async sendCard(to, card) { sent.push({ to, card }); return { success: true } },
    async sendText() { return { success: true } },
    async createCard() { return null },
    async downloadResourceToFile() { return { bytesWritten: 1 } },
  })
  const { FeishuConversationNode } = await import('../lib/feishu/node.js')
  const node = new FeishuConversationNode(root, { allowFrom: ['ou_me'], changesDigest: false }, logger)
  node.peerId = 'oc_chat'
  return { node, sent }
}

const QUESTION = () => ({
  id: 'release',
  header: '发布 v2.14.1',
  question: '这批改动是否现在发布 v2.14.1？',
  detail: '会打 tag 并 npm publish',
  options: [
    { label: '现在发布 (Recommended)', description: '同步更新 CHANGELOG 与发布说明' },
    { label: '先不发布', description: '继续攒改动，等你说发再发' },
    { label: '先只推代码不发布' },
  ],
})

test('[飞书提问卡片] 选项按钮整行铺满（width: fill），不塞进 column_set 被压窄', async () => {
  const { node, sent } = await makeFeishuNode()
  const entry = { number: 1, questions: [QUESTION()], timeoutSec: 0 }
  const ok = await node.sendAskCard({ peerId: 'oc_chat', isGroup: false }, QUESTION(), entry)
  assert.equal(ok, true)
  const card = sent[0].card

  const buttons = card.body.elements.filter((e) => e.tag === 'button')
  assert.equal(buttons.length, 3, '每个选项一个按钮')

  for (const b of buttons) {
    // 核心回归：必须是 fill，否则列容器会按权重压窄按钮、文字被截断
    assert.equal(b.width, 'fill', `按钮应整行铺满，实际 width=${b.width}`)
    // 不得再用 column_set 包按钮（那是被压窄的根因）
    assert.notEqual(b.tag, 'column')
  }
  // 卡片里不应再出现用于压缩宽度的 column_set
  assert.equal(card.body.elements.filter((e) => e.tag === 'column_set').length, 0,
    '不得用 column_set 约束按钮宽度（会导致选项文字被截断）')
})

test('[飞书提问卡片] 选项全文进正文（markdown 不截断），按钮只放短标签', async () => {
  const { node, sent } = await makeFeishuNode()
  const q = QUESTION()
  const entry = { number: 1, questions: [q], timeoutSec: 0 }
  await node.sendAskCard({ peerId: 'oc_chat', isGroup: false }, q, entry)
  const card = sent[0].card
  const buttons = card.body.elements.filter((e) => e.tag === 'button')
  const body = card.body.elements.filter((e) => e.tag === 'markdown').map((e) => e.content).join('\n')

  // 关键回归（2026-10-16 两次真机截图）：飞书**按钮文字有平台级单行截断**（约 13 字），
  // `width: fill` 只能加宽、不能避免截断。故选项全文必须进正文，按钮只放短标签。
  assert.match(body, /1\. ⭐ 现在发布/, '正文应含完整选项一（含推荐星标）')
  assert.match(body, /现在发布 \(Recommended\)/, '正文应保留推荐标注')
  assert.match(body, /同步更新 CHANGELOG 与发布说明/, '正文应含选项描述')
  assert.match(body, /2\. 先不发布/, '正文应含选项二')
  assert.match(body, /3\. 先只推代码不发布/, '正文应含选项三')

  // 按钮保持简短（主动压到 12 字内），不依赖"平台到底截多少"
  for (const b of buttons) {
    const t = b.text.content
    assert.ok(t.length <= 16, `按钮文字应保持简短以免被平台截断，实际「${t}」(${t.length})`)
  }
  assert.match(buttons[0].text.content, /^⭐ 1\./, '推荐项按钮带星标与序号')
  // 按钮 value 必须带齐回调所需字段（否则点击无反应）
  assert.deepEqual(buttons[2].value, { action: 'ask', askId: 1, askOption: 2 })
  // 推荐项用 primary 高亮
  assert.equal(buttons[0].type, 'primary')
  assert.equal(buttons[2].type, 'default')
})

test('[飞书提问卡片] 卡片保留文字回退提示与问题正文', async () => {
  const { node, sent } = await makeFeishuNode()
  const q = QUESTION()
  await node.sendAskCard({ peerId: 'oc_chat', isGroup: false }, q, { number: 1, questions: [q], timeoutSec: 0 })
  const card = sent[0].card
  const md = card.body.elements.filter((e) => e.tag === 'markdown').map((e) => e.content).join('\n')
  assert.match(md, /这批改动是否现在发布/)
  assert.match(md, /会打 tag 并 npm publish/)
  assert.match(md, /\/ask 1/, '应提示文字作答方式')
  assert.match(card.header.title.content, /需要你的决定/)
})

// ---------- 图片附件扩展名校正 ----------

test('[飞书附件] 无文件名的 JPEG 图片应存成 .jpg（旧实现一律 .png）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-feishu-ext-'))
  try {
    const jpegMagic = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01])
    writeFileSync(join(dir, 'shot.png'), jpegMagic)   // 名字是 .png，内容是 JPEG

    const { node } = await makeFeishuNode()
    // 通过 _processMedia 走真实路径（SDK 下载替换为本地已有文件）
    node.gateway = {
      async downloadResourceToFile(_mid, _key, _type, filePath) {
        writeFileSync(filePath, jpegMagic)
        return { bytesWritten: jpegMagic.length }
      },
    }
    const out = await node._processMedia(
      { messageId: 'm1', resources: [{ type: 'image', fileKey: 'k1' }] },
      dir,
    )
    assert.equal(out.length, 1)
    assert.match(out[0].filename, /\.jpg$/, `应按魔数校正为 .jpg，实际 ${out[0].filename}`)
    assert.ok(existsSync(out[0].path), '校正后的文件应存在')
    assert.equal(existsSync(join(dir, '.feishu-media', 'shot.png')), false, '旧的错误扩展名文件应已改名')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('[飞书附件] 用户明确给的文件名不被改写；占位扩展名才按魔数补全', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-feishu-ext2-'))
  try {
    const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])
    const { node } = await makeFeishuNode()
    node.gateway = {
      async downloadResourceToFile(_mid, _key, _type, filePath) {
        writeFileSync(filePath, pngMagic)
        return { bytesWritten: pngMagic.length }
      },
    }
    // 图片：PNG 魔数 → 保持 .png
    const imgs = await node._processMedia({ messageId: 'm2', resources: [{ type: 'image', fileKey: 'k2' }] }, dir)
    assert.match(imgs[0].filename, /\.png$/)

    // 用户明确给了扩展名（.zip）→ 尊重原样，不按内容改成 .png
    // （避免"自作聪明"改掉用户/发送方明确的名字；解压软件看的是内容，不看重扩展名）
    const named = await node._processMedia(
      { messageId: 'm3', resources: [{ type: 'file', fileKey: 'k3', fileName: 'archive.zip' }] },
      dir,
    )
    assert.equal(named[0].filename, 'archive.zip', '明确给出的文件名不应被改写')
    assert.equal(readFileSync(named[0].path).length, pngMagic.length)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------- 用户发来「文件」（而非图片）的场景 ----------
//
// 触发这次补测的提问：「如果我发送的不是图片，是个文件呢？」
// SDK 的 ResourceDescriptor.fileName 是**可选**的（见 channel-sdk 类型定义），
// 因此"文件没有名字"是真实可达的；旧实现会退化成无意义的 `.bin`。

test('[飞书附件] 文件带文件名：原样保留（含中文与 .pdf）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-file-named-'))
  try {
    const pdf = Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\nbody')
    const { node } = await makeFeishuNode()
    node.gateway = {
      async downloadResourceToFile(_m, _k, _t, p) { writeFileSync(p, pdf); return { bytesWritten: pdf.length } },
    }
    const out = await node._processMedia({ messageId: 'f1', resources: [{ type: 'file', fileKey: 'k', fileName: '季度报告.pdf' }] }, dir)
    assert.equal(out[0].filename, '季度报告.pdf', '用户给的文件名应原样保留')
    assert.match(out[0].path, /季度报告\.pdf$/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('[飞书附件] 文件无文件名：按魔数补全扩展名，不退化成 .bin', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-file-noname-'))
  try {
    const { node } = await makeFeishuNode()
    const cases = [
      { bytes: Buffer.from('%PDF-1.7\n...'), want: /\.pdf$/, name: 'PDF' },
      { bytes: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]), want: /\.zip$/, name: 'ZIP/docx' },
      { bytes: Buffer.from([0x1f, 0x8b, 0x08, 0x00]), want: /\.gz$/, name: 'gzip' },
    ]
    for (const c of cases) {
      node.gateway = {
        async downloadResourceToFile(_m, _k, _t, p) { writeFileSync(p, c.bytes); return { bytesWritten: c.bytes.length } },
      }
      const out = await node._processMedia({ messageId: `n-${c.name}`, resources: [{ type: 'file', fileKey: 'k' }] }, dir)
      assert.match(out[0].filename, c.want, `${c.name} 应按魔数补全扩展名，实际 ${out[0].filename}`)
      assert.doesNotMatch(out[0].filename, /\.bin$/, `${c.name} 不应退化成 .bin`)
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('[飞书附件] 无法识别的格式保持 .bin（宁可留占位，也不瞎猜）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-file-unknown-'))
  try {
    const { node } = await makeFeishuNode()
    const weird = Buffer.from('just some text, no magic bytes at all')
    node.gateway = {
      async downloadResourceToFile(_m, _k, _t, p) { writeFileSync(p, weird); return { bytesWritten: weird.length } },
    }
    const out = await node._processMedia({ messageId: 'u1', resources: [{ type: 'file', fileKey: 'k' }] }, dir)
    assert.match(out[0].filename, /\.bin$/, '识别不出格式时应保持 .bin，不猜')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('[飞书附件] 音视频同理：无文件名时按魔数识别，带名字则保留', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-file-av-'))
  try {
    const { node } = await makeFeishuNode()
    const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.from([0, 0, 0, 0])])
    node.gateway = {
      async downloadResourceToFile(_m, _k, _t, p) { writeFileSync(p, mp4); return { bytesWritten: mp4.length } },
    }
    const noName = await node._processMedia({ messageId: 'av1', resources: [{ type: 'video', fileKey: 'k' }] }, dir)
    assert.match(noName[0].filename, /\.mp4$/, `无文件名视频应按魔数识别，实际 ${noName[0].filename}`)

    const named = await node._processMedia(
      { messageId: 'av2', resources: [{ type: 'video', fileKey: 'k', fileName: '录屏.mov' }] },
      dir,
    )
    assert.equal(named[0].filename, '录屏.mov', '带名字的视频保留原名')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('[飞书提问卡片] 超长选项：正文完整、按钮仍简短（平台会单行截断按钮）', async () => {
  const { node, sent } = await makeFeishuNode()
  const longLabel = '选项一：完整的按钮文字应该完整显示不被截断（含这段说明）'
  const q = {
    id: 'long',
    question: '选项文字是否完整显示了？',
    options: [
      { label: longLabel, description: '这一段描述相当长，用来验证按钮文字不会再被截断成省略号' },
      { label: '选项二：另一段同样很长的选项文字用来确认每个按钮都完整' },
      { label: '选项三：短选项作为对照' },
    ],
  }
  await node.sendAskCard({ peerId: 'oc_chat', isGroup: false }, q, { number: 1, questions: [q], timeoutSec: 0 })
  const card = sent[0].card
  const body = card.body.elements.filter((e) => e.tag === 'markdown').map((e) => e.content).join('\n')
  const buttons = card.body.elements.filter((e) => e.tag === 'button')

  // 完整长标签必须能在正文里读到（这是"信息不丢失"的保证）
  assert.ok(body.includes(longLabel), '正文必须包含完整选项文字')
  // 而按钮不能长到被平台截断 —— 历史事故就是按钮里放了长文字
  for (const b of buttons) {
    assert.ok(b.text.content.length <= 16, `按钮应简短，实际「${b.text.content}」(${b.text.content.length})`)
    assert.doesNotMatch(b.text.content, /…$/, '按钮不应以省略号结尾（那是被截断的表现）')
  }
})

// ---------- 同一轮内多次出站必须**累积**，不能覆盖 ----------
//
// 真机反馈（2026-10-16）："消息流输出一半，然后又突然全部消失，又重新输出…只保留了最后一条"。
// 根因：宿主对每个 step 发一条独立的 assistant/message（该步片段，非整轮全文），
// 旧实现直接用最新片段 setContent 覆盖整张卡片。

test('[飞书流式] 同一轮内多次输出必须累积，旧内容不能被覆盖', async () => {
  const { node } = await makeFeishuNode()
  const sets = []
  let finished = 0
  node.gateway = {
    async openStream() {
      return {
        setContent: async (t) => { sets.push(t) },
        finish: async () => { finished += 1 },
      }
    },
  }
  node._inTurn = true
  const peer = { peerId: 'oc_chat' }
  await node._sendTurnOutput('oc_chat', '第一段：正在分析', peer)
  await node._sendTurnOutput('oc_chat', '第二段：找到问题了', peer)
  await node._sendTurnOutput('oc_chat', '第三段：已经修复', peer)

  // 最后一次写入必须已包含全部三段（累积），而不是只剩最后一段
  const last = sets.at(-1)
  assert.match(last, /第一段/)
  assert.match(last, /第二段/)
  assert.match(last, /第三段/)
  assert.equal(node._stream.text, '第一段：正在分析\n\n第二段：找到问题了\n\n第三段：已经修复')
  await node._finishStream()
  assert.equal(finished, 1)
})

test('[飞书流式] 新轮次开始时内容重新计（不把上一轮文本带进来）', async () => {
  const { node } = await makeFeishuNode()
  const sets = []
  node.gateway = {
    async openStream() {
      return { setContent: async (t) => { sets.push(t) }, finish: async () => {} }
    },
  }
  await node._sendTurnOutput('oc_chat', '第一轮内容', { peerId: 'oc_chat' })
  await node._finishStream()
  sets.length = 0
  await node._sendTurnOutput('oc_chat', '第二轮内容', { peerId: 'oc_chat' })
  const last = sets.at(-1)
  assert.match(last, /第二轮内容/)
  assert.doesNotMatch(last, /第一轮内容/, '新轮次不应携带上一轮文本')
  await node._finishStream()
})

test('[飞书流式] 切换会话目标时不串台（旧卡片先收尾、内容重置）', async () => {
  const { node } = await makeFeishuNode()
  const sets = []
  let finished = 0
  node.gateway = {
    async openStream() {
      return { setContent: async (t) => { sets.push(t) }, finish: async () => { finished += 1 } }
    },
  }
  await node._sendTurnOutput('chat-a', 'A 会话内容', { peerId: 'chat-a' })
  await node._sendTurnOutput('chat-b', 'B 会话内容', { peerId: 'chat-b' })
  assert.equal(finished, 1, '切目标时应先收尾旧卡片')
  const last = sets.at(-1)
  assert.match(last, /B 会话内容/)
  assert.doesNotMatch(last, /A 会话内容/, '不同会话不得串台')
  await node._finishStream()
})

test('[飞书流式] 若调用方传入的已是累积全文，则直接替换（不重复拼接）', async () => {
  const { node } = await makeFeishuNode()
  const sets = []
  node.gateway = {
    async openStream() {
      return { setContent: async (t) => { sets.push(t) }, finish: async () => {} }
    },
  }
  // 形态 2：第二条 content 已包含第一条（调用方自己累积过）
  await node._sendTurnOutput('oc_chat', '正在思考...', { peerId: 'oc_chat' })
  await node._sendTurnOutput('oc_chat', '正在思考...\n已完成代码生成', { peerId: 'oc_chat' })
  const last = sets.at(-1)
  assert.equal(last, '正在思考...\n已完成代码生成', '已累积全文应原样替换，不得重复拼接')
  assert.equal((last.match(/正在思考/g) || []).length, 1, '"正在思考" 不应出现两次')
  await node._finishStream()
})
