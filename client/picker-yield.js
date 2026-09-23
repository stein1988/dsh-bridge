// DSH 官方目录选择器的「让位」判定（issue #28 第 2 条）
//
// 背景：DSH 0.1.5 起自带官方目录选择器，且注册到与 dsh-bridge 完全相同的两个 Slot：
//   conversation.hero.workspace.directoryFlow
//   sidebar.workspaces.directoryFlow
// 后端由 @deepseek-ai/dsh-host-directory-picker-auto 按宿主事实分发：非回环绑定 /
// SSH / Linux 无 zenity·kdialog 等图形 chooser → browse（网页树形选择器），
// macOS·Windows 或 Linux 有 chooser → native（系统对话框）。
//
// 而 DSH 的 slots 是 shadow 语义：@deepseek-ai/dsh-cordis-client-runner 的注释明确
//   "Page-local shadowing rank. A later registration receives a lower priority."
//   "a dynamically registered entry is assigned a lower priority than the shipped
//    one, which makes it the winner"
// 即数值越小越优先、后注册者胜。动态加载的 dsh-bridge 因此天然覆盖内置 picker，
// 叠加本插件显式写的 `priority: -10`，连本机（127.0.0.1 / Electron）也被插件自己的
// 远程目录选择器接管：点「添加工作区」弹的是插件的远程抽屉而非 DSH 官方选择器。
//
// 让位条件（两者同时成立才让位）：
//   1. 本机访问（isLocalEnvironment()）—— 本机有完整权限，官方 picker 直接可用；
//   2. DSH 已自带官方 picker —— 旧版 DSH 没有，必须继续由插件兜底，
//      否则本机点「添加工作区」将彻底没有反应。
// 远程 / 移动访问一律继续由插件接管：那里需要管理密码解锁与 local_only 目录策略，
// 不能换成官方 picker（会绕过插件的访问限制）。
//
// 为什么探测用 ctx.get() 而不是 ctx.uiWorkspace：
//   @deepseek-ai/dsh-cordis-client-runner 的 guard 对**属性访问**要求服务已在插件
//   `inject` 中声明，未声明但确实存在的服务会直接 rejectGuard 抛错：
//     `service "uiWorkspace" is not declared by your plugin. Declare it on the plugin ...`
//   而 `ctx.get(name)` 是它明确允许的「可选查找」（optional ctx.get() lookup）。
//   又因为把 uiWorkspace 写进 inject 会让旧版 DSH（无该 seat）把整个插件 park 掉
//   （provider 缺失即不 apply），所以只能用 ctx.get() 探测。

/** 官方 workspace seat 的服务名（DSH 0.1.5 起提供 pickDirectory） */
export const OFFICIAL_WORKSPACE_SEAT = 'uiWorkspace';

/**
 * 探测 DSH 是否已提供官方目录选择器。
 *
 * 用 `ctx.get()` 做可选查找：seat 不存在（旧版 DSH）、宿主未暴露 pickDirectory、
 * 或 guard 拒绝时一律返回 false —— 探测本身绝不抛错影响插件加载。
 *
 * @param {{ get?: (name: string) => unknown }} [ctx] cordis 客户端 context
 * @returns {boolean} 官方 picker 是否可用
 */
export function hasOfficialDirectoryPicker(ctx) {
  let seat;
  try {
    seat = typeof ctx?.get === 'function' ? ctx.get(OFFICIAL_WORKSPACE_SEAT) : null;
  } catch {
    // 查询被 guard 拒绝或宿主异常：按「无官方 picker」处理，保持插件原有兜底行为
    return false;
  }
  return typeof seat?.pickDirectory === 'function';
}

/**
 * 是否应让位给 DSH 官方目录选择器。
 *
 * @param {{ local?: boolean, officialPicker?: boolean }} [facts]
 * @returns {boolean} true = 不注册插件选择器，本机交给 DSH 官方处理
 */
export function shouldYieldToOfficialPicker(facts) {
  return Boolean(facts?.local) && Boolean(facts?.officialPicker);
}
