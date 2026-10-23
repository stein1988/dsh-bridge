// 回归测试：issue #83「固定域名表单输入被 3 秒轮询自动清空」
//
// 故障链（修复前）：
//   面板每 3000ms 调 load(true) → getStatus → setStatus(新对象) → BridgePanel 重渲染
//   → 传给 CloudflareConfigForm 的 network 是**每次渲染新建的字面量对象**
//   → 子组件 useEffect 依赖数组 `[token, hostname, network]` 中的 network 引用每 tick 变化
//   → effect 每 tick 重跑，用服务端旧值 setHostnameVal/setTokenVal/setNetVals
//   → 用户正在键入的域名 / Token 被覆盖（服务端值为空时表现为「输入被自动清空」）。
//
// 本文件是**结构 + 语义断言**（不需要浏览器、不 import react）：
//   ① 用 espree 解析源码 AST，断言 CloudflareConfigForm 的同步 effect 依赖全是标量，
//      不再出现裸对象变量 network；
//   ② 断言父组件 BridgePanel 用 React.useMemo 稳定 network 引用（纵深防御），
//      调用点不得再写字面量对象；
//   ③ 语义模拟：把源码里解析出的依赖表达式在「网络对象换新引用、字段值不变」的两次
//      轮询快照上求值，断言不再触发 effect；并对照旧的 `[token, hostname, network]`
//      断言它会触发 —— 证明这条断言对回归有区分能力（不是恒真断言）；
//   ④ 同类表单核查：CustomTunnelConfigForm / ExternalTunnelCard 的同步 effect 依赖
//      同样是标量（本次核查结论固化为守卫，防止将来改回对象依赖）；
//   ⑤ 打包产物 client/client.js 与源码同步（忘记 npm run build:client 会在这里失败）。
//
// 证据强度说明：本文件不执行 React、不驱动 DOM，因此**不能**证明浏览器里的行为；
// 真实浏览器行为证据见交付报告（无头 Chrome 驱动 3082 真实 GUI 的前后对照）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'espree';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(resolve(repoRoot, 'client/index.js'), 'utf8');
const bundleRaw = readFileSync(resolve(repoRoot, 'client/client.js'), 'utf8');
// esbuild 会把产物里的中文/非 ASCII 转成 \uXXXX（标点也可能是 \xNN），反转义后才能与源码比对
const bundle = bundleRaw.replace(
  /\\u([0-9a-fA-F]{4})|\\x([0-9a-fA-F]{2})/g,
  (_, u, x) => String.fromCharCode(parseInt(u ?? x, 16)),
);

const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module', loc: true, range: true });

/** 深度优先遍历 AST */
function walk(node, visit) {
  if (!node || typeof node.type !== 'string') return;
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === 'parent') continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) if (child && typeof child.type === 'string') walk(child, visit);
    } else if (value && typeof value.type === 'string') {
      walk(value, visit);
    }
  }
}

/**
 * 取 `const Name = React.memo(function Name(props) { ... })` 形式的组件函数节点。
 * @returns {{ fn: object, decl: object } | null}
 */
function findMemoComponent(name) {
  let hit = null;
  walk(ast, (node) => {
    if (hit || node.type !== 'VariableDeclarator') return;
    if (node.id?.type !== 'Identifier' || node.id.name !== name) return;
    const init = node.init;
    if (init?.type !== 'CallExpression') return;
    const callee = init.callee;
    if (callee?.type !== 'MemberExpression' || callee.object?.name !== 'React' || callee.property?.name !== 'memo') return;
    const arg = init.arguments?.[0];
    if (arg?.type === 'FunctionExpression' || arg?.type === 'ArrowFunctionExpression') hit = { fn: arg, decl: node };
  });
  return hit;
}

/** 取函数内所有 `React.useEffect(cb, deps)` 调用（按源码出现顺序） */
function useEffectCalls(fnNode) {
  const calls = [];
  walk(fnNode, (node) => {
    if (node.type !== 'CallExpression') return;
    const callee = node.callee;
    if (callee?.type !== 'MemberExpression') return;
    if (callee.object?.name !== 'React' || callee.property?.name !== 'useEffect') return;
    calls.push({ node, callback: node.arguments?.[0], deps: node.arguments?.[1] ?? null });
  });
  return calls;
}

