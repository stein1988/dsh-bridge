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
