// test/ask-user.test.mjs
// Agent 决策问答（ask_user_question / 计划审批）——**平台无关核心**的单元测试。
//
// 背景：DSH 把"Agent 需要用户做个决定"收敛到 `user-questions/request` waterfall；
// 本插件此前完全没注册该钩子，IM 用户看不到任何提问。新实现的渲染/解析/校验都放在
// lib/platform/ask-user.js（纯函数），这里覆盖它的边界——尤其是**手机端输入**的各种写法。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  canRenderAsButtons,
  formatAnswerAck,
  formatAskPrompt,
  isPlanReview,
  parseAskReply,
  questionTitle,
  validateAnswerBatch,
  MAX_CARD_OPTIONS,
} from '../lib/platform/ask-user.js'

const single = () => ([{
  id: 'deploy',
  question: '用哪种部署方式？',
  header: '部署',
  detail: '影响后续发布流程',
  options: [
    { label: 'Docker (Recommended)', description: '最省事' },
    { label: '裸机' },
    { label: 'K8s' },
  ],
}])

const multi = () => ([
  { id: 'q1', question: '部署方式？', options: [{ label: 'Docker' }, { label: '裸机' }] },
  { id: 'q2', question: '要开监控吗？', options: [{ label: '要' }, { label: '不要' }], multiSelect: true },
])

test('[ask] 标题优先 header，缺失时退化为问题正文单行', () => {
  assert.equal(questionTitle({ id: 'a', question: '很长的问题正文', header: '部署' }), '部署')
  assert.equal(questionTitle({ id: 'a', question: '没有 header 的问题' }), '没有 header 的问题')
  assert.ok(questionTitle({ id: 'a', question: 'x'.repeat(200) }).length <= 60, '过长标题应截断')
})

test('[ask] 计划审批靠 intent.kind === plan-review 识别（与宿主同一判据）', () => {
  assert.equal(isPlanReview({ intent: { kind: 'plan-review' } }), true)
  assert.equal(isPlanReview({ intent: { kind: 'other' } }), false)
  assert.equal(isPlanReview({}), false)
  assert.equal(isPlanReview(null), false)
})

test('[ask] 何时能用按钮：单问单选且选项数适中', () => {
  assert.equal(canRenderAsButtons(single()[0]), true)
  // 无选项 → 只能自由输入，按钮无能为力
  assert.equal(canRenderAsButtons({ id: 'a', question: '?', options: [] }), false)
  assert.equal(canRenderAsButtons({ id: 'a', question: '?' }), false)
  // 多选交回文字（首版取舍：卡片上多选交互易误导）
  assert.equal(canRenderAsButtons({ id: 'a', question: '?', options: [{ label: 'x' }], multiSelect: true }), false)
  // 选项过多：IM 卡片放不下，退回文字
  const many = { id: 'a', question: '?', options: Array.from({ length: MAX_CARD_OPTIONS + 1 }, (_, i) => ({ label: `o${i}` })) }
  assert.equal(canRenderAsButtons(many), false)
  assert.equal(canRenderAsButtons({ ...many, options: many.options.slice(0, MAX_CARD_OPTIONS) }), true)
})

