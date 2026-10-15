// dsh-bridge 客户端国际化：跟随 DSH 主体语言（LocaleFace）。
//
// DSH 0.1.7 的 client 提供 locale 服务（`dsh-client-locale` 的 LocaleFace）：
//   - ctx.locale.register(namespace, { zh: {...}, en: {...} }) 注册词典；
//   - ctx.locale.translate(map) 按当前语言取译文（纯字符串原样返回、map 走词典，
//     未声明语言回退到 fallback 链，最终到 en）；
//   - ctx.locale.subscribe(fn) 在语言切换时通知。
// 插件把 "locale" 加进 inject 后即可拿到 ctx.locale，从而自动跟随 DSH 主体语言
// （含用户手动切换、浏览器语言回退、<html lang> 同步），无需自建语言开关。
//
// 本文件只收「移动端自绘 UI 的用户可见文案」（A 类）：顶栏按钮、工作区选择器、
// 远程访问面板、浏览器输入区提示等。内部字符串（DOM/CSS 类名匹配、注释、日志）
// 保持中文原样——它们不是 UI 文案，翻译会破坏匹配（见 readHostSessionTitle 教训）。

export const LOCALE_NAMESPACE = '@wenbin_wb/dsh-bridge';

/** 词典：每个命名空间至少要有 en（最终 fallback）；zh 为默认语言。 */
export const zh = {
  // 移动端顶栏
  'menu.open': '打开菜单',
  'menu.newSession': '新建会话',
  'title.fallback': '新会话',
  // 移动端输入区
  'composer.placeholder': '✍️ 点击输入消息…',
  'composer.expand': '展开输入框',
  'composer.collapse': '收起输入框，最大化对话阅读区',
  'panel.backToChat': '返回对话',
  // 宿主浮层（智能体团队 / 子智能体下拉）在移动端由本插件统一补收起按钮：动作文案，兼作 aria-label
  'popover.collapse': '收起',
  // 移动端设置面板 / 抽屉（dsh-bridge 自绘部分）
  'workspace.choose': '选择电脑工作区',
  'workspace.reading': '正在读取目录内容…',
  'workspace.currentDir': '当前目录:',
  'workspace.registeredHint': '已注册工作区 (${count} 个，点击直接切换)：',
  'workspace.enterHint': '点击进入文件夹，或点击「+ 选为工作区」直接添加并切换',
  'workspace.unlockHint': '远程访问时浏览/添加工作区需输入后台管理密码解锁（与访问密码不同）。',
  'workspace.chooseFolder': '选择工作区',
  'workspace.addFolder': '添加',
  'workspace.refresh': '刷新目录',
  'workspace.back': '返回上一级',
  'workspace.filter': '过滤子文件夹…',
  'workspace.more': '还有更多',
  'workspace.addSubfolder': '直接添加此子文件夹为工作区并进入',
  'workspace.onlyAdmin': '仅限本机管理',
  'workspace.isCurrent': '当前主入口',
  'workspace.isFallback': '主入口',
  // 远程访问面板
  'access.copyLink': '复制链接',
  'access.copied': '✓ 已复制',
  'access.hideQr': '隐藏二维码',
  'access.showQr': '显示二维码',
  'access.privateEnv': '请在私密环境下使用',
  'access.switching': '切换中…',
  'access.publicEntry': '公网访问入口',
  'access.copy': '复制',
  'access.stopReconnect': '停止重连',
  'access.close': '关闭',
  'access.connecting': '连接中…',
  'access.downloading': '下载中…',
  'access.enable': '开启公网隧道',
  'access.scanHint': '请在私密环境下扫码使用',
  'access.autoStart': '随 DSH 启动自动开启',
  'access.tunnelConfig': '隧道配置',
  'access.expand': '展开 ▾',
  'access.collapse': '收起 ▴',
  'access.saveError': '保存配置失败',
  'access.serverConfig': '隧道服务器配置',
  'access.saving': '保存中…',
  'access.saved': '✓ 已保存',
  'access.saveConfig': '保存配置',
  'access.clear': '清除',
  'access.externalTunnel': '外部已部署隧道',
  'access.saveFixed': '保存固定域名配置',
  'access.updateFailed': '更新失败',
  'access.securityHint': '设置外部访客访问密码',
  'access.goSetup': '去开启 ➔',
  'access.gotoSettings': '设置 ➔',
  'access.tutorial': '查看自建隧道服务器搭建教程',
};

