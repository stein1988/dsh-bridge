// 设置面板中英文文案守卫（issue #79：界面英文化）。
//
// 断言口径：
//   ① 词典完整性——下列「UI 文案模块」里每个含中文的字符串字面量 / 模板静态片段，要么在
//      panel-locales.mjs 的 panelEn 词典里（React 渲染层由 h() 包装器按原文精确翻译，
//      非组件模块显式调用 locales.mjs 的全局 t()），要么在下方内部白名单里（日志、DOM
//      选择器、用于匹配宿主中文界面文案的关键词等，翻译它们会破坏匹配/排障）。
//      新增中文 UI 文案却忘了补词典 → 本测试直接失败。
//   ② 词典无死词条——panelEn 的每个键都必须仍能在源码里找到，改文案后旧词条必须删除。
//   ③ 译文质量底线——英文值非空且不含中文；数组值只能是 [单数, 复数] 两形态。
//   ④ 翻译器行为——跟随 <html lang>：中文回原文、英文查词典；`${name}` 占位符与
//      vars.count 单复数选择正确；未收录的键回退原文（绝不显示键名或空白）。
//   ⑤ 服务端运行时文案词典（serverEn）同样要求非空、不含中文，且模式可命中。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectClientLiterals, needsTranslation } from './helpers/client-literals.mjs';
import { panelEn, serverEn, serverPatterns } from '../client/panel-locales.mjs';
import { createTranslator, t as globalT } from '../client/locales.mjs';
import { renderLoginPage, localizeAuthError, pickLoginLang } from '../lib/auth/login-template.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// 承载用户可见文案的客户端模块。
//   - client/index.js：React 面板 + 目录选择弹窗（渲染层 h() 包装器兜底翻译）；
//   - client/unlock-manager.js：解锁错误文案（显式调用全局 t()）；
//   - client/settings-nav-icon.js：设置页导航图标匹配用的标签（显式调用全局 t()）。
// 不含 UI 文案的模块（不扫描）：mobile-styles.js / theme-tokens.js 只有 CSS（其中的中文
// 仅在 CSS 注释里）、host-families.js / mobile-yield.js / picker-yield.js /
// resource-url-compat.js 是纯逻辑与注释、locales*.mjs 是词典本身。
const UI_MODULES = [
  'client/index.js',
  'client/unlock-manager.js',
  'client/settings-nav-icon.js',
];
const literals = UI_MODULES.flatMap((file) => collectClientLiterals(readFileSync(resolve(repoRoot, file), 'utf8'))
  .map((l) => ({ ...l, file })));
const sourceValues = new Set(literals.map((l) => l.value));

