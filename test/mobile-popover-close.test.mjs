// 回归测试：移动端宿主浮层（智能体团队 / 子智能体下拉）的统一收起按钮
//
// 现场：会话页在手机上打开「智能体团队」浮层后没有任何返回/关闭入口。宿主这两处浮层都是
// 桌面语义的 popover（hover 移出 / 点浮层外空白 / Esc），自身不含关闭控件；而它们的高度
// 上限已接近整屏（团队浮层 680px；子智能体下拉在矮屏 + 多子智能体时同样紧张），浏览器
// 地址栏与底部导航条又把上下空白吃掉，"点外面"这条唯一退路在手机上不可达。本插件因此在
// 浮层内统一注入一个常驻的「✕ 收起」按钮。
//
// 本文件只做「结构与产物同步」断言（不需要浏览器）；真实几何/命中/点击行为由
// test/browser/mobile-popover-close.mjs（npm run verify:mobile-ui）覆盖。
//
// ⚠️ 本文件里最要紧的一条是「观察器死循环红线」：注入逻辑跑在监听 class 的
// MutationObserver 回调里，而 Chromium 的 classList.add()/remove() **即使 class 属性值
// 不变也会写属性并产生变更记录**（实测 add 已有 token → 1 条；remove 不存在的 token →
// 也是 1 条）。无条件开关 class 会变成"回调→变更→回调"的微任务死循环，把渲染进程彻底
// 卡死（本次开发中真实踩到：打开浮层后页面 15s 无任何响应）。故源码里禁止直接写浮层的
// class（classList.add/remove、className=、setAttribute('class')），必须走先判存在再动的
// setPopoverHostClass。（`classList.toggle(token, force)` 实测不产生记录，属安全写法。）
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MOBILE_STYLES_CSS } from '../client/mobile-styles.js';
import { FAMILY_SLOTS, renderMobileStyles } from '../client/host-families.js';
import { zh, en } from '../client/locales.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// 断言关心规则内容而非宿主前缀（Issue #72 起源码里是 __F_<SLOT>__ 占位符）：
// 这里按 0.1.x 那一代前缀渲染做结构断言，产物同步断言用未渲染的模板原文。
const LEGACY_FAMILIES = Object.fromEntries(
  Object.entries(FAMILY_SLOTS).map(([slot, spec]) => [slot, spec.known[spec.known.length - 1]]),
);
const templateCss = MOBILE_STYLES_CSS;
const sourceCss = renderMobileStyles(templateCss, LEGACY_FAMILIES);
const indexSource = readFileSync(resolve(repoRoot, 'client/index.js'), 'utf8');
const bundle = readFileSync(resolve(repoRoot, 'client/client.js'), 'utf8');
// 产物里的中文注释被 esbuild 转成 \uXXXX（非 ASCII 标点也可能是 \xNN）转义，
// 反转义后才能与源码逐字比对
const unescapedBundle = bundle.replace(
  /\\u([0-9a-fA-F]{4})|\\x([0-9a-fA-F]{2})/g,
  (_, u, x) => String.fromCharCode(parseInt(u ?? x, 16)),
);

// 结构断言在"剥掉注释"的副本上做：注释里若出现「选择器 {」会被取块逻辑误当成规则，
// 而注释文本本身不该影响断言的成败。产物同步断言仍用带注释的原始串。
const structureCss = sourceCss.replace(/\/\*[\s\S]*?\*\//g, ' ');

/** 按花括号配对取出整段 @media 块，避免用 includes 误判"规则其实在别的块里" */
function mediaBlock(css, query) {
  const start = css.indexOf(`@media ${query}`);
  if (start < 0) return null;
  const open = css.indexOf('{', start);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(start, i + 1);
    }
  }
  return null;
}

/** 取某选择器在给定 CSS 片段里的声明体（本文件中的规则均无嵌套） */
function ruleBody(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`${escaped}\\s*\\{`).exec(css);
  if (!m) return null;
  const open = css.indexOf('{', m.index);
  const close = css.indexOf('}', open);
  if (open < 0 || close < 0) return null;
  return css.slice(open + 1, close);
}