test('[ask] 提示文本包含问题、选项编号、推荐标注与作答方式', () => {
  const text = formatAskPrompt(single(), { number: 2 })
  assert.match(text, /需要你的决定/)
  assert.match(text, /#2/)
  assert.match(text, /Q1\. 部署/)
  assert.match(text, /影响后续发布流程/)
  assert.match(text, /`1` Docker \(Recommended\) ⭐/)
  assert.match(text, /`2` 裸机/)
  assert.match(text, /\/ask 1/)
  assert.match(text, /\/ask =你的答案/)
})

test('[ask] 提示文本：计划审批用不同标题；多问给出按序作答说明', () => {
  const plan = formatAskPrompt([{ id: 'p', question: '执行计划？', intent: { kind: 'plan-review' }, options: [{ label: '批准' }] }], { number: 1 })
  assert.match(plan, /计划待确认/)
  const many = formatAskPrompt(multi(), { number: 3 })
  assert.match(many, /逐个作答/)
  assert.match(many, /2=1/)
})

test('[ask] 解析：单问数字选项 / 自由输入 / 字母编号', () => {
  assert.deepEqual(parseAskReply('/ask 1', single()), { ok: true, answers: [{ id: 'deploy', selected: ['Docker (Recommended)'] }] })
  assert.deepEqual(parseAskReply('2', single()), { ok: true, answers: [{ id: 'deploy', selected: ['裸机'] }] })
  // 自由输入：`=xxx` 形式（带 /ask 前缀）
  assert.deepEqual(parseAskReply('/ask =私有云方案', single()), { ok: true, answers: [{ id: 'deploy', selected: [], custom: '私有云方案' }] })
  // 自由输入：非数字内容一律当 custom（手机端用户很可能直接打字）
  assert.deepEqual(parseAskReply('我们自己的私有云', single()), { ok: true, answers: [{ id: 'deploy', selected: [], custom: '我们自己的私有云' }] })
  // 字母编号
  assert.deepEqual(parseAskReply('/ask b', single()), { ok: true, answers: [{ id: 'deploy', selected: ['裸机'] }] })
})

test('[ask] 解析：多问 —— 按序 / 指定编号 / 跳过 / 混合', () => {
  assert.deepEqual(parseAskReply('/ask 1; 2', multi()), {
    ok: true,
    answers: [
      { id: 'q1', selected: ['Docker'] },
      { id: 'q2', selected: ['不要'] },
    ],
  })
  // 只答第二问：第一问留空 → 显式跳过（selected 空、无 custom）
  assert.deepEqual(parseAskReply('/ask 2=1', multi()), {
    ok: true,
    answers: [
      { id: 'q1', selected: [] },
      { id: 'q2', selected: ['要'] },
    ],
  })
  // 混合：位置式 + 指定式 + 自由文本
  const mixed = parseAskReply('/ask 1; 2=自由输入的内容', multi())
  assert.deepEqual(mixed, {
    ok: true,
    answers: [
      { id: 'q1', selected: ['Docker'] },
      { id: 'q2', selected: [], custom: '自由输入的内容' },
    ],
  })
})

test('[ask] 解析：多选（仅 multiSelect 允许），否则报错', () => {
  assert.deepEqual(parseAskReply('/ask 1; 2=1,2', multi()), {
    ok: true,
    answers: [
      { id: 'q1', selected: ['Docker'] },
      { id: 'q2', selected: ['要', '不要'] },
    ],
  })
  // q1 不是多选 → 给两个选项要报错而不是静默取第一个
  const bad = parseAskReply('/ask 1,2; 2=1', multi())
  assert.equal(bad.ok, false)
  assert.match(bad.error, /不是多选/)
})

test('[ask] 解析：非法输入给出可操作错误，不静默', () => {
  assert.match(parseAskReply('/ask 9', single()).error, /选项编号 9 无效/)
  assert.match(parseAskReply('/ask 3=1', multi()).error, /超出范围/)
  assert.match(parseAskReply('/ask =x', multi()).error, /请指明问题编号/)
  assert.match(parseAskReply('', single()).error, /为空/)
  assert.match(parseAskReply('/ask', single()).error, /请在 \/ask 后/)
})

test('[ask] 提示里承诺的写法必须真的能解析（文档与实现一致）', () => {
  // 这条防的是"提示教用户 /ask 1; 2; 3，但实现解析不了"这类自相矛盾
  const prompt = formatAskPrompt(multi(), { number: 1 })
  for (const sample of ['/ask 1; 2', '/ask 2=1', '/ask =任意']) {
    const r = parseAskReply(sample, multi())
    // '/ask =任意' 在多问下应给出明确指引而不是崩溃
    if (sample === '/ask =任意') assert.equal(r.ok, false)
    else assert.equal(r.ok, true, `${sample} 应可解析：${JSON.stringify(r)}`)
  }
  assert.ok(prompt.includes('逐个作答'))
})

test('[ask] 答案批次校验：必须每个问题恰好一项（宿主 BAD_ANSWER 的前置自检）', () => {
  const qs = multi()
  assert.equal(validateAnswerBatch([{ id: 'q1', selected: [] }, { id: 'q2', selected: [] }], qs).ok, true)
  assert.match(validateAnswerBatch([{ id: 'q1', selected: [] }], qs).error, /条目数/)
  assert.match(validateAnswerBatch([{ id: 'q1', selected: [] }, { id: 'q1', selected: [] }], qs).error, /重复|未覆盖/)
  assert.match(validateAnswerBatch([{ id: 'q1', selected: [] }, { id: 'q2', selected: 'x' }], qs).error, /必须是数组/)
  assert.match(validateAnswerBatch([{ id: 'q1', selected: [] }, { id: 'q2', selected: [], custom: 1 }], qs).error, /必须是字符串/)
})

test('[ask] 回执把选择回显出来，便于用户确认被正确理解', () => {
  const ack = formatAnswerAck([
    { id: 'deploy', selected: ['裸机'] },
  ], single(), { number: 5 })
  assert.match(ack, /已提交你的选择 \(#5\)/)
  assert.match(ack, /\*\*部署\*\* → 裸机/)

  const skipped = formatAnswerAck([{ id: 'q1', selected: [] }, { id: 'q2', selected: [], custom: '自定义' }], multi())
  assert.match(skipped, /已跳过/)
  assert.match(skipped, /自定义/)
})

test('[ask] 多选问题的提示不能写成"选一项"（否则用户会以为只能单选）', () => {
  const multiSel = [{ id: 'x', question: '开哪些监控？', multiSelect: true, options: [{ label: '日志' }, { label: '指标' }] }]
  const text = formatAskPrompt(multiSel, { number: 1 })
  assert.match(text, /选多项/)
  assert.doesNotMatch(text, /选一项/)
  // 单选仍应提示"选一项"
  assert.match(formatAskPrompt(single(), { number: 1 }), /选一项/)
})
