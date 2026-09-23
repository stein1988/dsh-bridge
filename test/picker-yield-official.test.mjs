// 回归测试（issue #28 第 2 条）：本机访问时让位给 DSH 官方目录选择器
//
// 背景：DSH 0.1.5 起自带官方目录选择器，并注册到与 dsh-bridge 完全相同的两个 Slot。
// DSH 的 slots 是 shadow 语义（后注册的动态插件天然覆盖内置实现），插件因此在本机
// 127.0.0.1 也把「添加工作区」劫持成自己的远程抽屉。修复方式是「本机 + 官方 picker
// 可用」时**不注册**插件选择器（低优先级注册无效）；旧版 DSH 与远程/移动继续兜底。
//
// 本文件覆盖三层：
//   1. 行为断言：让位判定真值表 + 官方 picker 探测（全部为可导入的纯函数）；
//   2. 结构断言：判定必须位于两侧 Slot 注册之前且以 return 提前结束；
//   3. 产物同步断言：client/client.js 必须由源码重新构建。
// 真实浏览器交互（本机是否真的弹官方 picker）由远程人工验收覆盖。
//
// 断言失败时优先怀疑：改了 client/index.js 或 picker-yield.js 但没跑
// `npm run build:client`。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OFFICIAL_WORKSPACE_SEAT,
  hasOfficialDirectoryPicker,
  shouldYieldToOfficialPicker,
} from '../client/picker-yield.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const indexSource = readFileSync(resolve(repoRoot, 'client/index.js'), 'utf8');
const bundle = readFileSync(resolve(repoRoot, 'client/client.js'), 'utf8');
// 产物里的中文/非 ASCII 被 esbuild 转成 \uXXXX（标点也可能是 \xNN）
const unescapedBundle = bundle.replace(
  /\\u([0-9a-fA-F]{4})|\\x([0-9a-fA-F]{2})/g,
  (_, u, x) => String.fromCharCode(parseInt(u ?? x, 16)),
);

// ---------- 1. 行为断言：让位判定真值表 ----------

test('本机 + 官方 picker 可用 → 让位（不注册插件选择器）', () => {
  assert.equal(shouldYieldToOfficialPicker({ local: true, officialPicker: true }), true);
});

test('本机 + 官方 picker 不可用（旧版 DSH）→ 不让位，插件继续兜底', () => {
  assert.equal(shouldYieldToOfficialPicker({ local: true, officialPicker: false }), false);
});

test('远程/移动访问 → 一律不让位（保留管理密码解锁与 local_only 目录策略）', () => {
  assert.equal(shouldYieldToOfficialPicker({ local: false, officialPicker: true }), false);
  assert.equal(shouldYieldToOfficialPicker({ local: false, officialPicker: false }), false);
});

test('判定对缺失/畸形输入安全：按不让位处理，绝不抛错', () => {
  assert.equal(shouldYieldToOfficialPicker(), false);
  assert.equal(shouldYieldToOfficialPicker({}), false);
  assert.equal(shouldYieldToOfficialPicker({ local: true }), false);
  assert.equal(shouldYieldToOfficialPicker({ officialPicker: true }), false);
});

// ---------- 2. 行为断言：官方 picker 探测 ----------

test('探测通过 ctx.get() 可选查找进行，且要求 pickDirectory 为函数', () => {
  const queried = [];
  const ctx = {
    get(name) {
      queried.push(name);
      return { pickDirectory: () => {} };
    },
  };
  assert.equal(hasOfficialDirectoryPicker(ctx), true);
  assert.deepEqual(queried, [OFFICIAL_WORKSPACE_SEAT], '必须查询 uiWorkspace seat');
});

test('seat 不存在 / 无 pickDirectory / pickDirectory 非函数 → 判为不可用', () => {
  assert.equal(hasOfficialDirectoryPicker({ get: () => undefined }), false);
  assert.equal(hasOfficialDirectoryPicker({ get: () => null }), false);
  assert.equal(hasOfficialDirectoryPicker({ get: () => ({}) }), false);
  assert.equal(hasOfficialDirectoryPicker({ get: () => ({ pickDirectory: 'nope' }) }), false);
});

test('ctx.get 抛错（guard 拒绝）→ 按不可用处理，探测本身不抛错', () => {
  const throwing = {
    get() {
      throw new Error('service "uiWorkspace" is not declared by your plugin');
    },
  };
  assert.equal(hasOfficialDirectoryPicker(throwing), false);
  assert.equal(hasOfficialDirectoryPicker(null), false);
  assert.equal(hasOfficialDirectoryPicker(undefined), false);
  assert.equal(hasOfficialDirectoryPicker({}), false, '缺 get 时也不应抛错');
});