const mobileBlock = mediaBlock(structureCss, '(max-width: 767px)');
// 移出移动端块后的剩余 CSS：用于断言这些规则**只**在手机上生效
const outsideMobile = mobileBlock ? structureCss.split(mobileBlock).join('') : structureCss;
const TEAM_HOST = '[data-team-panel].dsh-bridge-team-panel';
const SUBAGENT_HOST = 'body > div[class*="_menu"].dsh-bridge-subagent-menu';

test('移动端块内为两处宿主浮层让出操作带并收紧高度上限', () => {
  assert.ok(mobileBlock, '移动端媒体查询块缺失');

  // (1) 两处浮层各自留出同一条"顶部 44px 操作带"
  const team = ruleBody(mobileBlock, TEAM_HOST);
  assert.ok(team, '团队浮层应有独立规则');
  assert.match(team, /[;{\s]padding-top:\s*44px\s*!important/, '团队浮层应为注入的收起按钮留出 44px 顶部操作带');

  const subagent = ruleBody(mobileBlock, SUBAGENT_HOST);
  assert.ok(subagent, '子智能体下拉应有独立规则');
  assert.match(subagent, /[;{\s]padding-top:\s*44px\s*!important/, '子智能体下拉应为注入的收起按钮留出 44px 顶部操作带');

  // (2) 各自的高度上限：按动态视口再留安全边（vh 兜底写在 dvh 之前），并带 160px 下限保护
  //     （数学函数在"视口比保留量还矮"时会算出 ≤0，而 !important 会赢过宿主自己的兜底 →
  //     浮层被压成 0 高、连按钮一起不可见；独立验收实测 80px 视口下计算值就是 0px）
  assert.match(team, /[;{\s]max-height:\s*max\(160px,\s*min\(680px,\s*calc\(100dvh - 96px\)\)\)\s*!important/,
    '团队浮层应按动态视口再留 96px 安全边，并有 160px 下限保护');
  assert.match(team, /[;{\s]max-height:\s*max\(160px,\s*min\(680px,\s*calc\(100vh - 96px\)\)\)\s*!important/,
    '不支持 dvh 的环境要有 vh 兜底');

  assert.match(subagent, /[;{\s]max-height:\s*max\(160px,\s*min\(560px,\s*calc\(100dvh - 140px\)\)\)\s*!important/,
    '子智能体下拉应沿用宿主 560px/140px 的设计上限、按动态视口计算，并有 160px 下限保护');
  assert.match(subagent, /[;{\s]max-height:\s*max\(160px,\s*min\(560px,\s*calc\(100vh - 140px\)\)\)\s*!important/,
    '不支持 dvh 的环境要有 vh 兜底');

  // (3) 共用的收起按钮样式
  const btn = ruleBody(mobileBlock, '.dsh-mobile-popover-close-btn');
  assert.ok(btn, '移动端块内应有 .dsh-mobile-popover-close-btn 规则');
  assert.match(btn, /[;{\s]position:\s*absolute\s*!important/, '按钮应绝对定位在浮层右上角');
  assert.match(btn, /[;{\s]top:\s*8px\s*!important/, '按钮应钉在浮层顶部');
  assert.match(btn, /[;{\s]right:\s*8px\s*!important/, '按钮应钉在浮层右侧');
  assert.match(btn, /[;{\s]height:\s*28px\s*!important/, '按钮高度应满足触控尺寸');
  assert.match(btn, /[;{\s]z-index:\s*\d+\s*!important/, '按钮应压在浮层内容之上');
});

test('这些规则只作用于移动端：桌面/平板宽度下不改动宿主浮层', () => {
  for (const sel of [TEAM_HOST, SUBAGENT_HOST, '.dsh-mobile-popover-close-btn']) {
    assert.equal(ruleBody(outsideMobile, sel), null, `${sel} 不得出现在 <=767px 之外（PC 端保持宿主原样）`);
  }
});

test('注入表：两处浮层各用稳定的非哈希钩子，且共用同一个按钮类', () => {
  assert.match(indexSource, /const MOBILE_POPOVERS = \[/, '应以表驱动方式声明需要补按钮的宿主浮层');
  assert.match(indexSource, /selector: '\[data-team-panel\]',\s*hostClass: 'dsh-bridge-team-panel',/,
    '团队浮层应使用宿主自带的 [data-team-panel] 属性钩子');
  assert.match(indexSource, /selector: 'body > div\[class\*="_menu"\]:has\(> div\[role="tree"\]\)',\s*hostClass: 'dsh-bridge-subagent-menu',/,
    '子智能体下拉应用「body 直挂 portal 菜单 + 直接子级 role=tree」两个结构特征定位（宿主无属性钩子）');
  assert.match(indexSource, /const POPOVER_CLOSE_CLASS = 'dsh-mobile-popover-close-btn';/, '按钮类名应与 CSS 一致');
  assert.match(indexSource, /btn\.setAttribute\(POPOVER_KEY_ATTR, popover\.key\);/, '按钮应带标记，便于区分它属于哪处浮层');
  assert.match(indexSource, /const collapseLabel = localeT\('popover\.collapse'\);/, '文案应取一次存成 collapseLabel，供 aria 与可见文案共用');
  assert.match(indexSource, /btn\.setAttribute\('aria-label', collapseLabel\)/, '按钮应带可读的 aria-label');
  // 可见文案走 textContent，不拼进 innerHTML（避免将来词典来源变化成为注入点）。
  // 只看收起按钮这一段的构造代码：仓库里其它按钮（如工作台收起）历史上用的是模板串，
  // 不属本次范围。
  assert.match(indexSource, /label\.textContent = collapseLabel;/, '可见文案应用 textContent 写入');
  const btnBlockStart = indexSource.indexOf('btn.className = POPOVER_CLOSE_CLASS;');
  const btnBlockEnd = indexSource.indexOf('node.appendChild(btn);', btnBlockStart);
  assert.ok(btnBlockStart >= 0 && btnBlockEnd > btnBlockStart, '收起按钮构造代码结构变了，请同步本断言');
  assert.doesNotMatch(indexSource.slice(btnBlockStart, btnBlockEnd), /\$\{/,
    '收起按钮的构造不得使用模板插值（图标是固定串、文案走 textContent）');
  assert.match(indexSource, /node\.appendChild\(btn\);/, '按钮应注入浮层内');
});

test('桌面宽度分支会撤掉按钮与让位类（PC 端保持宿主原样）', () => {
  assert.match(
    indexSource,
    /const mobile = window\.innerWidth <= MOBILE_MAX_WIDTH;/,
    '应以 MOBILE_MAX_WIDTH 作为移动端门控（与 CSS 的 max-width:767px 对齐）',
  );
  // 取整个注入函数的原文做断言：桌面分支里也有 MOBILE_POPOVERS.forEach，按"第一处 forEach"
  // 切片会切错（该函数自己就是"先桌面分支、后移动端分支"两段）
  const fnAt = indexSource.indexOf('const ensureMobilePopoverCloseButtons = () => {');
  assert.ok(fnAt >= 0, '应有 ensureMobilePopoverCloseButtons');
  const fnBody = indexSource.slice(fnAt, indexSource.indexOf('\n  };', fnAt));
  assert.match(fnBody, /if \(!mobile\) \{/, '应有桌面分支');
  assert.match(fnBody, /querySelectorAll\(`\.\$\{POPOVER_CLOSE_CLASS\}`\)\.forEach\(btn => btn\.remove\(\)\)/,
    '桌面分支应移除注入的按钮（含宿主换钩子后的残留）');
  assert.match(fnBody, /setPopoverHostClass\(node, popover\.hostClass, false\)/,
    '桌面分支应撤掉让位类');
});

test('观察器死循环红线：class 开关必须先判存在再动，且禁止封装外的直接写法', () => {
  const helperStart = indexSource.indexOf('const setPopoverHostClass = (el, cls, on) => {');
  assert.ok(helperStart >= 0, 'class 开关必须封装成"先判存在再动"的 setPopoverHostClass');
  const helperEnd = indexSource.indexOf('};', helperStart);
  assert.ok(helperEnd > helperStart, 'setPopoverHostClass 定义不完整');
  const helper = indexSource.slice(helperStart, helperEnd + 2);
  const outsideHelper = indexSource.slice(0, helperStart) + indexSource.slice(helperEnd + 2);

  assert.match(helper, /if \(on === el\.classList\.contains\(cls\)\) return;/, '封装内必须先比对当前状态再决定是否动 class');
  assert.match(helper, /if \(on\) el\.classList\.add\(cls\);/, '封装内加类');
  assert.match(helper, /else el\.classList\.remove\(cls\);/, '封装内撤类');
  assert.match(indexSource, /setPopoverHostClass\(node, popover\.hostClass, true\);/, '移动端分支应通过该封装加类');

  // 红线：封装之外任何直接写浮层 class 的写法都可能把观察器变成死循环
  assert.doesNotMatch(
    outsideHelper,
    /node\.classList\.(add|remove)\(|node\.className\s*=|node\.setAttribute\(\s*['"]class['"]/,
    '禁止在 setPopoverHostClass 之外直接写浮层 class：Chromium 在值未变时也会产生变更记录，'
      + '配合监听 class 的 MutationObserver 会变成微任务死循环（页面彻底卡死）',
  );
});

test('关闭动作走宿主自己的收起路径（外部 pointerdown + Esc 兜底）', () => {
  assert.match(indexSource, /document\.body\.dispatchEvent\(new PointerCtor\('pointerdown', \{ bubbles: true, cancelable: true \}\)\)/,
    '应派发一次冒泡 pointerdown（等价于点浮层外的空白，宿主据此收起）');
  assert.match(indexSource, /new KeyboardEvent\('keydown', \{ key: 'Escape', bubbles: true, cancelable: true \}\)/,
    '应有 Esc 兜底（团队浮层注册的是 document 级 keydown 收起）');
  assert.match(indexSource, /const PointerCtor = typeof window\.PointerEvent === 'function' \? window\.PointerEvent : window\.MouseEvent;/,
    '老环境应回退到 MouseEvent');
  assert.match(indexSource, /if \(node === undefined \|\| !node\.isConnected\) return;/, '浮层已消失时不得再派发收起事件');
});

test('注入接线到既有观察器与 resize 回调（浮层出现/重建/宽窄屏切换都能收敛）', () => {
  assert.match(indexSource, /const syncMobilePanelAffordances = \(\) => \{\s*ensurePanelCloseButton\(\);\s*ensureMobilePopoverCloseButtons\(\);\s*\};/,
    '浮层补齐应挂在同一个同步入口上');
  assert.match(indexSource, /new MutationObserver\(syncMobilePanelAffordances\)/, '观察器回调应调用同步入口');
  assert.match(indexSource, /window\.addEventListener\('resize', syncMobilePanelAffordances\)/, 'resize 应调用同步入口');
  // 语言切换是"事件驱动"的：<html lang> 不在 body 子树里，必须单独观察，
  // 否则按钮文案只能碰运气等下一次 class 变更（独立验收实测过这个滞后）
  assert.match(
    indexSource,
    /panelObserver\.observe\(document\.documentElement, \{ attributes: true, attributeFilter: \['lang'\] \}\);/,
    '应单独观察 <html lang>，让已注入按钮的文案在语言切换时立即跟上',
  );
});

test('查询浮层必须吞掉选择器异常：老引擎不支持 :has() 时不能把同批其它浮层带崩', () => {
  const fnAt2 = indexSource.indexOf('const popoverNodes = (selector) => {');
  assert.ok(fnAt2 >= 0, '应通过 popoverNodes 统一查询');
  const fnBody2 = indexSource.slice(fnAt2, indexSource.indexOf('\n  };', fnAt2));
  assert.match(fnBody2, /try \{\s*return document\.querySelectorAll\(selector\);\s*\}/, '查询应包在 try 里');
  assert.match(fnBody2, /catch \(reason\) \{/, 'catch 应接住 SyntaxError（:has() 需要 Chromium 105+）');
  assert.match(fnBody2, /return \[\];/, '不支持时返回空集，绝不让异常冒泡出观察器回调');
  // 两处调用点（桌面分支撤类 + 移动端注入）都必须走这个封装
  assert.equal((indexSource.match(/popoverNodes\(popover\.selector\)/g) || []).length, 2,
    '两处浮层查询都应走 popoverNodes（不能有裸 querySelectorAll(popover.selector)）');
  assert.doesNotMatch(indexSource, /document\.querySelectorAll\(popover\.selector\)/,
    '不得再出现未捕获异常的裸查询');
});

test('语言切换后已注入的按钮文案会跟上（写前比对，不产生额外 DOM 变更）', () => {
  assert.match(indexSource, /const existing = node\.querySelector\(`\.\$\{POPOVER_CLOSE_CLASS\}`\);/,
    '应复用已注入的按钮而不是重复注入');
  assert.match(indexSource, /if \(text !== null && text\.textContent !== collapseLabel\) text\.textContent = collapseLabel;/,
    '语言变化时可见文案应就地更新');
  assert.match(indexSource, /if \(existing\.getAttribute\('aria-label'\) !== collapseLabel\) existing\.setAttribute\('aria-label', collapseLabel\);/,
    'aria-label 也应同步（同样先比对再写）');
});

test('选择器不被支持时留下可观测告警（不静默降级）', () => {
  assert.match(indexSource, /const popoverSelectorWarned = new Set\(\);/, '同一选择器只应告警一次（观察器回调很频繁）');
  assert.match(indexSource, /if \(!popoverSelectorWarned\.has\(selector\)\) \{/, '应有一次性去重');
  assert.match(indexSource, /console\.warn\(`\[dsh-bridge\] 浮层选择器不被当前浏览器支持/, '应打印可检索的告警文案');
  assert.match(indexSource, /catch \(reason\) \{/, 'catch 应接住原因并用于告警');
});

test('文案：中英词典都有收起动作（按钮文字兼 aria-label）', () => {
  assert.equal(zh['popover.collapse'], '收起');
  assert.equal(en['popover.collapse'], 'Collapse');
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), 'zh/en 词典键集必须一致');
});

test('打包产物与源码同步（含两处浮层、共用按钮与死循环红线守卫）', () => {
  assert.ok(
    unescapedBundle.includes(templateCss),
    '产物内嵌的移动端 CSS 与源码不一致，请运行 npm run build:client',
  );
  for (const needle of [
    '[data-team-panel].dsh-bridge-team-panel',
    'body > div[class*="_menu"].dsh-bridge-subagent-menu',
    '.dsh-mobile-popover-close-btn',
    'dsh-bridge-team-panel',
    'dsh-bridge-subagent-menu',
    'setPopoverHostClass',
    'classList.contains(cls)',
    'popoverNodes',
    'popoverSelectorWarned',
    'attributeFilter: ["lang"]',
    'text.textContent !== collapseLabel',
    // esbuild 打印时会把引号规范化：含双引号的字符串用单引号，其余用双引号
    'selector: "[data-team-panel]"',
    'selector: \'body > div[class*="_menu"]:has(> div[role="tree"])\'',
    'localeT("popover.collapse")',
  ]) {
    assert.ok(unescapedBundle.includes(needle), `产物缺少 ${needle}，疑似忘记运行 npm run build:client`);
  }
});
