// issue #75：隧道操作「未设置访问密码」前置条件的客户端判定（须与服务端同源）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hasAnyPassword, needsTunnelPassword } from '../client/tunnel-guard.js'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('[#75] 前置条件判定与服务端 checkAdminAuth 同源', () => {
  // 默认策略（password_unlock + 管理保护开启）且无任何密码 → 需要先设密码
  assert.equal(needsTunnelPassword({ adminPolicy: 'password_unlock', adminProtection: true, hasPassword: false, hasAdminPassword: false }), true)
  // 设过任意一种密码即放行
  assert.equal(needsTunnelPassword({ adminPolicy: 'password_unlock', adminProtection: true, hasPassword: true, hasAdminPassword: false }), false)
  assert.equal(needsTunnelPassword({ adminPolicy: 'password_unlock', adminProtection: true, hasPassword: false, hasAdminPassword: true }), false)
  // 管理保护关闭 / 宽松策略 → 服务端 requireConfigured 不生效
  assert.equal(needsTunnelPassword({ adminPolicy: 'password_unlock', adminProtection: false }), false)
  assert.equal(needsTunnelPassword({ adminPolicy: 'open', adminProtection: true }), false)
  // local_only 走 adminToken 校验，不受该条件约束
  assert.equal(needsTunnelPassword({ adminPolicy: 'local_only', adminProtection: true }), false)
  // 状态未加载（无 auth）不得误报
  assert.equal(needsTunnelPassword(undefined), false)
  assert.equal(needsTunnelPassword(null), false)
  // 空对象：服务端默认值即管理保护开启 + 非宽松 + 无密码 → 需要设密码
  assert.equal(needsTunnelPassword({}), true)

  assert.equal(hasAnyPassword({ hasPassword: true }), true)
  assert.equal(hasAnyPassword({ hasAdminPassword: true }), true)
  assert.equal(hasAnyPassword({}), false)
  assert.equal(hasAnyPassword(undefined), false)
})

test('[#75] 客户端接线：隧道高危操作必须走前置预检 + 按钮旁常驻提示', () => {
  const source = readFileSync(resolve(repoRoot, 'client/index.js'), 'utf8')
  // 预检：所有 requireConfigured 的隧道操作都要先过 needsTunnelPassword
  assert.ok(source.includes('needsTunnelPassword(status?.auth)'), '应基于状态里的 auth 计算前置条件')
  const guardedEndpoints = [
    'startCloudflared',
    'startCustomTunnel',
    'saveCloudflaredConfig',
    'saveCustomTunnelConfig',
    'saveExternalTunnel',
    'setTunnelAutoStart',
  ]
  for (const ep of guardedEndpoints) {
    assert.ok(source.includes(`BRIDGE_ENDPOINTS.${ep}`), `应存在 ${ep} 调用点`)
  }
  // 精确计数（曾用 >=5：删掉 1~3 处守卫仍能通过）
  assert.equal((source.match(/if \(tunnelGate\)/g) || []).length, 8, '8 处高危隧道操作都必须先判断 tunnelGate')
  // 逐个 handler 断言（防止只计数时"删一个、补一个"式绕过）
  const guardedHandlers = [
    'onStartCloudflared',
    'onResetCloudflared',
    'onToggleCloudflaredAutoStart',
    'saveCloudflaredConfig',
    'onStartCustom',
    'onToggleCustomAutoStart',
    'saveConfig',
    'saveExternalTunnel',
  ]
  for (const name of guardedHandlers) {
    assert.match(source, new RegExp(`const ${name} = React\\.useCallback\\([\\s\\S]{0,240}?if \\(tunnelGate\\)`),
      `${name} 必须先做前置检查（否则点了没反应/复合操作半途失败）`)
  }
  // 常驻提示：文案 + 直达「安全认证」的入口 + 两个真实渲染点
  assert.ok(source.includes('开启公网隧道前，请先在「安全认证」中设置访问密码'), '应渲染可读的前置条件提示')
  assert.ok(source.includes('const TunnelPasswordNotice = React.memo'), '应有专用的内联提示组件（不是只写顶部横幅）')
  assert.match(source, /tunnelGate && h\(TunnelPasswordNotice, \{ onNavigateSecurity: navSecurity \}\)/,
    '隧道 Tab 顶部必须常驻提示（删掉它 = 用户又看不到反馈）')
  assert.match(source, /!running && onStart && needsTunnelPassword\(auth\)/,
    '带 onStart 的隧道卡片动作行内必须再渲染一次提示')
})
