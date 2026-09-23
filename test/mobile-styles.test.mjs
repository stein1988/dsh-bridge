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
