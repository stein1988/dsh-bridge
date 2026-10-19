// 设置面板「同平台多账号（多实例）」结构守卫（issue #78 / 契约 §8）。
//
// 覆盖：
//   1. 账号列表渲染：按平台类型过滤 listPlatforms，每个账号一张 PlatformCard，
//      key/props 用 instanceId，旧的「单卡片」渲染已移除；
//   2. 卡片内所有平台 RPC 一律传 instanceId（platformId 仅保留品牌/分支用途）；
//   3. 添加账号（platformAddAccount）接线：类型恒可点、0 账号空状态、上限 10 时禁用、
//      添加成功刷新并定位新账号；
//   4. 移除账号（platformRemoveAccount）接线：二次确认文案说明会停止账号并删除配置与
//      会话归属、但不删 DSH 会话；最后一个账号也允许移除；
//   5. 新中文文案的英文词典齐全、`${x}` 占位符逐字一致；服务端账号错误可英文化；
//   6. client/client.js 打包产物与源码同步（产物入库，忘记 build 会被本用例拦住）。
//
// 与仓库既有面板测试一致：不引入 jsdom，只做源码结构断言（见 test/client-provide.test.mjs）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { panelEn, serverEn, serverPatterns } from '../client/panel-locales.mjs';
import { createTranslator } from '../client/locales.mjs';
import { needsTranslation } from './helpers/client-literals.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const indexSource = readFileSync(resolve(repoRoot, 'client/index.js'), 'utf8');
const panelLocalesSource = readFileSync(resolve(repoRoot, 'client/panel-locales.mjs'), 'utf8');
const bundleRaw = readFileSync(resolve(repoRoot, 'client/client.js'), 'utf8');
// esbuild 默认把非 ASCII 转成 \uXXXX，比对产物前先还原
const bundle = bundleRaw.replace(
  /\\u([0-9a-fA-F]{4})|\\x([0-9a-fA-F]{2})/g,
  (_, u, x) => String.fromCharCode(parseInt(u ?? x, 16)),
);

