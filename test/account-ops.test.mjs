// issue #78 / verifier D2、D3、D4：账号运行时编排（lib/platform/account-ops.js）装配级单测
//
// 用 fake 依赖覆盖「查重命中不落库、上限拒绝、移除确实删配置、并发同步不重复构造/启动、
// 唯一 cordis 服务名与 ctx 槽位清理、create 失败可读暴露」等分支——这些分支此前只靠
// lib/index.js 闭包实现，突变（删上限 / 查重短路 / 移除不删 config / 去串行化）无法被 kill。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PlatformManager } from '../lib/platform/index.js'
import { createPlatformAccountOps, assertNoCreateErrors } from '../lib/platform/account-ops.js'
import { MAX_ACCOUNTS_PER_TYPE } from '../lib/platform/instances.js'

const silentLogger = { info() {}, warn() {}, error() {} }

function makeFakeService({ id, instanceId, registry } = {}) {
  const state = { started: 0, stopped: 0, disposed: 0, throwOnStop: false }
  const service = {
    id,
    instanceId,
    name: id,
    displayName: null,
    config: {},
    state,
    getStatus() { return { id, instanceId, status: 'idle', configured: false, login: {}, config: { name: '' } } },
    async start() { state.started += 1 },
    async stop() { state.stopped += 1; if (state.throwOnStop) throw new Error('stop boom') },
    dispose() { state.disposed += 1 },
  }
  service.__register = (serviceName) => {
    if (!registry) return
    if (registry.has(serviceName)) throw new Error(`service "${serviceName}" has been registered`)
    registry.add(serviceName)
  }
  return service
}

function makeHarness({ config = {}, registry = null, asyncCreate = false } = {}) {
  const store = JSON.parse(JSON.stringify(config))
  const manager = new PlatformManager({ logger: silentLogger })
  const created = []
  const ctx = {}
  let writes = 0

  const ops = createPlatformAccountOps({
    logger: silentLogger,
    ctx,
    loadNormalizedConfig: async () => JSON.parse(JSON.stringify(store)),
    updateConfig: async (mutate) => {
      // 与真实 updateConfig 同语义：mutate 拿到 draft，写回整体替换
      const draft = JSON.parse(JSON.stringify(store))
      const next = (await mutate(draft)) ?? draft
      for (const key of Object.keys(store)) delete store[key]
      Object.assign(store, next)
      writes += 1
      return store
    },
    platformManager: manager,
    createInstance: async (type, account, index, { serviceName }) => {
      if (asyncCreate) await new Promise((resolve) => setTimeout(resolve, 10))
      const service = makeFakeService({ id: type, instanceId: account.instanceId, registry })
      service.__register(serviceName)
      created.push({ type, instanceId: account.instanceId, serviceName })
      return service
    },
    restoreInstance: (service) => { service.restored = (service.restored ?? 0) + 1 },
    startInstance: (service) => { service.state.started += 1; return true },
    statusOf: (service) => ({ instanceId: service.instanceId, status: 'idle' }),
  })
  return { store, manager, created, ctx, ops, writes: () => writes }
}

// ---------------------------------------------------------------------------
// D4：查重（突变 ⑦：真实 validateAccountConfig 被短路）
// ---------------------------------------------------------------------------

test('D4/查重：同类型重复凭证命中 → 抛可读错误（真实 findDuplicateCredential 路径）', async () => {
  const { ops, store } = makeHarness({
    config: {
      feishu: {
        accounts: [
          { instanceId: 'feishu', appId: 'cli_a', appSecret: 's' },
          { instanceId: 'feishu:2', appId: 'cli_b', appSecret: 's' },
        ],
        seq: 2,
      },
    },
  })
  const snapshot = JSON.stringify(store)
  await assert.rejects(
    // 第二个账号把 appId 改成第一个账号已用的值 → 必须被拦截
    ops.validateAccountConfig({ id: 'feishu', instanceId: 'feishu:2', name: 'Feishu', config: { appId: 'cli_b' } }, { appId: 'cli_a' }),
    /同一应用不能重复添加：该凭证已被「飞书 1」使用/,
  )
  assert.equal(JSON.stringify(store), snapshot, '查重失败不得改动 config')
  // 不冲突 / 空凭证不参与：都应放行
  await ops.validateAccountConfig({ id: 'feishu', instanceId: 'feishu:2', config: { appId: 'cli_c' } }, { appId: 'cli_c' })
  await ops.validateAccountConfig({ id: 'feishu', instanceId: 'feishu:2', config: {} }, {})
})

test('D4/查重：排除自身与跨类型不误报', async () => {
  const { ops } = makeHarness({
    config: { feishu: { accounts: [{ instanceId: 'feishu', appId: 'cli_a' }], seq: 1 }, qq: { accounts: [{ instanceId: 'qq', appId: 'cli_a' }], seq: 1 } },
  })
  await ops.validateAccountConfig({ id: 'feishu', instanceId: 'feishu', config: { appId: 'cli_a' } }, { appId: 'cli_a' })
  await ops.validateAccountConfig({ id: 'qq', instanceId: 'qq', config: { appId: 'cli_a' } }, { appId: 'cli_a' })
})

