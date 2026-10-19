// 隧道类操作的前置条件判断（issue #75）——纯函数，便于单测。
//
// 背景：可信隧道相关的高危 RPC（startCloudflared / startCustomTunnel /
// saveCloudflaredConfig / saveCustomTunnelConfig / saveExternalTunnel /
// setTunnelAutoStart）在服务端都带 `requireConfigured: true` 守卫：
//
// 【例外】resetCloudflared 在服务端只是普通 checkAdminAuth（无 requireConfigured），
// 客户端对它也做同一预检，是因为它是 stop+start 复合操作：无密码时 stop 会成功、
// start 被拒，把隧道留在"已停用"状态。故按 start 的前置条件提前拦截——这条属产品
// 取舍，不是与服务端逐端点同源。
// 当「管理保护未关闭」(adminProtection !== false)、「策略非宽松」(adminPolicy !== 'open')
// 且「从未设置任何访问密码/管理密码」时，服务端会直接拒绝并返回可读错误
// （bridge-rpc.js 的 checkAdminAuth）。
//
// 问题在于提示位置：旧实现只在点击后把错误写到**面板顶部横幅**，而隧道卡片往往在
// 长页面下方，用户看不到任何反馈，误以为"点了没反应"（issue #75 的现场观感）。
// 因此客户端需要**与服务端同源**地判断该前置条件，用于「按钮旁常驻提示 + 点击前预检」，
// 而不是自己发明一套规则：条件不一致会出现"提示说不行、点了却能成功"或反之。
//
// 注意判定必须与 bridge-rpc.js checkAdminAuth 的分支顺序一致：
//   1) adminPolicy === 'local_only'  → 另走 adminToken 校验，不受本条件约束（返回 false）
//   2) adminProtection === false     → 服务端直接放行
//   3) adminPolicy === 'open'        → 服务端直接放行
//   4) 其余：无任何密码时 requireConfigured 拦截

/**
 * 是否已设置过任意一种密码（访客访问密码或独立管理密码）。
 * @param {{hasPassword?: boolean, hasAdminPassword?: boolean}} [auth]
 */
export function hasAnyPassword(auth) {
  return Boolean(auth?.hasPassword || auth?.hasAdminPassword)
}

/**
 * 隧道类操作是否会被服务端的前置条件拦下（缺访问密码）。
 * @param {object} [auth] 状态快照里的 auth 段（authManager.getStatus()）
 * @returns {boolean} true = 需要先设置访问密码
 */
export function needsTunnelPassword(auth) {
  // 没有 auth 快照（状态未加载）时不做判断，避免误导
  if (!auth || typeof auth !== 'object') return false
  if (auth.adminPolicy === 'local_only') return false
  if (auth.adminProtection === false) return false
  if (auth.adminPolicy === 'open') return false
  return !hasAnyPassword(auth)
}