/** 判断 call 节点内部某处是否调用了以 name 命名的函数 */
function callsFunction(callNode, name) {
  let yes = false;
  walk(callNode, (node) => {
    if (node.type === 'CallExpression' && node.callee?.type === 'Identifier' && node.callee.name === name) yes = true;
  });
  return yes;
}

/** 把依赖数组元素转成可比较的描述：裸标识符 / 成员链 / 其他表达式 */
function describeDep(node) {
  if (node.type === 'Identifier') return { kind: 'identifier', name: node.name };
  const chain = node.type === 'ChainExpression' ? node.expression : node;
  if (chain.type === 'MemberExpression') {
    const parts = [];
    let cur = chain;
    while (cur.type === 'MemberExpression') {
      const key = cur.property.type === 'Identifier' ? cur.property.name : cur.property.value;
      parts.unshift(String(key));
      cur = cur.object;
    }
    if (cur.type === 'Identifier') return { kind: 'member', root: cur.name, path: `${cur.name}.${parts.join('.')}` };
    return { kind: 'other', text: source.slice(node.range[0], node.range[1]) };
  }
  return { kind: 'other', text: source.slice(node.range[0], node.range[1]) };
}

/** 取依赖数组的 AST 元素列表 */
function depsOf(effect) {
  assert.ok(effect.deps, 'useEffect 必须显式给出依赖数组（无法静态判定依赖 → 视为失败）');
  assert.equal(effect.deps.type, 'ArrayExpression', 'useEffect 第二个参数必须是数组字面量');
  return effect.deps.elements;
}

/** 在源码里取某节点的原文（用于错误信息里给人看） */
const textOf = (node) => source.slice(node.range[0], node.range[1]).replace(/\s+/g, ' ');

// ---------------------------------------------------------------------------
// ① CloudflareConfigForm：同步服务端值的 effect 必须只依赖标量
// ---------------------------------------------------------------------------
test('CloudflareConfigForm 的同步 effect 依赖全是标量，不再包含裸对象 network', () => {
  const comp = findMemoComponent('CloudflareConfigForm');
  assert.ok(comp, 'client/index.js 应存在 const CloudflareConfigForm = React.memo(function ...)');

  const effects = useEffectCalls(comp.fn);
  assert.ok(effects.length >= 1, 'CloudflareConfigForm 应至少有一个 useEffect');
  // 同步 effect = 回调里调用 setNetVals 的那个（把 network 回填进本地草稿）
  const syncEffects = effects.filter((e) => callsFunction(e.callback, 'setNetVals'));
  assert.equal(syncEffects.length, 1, '应恰有一个回填 setNetVals 的同步 effect');
  const sync = syncEffects[0];

  const deps = depsOf(sync).map(describeDep);
  const bareObjects = deps.filter((d) => d.kind === 'identifier' && d.name === 'network');
  assert.deepEqual(
    bareObjects,
    [],
    `effect 依赖里不得出现裸对象变量 network（每轮轮询都会换新引用，导致用户输入被覆盖）：${textOf(sync.node)}`,
  );

  // 三个网络参数必须以标量字段的形式参与比较
  const paths = deps.filter((d) => d.kind === 'member').map((d) => d.path).sort();
  assert.deepEqual(paths, ['network.edgeIpVersion', 'network.protocol', 'network.region'],
    '三个网络参数应作为标量成员表达式进入依赖数组');

  // token / hostname 也是标量
  const names = deps.filter((d) => d.kind === 'identifier').map((d) => d.name).sort();
  assert.deepEqual(names, ['hostname', 'token'], 'token / hostname 应保持为标量标识符依赖');
  assert.equal(deps.length, 5, '依赖数组应为 5 项（token, hostname + 三个标量网络参数）');
});

