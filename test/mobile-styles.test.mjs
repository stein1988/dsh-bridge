import test from 'node:test';
import assert from 'node:assert/strict';
import { MOBILE_STYLES_CSS } from '../client/mobile-styles.js';

// 这套 CSS 靠硬编码宿主构建产物的 CSS-module 哈希类名命中元素，宿主一升级就可能失效。
// 这里只钉住"用户可见行为"层面的关键规则，避免以后被误删：
//   1) 输入框下方的统计胶囊条（StatsPills）在移动端必须隐藏
//   2) 该隐藏必须与移动端主断点同处一个 @media 内（不断言具体像素值，避免官方调断点就过期）
//   3) 同时保留 data-composer-stats 属性选择器（宿主换哈希后仍能命中）

/** 取出包含给定片段的那个 @media 块的头部，用于判断作用域。 */
function enclosingMediaQuery(css, needle) {
  const at = css.indexOf(needle);
  assert.notEqual(at, -1, `CSS 中找不到 ${needle}`);
  const mediaAt = css.lastIndexOf('@media', at);
  assert.notEqual(mediaAt, -1, `${needle} 不在任何 @media 块内`);
  return css.slice(mediaAt, css.indexOf('{', mediaAt)).trim();
}

/** 取出 needle 所在规则块的完整文本（含选择器与声明）。 */
function ruleBlockFor(css, selector) {
  const at = css.indexOf(selector);
  assert.notEqual(at, -1, `CSS 中找不到选择器 ${selector}`);
  const open = css.indexOf('{', at);
  const close = css.indexOf('}', open);
  assert.notEqual(open, -1, `${selector} 缺少 {`);
  assert.notEqual(close, -1, `${selector} 缺少 }`);
  return css.slice(at, close + 1);
}

test('移动端隐藏输入框下方的统计胶囊条（StatsPills）', () => {
  const block = ruleBlockFor(MOBILE_STYLES_CSS, 'div[data-composer-stats="true"]');

  // 必须真的隐藏，而不是只改尺寸/透明度
  assert.match(block, /display:\s*none\s*!important/, '统计条必须 display:none !important');
  // 必须清掉自带 padding，否则隐藏后仍可能残留顶部空隙
  assert.match(block, /padding:\s*0\s*!important/, '统计条必须清掉 padding');
});

test('统计条隐藏规则限定在移动端断点内，不影响桌面端', () => {
  // 不写死断点像素值：官方会调（如 768→767，见 v2.10.11 #41），写死则每次都要跟改。
  // 改为断言"与移动端主断点同处一个 @media 块"：以移动端专属选择器 .dsh-mobile-app-header
  // 作锚点反查它所在的断点块，要求统计条规则也在同一个块里。
  const headerMedia = enclosingMediaQuery(MOBILE_STYLES_CSS, '.dsh-mobile-app-header');
  const statsMedia = enclosingMediaQuery(MOBILE_STYLES_CSS, 'data-composer-stats="true"');

  assert.equal(statsMedia, headerMedia,
    `统计条规则应与移动端主断点同处一个 @media 块。\n统计条所在: ${statsMedia}\n主断点所在: ${headerMedia}`);

  // 必须是 max-width 型（即移动端小屏生效），不能是 min-width（那会在桌面端生效）
  assert.match(statsMedia, /max-width/,
    `统计条规则应在 max-width 类型断点内（移动端生效），实际: ${statsMedia}`);
});

test('统计条隐藏同时覆盖 CSS-module 哈希类名与稳定属性选择器', () => {
  // 属性选择器是主选择器（宿主升级换哈希后仍生效）
  assert.ok(
    MOBILE_STYLES_CSS.includes('div[data-composer-stats="true"]'),
    '缺少 data-composer-stats 属性选择器'
  );
  // 哈希类名是双保险；哈希变化时用例会失败并提醒同步更新（见文件头注释）
  assert.ok(
    MOBILE_STYLES_CSS.includes('div[class*="bOPqQW_root"]'),
    '缺少 bOPqQW_root 哈希类名选择器（宿主升级后需同步新哈希）'
  );
});