// ---------------------------------------------------------------------------
// D3/D4：上限（突变 ⑥：删 10 上限）
// ---------------------------------------------------------------------------

test('D4/上限：第 11 个账号被拒绝且不落库', async () => {
  const accounts = Array.from({ length: MAX_ACCOUNTS_PER_TYPE }, (_, i) => ({
    instanceId: i === 0 ? 'feishu' : `feishu:${i + 1}`,
  }))
  const { ops, store, writes, created } = makeHarness({ config: { feishu: { accounts, seq: MAX_ACCOUNTS_PER_TYPE } } })
  await assert.rejects(ops.addAccount({ platformId: 'feishu' }), /单个平台最多添加 10 个账号/)
  assert.equal(store.feishu.accounts.length, MAX_ACCOUNTS_PER_TYPE, '超限不得写入 config')
  assert.equal(writes(), 0, '超限时不应发生任何写事务')
  assert.deepEqual(created, [], '超限不得构造实例')
})

test('D4/上限：未满时可新增并落库/构造实例', async () => {
  const accounts = Array.from({ length: MAX_ACCOUNTS_PER_TYPE - 1 }, (_, i) => ({
    instanceId: i === 0 ? 'feishu' : `feishu:${i + 1}`,
  }))
  const { ops, store, manager } = makeHarness({ config: { feishu: { accounts, seq: MAX_ACCOUNTS_PER_TYPE - 1 } } })
  const result = await ops.addAccount({ platformId: 'feishu', name: '十一号' })
  assert.equal(result.instanceId, `feishu:${MAX_ACCOUNTS_PER_TYPE}`)
  assert.equal(store.feishu.accounts.length, MAX_ACCOUNTS_PER_TYPE)
  assert.equal(store.feishu.accounts.at(-1).name, '十一号')
  assert.ok(manager.getExact(result.instanceId))
})

// ---------------------------------------------------------------------------
// D4：移除（突变 ⑧：removePlatformAccount 不从 config 删除）
// ---------------------------------------------------------------------------

test('D4/移除：确实从 config 删除目标账号、保留其余、移除实例', async () => {
  const { ops, store, manager } = makeHarness({
    config: {
      feishu: {
        accounts: [
          { instanceId: 'feishu', appId: 'cli_a' },
          { instanceId: 'feishu:2', appId: 'cli_b' },
        ],
        seq: 2,
      },
    },
  })
  await ops.syncAccounts({ start: true })
  assert.equal(manager.listByType('feishu').length, 2)

  const result = await ops.removeAccount({ instanceId: 'feishu' })
  assert.deepEqual(result, { ok: true, instanceId: 'feishu' })
  assert.deepEqual(store.feishu.accounts.map((account) => account.instanceId), ['feishu:2'])
  assert.equal(store.feishu.seq, 2, 'seq 不因删除回退')
  assert.equal(manager.getExact('feishu'), undefined)
  assert.equal(manager.listByType('feishu').length, 1)
})

test('D4/移除：允许删掉最后一个账号（回到 0 账号）', async () => {
  const { ops, store, manager } = makeHarness({ config: { qq: { accounts: [{ instanceId: 'qq' }], seq: 1 } } })
  await ops.syncAccounts({ start: true })
  await ops.removeAccount({ instanceId: 'qq' })
  assert.deepEqual(store.qq.accounts, [])
  assert.deepEqual(manager.listByType('qq'), [])
})

test('D4/移除：参数校验与不存在账号给出可读错误', async () => {
  const { ops } = makeHarness({ config: { qq: { accounts: [], seq: 0 } } })
  await assert.rejects(ops.removeAccount({}), /缺少 instanceId 参数/)
  await assert.rejects(ops.removeAccount({ instanceId: 'qq:9' }), /账号不存在: qq:9/)
  await assert.rejects(ops.addAccount({ platformId: 'dingtalk' }), /不支持的平台类型: dingtalk/)
  await assert.rejects(ops.addAccount({}), /不支持的平台类型: \(空\)/)
})

// ---------------------------------------------------------------------------
// D2/D4：串行化（突变 ⑨：syncPlatformAccounts 去串行化）
// ---------------------------------------------------------------------------

test('D4/串行化：并发 syncAccounts 只构造/启动一次', async () => {
  const { ops, created, manager } = makeHarness({
    config: { feishu: { accounts: [{ instanceId: 'feishu', appId: 'a', appSecret: 'b' }], seq: 1 } },
    asyncCreate: true,
  })
  await Promise.all([ops.syncAccounts({ start: true }), ops.syncAccounts({ start: true }), ops.syncAccounts({ start: true })])
  assert.equal(created.length, 1, '并发同步不得重复构造实例')
  assert.equal(manager.listByType('feishu').length, 1)
  assert.equal(manager.getExact('feishu').state.started, 1, '并发同步不得重复 start')
})