// ---------------------------------------------------------------------------
// ② BridgePanel：父组件必须稳定 network 引用，调用点不得再写字面量对象
// ---------------------------------------------------------------------------
test('父组件 BridgePanel 用 React.useMemo 稳定传给 CloudflareConfigForm 的 network 引用', () => {
  const panel = findMemoComponent('BridgePanel') ?? (() => {
    // BridgePanel 是普通 function 声明（不是 React.memo 包装）
    let fn = null;
    walk(ast, (node) => {
      if (!fn && node.type === 'FunctionDeclaration' && node.id?.name === 'BridgePanel') fn = node;
    });
    return fn ? { fn, decl: fn } : null;
  })();
  assert.ok(panel, 'client/index.js 应存在 function BridgePanel');

  // 2.1 存在 cfNetwork 的 useMemo，且依赖是三个标量字段
  let memo = null;
  walk(panel.fn, (node) => {
    if (memo || node.type !== 'VariableDeclarator' || node.id?.name !== 'cfNetwork') return;
    const init = node.init;
    if (init?.type !== 'CallExpression') return;
    if (init.callee?.type !== 'MemberExpression' || init.callee.property?.name !== 'useMemo') return;
    memo = init;
  });
  assert.ok(memo, 'BridgePanel 应用 React.useMemo 创建 cfNetwork（稳定 network 引用，纵深防御）');
  const memoDeps = memo.arguments[1];
  assert.equal(memoDeps?.type, 'ArrayExpression', 'cfNetwork 的 useMemo 必须显式给出依赖数组');
  const memoPaths = memoDeps.elements.map(describeDep);
  assert.equal(memoPaths.length, 3, 'cfNetwork 的 useMemo 应依赖三个标量字段');
  assert.deepEqual(
    memoPaths.filter((d) => d.kind === 'member').map((d) => d.path).sort(),
    ['status.cloudflared.edgeIpVersion', 'status.cloudflared.protocol', 'status.cloudflared.region'],
    'cfNetwork 只应依赖 cf 的三个标量字段（不能依赖整个 status/cf 对象）',
  );

  // 2.2 调用点的 network 属性必须是 cfNetwork 的引用，而不是对象字面量
  let callSite = null;
  walk(panel.fn, (node) => {
    if (callSite) return;
    if (node.type !== 'CallExpression') return;
    if (node.callee?.type !== 'Identifier' || node.callee.name !== 'h') return;
    const first = node.arguments?.[0];
    if (first?.type === 'Identifier' && first.name === 'CloudflareConfigForm') callSite = node;
  });
  assert.ok(callSite, 'BridgePanel 应渲染 h(CloudflareConfigForm, {...})');
  const propsArg = callSite.arguments?.[1];
  assert.equal(propsArg?.type, 'ObjectExpression', 'CloudflareConfigForm 的 props 应是对象字面量');
  const networkProp = propsArg.properties.find((p) => p.type === 'Property' && p.key?.name === 'network');
  assert.ok(networkProp, 'CloudflareConfigForm 应接收 network prop');
  assert.notEqual(
    networkProp.value.type,
    'ObjectExpression',
    '禁止在渲染中新建 network 字面量对象（每 tick 换引用 → 子组件 effect 每 tick 重跑）',
  );
  assert.match(
    textOf(networkProp.value),
    /cfNetwork/,
    `network prop 应使用 useMemo 稳定的 cfNetwork 引用，实际为：${textOf(networkProp.value)}`,
  );
});