// 内部中文白名单（不是 UI 文案）：
//   - [dsh-bridge] 开头的 console/日志；
//   - DOM 选择器（button[aria-label*="…"] 等）与宿主中文界面关键词匹配
//     （'操作' / '视图' / '搜索' / '设置' / '新会话' / '添加工作区' …）——这些用来
//      命中 DSH 自己渲染的中文界面元素，改成英文反而会让移动端交互失效。
export const INTERNAL_TEXT = [
  "[dsh-bridge] 无法解析宿主设置弹窗的 CSS-module 前缀，移动端设置页样式将不生效。",
  " 已解析=",
  " 来源=",
  "[dsh-bridge] 部分宿主前缀按基线假设（对应规则可能不生效）：",
  " 未验证=",
  " 缺失=",
  "button[aria-label*=\"打开侧边栏\"], button[title*=\"打开侧边栏\"], button[aria-label*=\"Open sidebar\"], button[title*=\"Open sidebar\"]",
  "button[aria-label=\"新建会话\"], button[aria-label=\"New session\"]",
  "nav[aria-label=\"Session hierarchy\"], nav[aria-label=\"会话层级\"]",
  "button[class*=\"toggleButton\"][aria-label*=\"收起\"], button[class*=\"toggleButton\"][aria-label*=\"Collapse\"]",
  "[dsh-bridge] 浮层选择器不被当前浏览器支持，该处浮层不会注入收起按钮：",
  "button[aria-label*=\"面板\"], button[aria-label*=\"工作区\"], button[aria-label*=\"workspace\"], button[aria-label*=\"Workspace\"], div[class*=\"toggleCluster\"] button, button[class*=\"subagent\"], div[class*=\"headerActions\"] button, div[class*=\"titleRow\"] button",
  "button[aria-label*=\"收起侧边栏\"], button[title*=\"收起侧边栏\"], button[aria-label*=\"Collapse sidebar\"], button[title*=\"Collapse sidebar\"]",
  "操作",
  "视图",
  "搜索",
  "设置",
  "新会话",
  "button[aria-label*=\"操作\"], button[aria-label*=\"Session actions\"], button[class*=\"iconButton\"], button",
  ", button[aria-label*=\"打开侧边栏\"], button[title*=\"打开侧边栏\"], button[aria-label*=\"Open sidebar\"], button[title*=\"Open sidebar\"]",
  "添加工作区",
  "新建工作区",
  "打开工作区",
  "打开文件夹",
  "button[aria-label*=\"工作区\"][aria-label*=\"添加\"], button[aria-label*=\"工作区\"][aria-label*=\"打开\"], button[aria-label*=\"Workspace\"][aria-label*=\"add\"], button[aria-label*=\"Workspace\"][aria-label*=\"open\"], button[aria-label*=\"Add workspace\"], button[aria-label*=\"Open workspace\"]",
  "管理员权限",
  "管理密码解锁",
];

const INTERNAL_SET = new Set(INTERNAL_TEXT);

test('panel 文案：UI 模块里所有中文文案都在词典或内部白名单内', () => {
  assert.ok(literals.length > 400, `应扫描到足量中文文案（实际 ${literals.length}）`);
  const missing = new Map();
  for (const l of literals) {
    if (panelEn[l.value] !== undefined || INTERNAL_SET.has(l.value)) continue;
    if (!missing.has(l.value)) missing.set(l.value, l);
  }
  const preview = [...missing.values()].slice(0, 15)
    .map((l) => `  ${l.file}:${l.line}: ${JSON.stringify(l.value)}`).join('\n');
  assert.equal(missing.size, 0,
    `以下中文文案未在 client/panel-locales.mjs 的 panelEn 中登记（界面将保持中文）：\n${preview}`);
});

test('panel 词典无死词条：每个键都仍被源码引用', () => {
  const dead = Object.keys(panelEn).filter((key) => !sourceValues.has(key));
  assert.equal(dead.length, 0,
    `panelEn 中以下词条已不再被 client/index.js 引用，请删除（改文案后旧键必须清理）：\n  ${dead.slice(0, 15).join('\n  ')}`);
});

test('panel 词典译文完整：非空、不含中文、单复数数组恰好两形态', () => {
  const keys = Object.keys(panelEn);
  assert.ok(keys.length >= 400, `词典规模应覆盖整面板（实际 ${keys.length} 条）`);
  for (const key of keys) {
    assert.ok(key.length > 0, '键不能为空');
    const value = panelEn[key];
    const values = Array.isArray(value) ? value : [value];
    if (Array.isArray(value)) assert.equal(value.length, 2, `单复数数组必须恰好两条：${JSON.stringify(key)}`);
    for (const v of values) {
      assert.equal(typeof v, 'string', `译文必须是字符串：${JSON.stringify(key)}`);
      assert.ok(v.length > 0, `译文不能为空：${JSON.stringify(key)}`);
      assert.equal(needsTranslation(v), false, `英文译文不应含中文（未翻译或漏改）：${JSON.stringify(key)} → ${JSON.stringify(v)}`);
    }
  }
  // 服务端运行时文案词典（精确匹配）同样要求非空且不含中文
  for (const [key, value] of Object.entries(serverEn)) {
    assert.ok(key.length > 0 && typeof value === 'string' && value.length > 0, `服务端词条不完整：${JSON.stringify(key)}`);
    assert.equal(needsTranslation(value), false, `服务端英文译文不应含中文：${JSON.stringify(key)} → ${JSON.stringify(value)}`);
  }
  for (const [pattern, english] of serverPatterns) {
    assert.ok(pattern instanceof RegExp, '服务端模式必须是正则');
    assert.ok(typeof english === 'string' && english.length > 0 && !needsTranslation(english), `服务端模式译文不合法：${pattern}`);
  }
});