/** 截取源码里 [startMarker, endMarker) 之间的片段，用于「只在卡片/面板范围内」断言 */
function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `源码应包含 ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `源码中 ${startMarker} 之后应出现 ${endMarker}`);
  return source.slice(start, end);
}

const platformCardSource = sliceBetween(indexSource, 'function PlatformCard(', '// 宿主系统运行监控看板');
const imTabSource = sliceBetween(indexSource, "} else if (activeTab === 'im') {", 'const auth = status?.auth;');

// ---------- 1. 账号列表渲染 ----------

test('平台 Tab：按类型过滤出账号列表，每个账号一张 PlatformCard（旧的单卡片渲染已移除）', () => {
  // 类型过滤助手存在且被账号列表使用
  assert.match(indexSource, /function platformAccountsOf\(platforms, type\)/);
  assert.match(imTabSource, /const accounts = platformAccountsOf\(platforms, selectedPlatform\);/);
  // 每个账号一张卡片，key 用 instanceId（增删/切换类型时不串账）
  assert.match(imTabSource, /accounts\.map\(\(\{ instanceId, status \}, index\) => h\(PlatformCard, \{/);
  assert.match(imTabSource, /key: instanceId,/);
  // 契约 §8 要求的 props
  assert.match(imTabSource, /instanceId,\s*$/m);
  assert.match(imTabSource, /displayName: accountDisplayName\(status, selectedLabel, index \+ 1\)/);
  assert.match(imTabSource, /accountIndex: index \+ 1,/);
  assert.match(imTabSource, /accountCount: accounts\.length,/);
  // platformId 仍是平台类型（品牌/分支逻辑）
  assert.match(imTabSource, /platformId: selectedPlatform,/);
  // 旧的「只渲染当前选中的一个 platforms[selectedPlatform]」必须已移除
  assert.equal(indexSource.includes('platforms?.[selectedPlatform]'), false,
    '不应再有「一个平台只渲染一张卡片」的旧渲染');
  assert.equal(indexSource.includes('const platformData = loaded ? platforms[id] : undefined;'), false,
    '平台类型磁贴不应再按单实例取 platforms[id] 决定可用性');
});

test('平台类型磁贴：四个类型恒可点击（0 账号也必须能进入空状态添加第一个账号）', () => {
  // 契约 §8 / Lead 裁定：不能按「至少一个实例」把 Tab 置灰
  assert.match(imTabSource, /onClick: \(\) => setSelectedPlatform\(id\),/);
  assert.equal(imTabSource.includes("onClick: available ? () => setSelectedPlatform(id)"), false);
  assert.equal(imTabSource.includes("cursor: 'not-allowed'"), false, '平台类型磁贴不得因 0 账号禁用点击');
  // 类型状态文案：未添加账号 / 未连接 / 数据缺失 三者区分
  assert.match(imTabSource, /'未添加账号'/);
  assert.match(imTabSource, /'数据缺失'/);
});

test('空状态：0 账号时展示可读提示 + 「＋ 添加账号」', () => {
  assert.match(imTabSource, /accounts\.length === 0/);
  assert.match(imTabSource, /localeT\('还没有添加「\$\{name\}」账号', \{ name: localeT\(selectedLabel\) \}\)/);
  assert.match(imTabSource, /renderAddAccountButton\(\{ primary: true \}\)/);
});

// ---------- 2. 卡片内 RPC 用 instanceId ----------

test('PlatformCard：所有平台 RPC 参数由 platformId 改为 instanceId', () => {
  // 统一动作入口
  assert.match(platformCardSource, /const r = await rpcCall\(endpoint, \{ instanceId, \.\.\.payload \}\);/);
  // 白名单两处直接调用（add 与 remove 走 act）
  assert.match(platformCardSource, /rpcCall\(BRIDGE_ENDPOINTS\.platformSetAllowFrom, \{ instanceId, allowFrom: list \}\)/);
  // listPlatforms 按 instanceId 取本卡片对应的账号
  assert.match(platformCardSource, /setPlatform\(allPlatforms\[instanceId\] \?\? null\);/);
  // 卡片范围内不得再出现以 platformId 作为 RPC 定位参数的写法
  assert.equal(/\{ platformId[,}]/.test(platformCardSource), false,
    'PlatformCard 内所有平台 RPC 必须用 instanceId 定位账号，不能再传 platformId');
  // 解绑（高危及）与停止/登录等仍统一走 act（act 已用 instanceId）
  assert.match(platformCardSource, /BRIDGE_ENDPOINTS\.platformUnbind, \{\}\)/);
});

// ---------- 3. 添加账号 ----------

test('添加账号：platformAddAccount 接线、成功刷新并定位新卡片', () => {
  assert.match(indexSource, /authRpcCall\(BRIDGE_ENDPOINTS\.platformAddAccount, \{ platformId: selectedPlatform \}\)/);
  assert.match(indexSource, /const addedInstanceId = r\.value\?\.instanceId \?\? null;/);
  assert.match(indexSource, /refreshPlatforms\(\);/);
  assert.match(indexSource, /if \(addedInstanceId\) setRecentAccountId\(addedInstanceId\);/);
  // 列表顶部/空状态的按钮都接到同一个添加动作
  assert.match(imTabSource, /onClick: addPlatformAccount,/);
  assert.match(imTabSource, /renderAddAccountButton\(\)/);
  // 新卡片高亮 + 滚入可视区（「展开/定位新账号」）
  assert.match(imTabSource, /highlight: recentAccountId === instanceId,/);
  assert.match(platformCardSource, /el\.scrollIntoView\(\{ behavior: 'smooth', block: 'nearest' \}\)/);
  assert.match(platformCardSource, /const cardStyle = highlight\s*\?[\s\S]{0,200}boxShadow:/);
  // 新账号未填凭证的明确状态（现有 configured 逻辑 + 可读提示）
  assert.match(platformCardSource, /!platform\?\.configured && !showQr && h\('div'/);
  assert.match(platformCardSource, /'未配置凭证 — 请先完成下方配置。'/);
});

test('单类型账号上限 10：达到上限禁用「＋ 添加账号」并提示', () => {
  assert.match(indexSource, /const PLATFORM_ACCOUNT_LIMIT = 10;/);
  assert.match(imTabSource, /const atAccountLimit = accounts\.length >= PLATFORM_ACCOUNT_LIMIT;/);
  assert.match(imTabSource, /disabled: addingAccount \|\| atAccountLimit,/);
  assert.match(imTabSource, /localeT\('每个平台最多 \$\{limit\} 个账号', \{ limit: PLATFORM_ACCOUNT_LIMIT \}\)/);
  assert.match(imTabSource, /localeT\('已达单平台账号上限（最多 \$\{limit\} 个）', \{ limit: PLATFORM_ACCOUNT_LIMIT \}\)/);
});

// ---------- 4. 移除账号 ----------

test('移除账号：platformRemoveAccount + 二次确认（说明停止账号/删除配置与会话归属、不删 DSH 会话）', () => {
  assert.match(platformCardSource, /rpcCall\(BRIDGE_ENDPOINTS\.platformRemoveAccount, \{ instanceId \}\)/);
  assert.match(platformCardSource, /window\.confirm\(localeT\('确认移除账号「\$\{name\}」？将停止该账号并删除其配置与会话归属；DSH 会话本身不会被删除。', \{ name: localeT\(label\) \}\)\)/);
  // 仅剩 1 个账号也允许移除：移除按钮不依赖 accountCount
  assert.match(platformCardSource, /onClick: removeAccount,/);
  assert.equal(/accountCount\s*>\s*1\s*&&\s*h\('button'/.test(platformCardSource), false,
    '移除账号按钮不得在只剩一个账号时隐藏');
  // 成功后在父级列表里立即移除该账号并刷新
  assert.match(imTabSource, /onAccountRemoved: removePlatformAccountLocally,/);
  assert.match(indexSource, /const removePlatformAccountLocally = React\.useCallback\(\(removedInstanceId\) => \{/);
});

test('备注名：失焦/回车保存走 platformSetConfig 的 name 字段并回显 config.name', () => {
  assert.match(platformCardSource, /const savedAccountName = typeof platform\?\.config\?\.name === 'string' \? platform\.config\.name : undefined;/);
  assert.match(platformCardSource, /act\(BRIDGE_ENDPOINTS\.platformSetConfig, \{ name: next \}\)/);
  assert.match(platformCardSource, /placeholder: localeT\('备注名（可选，用于区分同平台多个账号）'\)/);
  assert.match(platformCardSource, /onBlur: \(\) => \{ void saveAccountName\(\); \}/);
  assert.match(platformCardSource, /onKeyDown: \(e\) => \{ if \(e\.key === 'Enter'\) e\.currentTarget\.blur\(\); \}/);
  // 丢空 = 清除备注（回落到服务端合成的展示名）
  assert.match(platformCardSource, /if \(next === \(savedAccountName \?\? ''\)\.trim\(\)\) return;/);
});

test('展示名：优先服务端 displayName，旧服务端缺字段时按「平台名 + 序号」兜底', () => {
  assert.match(indexSource, /function accountDisplayName\(status, platformLabel, index\)/);
  assert.match(indexSource, /return displayName \|\| `\$\{platformLabel\} \$\{index\}`;/);
  // 单账号兼容：一张卡片 + 头部账号名/移除入口，不引入额外点击步骤
  assert.match(platformCardSource, /displayName \|\| platformName,/);
});

// ---------- 5. i18n ----------

/** 提取文案里的 `${x}` 占位符名（排序去重） */
function placeholders(text) {
  return [...new Set([...String(text).matchAll(/\$\{([^}]+)\}/g)].map((m) => m[1]))].sort();
}

const NEW_PANEL_KEYS = [
  '未添加账号',
  '${count} 个账号',
  '账号列表（${count} 个）',
  '账号 ${index}/${total}',
  '＋ 添加账号',
  '添加中…',
  '添加账号失败',
  '添加一个新账号（同一平台可接入多个账号）',
  '还没有添加「${name}」账号',
  '添加账号后可填写该账号的凭证并独立连接；同一平台支持同时接入多个账号，凭证、白名单与会话归属互不影响。',
  '每个平台最多 ${limit} 个账号',
  '已达单平台账号上限（最多 ${limit} 个）',
  '备注名（可选，用于区分同平台多个账号）',
  '移除账号',
  '移除账号失败',
  '停止该账号并删除其配置与会话归属（不会删除 DSH 会话本身）',
  '确认移除账号「${name}」？将停止该账号并删除其配置与会话归属；DSH 会话本身不会被删除。',
  '未配置凭证 — 请先完成下方配置。',
];

test('i18n：多账号新增文案全部有英文对照，且 ${x} 占位符与源码逐字一致', () => {
  for (const key of NEW_PANEL_KEYS) {
    assert.ok(Object.hasOwn(panelEn, key), `panelEn 缺少多账号文案：${JSON.stringify(key)}`);
    assert.ok(indexSource.includes(`'${key}'`), `源码里应逐字引用词典键：${JSON.stringify(key)}`);
    const value = panelEn[key];
    const values = Array.isArray(value) ? value : [value];
    for (const v of values) {
      assert.equal(needsTranslation(v), false, `英文译文不得含中文：${JSON.stringify(key)} → ${JSON.stringify(v)}`);
      assert.deepEqual(placeholders(v), placeholders(key),
        `占位符必须一致：${JSON.stringify(key)} → ${JSON.stringify(v)}`);
    }
  }
});

test('i18n：服务端账号错误（查重/超限/类型/不存在）可英文化且不吞错误', () => {
  // 精确匹配的服务端错误
  for (const key of ['单个平台最多添加 10 个账号', '缺少 instanceId 参数', '缺少 instanceId/platformId 参数', '多账号能力未接线']) {
    assert.ok(Object.hasOwn(serverEn, key), `serverEn 缺少：${JSON.stringify(key)}`);
    assert.equal(needsTranslation(serverEn[key]), false, `服务端英文译文不得含中文：${JSON.stringify(key)}`);
  }
  assert.ok(serverPatterns.some(([, english]) => needsTranslation(english) === false),
    'serverPatterns 译文不得含中文');

  const originalDocument = globalThis.document;
  try {
    globalThis.document = { documentElement: { getAttribute: () => 'en' } };
    const en = createTranslator({});
    // 查重错误：错误原样返回给面板（不吞），英文界面下连同 displayName 一起英文化
    assert.equal(
      en.t('同一应用不能重复添加：该凭证已被「飞书 2」使用'),
      'This app cannot be added twice: its credentials are already used by “Lark / Feishu 2”',
    );
    assert.equal(en.t('飞书 2'), 'Lark / Feishu 2');
    assert.equal(en.t('单个平台最多添加 10 个账号'), 'Up to 10 accounts per platform');
    assert.equal(en.t('不支持的平台类型: dingtalk'), 'Unsupported platform type: dingtalk');
    assert.equal(en.t('不支持的平台类型: (空)'), 'Unsupported platform type: (empty)');
    assert.equal(en.t('账号不存在: feishu:9'), 'Account not found: feishu:9');
    // 中文模式：错误原样展示（服务端文案不丢）
    globalThis.document = { documentElement: { getAttribute: () => 'zh-CN' } };
    const zh = createTranslator({});
    assert.equal(zh.t('同一应用不能重复添加：该凭证已被「飞书 2」使用'), '同一应用不能重复添加：该凭证已被「飞书 2」使用');
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
});

// ---------- 6. 打包产物同步 ----------

test('client/client.js 打包产物同步包含多账号实现（忘记 npm run build:client 会被拦住）', () => {
  const expected = [
    'platformAccountsOf',
    'platformAddAccount',
    'platformRemoveAccount',
    'accountDisplayName',
    'PLATFORM_ACCOUNT_LIMIT',
    '备注名（可选，用于区分同平台多个账号）',
    '移除账号',
    '还没有添加「',
    '同一应用不能重复添加',
  ];
  for (const marker of expected) {
    assert.ok(bundle.includes(marker), `client/client.js 缺少 ${JSON.stringify(marker)}，请运行 npm run build:client`);
    assert.ok(panelLocalesSource.includes(marker) || indexSource.includes(marker) || marker === '同一应用不能重复添加',
      `源码中应存在 ${JSON.stringify(marker)}`);
  }
});