// ---------------------------------------------------------------------------
// ③ 语义模拟：依赖比较在「network 换新引用、字段值不变」时不得触发 effect
// ---------------------------------------------------------------------------
test('依赖比较语义：轮询换新 network 引用但字段不变时不再触发 effect（旧写法会触发，作对照）', () => {
  const comp = findMemoComponent('CloudflareConfigForm');
  const sync = useEffectCalls(comp.fn).find((e) => callsFunction(e.callback, 'setNetVals'));
  assert.ok(sync, '应找到 CloudflareConfigForm 的同步 effect');
  const depNodes = depsOf(sync);

  /** 极简表达式求值：Identifier / MemberExpression（含可选链）/ Literal */
  const evaluate = (node, env) => {
    if (node.type === 'Identifier') return env[node.name];
    if (node.type === 'ChainExpression') return evaluate(node.expression, env);
    if (node.type === 'MemberExpression') {
      const obj = evaluate(node.object, env);
      if (obj === null || obj === undefined) return undefined; // 可选链短路
      const key = node.property.type === 'Identifier' ? node.property.name : node.property.value;
      return obj[key];
    }
    if (node.type === 'Literal') return node.value;
    throw new Error(`语义模拟不支持该表达式：${textOf(node)}`);
  };
  /** 模拟 React 的依赖比较（Object.is 逐项比较） */
  const depsChanged = (prev, next) => prev.length !== next.length || prev.some((v, i) => !Object.is(v, next[i]));
  const snapshot = (network) => depNodes.map((n) => evaluate(n, { token: 'tok-x', hostname: 'h.example.com', network }));

  // 两次轮询：网络对象整体换新引用，三个字段值相同（正是修复前的真实场景）
  const tickA = snapshot({ protocol: '', edgeIpVersion: '4', region: '' });
  const tickB = snapshot({ protocol: '', edgeIpVersion: '4', region: '' });
  assert.equal(
    depsChanged(tickA, tickB),
    false,
    '字段值未变时，依赖不应判定为变化（否则 effect 每 tick 重跑并覆盖用户输入）',
  );

  // 字段真变化时必须重跑（否则「服务端改了配置 → 表单不回填」）
  const tickC = snapshot({ protocol: 'quic', edgeIpVersion: '4', region: '' });
  assert.equal(depsChanged(tickB, tickC), true, '网络参数真正变化时 effect 必须重跑以回填新值');

  // 对照：修复前的依赖数组 `[token, hostname, network]` 在同一快照上必然判定为变化
  const legacySnapshot = (network) => ['tok-x', 'h.example.com', network];
  assert.equal(
    depsChanged(legacySnapshot({ protocol: '', edgeIpVersion: '4', region: '' }),
      legacySnapshot({ protocol: '', edgeIpVersion: '4', region: '' })),
    true,
    '对照断言：旧的 network 对象依赖在换新引用时必然触发 effect —— 证明本测试对 #83 有区分能力',
  );
});

// ---------------------------------------------------------------------------
// ④ 同类表单核查结论固化：CustomTunnelConfigForm / ExternalTunnelCard 依赖也是标量
// ---------------------------------------------------------------------------
test('同类表单 CustomTunnelConfigForm / ExternalTunnelCard 的同步 effect 依赖同为标量（本次核查结论）', () => {
  // 4.1 自建隧道表单：回填 effect 依赖 initUrl / initToken 两个字符串标量，
  //     props 由父组件以 `(ct && ct.serverUrl) || ''` 传入，是字符串而非对象。
  const custom = findMemoComponent('CustomTunnelConfigForm');
  assert.ok(custom, '应存在 CustomTunnelConfigForm');
  const customEffects = useEffectCalls(custom.fn);
  const customSync = customEffects.filter((e) => callsFunction(e.callback, 'setServerUrl') && callsFunction(e.callback, 'setAccessToken'));
  assert.equal(customSync.length, 1, 'CustomTunnelConfigForm 应恰有一个回填服务器配置的同步 effect');
  const customDeps = depsOf(customSync[0]).map(describeDep);
  assert.deepEqual(
    customDeps.map((d) => `${d.kind}:${d.name ?? d.path}`).sort(),
    ['identifier:initToken', 'identifier:initUrl'],
    'CustomTunnelConfigForm 的同步 effect 依赖应是 initUrl/initToken 两个标量（不得依赖对象 prop）',
  );

  // 4.2 外部隧道卡片：依赖 `ext?.url`（属性访问 → 标量），不是整个 ext 对象
  const ext = findMemoComponent('ExternalTunnelCard');
  assert.ok(ext, '应存在 ExternalTunnelCard');
  const extSyncs = useEffectCalls(ext.fn).filter((e) => callsFunction(e.callback, 'setUrlVal'));
  assert.equal(extSyncs.length, 1, 'ExternalTunnelCard 应恰有一个回填 URL 的同步 effect');
  const extDeps = depsOf(extSyncs[0]).map(describeDep);
  assert.equal(extDeps.length, 1, 'ExternalTunnelCard 的同步 effect 应只有一个依赖项');
  assert.deepEqual(
    { kind: extDeps[0].kind, path: extDeps[0].path },
    { kind: 'member', path: 'ext.url' },
    'ExternalTunnelCard 的同步 effect 应依赖标量 ext?.url，而不是裸对象 ext',
  );
});

