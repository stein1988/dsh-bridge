// 日志净化（防日志注入）单元测试
//
// 对应 CodeQL js/log-injection：外部可控字符串（Telegram API 的 description、
// 远端错误信息等）进入日志前必须折叠换行与控制字符，否则攻击者可在日志里伪造新行。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeLogValue, LOG_VALUE_MAX_LEN } from '../lib/security/log-sanitize.js'

test('换行与回车被折叠成空格（杜绝伪造日志行）', () => {
  const forged = '正常内容\n[ERROR] 审批已通过 #1\r\n伪造的第二行'
  const out = sanitizeLogValue(forged)
  assert.ok(!/[\r\n]/.test(out), `不得残留换行，实际：${JSON.stringify(out)}`)
  assert.match(out, /正常内容/)
  assert.match(out, /伪造的第二行/, '内容保留（只是不再单独成行）')
})

test('控制字符被剔除，可读内容保留', () => {
  // 注意：先折叠换行为空格，再剔除其余控制字符 → 'abcd e'
  const out = sanitizeLogValue('a\u0000b\u0007c\u001bd\ne')
  assert.equal(out, 'abcd e')
  // 断言"不含控制字符"正是本测试目的，显式豁免 no-control-regex
  // eslint-disable-next-line no-control-regex
  assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(out), '不得残留任何控制字符')
  // C1 控制字符（\u0080-\u009f）也要处理
  // eslint-disable-next-line no-control-regex
  assert.ok(!/[\u0080-\u009f]/.test(sanitizeLogValue('x\u009by')))
})

test('Error / 对象 / null / 数字安全转换', () => {
  assert.equal(sanitizeLogValue(new Error('boom\ninjected')), 'boom injected')
  // JSON.stringify 会把真换行转义成字面量 \n（两个字符），不会伪造新行——这是安全的
  assert.equal(sanitizeLogValue({ a: 1, b: 'x\ny' }), '{"a":1,"b":"x\\ny"}')
  assert.equal(sanitizeLogValue(null), '')
  assert.equal(sanitizeLogValue(undefined), '')
  assert.equal(sanitizeLogValue(42), '42')
  // 循环引用不得抛异常
  const cyclic = { name: 'x' }
  cyclic.self = cyclic
  assert.doesNotThrow(() => sanitizeLogValue(cyclic))
})

test('超长输入截断并标注原始长度（防撑爆日志采集器）', () => {
  const long = 'x'.repeat(LOG_VALUE_MAX_LEN + 500)
  const out = sanitizeLogValue(long)
  assert.ok(out.length < long.length)
  assert.match(out, /…\(\d+ chars\)$/)
  // 自定义上限
  assert.equal(sanitizeLogValue('abcdef', { maxLen: 3 }), 'abc…(6 chars)')
})

test('净化是幂等的：重复处理不改变结果', () => {
  const once = sanitizeLogValue('a\nb\u0000c')
  assert.equal(sanitizeLogValue(once), once)
})