// ---------------------------------------------------------------------------
// 输入框工具区（附件按钮）：曾经整行 display:none，导致移动端无法发送文件。
// 宿主把「命令菜单(aria-haspopup)」与「附件上传」两个按钮一起放在 .uV2eYG_tools 里，
// 而宿主自己没有为这个容器提供任何样式 —— 因此这里必须同时满足：
//   1) 容器可见且是横向 flex（否则两个 28px 按钮会块级上下堆叠）
//   2) 附件按钮保留（即不能把整行隐藏）
//   3) 命令菜单按钮仍隐藏（用 aria-haspopup 定位，与界面语言无关）
// ---------------------------------------------------------------------------

test('输入框工具区不再整行隐藏（否则附件按钮会消失）', () => {
  const block = ruleBlockFor(MOBILE_STYLES_CSS, 'div[class*="uV2eYG_tools"] {');

  assert.doesNotMatch(block, /display:\s*none/,
    '工具区不能整行 display:none —— 附件上传按钮就在这一行里，隐藏后移动端无法发送文件');
  assert.match(block, /display:\s*flex\s*!important/,
    '工具区应为横向 flex：宿主没有为它提供样式，不加 flex 两个按钮会上下堆叠');
});

test('工具区只隐藏命令菜单按钮，保留附件按钮', () => {
  // 命令菜单按钮是二者中唯一带 aria-haspopup 的（见 dsh-client-ui-conversation 的 InputBar）
  const hiddenRule = 'div[class*="uV2eYG_tools"] button[aria-haspopup]';
  assert.ok(MOBILE_STYLES_CSS.includes(hiddenRule),
    '缺少按 aria-haspopup 隐藏命令菜单按钮的规则');

  const block = ruleBlockFor(MOBILE_STYLES_CSS, hiddenRule);
  assert.match(block, /display:\s*none\s*!important/,
    '命令菜单按钮应被隐藏');

  // 反向断言：不得出现"隐藏工具区内所有 button"这种会连带干掉附件按钮的写法
  assert.doesNotMatch(MOBILE_STYLES_CSS, /uV2eYG_tools[^{]*button\s*\{[^}]*display:\s*none/,
    '不能隐藏工具区内全部按钮 —— 那会把附件按钮一起干掉');
});

// ---------------------------------------------------------------------------
// 移动端变量的一致性与安全区适配。
//
// 背景：会话页改成 edge-to-edge 后，--dsh-mobile-safe-top 不再为 0，
// 顶栏若仍写死 height: 52px 再叠加 padding-top，内容盒会被压扁。
// 因此引入 --dsh-mobile-header-total 并在所有"需要让出顶栏"的地方统一使用。
// 同时底部安全区必须走变量（而非直接写 env()），否则原生壳注入的值不会生效。
// ---------------------------------------------------------------------------

/** 取出 :root 块里的自定义属性定义：name -> value */
function rootCustomProperties(css) {
  const start = css.indexOf(':root');
  assert.notEqual(start, -1, 'CSS 中找不到 :root');
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  const body = css.slice(open + 1, close);
  const out = new Map();
  for (const m of body.matchAll(/(--[a-zA-Z0-9-]+)\s*:\s*([^;]+);/g)) {
    out.set(m[1], m[2].trim());
  }
  return out;
}

test('自定义属性不得自我引用（自我引用会让该声明整条失效）', () => {
  // 曾经真的写出来过 `--dsh-mobile-safe-bottom: var(--dsh-mobile-safe-bottom);`：
  // CSS 里这是循环引用 → 变量变成无效值 → 所有用到它的声明在计算值阶段被丢弃，
  // 底部安全区静默失效。这里做一个通用守卫。
  const props = rootCustomProperties(MOBILE_STYLES_CSS);
  assert.ok(props.size > 0, '未能解析出任何自定义属性，解析逻辑可能已失效');

  for (const [name, value] of props) {
    assert.ok(
      !new RegExp(`var\\(\\s*${name}\\s*[,)]`).test(value),
      `${name} 的值引用了它自己：${value}`
    );
  }
});

test('引用的 --dsh-mobile-* 变量都必须在样式表内定义', () => {
  // 捕获拼写错误（如 --dsh-mobile-header-totals）导致的静默失效。
  // 宿主令牌（--dsw-* 等）由 DSH 提供，不在此范围内。
  const defined = new Set(rootCustomProperties(MOBILE_STYLES_CSS).keys());
  // 同一张表里也可能在别的选择器下定义变量，一并收集
  for (const m of MOBILE_STYLES_CSS.matchAll(/(--dsh-mobile-[a-zA-Z0-9-]+)\s*:/g)) {
    defined.add(m[1]);
  }

  const referenced = new Set();
  for (const m of MOBILE_STYLES_CSS.matchAll(/var\(\s*(--dsh-mobile-[a-zA-Z0-9-]+)/g)) {
    referenced.add(m[1]);
  }
  assert.ok(referenced.size > 0, '未发现任何 var(--dsh-mobile-*) 引用，断言已失去意义');

  const missing = [...referenced].filter((name) => !defined.has(name));
  assert.deepEqual(missing, [], `以下变量被引用但未定义：${missing.join(', ')}`);
});

test('安全区变量由 env() 提供，且被实际使用', () => {
  const props = rootCustomProperties(MOBILE_STYLES_CSS);

  // 变量必须源自 env()，这样浏览器里行为不变、原生壳里可被注入覆盖
  assert.match(props.get('--dsh-mobile-safe-top') ?? '', /env\(safe-area-inset-top/,
    '--dsh-mobile-safe-top 应由 env(safe-area-inset-top) 提供');
  assert.match(props.get('--dsh-mobile-safe-bottom') ?? '', /env\(safe-area-inset-bottom/,
    '--dsh-mobile-safe-bottom 应由 env(safe-area-inset-bottom) 提供');

  // 除 :root 的定义处之外，不得再直接写 env(safe-area-inset-bottom)：
  // 否则原生壳（edge-to-edge 的 App）注入的 --dsh-mobile-safe-bottom 不会生效。
  const rootStart = MOBILE_STYLES_CSS.indexOf(':root');
  const rootOpen = MOBILE_STYLES_CSS.indexOf('{', rootStart);
  const rootClose = MOBILE_STYLES_CSS.indexOf('}', rootOpen);
  const outsideRoot =
    MOBILE_STYLES_CSS.slice(0, rootOpen) + MOBILE_STYLES_CSS.slice(rootClose + 1);

  assert.doesNotMatch(outsideRoot, /env\(safe-area-inset-bottom/,
    '底部安全区在 :root 之外不能直接写 env(safe-area-inset-bottom)，必须走 --dsh-mobile-safe-bottom 变量');
  assert.doesNotMatch(outsideRoot, /env\(safe-area-inset-top/,
    '顶部安全区在 :root 之外不能直接写 env(safe-area-inset-top)，必须走 --dsh-mobile-safe-top 变量');
});

test('顶栏预留高度包含顶部安全区（否则会被压扁或与内容重叠）', () => {
  const props = rootCustomProperties(MOBILE_STYLES_CSS);

  // 总高度 = 内容高度 + 顶部安全区
  const total = props.get('--dsh-mobile-header-total') ?? '';
  assert.match(total, /calc\(/,
    `--dsh-mobile-header-total 应为 calc()，实际: ${total}`);
  assert.match(total, /--dsh-mobile-header-h/,
    `--dsh-mobile-header-total 应包含 --dsh-mobile-header-h，实际: ${total}`);
  assert.match(total, /--dsh-mobile-safe-top/,
    `--dsh-mobile-header-total 应包含 --dsh-mobile-safe-top，实际: ${total}`);

  // 顶栏自身高度必须用总高度（固定 52px + padding-top 会压扁内容盒）
  const headerRule = ruleBlockFor(MOBILE_STYLES_CSS, '.dsh-mobile-app-header {');
  assert.match(headerRule, /height:\s*var\(--dsh-mobile-header-total\)/,
    '顶栏 height 必须使用 --dsh-mobile-header-total');
  assert.doesNotMatch(headerRule, /height:\s*var\(--dsh-mobile-header-h\)/,
    '顶栏 height 不能只用 --dsh-mobile-header-h（漏掉安全区会压扁内容）');

  // 主框架让出的顶部空间同样要包含安全区
  const frameRule = ruleBlockFor(MOBILE_STYLES_CSS, 'div[class*="_frame"] {');
  assert.match(frameRule, /padding-top:\s*var\(--dsh-mobile-header-total\)/,
    '主框架 padding-top 必须使用 --dsh-mobile-header-total');

  // 所有需要"让出顶栏"的地方都不应再直接用 --dsh-mobile-header-h（含带 52px 回退的旧写法）
  assert.doesNotMatch(MOBILE_STYLES_CSS, /var\(--dsh-mobile-header-h,\s*52px\)/,
    '不应再出现 var(--dsh-mobile-header-h, 52px) 这种漏掉安全区的旧写法');
});