// ---------------------------------------------------------------------------
// ⑤ 全文件守卫：任何 useEffect 依赖数组都不得出现裸标识符 network
// ---------------------------------------------------------------------------
test('全文件守卫：没有任何 useEffect 把裸对象 network 当依赖', () => {
  const offenders = [];
  walk(ast, (node) => {
    if (node.type !== 'CallExpression') return;
    const callee = node.callee;
    if (callee?.type !== 'MemberExpression' || callee.object?.name !== 'React' || callee.property?.name !== 'useEffect') return;
    const deps = node.arguments?.[1];
    if (deps?.type !== 'ArrayExpression') return;
    for (const el of deps.elements) {
      if (el?.type === 'Identifier' && el.name === 'network') {
        offenders.push(source.slice(node.range[0], node.range[1]).split('\n')[0]);
      }
    }
  });
  assert.deepEqual(offenders, [], 'useEffect 依赖数组里不得出现裸 network 对象（用 network?.field 标量代替）');
});

// ---------------------------------------------------------------------------
// ⑥ 产物同步：client/client.js 必须由当前源码重建（含修复，且无旧写法残留）
// ---------------------------------------------------------------------------
// 把注释区间替换成空格：注释里会**引用**修复前写法做说明（本文件的修复注释就写了
// `network: cf && { ... }`），直接做子串否定判定会误报。只匹配代码、不匹配注释。
// 必须按 UTF-16 code unit 切分（split('')），不能用 [...text]（按码点切分）：
// 源码里有 emoji（码点占 2 个 code unit），按码点得到的下标与 espree 的 range 不对齐，
// 会错位抹掉代码片段。
function stripComments(text, comments) {
  if (!comments?.length) return text;
  const chars = text.split('');
  for (const c of comments) {
    for (let i = c.range[0]; i < c.range[1]; i += 1) {
      if (chars[i] !== '\n') chars[i] = ' ';
    }
  }
  return chars.join('');
}
const sourceCode = stripComments(
  source,
  parse(source, { ecmaVersion: 'latest', sourceType: 'module', comment: true, range: true }).comments,
);
const bundleCode = stripComments(
  bundle,
  parse(bundle, { ecmaVersion: 'latest', sourceType: 'script', comment: true, range: true }).comments,
);

test('打包产物 client/client.js 与源码同步（含本次修复、无旧写法残留）', () => {
  // 用容忍空白的正则而不是整行字面量：只锁语义片段，不锁排版（避免格式化就误红）。
  const SCALAR_DEPS = /\[\s*token\s*,\s*hostname\s*,\s*network\?\.protocol\s*,\s*network\?\.edgeIpVersion\s*,\s*network\?\.region\s*\]/;
  const CF_NETWORK_MEMO = /const cfNetwork\s*=\s*React\.useMemo\(/;
  // esbuild 可能把 `undefined` 输出成 `void 0`，两种形态都接受
  const NETWORK_PROP = /network:\s*cf\s*\?\s*cfNetwork\s*:\s*(?:undefined|void 0)/;
  // 修复前写法（只做否定判定；注释已在上面被抹掉）
  const OLD_DEPS = /\[\s*token\s*,\s*hostname\s*,\s*network\s*\]/;
  const OLD_NETWORK_LITERAL = /network:\s*cf\s*&&\s*\{/;

  assert.match(sourceCode, SCALAR_DEPS, '源码的 effect 依赖应为三个标量网络参数');
  assert.match(sourceCode, CF_NETWORK_MEMO, '源码应用 useMemo 稳定 cfNetwork');
  assert.match(sourceCode, NETWORK_PROP, '源码应以 cfNetwork 传入 network');

  assert.match(bundleCode, SCALAR_DEPS,
    '产物缺少标量依赖（疑似忘记运行 npm run build:client）');
  assert.match(bundleCode, CF_NETWORK_MEMO,
    '产物缺少 cfNetwork 的 useMemo（疑似忘记运行 npm run build:client）');
  assert.match(bundleCode, NETWORK_PROP,
    '产物的 network prop 未使用 cfNetwork（疑似忘记运行 npm run build:client）');

  assert.doesNotMatch(sourceCode, OLD_DEPS, '源码里仍有修复前的对象依赖 [token, hostname, network]');
  assert.doesNotMatch(bundleCode, OLD_DEPS, '产物里仍有修复前的对象依赖，请重新运行 npm run build:client');
  assert.doesNotMatch(sourceCode, OLD_NETWORK_LITERAL, '源码里仍在渲染中新建 network 字面量对象');
  assert.doesNotMatch(bundleCode, OLD_NETWORK_LITERAL, '产物里仍在渲染中新建 network 字面量对象，请重新运行 npm run build:client');
});
