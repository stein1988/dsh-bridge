// 移动端顶栏改造的结构断言（分支 feat/mobile-adaptation-20260924）
//
// 本次只改两件事：
//   ① 顶栏占位高度把顶部安全区算进同一个变量；
//   ② 顶部精简——隐藏整条会话头部（Preset 徽标行 + 对话/轨迹 tab 栏）、隐藏加号、
//      右栏按钮占用加号位置并做成展开/收起切换、轨迹视图补一个返回入口。
//
// 只做「源码结构 + 产物同步」断言；真实几何与交互由手机端人工验收。
// 断言失败时优先怀疑：改了 client/*.js 但没跑 npm run build:client。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MOBILE_STYLES_CSS } from '../client/mobile-styles.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const indexSource = readFileSync(resolve(repoRoot, 'client/index.js'), 'utf8');
const bundle = readFileSync(resolve(repoRoot, 'client/client.js'), 'utf8');
// 产物里的中文注释被 esbuild 转成 \uXXXX（非 ASCII 标点也可能是 \xNN）
const unescapedBundle = bundle.replace(
  /\\u([0-9a-fA-F]{4})|\\x([0-9a-fA-F]{2})/g,
  (_, u, x) => String.fromCharCode(parseInt(u ?? x, 16)),
);
// 结构断言在剥掉注释的副本上做，避免注释里提到的选择器干扰
const structureCss = MOBILE_STYLES_CSS.replace(/\/\*[\s\S]*?\*\//g, ' ');

function mediaBlock(css, query) {
  const start = css.indexOf('@media ' + query);
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

// 本文件用到的选择器都写成「选择器 + 空格 + {」，所以直接按字符串定位即可
function ruleBody(css, selector) {
  const at = css.indexOf(selector + ' {');
  if (at < 0) return null;
  const open = css.indexOf('{', at);
  const close = css.indexOf('}', open);
  if (open < 0 || close < 0) return null;
  return css.slice(open + 1, close);
}

test('顶栏占位高度把安全区算进同一个变量（不引入第二套数值）', () => {
  const mobile = mediaBlock(structureCss, '(max-width: 767px)');
  assert.ok(mobile, '移动端媒体查询块缺失');
  assert.match(
    mobile,
    /:root\s*\{[^}]*--dsh-mobile-header-h:\s*calc\(52px \+ var\(--dsh-mobile-safe-top\)\)\s*;/,
    '移动块内应把顶部安全区算进 --dsh-mobile-header-h',
  );
  const header = ruleBody(mobile, '.dsh-mobile-app-header');
  assert.match(
    header,
    /[;{\s]height:\s*var\(--dsh-mobile-header-h\)\s*!important/,
    '顶栏高度必须与让位量同源',
  );
  assert.equal(structureCss.includes('--dsh-mobile-header-total'), false, '不应引入第二套高度变量');
});

test('顶部精简：整条会话头部按槽锚点隐藏，且不带哈希兜底', () => {
  const mobile = mediaBlock(structureCss, '(max-width: 767px)');
  assert.match(
    mobile,
    /\[data-slot="conversation\.session\.header"\]\s*\{\s*display:\s*none\s*!important/,
    '应隐藏 conversation.session.header 槽（含 Preset 徽标行与 tab 栏）',
  );
  assert.doesNotMatch(
    mobile,
    /\[data-slot="conversation\.session\.header"\][^{]*,[^{]*\{/,
    '该规则不应附带哈希兜底选择器（宿主升级时宁可显式失效）',
  );
});

test('加号隐藏，右栏代理按钮占用它的位置且可点', () => {
  const mobile = mediaBlock(structureCss, '(max-width: 767px)');
  assert.match(ruleBody(mobile, '.dsh-header-new-btn'), /display:\s*none\s*!important/, '加号应隐藏');
  const expand = ruleBody(mobile, '.dsh-header-expand-btn');
  assert.ok(expand, '应有右栏代理按钮样式');
  assert.match(expand, /pointer-events:\s*auto\s*!important/, '顶栏 pointer-events:none，按钮必须自己开 auto');
  assert.match(indexSource, /bar\.insertBefore\(btn, anchor\)/, '代理按钮应插在加号原来的位置');
});

test('右栏按钮用宿主语义属性做展开/收起切换，且不再被误判为工作台', () => {
  assert.match(indexSource, /button\[data-sidebar-right-expand\]/, '展开应点宿主的 [data-sidebar-right-expand]');
  assert.match(indexSource, /button\[data-sidebar-right-toggle\]/, '收起应点面板内的 [data-sidebar-right-toggle]');
  assert.match(indexSource, /isSidebarRightControl/, '捕获型 click 监听必须排除右栏按钮，否则会误加 dsh-workbench-open');
});

test('轨迹返回按钮按 aria-selected 判断，不读界面文案', () => {
  assert.match(indexSource, /aria-selected/, '应使用 aria-selected 判断当前视图');
  assert.match(indexSource, /dsh-trajectory-back-btn/, '应有轨迹返回按钮');
  assert.doesNotMatch(indexSource, /textContent[^\n]*轨迹/, '不应再按中文文案判断视图');
  assert.doesNotMatch(indexSource, /!==\s*'轨迹'/, '不应再按中文文案挑 tab');
});

test('打包产物与源码同步（含本次顶栏改造）', () => {
  assert.ok(unescapedBundle.includes(MOBILE_STYLES_CSS), '产物内嵌的移动端 CSS 与源码不一致，请运行 npm run build:client');
  assert.ok(unescapedBundle.includes('dsh-header-expand-btn'), '产物缺少右栏代理按钮');
  assert.ok(unescapedBundle.includes('dsh-trajectory-back-btn'), '产物缺少轨迹返回按钮');
  assert.ok(unescapedBundle.includes('data-sidebar-right-expand'), '产物缺少右栏按钮的宿主锚点');
});
