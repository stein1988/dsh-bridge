// test/first-run-guide.test.mjs
// 回归用例：首次启用引导的「保守判据」。
// 目标：默认监听 0.0.0.0 且认证默认关闭时提示新用户开门禁，
// 同时保证已配置过认证/机器人的老用户升级后不被打扰。
import test from 'node:test'
import assert from 'node:assert/strict'

// 与 lib/index.js 中 service.firstRunGuidePending 的判据保持一致：
//   pending = authManager.enabled !== true && stored?.wizard?.guideShown !== true
// 用严格判等（!== true），使缺失值、脏数据（如字符串 'true'）一律视为「未开启」，
// 即宁可提示也不静默放过潜在的开箱敞开状态。
function shouldPrompt(stored) {
  return stored?.auth?.enabled !== true && stored?.wizard?.guideShown !== true
}

test('全新用户（无 config）应被提示', () => {
  assert.equal(shouldPrompt(undefined), true)
  assert.equal(shouldPrompt({}), true)
})

test('已开启访问认证的用户不应被提示', () => {
  assert.equal(shouldPrompt({ auth: { enabled: true } }), false)
})

test('已确认过引导的用户不应被提示（即便仍未开门禁）', () => {
  assert.equal(shouldPrompt({ wizard: { guideShown: true } }), false)
  assert.equal(shouldPrompt({ auth: { enabled: false }, wizard: { guideShown: true } }), false)
})

test('已开认证且已看过引导的老用户不应被提示（升级不打扰）', () => {
  const oldUser = {
    auth: { enabled: true, passwordHash: 'pbkdf2-sha256$600000$deadbeef' },
    cloudflared: { token: 'jwt', hostname: 'x.example', autoStart: true },
    lan: { selectedIp: '192.168.1.5' },
  }
  assert.equal(shouldPrompt(oldUser), false)
})

test('设有密码但认证关闭时仍应提示（确实处于未开门禁状态）', () => {
  assert.equal(shouldPrompt({ auth: { enabled: false, passwordHash: 'x' } }), true)
})

test('脏数据 enabled 为字符串不应被误判为已开启', () => {
  assert.equal(shouldPrompt({ auth: { enabled: 'true' } }), true)
  assert.equal(shouldPrompt({ auth: { enabled: 1 } }), true)
})