test('D4/串行化：sync 与 remove 并发时不会复活已删账号', async () => {
  const { ops, store, manager } = makeHarness({
    config: { feishu: { accounts: [{ instanceId: 'feishu', appId: 'a' }], seq: 1 } },
    asyncCreate: true,
  })
  const syncing = ops.syncAccounts({ start: true })
  const removing = ops.removeAccount({ instanceId: 'feishu' })
  await Promise.all([syncing, removing])
  assert.deepEqual(store.feishu.accounts, [])
  assert.deepEqual(manager.listByType('feishu'), [], '移除后不得被并发 sync 复活')
})

// ---------------------------------------------------------------------------
// D2：唯一 cordis 服务名 + ctx 槽位清理 + 同 instanceId 重建
// ---------------------------------------------------------------------------

test('D2：创建→移除→同 instanceId 再创建使用新服务名，槽位不残留', async () => {
  const registry = new Set()
  const { ops, ctx, created, manager, store } = makeHarness({
    config: { feishu: { accounts: [{ instanceId: 'feishu', appId: 'a' }], seq: 1 } },
    registry,
  })
  await ops.syncAccounts({ start: true })
  assert.equal(created[0].serviceName, 'feishu', '首次使用 instanceId 作为服务名')
  assert.equal(ctx.feishu, manager.getExact('feishu'), '首个实例占用 ctx.feishu 槽位')

  await ops.removeAccount({ instanceId: 'feishu' })
  assert.equal(ctx.feishu, undefined, '移除首个实例后槽位不得再指向已 dispose 的网关')

  // 模拟 importBackup 重新导入同一 instanceId（cordis 服务名未释放）
  store.feishu = { accounts: [{ instanceId: 'feishu', appId: 'a' }], seq: 1 }
  const report = await ops.syncAccounts({ start: true })
  assert.deepEqual(report.errors, [], '重名不得导致 create 失败')
  assert.equal(created.length, 2)
  assert.equal(created[1].serviceName, 'feishu#1', '重复创建必须换唯一服务名')
  assert.ok(manager.getExact('feishu'))
  assert.equal(ctx.feishu, manager.getExact('feishu'), '重建后槽位指向新实例')
})

test('D2 前提：同名 cordis 服务重复注册确实抛错（唯一服务名方案的必要性）', () => {
  const registry = new Set(['feishu'])
  const service = makeFakeService({ id: 'feishu', instanceId: 'feishu' })
  service.__register = (name) => {
    if (registry.has(name)) throw new Error(`service "${name}" has been registered`)
    registry.add(name)
  }
  assert.throws(() => service.__register('feishu'), /service "feishu" has been registered/)
  assert.doesNotThrow(() => service.__register('feishu#1'))
})

test('D2/③：create 失败可在同步报告中读到，assertNoCreateErrors 抛可读错误', async () => {
  const registry = new Set()
  const { ops } = makeHarness({
    config: { feishu: { accounts: [{ instanceId: 'feishu' }], seq: 1 } },
    registry,
  })
  // 占掉首次服务名，模拟"服务名未释放"场景被唯一分配器绕过失败前直接触发 create 异常
  registry.add('feishu')
  const report = await ops.syncAccounts({ start: true })
  assert.equal(report.created.length, 0)
  assert.deepEqual(report.errors.map((row) => `${row.phase}:${row.instanceId}`), ['create:feishu'])
  assert.throws(() => assertNoCreateErrors(report, { action: '备份导入后的平台账号恢复' }),
    /备份导入后的平台账号恢复失败：1 个账号未能创建（feishu）/)
  assert.doesNotThrow(() => assertNoCreateErrors({ errors: [{ phase: 'start', instanceId: 'x' }] }))
})

test('D2：allocateServiceName 首次用 instanceId，之后 instanceId#1、#2… 不复用', () => {
  const { ops } = makeHarness({ config: {} })
  assert.equal(ops.allocateServiceName('feishu'), 'feishu')
  assert.equal(ops.allocateServiceName('feishu'), 'feishu#1')
  assert.equal(ops.allocateServiceName('feishu'), 'feishu#2')
  assert.equal(ops.allocateServiceName('feishu:2'), 'feishu:2')
})

// ---------------------------------------------------------------------------
// 同步报告与 start 语义
// ---------------------------------------------------------------------------

test('syncAccounts 返回 reconcile 报告（created/started/errors），start=false 不启动', async () => {
  const { ops, manager } = makeHarness({
    config: { telegram: { accounts: [{ instanceId: 'telegram', botToken: '1:a' }], seq: 1 } },
  })
  const report = await ops.syncAccounts({ start: false })
  assert.deepEqual(report.created, ['telegram'])
  assert.deepEqual(report.started, [])
  assert.equal(manager.getExact('telegram').state.started, 0)
})
