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
//   cordis 本体对**未在插件 inject 中声明**的服务做属性访问会直接抛错：
//     cannot get property "uiWorkspace" without inject   （cordis/lib/index.js）
//   —— dsh-bridge 的 client half 是静态 client 插件，其 ctx 是真 cordis Context
//   （不是动态包的 runner guard facade），所以拦在这里的是 cordis 本体的规则。
//   而 `ctx.get(name)` 是允许的「可选查找」，不要求声明。
//   又不能把 uiWorkspace 写进 inject：旧版 DSH（无该 seat）会因此把整个插件 park 掉
//   （provider 缺失即不 apply），所以只能用 ctx.get() 探测。
//
// ⚠️ 已知时序依赖（独立验收记录，真机 6/6 冷启动实测未触发）：
//   cordis 的 ctx.get() 在 provider fiber 尚未进入 ACTIVE 时会返回 undefined。理论上若
//   本判定早于 ui-workspace 插件 apply 完成，就会把「有官方 picker」误判为「无」而仍然
//   注册，让位失效。当前稳定是因为 dsh-bridge 自身 inject 的 workspaces / sessions 由
//   roster 中排在 ui-workspace **之后**的插件提供，插件真正激活时 ui-workspace 早已
//   apply 完成 —— 这是对 roster 顺序的**隐式耦合，不是显式保证**。若将来调整 roster
//   顺序或去掉 workspaces 依赖，需重新评估（加固思路：注册后等 uiWorkspace 可用时
//   再撤销自己的注册）。

/** 官方 workspace seat 的服务名（DSH 0.1.5 起提供 pickDirectory） */
export const OFFICIAL_WORKSPACE_SEAT = 'uiWorkspace';

/**
 * 探测 DSH 是否已提供官方目录选择器。
 *
 * 用 `ctx.get()` 做可选查找：seat 不存在（旧版 DSH）、宿主未暴露 pickDirectory、
 * 查询或属性读取抛错时一律返回 false —— 探测本身绝不外抛影响插件加载。
 *
 * @param {{ get?: (name: string) => unknown }} [ctx] cordis 客户端 context
 * @returns {boolean} 官方 picker 是否可用
 */
export function hasOfficialDirectoryPicker(ctx) {
  try {
    if (typeof ctx?.get !== 'function') return false;
    const seat = ctx.get(OFFICIAL_WORKSPACE_SEAT);
    // typeof 也放在 try 内：seat 可能是带异常 getter 的对象或 Proxy，
    // 读 pickDirectory 本身就可能抛错。
    return typeof seat?.pickDirectory === 'function';
  } catch {
    // ctx.get 抛错（宿主异常），或属性读取抛错（异常 getter / Proxy）：
    // 一律按「无官方 picker」处理，保持插件原有兜底行为，探测绝不外抛。
    return false;
  }
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