test('翻译器：跟随 <html lang>、中文回原文、英文查词典、占位符与单复数正确', () => {
  const originalDocument = globalThis.document;
  try {
    globalThis.document = { documentElement: { getAttribute: () => 'en' } };
    const en = createTranslator({});
    // 渲染层词典（中文原文键）
    assert.equal(en.t('运行中'), 'Running');
    assert.equal(en.t('未连接'), 'Disconnected');
    assert.equal(en.t('（无）'), '(none)');
    // 未收录的中文/英文原样返回（绝不显示键名或空串）
    assert.equal(en.t('这段文案没有词条'), '这段文案没有词条');
    assert.equal(en.t('plain ascii'), 'plain ascii');
    // 语义化键词典仍生效（移动端自绘 UI）
    assert.equal(en.t('menu.open'), 'Open menu');
    // 占位符替换
    assert.equal(en.t('已注册工作区 (${count} 个，点击直接切换)：', { count: 2 }), 'Registered workspaces (2, tap to switch):');
    assert.equal(en.t('输入${kind}', { kind: 'admin password' }), 'Enter the admin password');
    // vars.count 选择英文单复数
    assert.equal(en.t('${count} 个文件夹', { count: 1 }), '1 folder');
    assert.equal(en.t('${count} 个文件夹', { count: 3 }), '3 folders');
    assert.equal(en.t('${count} 次工具调用', { count: 1 }), '1 tool call');
    assert.equal(en.t('${count} 次工具调用', { count: 5 }), '5 tool calls');
    // 服务端运行时文案：精确匹配 + 正则模式（$1 捕获组）
    assert.equal(en.t('Cloudflare 隧道已在运行'), 'The Cloudflare tunnel is already running');
    assert.equal(en.t('操作已被拦截：需要管理员权限，请先在控制台输入管理密码解锁'), 'Blocked: admin access required — enter the admin password to unlock first');
    assert.equal(en.t('连接畅通 (延迟 12ms)'), 'Connection OK (latency 12 ms)');
    assert.equal(en.t('平台未注册: qq'), 'Platform not registered: qq');
    assert.equal(en.t('请求过于频繁，请等待 8 秒后再试'), 'Too many requests; retry in 8 s');

    globalThis.document = { documentElement: { getAttribute: () => 'zh-CN' } };
    const zh = createTranslator({});
    // 中文模式：原文返回（行为与改造前一致），语义键取中文词典
    assert.equal(zh.t('运行中'), '运行中');
    assert.equal(zh.t('menu.open'), '打开菜单');
    assert.equal(zh.t('${count} 个文件夹', { count: 3 }), '3 个文件夹');
    assert.equal(zh.t('Cloudflare 隧道已在运行'), 'Cloudflare 隧道已在运行');
    assert.equal(zh.t('连接畅通 (延迟 12ms)'), '连接畅通 (延迟 12ms)');
    assert.equal(zh.active(), 'zh');
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
});

test('全局 t()：非 React 模块（解锁文案 / 导航标签）同样跟随 <html lang>', () => {
  const originalDocument = globalThis.document;
  try {
    globalThis.document = { documentElement: { getAttribute: () => 'en' } };
    assert.equal(globalT('管理员密码错误'), 'Incorrect admin password');
    assert.equal(globalT('解锁请求失败'), 'Unlock request failed');
    assert.equal(globalT('远程访问'), 'Remote access');
    globalThis.document = { documentElement: { getAttribute: () => 'zh-CN' } };
    assert.equal(globalT('管理员密码错误'), '管理员密码错误');
    assert.equal(globalT('远程访问'), '远程访问');
    // document 不存在或残缺也不能抛（Node 环境 / 宿主外壳 stub）；语言回退到 en
    delete globalThis.document;
    assert.equal(globalT('远程访问'), 'Remote access');
    globalThis.document = { documentElement: {} };
    assert.equal(globalT('远程访问'), 'Remote access');
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
});

test('翻译器：词典查询不得命中对象原型属性（否则字符串子节点会被渲染成函数）', () => {
  const originalDocument = globalThis.document;
  try {
    globalThis.document = { documentElement: { getAttribute: () => 'en' } };
    const en = createTranslator({});
    for (const name of ['constructor', 'toString', '__proto__', 'valueOf', 'hasOwnProperty']) {
      assert.equal(en.t(name), name, `原型属性名必须原样返回：${name}`);
      assert.equal(globalT(name), name, `全局 t() 同样必须原样返回：${name}`);
    }
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
});

test('h() 渲染层包装器：真实执行源码里的包装器（子节点/属性翻译、中文幂等、用户数据不误翻）', () => {
  const source = readFileSync(resolve(repoRoot, 'client/index.js'), 'utf8');
  const start = source.indexOf('const TRANSLATABLE_PROPS');
  const marker = 'function h(type, props, ...children) {';
  const markerIdx = source.indexOf(marker, start);
  assert.ok(start > 0 && markerIdx > start, '应能在 client/index.js 里定位 h() 包装器');
  const snippet = source.slice(start, markerIdx + source.slice(markerIdx).indexOf('\n}') + 2);

  const originalDocument = globalThis.document;
  let currentLang = 'en';
  try {
    globalThis.document = { documentElement: { getAttribute: () => currentLang } };
    const translator = createTranslator({});
    // 用桩 React.createElement 真实执行源码里的包装器
    const factory = new Function('React', 'localeT', `${snippet}\nreturn h;`);
    const h = factory(
      { createElement: (type, props, ...children) => ({ type, props, children }) },
      (key, vars) => translator.t(key, vars),
    );

    // 字符串子节点 / 数组子节点 / 可翻译属性
    assert.deepEqual(h('span', null, '运行中').children, ['Running']);
    assert.deepEqual(h('div', null, ['运行中', '未启动']).children, [['Running', 'Not started']]);
    assert.equal(h('button', { title: '关闭' }).props.title, 'Close');
    assert.equal(h('input', { placeholder: '复制链接' }).props.placeholder, 'Copy link');
    assert.equal(h('button', { 'aria-label': '✓ 已复制' }).props['aria-label'], '✓ Copied');
    assert.equal(h('img', { alt: '运行中' }).props.alt, 'Running');
    // 未命中词典的内容原样保留（用户数据 / 路径 / 代码不会误翻）
    assert.equal(h('div', null, 'my session 运行中 test').children[0], 'my session 运行中 test');
    assert.equal(h('div', null, '/home/me/运行中/x.js').children[0], '/home/me/运行中/x.js');
    assert.equal(h('div', null, '这段文案没有词条').children[0], '这段文案没有词条');
    assert.deepEqual(h('div', null, 42, null, false, '').children, [42, null, false, '']);
    // 原型属性名不得被当成词条（否则 React 会拿到函数/对象）
    for (const name of ['constructor', 'toString', '__proto__']) {
      assert.equal(h('div', null, name).children[0], name, `原型属性名必须原样渲染：${name}`);
    }
    // React 语义：key / style 保真；无可翻译属性时 props 引用不变
    const style = { color: 'red' };
    const withKey = h('div', { key: 'k', style }, '运行中');
    assert.equal(withKey.props.key, 'k');
    assert.equal(withKey.props.style, style);
    const plainProps = { onClick: () => {} };
    assert.equal(h('div', plainProps, 'x').props, plainProps, '无可翻译属性时不应创建 props 副本');
    assert.equal(h('br').props, undefined);
    // 中文模式逐字一致（含换行与全角标点）
    currentLang = 'zh-CN';
    const zhText = '⚠️ 检测到有任务正在运行，重启会中断它们：\n\n继续？';
    assert.equal(h('div', null, zhText).children[0], zhText);
    assert.equal(h('div', { title: '远程访问' }).props.title, '远程访问');
    assert.equal(h('span', null, '运行中').children[0], '运行中');
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
});

test('服务端运行时文案：网络诊断 / 路径校验 / 隧道详情 / 升级重启错误均能英文化', () => {
  const originalDocument = globalThis.document;
  try {
    globalThis.document = { documentElement: { getAttribute: () => 'en' } };
    const en = createTranslator({});
    const cases = [
      // 网络连通性一键诊断（面板自有卡片，来源 lib/index.js diagnoseNetwork）
      ['本地反向代理端口 (3082)', 'Local reverse-proxy port (3082)'],
      ['正常运行中 (代理目标端口: 8080)', 'Running (proxy target port: 8080)'],
      ['代理未启动', 'Proxy is not running'],
      ['局域网 IP 分配与可用性', 'LAN IP allocation & availability'],
      ['检测到有效局域网 IPv4: 192.168.1.5', 'Valid LAN IPv4 detected: 192.168.1.5'],
      ['未检测到活跃局域网 IPv4 地址 (可能未连接 Wi-Fi/以太网)', 'No active LAN IPv4 address detected (Wi-Fi/Ethernet may be disconnected)'],
      ['Cloudflare Anycast 边缘网络', 'Cloudflare Anycast edge network'],
      ['国内 npm 高速镜像源 (npmmirror)', 'npmmirror (fast npm mirror)'],
      ['服务器连通良好 (延迟 12ms · 状态: 客户端在线运行中)', 'Server reachable (latency 12 ms · status: Client online)'],
      ['自建隧道部署服务器 (example.com:443)', 'Self-hosted tunnel server (example.com:443)'],
      ['无法连通自建服务器: connect ECONNREFUSED', 'Cannot reach the self-hosted server: connect ECONNREFUSED'],
      // 嵌套翻译：外层英文模板 + 内层中文原因（$1t）
      ['连接异常: 连接超时 (3.5s) (临时公网隧道可能受阻)', 'Connection error: Connection timed out (3.5s) (the temporary public tunnel may be blocked)'],
      // 目录选择器路径校验 / 安全拦截
      ['指定路径不是文件夹: /etc/passwd', 'Not a folder: /etc/passwd'],
      ['无法访问指定路径 (EACCES: permission denied)', 'Cannot access the path (EACCES: permission denied)'],
      ['读取文件夹失败: Error: ENOENT', 'Failed to read the folder: Error: ENOENT'],
      ['安全拦截：禁止访问敏感配置目录「.ssh」', 'Blocked: access to a sensitive configuration directory “.ssh” is not allowed'],
      ['安全拦截：禁止访问 UNC 网络共享路径', 'Blocked: UNC network share paths are not allowed'],
      // 隧道就绪 / 健康探活详情
      ['固定隧道已建立 (https://x.trycloudflare.com)', 'Fixed tunnel established (https://x.trycloudflare.com)'],
      ['健康探活连续 3 次失败：连接器已无健康边缘连接，正在观察能否自行恢复（3/10）', 'Health probe failed 3 times in a row: the connector has no healthy edge connection — watching whether it recovers (3/10)'],
      // 升级 / 重启 / IM 平台错误
      ['非法的版本号格式: x.y.z', 'Invalid version format: x.y.z'],
      ['重启失败：permission denied', 'Restart failed: permission denied'],
      ['当前运行在 DSH 桌面版内，宿主由应用统一管理，插件不能自行重启。请用桌面应用菜单的重启/退出重进（有关闭确认保护正在跑的任务），不要用面板重启。',
        'DSH Desktop manages the host itself, so the plugin cannot restart it. Use the desktop app menu to restart or quit and reopen (it asks for confirmation when tasks are running) instead of the panel restart.'],
      ['扫码创建应用未返回完整凭据', 'Scan-to-create did not return complete credentials'],
      ['飞书通道未启动：请先配置应用凭证并连接', 'Lark / Feishu channel is not running: configure the app credentials and connect first'],
      // 正则顺序：专用规则必须先于通用「请求过于频繁」命中
      ['添加工作区请求过于频繁，请等待 3 秒后再试', 'Too many workspace requests; retry in 3 s'],
      ['请求过于频繁，请等待 8 秒后再试', 'Too many requests; retry in 8 s'],
      // 服务端数据型文案：目录弹窗常用根目录 / 盘符、网卡标签后缀、工作区错误
      ['🏠 用户主目录', '🏠 Home'],
      ['💻 桌面', '💻 Desktop'],
      ['📁 文档', '📁 Documents'],
      ['📥 下载', '📥 Downloads'],
      ['根目录 /', 'Root /'],
      ['C: 盘', 'C: drive'],
      ['D: 盘', 'D: drive'],
      ['192.168.1.5 · en0 (Wi-Fi 无线网卡)', '192.168.1.5 · en0 (Wi-Fi adapter)'],
      ['192.168.1.5 · eth0 (有线网卡)', '192.168.1.5 · eth0 (wired adapter)'],
      ['172.24.0.1 · docker0 (虚拟网卡 / WSL / 虚拟机)', '172.24.0.1 · docker0 (virtual adapter / WSL / VM)'],
      ['缺少工作区目录路径', 'Missing workspace directory path'],
      ['路径安全校验未通过', 'Path failed the security check'],
      ['登录启动失败', 'Failed to start sign-in'],
      ['升级命令执行失败', 'Upgrade command failed'],
      ['未找到 dsh 命令（可能通过源码/打包方式运行，非 npm 全局安装）', 'dsh command not found (it may be installed from source or packaged rather than as a global npm package)'],
      ['当前 DSH 为非 npm 全局安装，无法自动升级；请按官方渠道手动更新', 'This DSH is not a global npm install, so automatic upgrade is unavailable — update manually via the official channel'],
      ['隧道未运行', 'Tunnel is not running'],
      ['未命名会话', 'Untitled session'],
      ['待审批请求', 'Pending approval'],
      // 隧道运行时拼接详情（含内层原因二次翻译）
      ['cloudflared 启动失败: spawn ENOENT，5s 后自动重连（第 2/12 次）', 'cloudflared failed to start: spawn ENOENT, reconnecting automatically after 5s (attempt 2/12)'],
      ['cloudflared 启动失败: spawn ENOENT，30s 后继续自动重连（已重试 13 次；隧道长时间无法建立，请检查网络与 Token）', 'cloudflared failed to start: spawn ENOENT, continuing to reconnect automatically after 30s (retried 13 times; the tunnel has been down for a while — check your network and Token)'],
      ['cloudflared 启动失败: timeout（已自动重试 12 次仍失败，请检查网络/Token，或点击「关闭」停止）', 'cloudflared failed to start: timeout (retried 12 times without success — check your network/Token, or click “Close” to stop)'],
      ['隧道已建立；⚠️ 运行时健康探活未启用（未识别到 cloudflared metrics 地址），连接器若静默假死将无法自动发现', 'Tunnel established; ⚠️ runtime health probing is disabled (no cloudflared metrics address found) — a silently hung connector will not be detected automatically'],
      // 进程意外退出 / 退出码 与组合串（专用规则需先于通用前缀命中，内层原因二次翻译）
      ['cloudflared 进程意外退出 (code=1)', 'cloudflared exited unexpectedly (code=1)'],
      ['cloudflared 进程意外退出 (code=1, SIGTERM)，5s 后自动重连（第 1/3 次）', 'cloudflared exited unexpectedly (code=1, SIGTERM), reconnecting automatically after 5s (attempt 1/3)'],
      ['cloudflared 启动失败: cloudflared 退出，code=1 signal=SIGTERM，5s 后自动重连（第 1/3 次）', 'cloudflared failed to start: cloudflared exited (code=1, signal=SIGTERM), reconnecting automatically after 5s (attempt 1/3)'],
      ['cloudflared 启动失败: 配置错误（请检查 Token 与参数）', 'cloudflared failed to start: Configuration error (check the Token and parameters)'],
      // 面板解锁弹窗的认证错误（与登录页共用同一套语义）
      ['尝试次数过多，请 60 秒后再试', 'Too many attempts, please try again in 60 seconds'],
      ['尝试次数过多，请稍后再试', 'Too many attempts, please try again later'],
      ['当前已配置为仅限电脑本机管理设置', 'Management is currently restricted to this computer'],
      // D13：Telegram 稳态标签 / 微信登录失败 / 飞书扫码错误 / 升级探测原因 / systemctl 内层原因
      ['已配置 Token', 'Token configured'],
      ['登录失败或超时', 'Sign-in failed or timed out'],
      ['探测 dsh 安装形态失败，请按官方渠道手动更新', 'Failed to detect how dsh is installed; update manually via the official channel'],
      ['你已拒绝授权，可重新发起扫码创建（access_denied）', 'You declined the authorization; you can start the QR sign-in again (access_denied)'],
      ['二维码已过期，请重新发起扫码创建（expired_token）', 'The QR code expired; start the QR sign-in again (expired_token)'],
      ['systemctl 执行超时（5s）', 'systemctl timed out (5s)'],
      ['systemctl 退出码 1', 'systemctl exit code 1'],
      ['systemctl restart dsh 失败：systemctl 执行超时（5s）。DSH 仍在运行；请手动执行「systemctl restart dsh」或检查单元。', 'systemctl restart dsh failed: systemctl timed out (5s). DSH is still running; run “systemctl restart dsh” manually or check the unit.'],
    ];
    for (const [zh, expected] of cases) {
      assert.equal(en.t(zh), expected, `服务端文案英文化失败：${JSON.stringify(zh)}`);
    }
    globalThis.document = { documentElement: { getAttribute: () => 'zh-CN' } };
    const zhT = createTranslator({});
    for (const [zh] of cases) assert.equal(zhT.t(zh), zh, `中文模式必须原样返回：${JSON.stringify(zh)}`);
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
});

test('访客登录页：跟随 Accept-Language 的中英渲染与错误映射', () => {
  const CJK = /[\u3400-\u9fff\u3000-\u303f\uff01-\uff60\uffe0-\uffe6]/;
  // 英文页：三种"未设密码"分支都不得残留中文/全角标点
  for (const mode of ['password_only', 'token_only', 'token_and_password']) {
    const html = renderLoginPage({ lang: 'en', noPasswordConfigured: true, hasPassword: false, mode });
    assert.equal(CJK.test(html), false, `英文登录页不应含中文（mode=${mode}）`);
    assert.match(html, /<html lang="en">/);
  }
  const en = renderLoginPage({ lang: 'en' });
  assert.equal(CJK.test(en), false, '英文登录页不应含中文');
  // 中文页保持原样（缺省语言 = 中文）
  const zh = renderLoginPage({});
  assert.equal(CJK.test(zh), true, '中文登录页应保持中文');
  assert.match(zh, /<html lang="zh-CN">/);
  // 已知服务端错误映射；未知文案原样显示（不编造）
  assert.equal(CJK.test(renderLoginPage({ lang: 'en', error: '访问密码错误' })), false);
  assert.match(renderLoginPage({ lang: 'en', error: '访问密码错误' }), /Incorrect access password/);
  assert.equal(localizeAuthError('尝试次数过多，请 60 秒后再试', 'en'), 'Too many attempts, please try again in 60 seconds');
  assert.equal(localizeAuthError('未收录的错误', 'en'), '未收录的错误');
  assert.equal(localizeAuthError('访问密码错误', 'zh'), '访问密码错误');
  assert.equal(localizeAuthError('', 'en'), '');
});

test('$1t 递归翻译有深度上限（超长嵌套前缀不得把调用栈打爆）', () => {
  const originalDocument = globalThis.document;
  try {
    globalThis.document = { documentElement: { getAttribute: () => 'en' } };
    const en = createTranslator({});
    const deep = '重启失败：'.repeat(2000) + 'permission denied';
    let out;
    assert.doesNotThrow(() => { out = en.t(deep); });
    assert.equal(typeof out, 'string');
    assert.ok(out.endsWith('permission denied'));
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
});

test('登录页与登录错误共用同一语言判定（非中非英浏览器不得出现英文页 + 中文报错）', () => {
  const CJK = /[\u3400-\u9fff\u3000-\u303f\uff01-\uff60\uffe0-\uffe6]/;
  for (const header of ['', 'zh-CN,zh;q=0.9', 'en-US,en;q=0.9', 'de-DE,de;q=0.9', 'ja-JP', 'fr-FR,fr;q=0.8', '*']) {
    const lang = pickLoginLang(header);
    const page = renderLoginPage({ lang, error: '访问密码错误' });
    const error = localizeAuthError('访问密码错误', lang);
    if (lang === 'en') {
      assert.equal(CJK.test(page), false, `英文页不应含中文（header=${header}）`);
      assert.equal(error, 'Incorrect access password', `英文错误文案（header=${header}）`);
    } else {
      assert.equal(CJK.test(page), true, `中文页应保持中文（header=${header}）`);
      assert.equal(error, '访问密码错误', `中文错误文案（header=${header}）`);
    }
    // 页面语言与错误语言必须一致：出现 "Incorrect access password" 就说明是英文侧
    assert.equal(page.includes('Incorrect access password'), lang === 'en', `页面/错误语言必须一致（header=${header}）`);
  }
  assert.equal(pickLoginLang(), 'zh');
  assert.equal(pickLoginLang(undefined), 'zh');
  assert.equal(pickLoginLang('zh-TW'), 'zh');
  assert.equal(pickLoginLang('EN-us'), 'en');
});

test('渲染点接线：服务端数据必须先过 localeT 再渲染（防止重构误删接线）', () => {
  const source = readFileSync(resolve(repoRoot, 'client/index.js'), 'utf8');
  const wirings = [
    // 目录选择弹窗：常用目录 / 盘符名称（服务端返回中文）
    'localeT(d.name)',
    'localeT(r.name)',
    // 网卡标签（服务端拼了中文后缀）
    'localeT(iface.label || iface.name)',
    // 工作警告：会话标题兜底与待审批摘要
    'title: localeT(s.title)',
    'summary: localeT(a.summary)',
  ];
  for (const wiring of wirings) {
    assert.ok(source.includes(wiring), `渲染点必须保留 ${wiring}（否则服务端中文会原样渲染）`);
  }
  // 登录页与 POST /login 错误必须共用 pickLoginLang（两处都要；只改一处会导致
  // 非中非英浏览器看到「英文页面 + 中文报错」）
  const libSource = readFileSync(resolve(repoRoot, 'lib/index.js'), 'utf8');
  const wiring = "pickLoginLang(req.headers['accept-language'])";
  assert.equal(libSource.split(wiring).length - 1, 2, 'lib/index.js 必须在登录页与登录错误两处共用 pickLoginLang');
});