test('探测绝不使用属性访问（未声明服务的属性访问会被 guard 直接拒绝）', () => {
  let propertyTouched = false;
  const ctx = { get: () => undefined };
  Object.defineProperty(ctx, OFFICIAL_WORKSPACE_SEAT, {
    get() {
      propertyTouched = true;
      return { pickDirectory: () => {} };
    },
  });
  assert.equal(hasOfficialDirectoryPicker(ctx), false);
  assert.equal(propertyTouched, false, '只能走 ctx.get()，不得读 ctx.uiWorkspace 属性');
});

// ---------- 3. 结构断言：判定必须先于注册 ----------

/**
 * 按花括号配对取出 `sidebar.workspaces.directoryFlow` 的 generator 函数体。
 * 该函数体内只有对象字面量（`{ name, priority, inject }`）会增删花括号且成对，
 * 注释与字符串中不含未配对花括号，故简单计数可靠。
 * @param {string} source - 源码或产物文本
 * @returns {string|null} generator 体，未找到时为 null
 */
function sidebarGeneratorBody(source) {
  const marker = 'sidebar.workspaces.directoryFlow';
  const at = source.indexOf(marker);
  if (at < 0) return null;
  const genAt = source.indexOf('function*', at);
  if (genAt < 0) return null;
  const open = source.indexOf('{', genAt);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return null;
}

test('源码：让位判定位于 Slot 注册之前，且以 return 提前结束（不注册）', () => {
  const body = sidebarGeneratorBody(indexSource);
  assert.ok(body, 'client/index.js 应保留 sidebar.workspaces.directoryFlow 的 generator 注册');

  const guardAt = body.indexOf('shouldYieldToOfficialPicker');
  const firstYieldAt = body.indexOf('yield ctx.slots.register');
  assert.ok(guardAt >= 0, 'generator 内应有让位判定');
  assert.ok(firstYieldAt >= 0, 'generator 内应仍注册插件选择器（旧版 DSH / 远程兜底）');
  assert.ok(guardAt < firstYieldAt, '让位判定必须在注册之前');

  // 判定为真时必须 return —— 若是「低优先级注册」而非跳过注册，仍会 shadow 官方实现
  const guardSegment = body.slice(guardAt, firstYieldAt);
  assert.match(
    guardSegment,
    /\)\)\s*return\s*;/,
    '判定为真时必须 return 提前结束 generator（不注册才能让位）',
  );

  // 两个 Slot 都必须在同一个判定之下
  assert.equal(
    body.split('yield ctx.slots.register').length - 1,
    2,
    '两个 directoryFlow Slot 都应位于让位判定之后',
  );
});

test('源码：判定同时依赖「本机」与「官方 picker 可用」两个条件', () => {
  const body = sidebarGeneratorBody(indexSource);
  assert.ok(body, '未取到 generator 体');
  assert.match(body, /local\s*:\s*isLocalEnvironment\(\)/, '应使用 isLocalEnvironment() 判断本机');
  assert.match(
    body,
    /officialPicker\s*:\s*hasOfficialDirectoryPicker\(ctx\)/,
    '应通过 ctx 探测官方 picker',
  );
});

test('源码：不得把 uiWorkspace 写进 inject（旧版 DSH 会 park 整个插件）', () => {
  assert.doesNotMatch(
    indexSource,
    /const inject\s*=\s*\[[^\]]*uiWorkspace/,
    'uiWorkspace 不能写进 inject：旧版 DSH 无该 seat 时插件会被 park',
  );
});

// ---------- 4. 产物同步断言 ----------

test('打包产物已同步让位逻辑（含判定函数，且注册仍在其后）', () => {
  const body = sidebarGeneratorBody(unescapedBundle);
  assert.ok(body, '产物缺少 directoryFlow generator，疑似忘记运行 npm run build:client');

  assert.ok(
    unescapedBundle.includes('shouldYieldToOfficialPicker'),
    '产物未包含让位判定，请运行 npm run build:client',
  );
  assert.ok(
    unescapedBundle.includes('hasOfficialDirectoryPicker'),
    '产物未包含官方 picker 探测，请运行 npm run build:client',
  );

  const guardAt = body.indexOf('shouldYieldToOfficialPicker');
  const firstYieldAt = body.indexOf('yield ctx.slots.register');
  assert.ok(guardAt >= 0 && firstYieldAt >= 0, '产物中的判定/注册缺失');
  assert.ok(guardAt < firstYieldAt, '产物中让位判定必须早于注册，请重新 build');
});
