// test/plugin-inject-safety.test.mjs
//
// 静态守卫：**未在 inject 里声明的 cordis 服务，绝不能直接取属性**。
//
// 背景（真实事故 2026-10-16 03:02）：会话桥的 session 事件回调里直接写了
// `this.ctx.workspaceChanges`，而该服务不在 `inject` 列表中。cordis 对未声明属性
// **取即抛**（`cannot get property "workspaceChanges" without inject`），异常从
// onEvent 冒泡成 `dsh: fatal load failure` → 宿主主进程退出 → systemd 重启
// dsh-web。IM 侧的表象只是"改动摘要一条都没播报"，但实际是整机宿主崩了一次。
//
// 为什么功能测试没能拦住：测试夹具（makeMockCtx）是普通对象，取不存在的键只会
// 得到 undefined，与真 cordis ctx 的"抛错"语义不同，于是 CI 全绿而生产崩溃。
// 本用例改为**静态扫描源码**，对这类写法直接失败：它不依赖运行时语义，也就不会
// 因为夹具太宽松而失效。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 递归收集 lib/ 下的 .js/.mjs 源文件（排除打包产物与第三方 vendor）。 */
function sourceFiles(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) {
      out.push(...sourceFiles(full))
      continue
    }
    if (!/\.(js|mjs)$/.test(name)) continue
    // client/client.js 是 esbuild 打包产物；lark-bundled 是官方 SDK 原始 bundle —— 均非本仓手写
    if (name === 'client.js' || name === 'lark-bundled.mjs') continue
    out.push(full)
  }
  return out
}

/** 从 lib/index.js 读 inject 声明（数组或 {required, optional} 两种都支持）。 */
function declaredInject() {
  const src = readFileSync(join(repoRoot, 'lib', 'index.js'), 'utf8')
  const m = /const inject\s*=\s*([[{][\s\S]*?[\]}])\s*\n/.exec(src)
  assert.ok(m, 'lib/index.js 里应能解析出 inject 声明')
  const body = m[1]
  const names = new Set()
  for (const q of body.matchAll(/['"]([A-Za-z_$][\w$]*)['"]/g)) names.add(q[1])
  return names
}

/** cordis 的服务访问：this.ctx.<name> / ctx.<name>（排除框架通用成员）。 */
const FRAMEWORK_MEMBERS = new Set([
  'effect', 'on', 'off', 'emit', 'get', 'set', 'inject', 'logger', 'plugin',
  'scope', 'parallel', 'waterfall', 'bail', 'emitAsync', 'start', 'stop',
])

/**
 * 本插件**自己挂在 ctx 上**的命名空间（`ctx.feishu = gateway` 等），
 * 以及平台适配层子上下文里的 `ctx.qq / ctx.telegram / ctx.wechat`。
 * 这些不是 cordis 服务，不受 inject 约束，必须排除（否则守卫会大面积误报）。
 * 判定依据是仓库既有写法：各平台 index.js 里显式 `ctx.<name> = <gateway>`。
 */
function selfDefinedNamespaces() {
  const names = new Set()
  for (const file of sourceFiles(join(repoRoot, 'lib'))) {
    const src = readFileSync(file, 'utf8')
    for (const m of src.matchAll(/\bctx\.([A-Za-z_$][\w$]*)\s*=[^=]/g)) names.add(m[1])
  }
  // 已知的平台网关命名空间。feishu/qq/telegram 在各自 index.js 里显式 `ctx.<name> = gateway`，
  // 能被上面自动识别；**wechat 是唯一漏掉这句赋值的**（它的 node 仍按同样约定读 ctx.wechat，
  // 靠外部/宿主侧提供）。这里显式登记，保持四个平台一致。
  // 注意：这些是"插件自己的命名空间"，不是 cordis 服务，不受 inject 约束。
  for (const name of ['wechat', 'qq', 'feishu', 'telegram']) names.add(name)
  return names
}

test('lib/ 源码不得直接访问未 inject 的 cordis 服务（会 fatal load failure）', () => {
  const declared = declaredInject()
  const selfNamespaces = selfDefinedNamespaces()
  // 通过 peekCtxProperty 安全探测的属性允许出现（探测本身会吞掉 cordis 的抛错）
  const unsafe = []
  for (const file of sourceFiles(join(repoRoot, 'lib'))) {
    const src = readFileSync(file, 'utf8')
    const lines = src.split('\n')
    lines.forEach((line, i) => {
      // 跳过注释行（说明性文字里会出现 this.ctx.workspaceChanges）
      if (/^\s*(\*|\/\*|\/\/)/.test(line)) return
      const code = line.replace(/\/\/.*$/, '')
      for (const m of code.matchAll(/\b(?:this\.)?ctx\.([A-Za-z_$][\w$]*)/g)) {
        const name = m[1]
        if (FRAMEWORK_MEMBERS.has(name) || declared.has(name) || selfNamespaces.has(name)) continue
        // 探测写法白名单：peekCtxProperty(ctx, 'name')
        const isPeeked = new RegExp(`peekCtxProperty\\(\\s*(?:this\\.)?ctx\\s*,\\s*['"]${name}['"]`).test(code)
        if (isPeeked) continue
        // 赋值给 ctx.<name> 不算"读取服务"
        if (new RegExp(`ctx\\.${name}\\s*=[^=]`).test(code)) continue
        unsafe.push(`${relative(repoRoot, file)}:${i + 1}  ctx.${name}`)
      }
    })
  }
  assert.deepEqual(
    unsafe,
    [],
    '以下位置直接访问了未 inject 的服务，真机上会抛 "cannot get property ... without inject"：\n'
      + unsafe.join('\n')
      + '\n修法：要么把服务加进 lib/index.js 的 inject，要么用 peekCtxProperty(ctx, \'<name>\') 安全探测。',
  )
})

test('inject 声明与代码实际使用保持可解析（防止守卫自身失效）', () => {
  const declared = declaredInject()
  // 已知必用服务：这些缺失会让插件根本起不来
  for (const must of ['sessions', 'agents', 'workspaceRegistry', 'sessionPersistence']) {
    assert.ok(declared.has(must), `inject 应包含 ${must}`)
  }
  // workspaceChanges 是**可选**能力（老宿主/未装该 composition 时不存在），
  // 刻意不放进 inject —— 只能探测。若有人把它加进 inject，插件会变成"必须依赖它"，
  // 在缺该服务的宿主上直接不加载，反而更糟。
  assert.ok(!declared.has('workspaceChanges'), 'workspaceChanges 必须保持可选（不得写进 inject）')
})
