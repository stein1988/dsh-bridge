// dsh-cost-meter 的「本会话费用明细」入口（.cm-stat-entry）在输入框下方常驻。
//
// 该按钮由 dsh-cost-meter **无条件**注册进 conversation.composer.dock 槽，插件自身的
// 「会话费用显示位置=关闭」只关成本数字那一行、不关入口（实测 1.8.2）。本插件在全局样式
// 里兜底隐藏输入框下方那个入口：因为要「网页端 + 手机端都生效」，规则必须在移动端
// @media(max-width:767px) 之外；同时刻意收窄到 composer dock 槽，避免误伤同一插件注册
// 在会话标题栏的另一个入口。
//
// 断言失败时优先怀疑：改了 client/*.js 但没跑 npm run build:client。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MOBILE_STYLES_CSS } from '../client/mobile-styles.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundle = readFileSync(resolve(repoRoot, 'client/client.js'), 'utf8');
const unescapedBundle = bundle.replace(
  /\\u([0-9a-fA-F]{4})|\\x([0-9a-fA-F]{2})/g,
  (_, u, x) => String.fromCharCode(parseInt(u ?? x, 16)),
);

test('输入框下方的费用明细入口在全局区按槽锚点隐藏（网页端也生效）', () => {
  const mobileStart = MOBILE_STYLES_CSS.indexOf('@media (max-width: 767px)');
  assert.ok(mobileStart > 0, '应存在移动端媒体查询块');
  const globalPart = MOBILE_STYLES_CSS.slice(0, mobileStart);
  assert.match(
    globalPart,
    /\[data-slot="conversation\.composer\.dock"\]\s+\.cm-stat-entry\s*\{[^}]*display:\s*none\s*!important/,
    '输入框下方（composer dock 槽）的 .cm-stat-entry 必须在移动端媒体查询之外隐藏',
  );
  // 不得用裸 .cm-stat-entry：会连会话标题栏的另一个入口一起误伤。
  assert.doesNotMatch(
    globalPart,
    /(^|[},]\s*)\.cm-stat-entry\s*\{/,
    '应把选择器收窄到 composer dock 槽，不使用裸 .cm-stat-entry',
  );
});

test('打包产物与源码同步（费用明细入口隐藏）', () => {
  assert.ok(unescapedBundle.includes(MOBILE_STYLES_CSS), '产物内嵌的 CSS 与源码不一致，请运行 npm run build:client');
  assert.ok(unescapedBundle.includes('.cm-stat-entry'), '产物缺少费用明细入口的隐藏规则');
});