export const en = {
  'menu.open': 'Open menu',
  'menu.newSession': 'New session',
  'title.fallback': 'New Session',
  'composer.placeholder': '✍️ Tap to type a message…',
  'composer.expand': 'Expand input',
  'composer.collapse': 'Collapse input to maximize chat view',
  'panel.backToChat': 'Back to chat',
  // Host popovers (Agent Team / subagent dropdown) get a collapse control from this plugin on mobile
  'popover.collapse': 'Collapse',
  'workspace.choose': 'Choose a workspace',
  'workspace.reading': 'Reading directory…',
  'workspace.currentDir': 'Current directory:',
  'workspace.registeredHint': 'Registered workspaces (${count}, click to switch):',
  'workspace.enterHint': 'Enter a folder, or tap “+ Select as workspace” to add & switch',
  'workspace.unlockHint': 'Browsing/adding workspaces remotely requires the admin password to unlock (different from the access password).',
  'workspace.chooseFolder': 'Choose workspace',
  'workspace.addFolder': 'Add',
  'workspace.refresh': 'Refresh',
  'workspace.back': 'Back',
  'workspace.filter': 'Filter subfolders…',
  'workspace.more': 'More',
  'workspace.addSubfolder': 'Add this subfolder as a workspace and enter',
  'workspace.onlyAdmin': 'Local admin only',
  'workspace.isCurrent': 'Current entry',
  'workspace.isFallback': 'Main entry',
  'access.copyLink': 'Copy link',
  'access.copied': '✓ Copied',
  'access.hideQr': 'Hide QR',
  'access.showQr': 'Show QR',
  'access.privateEnv': 'Use in a private environment',
  'access.switching': 'Switching…',
  'access.publicEntry': 'Public access entry',
  'access.copy': 'Copy',
  'access.stopReconnect': 'Stop reconnecting',
  'access.close': 'Close',
  'access.connecting': 'Connecting…',
  'access.downloading': 'Downloading…',
  'access.enable': 'Enable public tunnel',
  'access.scanHint': 'Scan in a private environment',
  'access.autoStart': 'Start automatically with DSH',
  'access.tunnelConfig': 'Tunnel configuration',
  'access.expand': 'Expand ▾',
  'access.collapse': 'Collapse ▴',
  'access.saveError': 'Failed to save configuration',
  'access.serverConfig': 'Tunnel server configuration',
  'access.saving': 'Saving…',
  'access.saved': '✓ Saved',
  'access.saveConfig': 'Save configuration',
  'access.clear': 'Clear',
  'access.externalTunnel': 'External tunnel',
  'access.saveFixed': 'Save fixed-domain configuration',
  'access.updateFailed': 'Update failed',
  'access.securityHint': 'Set an external visitor access password',
  'access.goSetup': 'Set up ➔',
  'access.gotoSettings': 'Settings ➔',
  'access.tutorial': 'View the self-hosted tunnel server tutorial',
};

/**
 * 构造一个翻译函数：优先用宿主的 ctx.locale.translate（跟随主体语言），
 * 宿主不支持时退化为「取当前语言词典（en/zh）+ 互为兜底」。
 * @param {object} ctx - Cordis 客户端上下文（含可选 locale 服务）
 * @returns {{ t: Function, active: () => string, subscribe: Function }}
 */
/**
 * 构造翻译器：读 DSH 主体语言（`<html lang>`，宿主 LocaleFace 实时同步），
 * 中英词典按当前语言选词。`ctx.locale` 只作可选的词典注册（拿到则注册，
 * 拿不到或未声明 inject 也不抛错、不影响翻译——动态插件无法把 locale 加进
 * inject，宿主会对未声明服务抛 denyRead，详见 index.js 注释）。
 * @param {object} ctx - Cordis 客户端上下文（可选）
 * @returns {{ t: Function, active: () => string }}
 */
export function createTranslator(ctx) {
  // 当前语言：宿主把 active 语言同步到 <html lang>（zh→zh-CN，其余原样）。
  // 读它即可跟随 DSH 主体语言且无需声明 locale 服务。
  const active = () => {
    const lang = (typeof document !== 'undefined' ? document.documentElement.getAttribute('lang') : '') || '';
    return lang.toLowerCase().startsWith('zh') ? 'zh' : 'en';
  };
  const entryOf = (key) => ({ zh: zh[key], en: en[key] });
  const t = (key, vars) => {
    const e = entryOf(key);
    let text = e[active()] ?? e.en ?? e.zh ?? '';
    if (vars && text) {
      for (const [k, v] of Object.entries(vars)) text = text.replaceAll(`\${${k}}`, String(v));
    }
    return text;
  };
  // 可选：向宿主注册词典（仅当其有 register 且可访问时；失败无妨）
  try {
    const locale = ctx && (typeof ctx.get === 'function' ? ctx.get('locale') : ctx.locale);
    if (locale && typeof locale.register === 'function') {
      locale.register(LOCALE_NAMESPACE, { zh, en });
    }
  } catch { /* 动态插件的 locale 服务被宿主门控时忽略 */ }
  return { t, active };
}