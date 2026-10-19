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
// 本文件有两类词条，分属两层：
//   ① 语义化键词典（下面的 `zh` / `en`）：移动端自绘 UI、DOM 注入、aria/title 等
//      「拿不到原文上下文」的调用点，用 localeT('menu.open') 这类键；
//   ② 「中文原文 → 英文」渲染层词典（panel-locales.mjs 的 panelEn / serverEn）：
//      client/index.js 的 h() 包装器在渲染时按原文精确命中翻译，动态拼接与服务端
//      运行时文案另有 `${var}` 占位符与正则模式。
// 内部字符串（DOM/CSS 类名匹配、注释、日志）保持中文原样——它们不是 UI 文案，
// 翻译会破坏匹配（见 readHostSessionTitle 教训）；这类字面量由
// test/panel-i18n.test.mjs 的内部白名单显式登记。

import { panelEn, serverEn, serverPatterns } from './panel-locales.mjs';

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
  // 读 <html lang>。document 可能不存在（Node 测试）或只有残缺 stub（宿主外壳/测试
  // 替身没有 documentElement.getAttribute）——整体容错：翻译函数在渲染/初始化链路上
  // 被高频调用，任何一个残缺 document 都不该把面板初始化打断。
  const readLang = () => {
    try {
      const root = typeof document !== 'undefined' ? document.documentElement : null;
      return (root && typeof root.getAttribute === 'function' ? root.getAttribute('lang') : '') || '';
    } catch {
      return '';
    }
  };
  const active = () => (readLang().toLowerCase().startsWith('zh') ? 'zh' : 'en');
  // 词典查询必须用「自有属性」判定：词典是普通对象，直接 dict[key] 会让
  // 'constructor' / 'toString' / '__proto__' 这类原型属性名返回函数或对象。
  // 渲染层 h() 会把**所有**字符串子节点送进来（含用户数据、路径、会话标题），
  // 一旦命中就会把函数当 React child 渲染（React 直接抛错）。见
  // test/panel-i18n.test.mjs 的「h() 包装器」用例。
  const own = (dict, key) => (typeof key === 'string' && Object.hasOwn(dict, key) ? dict[key] : undefined);
  // 先查语义化键词典（locales.mjs），未命中再查「中文原文 → 译文」词典
  // （panel-locales.mjs，渲染层兜底翻译用）。中文模式下 panel 词典不生效——
  // 中文就是原文本身（键），直接返回 undefined 让 t() 回退键。
  const lookup = (key, lang, vars, depth = 0) => {
    if (typeof key !== 'string') return undefined;
    // `$1t` 允许捕获组再翻译一次；深度设上限，防止超长嵌套前缀把调用栈打爆
    if (depth > 8) return undefined;
    const semantic = lang === 'zh' ? own(zh, key) : (own(en, key) ?? own(zh, key));
    if (semantic !== undefined) return semantic;
    if (lang === 'zh') return undefined;
    const panel = own(panelEn, key);
    if (panel !== undefined) {
      if (Array.isArray(panel)) return vars && vars.count === 1 ? panel[0] : panel[1];
      return panel;
    }
    // 服务端运行时文案（RPC 错误 / 隧道状态 / 网络诊断）：精确匹配优先，其次正则模式。
    const server = own(serverEn, key);
    if (server !== undefined) return server;
    for (const [pattern, english] of serverPatterns) {
      const matched = pattern.exec(key);
      if (!matched) continue;
      // `$1` 原样插入捕获组；`$1t` 表示「该捕获组本身也要过一遍词典」
      // （服务端常把中文原因/状态嵌在英文模板里，如『连接异常: 连接超时 (3.5s)』）。
      return english.replace(/\$(\d)(t?)/g, (_, group, translate) => {
        const captured = matched[Number(group)] ?? '';
        return translate ? (lookup(captured, 'en', undefined, depth + 1) ?? captured) : captured;
      });
    }
    return undefined;
  };
  const t = (key, vars) => {
    let text = lookup(key, active(), vars);
    // 英文缺失译文时回退原文（宁可见中文，也不显示键名/空白）
    if (text === undefined) text = key;
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

const globalTranslator = createTranslator(null);

/**
 * 无 ctx 的全局翻译函数：给「不在 React 渲染层、也拿不到 ctx」的模块用
 * （例：client/unlock-manager.js 的错误文案、client/settings-nav-icon.js 的兜底标签）。
 * 语言每次调用实时读 <html lang>，与面板翻译器同源。
 * @param {string} key 语义化键或中文原文
 * @param {Record<string, unknown>} [vars] 占位符/单复数变量
 * @returns {string}
 */
export const t = (key, vars) => globalTranslator.t(key, vars);