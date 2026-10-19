// issue #78 后端单测：同平台多账号（多实例）
//
// 覆盖契约 §6 全部纯函数（迁移/幂等/边界）、§3 PlatformManager（instanceId 键/回退/
// listByType/unregister）、§5 同步编排（注入 fake 平台构造器）、§7 RPC（instanceId 优先、
// platformId 回退、增删账号、鉴权与错误文案）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PlatformManager } from '../lib/platform/index.js'
import {
  PLATFORM_TYPES,
  MAX_ACCOUNTS_PER_TYPE,
  normalizePlatformSection,
  normalizePlatformConfig,
  patchAccount,
  nextAccount,
  removeAccount,
  findDuplicateCredential,
  displayNameFor,
  platformTypeOf,
  PLATFORM_TYPE_LABELS,
  reconcilePlatformInstances,
} from '../lib/platform/instances.js'
import { installBridgeRpc, BRIDGE_ENDPOINTS } from '../lib/bridge-rpc.js'

const silentLogger = { info() {}, warn() {}, error() {} }

// ---------------------------------------------------------------------------
// 测试替身：最小平台实例（只实现 PlatformManager / reconcile / RPC 用到的契约）
// ---------------------------------------------------------------------------

function makeFakePlatform({ id, instanceId, name = id, displayName = null } = {}) {
  const state = {
    id,
    instanceId,
    started: 0,
    stopped: 0,
    disposed: 0,
    stoppedError: null,
    config: {},
    allowFrom: null,
    unbound: false,
    loginCount: 0,
  }
  const platform = {
    id,
    instanceId,
    name,
    displayName,
    get config() { return state.config },
    set config(value) { state.config = value },
    getStatus() {
      return {
        id,
        name,
        status: 'idle',
        configured: false,
        instanceId,
        platformId: id,
        displayName: displayName ?? name,
        login: {},
        config: { name: state.config.name ?? '' },
      }
    },
    async start() { state.started += 1; return { success: true } },
    async stop() {
      state.stopped += 1
      if (state.stoppedError) throw state.stoppedError
      return { success: true }
    },
    dispose() { state.disposed += 1 },
    async login() { state.loginCount += 1; return { ok: true } },
    async setAllowFrom(list) { state.allowFrom = list },
    async setConfig(config) { state.config = { ...state.config, ...config } },
    async unbind() { state.unbound = true },
  }
  return { platform, state }
}

function makeFakeManagerWith(platforms = []) {
  const manager = new PlatformManager({ logger: silentLogger })
  for (const platform of platforms) manager.register(platform)
  return manager
}

function sectionsOf(config) {
  const sections = {}
  for (const type of PLATFORM_TYPES) {
    sections[type] = normalizePlatformSection(type, config?.[type]).section
  }
  return sections
}

// ---------------------------------------------------------------------------
// 1. 常量与迁移
// ---------------------------------------------------------------------------

test('PLATFORM_TYPES 覆盖四个平台类型，账号上限为 10，中文名用于 displayName 兜底', () => {
  assert.deepEqual([...PLATFORM_TYPES], ['wechat', 'qq', 'feishu', 'telegram'])
  assert.equal(MAX_ACCOUNTS_PER_TYPE, 10)
  assert.deepEqual(PLATFORM_TYPE_LABELS, { wechat: '微信', qq: 'QQ', feishu: '飞书', telegram: 'Telegram' })
  // 飞书服务类的 this.name 是英文 'Feishu'，但展示名兜底必须用契约的中文名
  assert.equal(displayNameFor({ type: 'feishu', label: PLATFORM_TYPE_LABELS.feishu, account: {}, index: 2 }), '飞书 2')
})

test('迁移：旧单对象 → { accounts: [{ instanceId: type, ... }], seq: 1 }，未知字段不丢', () => {
  const legacy = {
    appId: 'cli_xxx',
    appSecret: 'secret',
    allowFrom: ['ou_1'],
    activeSessionId: 's-1',
    futureUnknownField: { nested: true },
    customNumber: 42,
  }
  const { section, changed } = normalizePlatformSection('feishu', legacy)
  assert.equal(changed, true)
  assert.equal(section.seq, 1)
  assert.equal(section.accounts.length, 1)
  const [account] = section.accounts
  assert.equal(account.instanceId, 'feishu')
  assert.equal(account.appId, 'cli_xxx')
  assert.equal(account.appSecret, 'secret')
  assert.deepEqual(account.allowFrom, ['ou_1'])
  assert.equal(account.activeSessionId, 's-1')
  assert.deepEqual(account.futureUnknownField, { nested: true })
  assert.equal(account.customNumber, 42)
  // 顶层旧字段已搬进账号，不再残留在 section 顶层
  assert.deepEqual(Object.keys(section).sort(), ['accounts', 'seq'])
})

test('迁移幂等：对规范化输出再次调用 changed=false 且内容不变', () => {
  const once = normalizePlatformSection('telegram', { botToken: '1:a', allowFrom: [] })
  assert.equal(once.changed, true)
  const twice = normalizePlatformSection('telegram', once.section)
  assert.equal(twice.changed, false)
  assert.deepEqual(twice.section, once.section)
})

test('D6：accounts 数组存在（哪怕为空）即为新格式，不复活幽灵账号、不重置 seq', () => {
  const { section, changed } = normalizePlatformSection('wechat', { accounts: [], token: 't', accountId: 'a', seq: 4 })
  assert.equal(changed, false)
  assert.deepEqual(section.accounts, [], '空 accounts 不得被当成旧单对象复活出一个账号')
  assert.equal(section.seq, 4, 'seq 不得回退为 1')
  assert.equal(section.token, 't', '段级未知字段仍不丢')
  assert.equal(section.accountId, 'a')
  // 幂等
  assert.equal(normalizePlatformSection('wechat', section).changed, false)
})

test('D5：旧段自带 instanceId 时迁移结果必须是 type（不得被脏数据覆盖）', () => {
  const { section, changed } = normalizePlatformSection('feishu', { instanceId: 'bogus', appId: 'cli_a' })
  assert.equal(changed, true)
  assert.equal(section.accounts[0].instanceId, 'feishu')
  assert.equal(section.accounts[0].appId, 'cli_a')
  assert.equal(section.seq, 1)
})

test('D6：无 accounts 但有段级明细键时迁移保留更大的 seq（不回退）', () => {
  const { section } = normalizePlatformSection('telegram', { botToken: '1:a', seq: 7 })
  assert.equal(section.accounts[0].instanceId, 'telegram')
  assert.equal(section.seq, 7, 'legacy seq 大于 1 时不得回退（防序号复用）')
})

test('D3：nextAccount 在达到单类型上限 10 时抛可读错误', () => {
  const accounts = Array.from({ length: MAX_ACCOUNTS_PER_TYPE }, (_, i) => ({
    instanceId: i === 0 ? 'feishu' : `feishu:${i + 1}`,
  }))
  const full = { accounts, seq: MAX_ACCOUNTS_PER_TYPE }
  assert.throws(() => nextAccount({ section: full, type: 'feishu' }), /单个平台最多添加 10 个账号/)
  const notFull = { accounts: accounts.slice(0, MAX_ACCOUNTS_PER_TYPE - 1), seq: MAX_ACCOUNTS_PER_TYPE - 1 }
  assert.equal(nextAccount({ section: notFull, type: 'feishu' }).section.accounts.length, MAX_ACCOUNTS_PER_TYPE)
})

test('缺失段不合成账号：undefined/null/新 config 无该类型时 accounts 为空且 changed=false', () => {
  for (const raw of [undefined, null]) {
    const { section, changed } = normalizePlatformSection('feishu', raw)
    assert.equal(changed, false)
    assert.deepEqual(section, { accounts: [], seq: 0 })
  }
  const { config, changed } = normalizePlatformConfig({ port: 3082 })
  assert.equal(changed, false)
  assert.equal('feishu' in config, false, '缺失的类型不应被凭空写入 config')
  assert.equal('accounts' in (config.feishu ?? {}), false)
})

test('accounts: [] 原样保留（0 账号合法状态），seq 不清零', () => {
  const { section, changed } = normalizePlatformSection('qq', { accounts: [], seq: 3 })
  assert.equal(changed, false)
  assert.deepEqual(section, { accounts: [], seq: 3 })
  const { config, changed: anyChanged } = normalizePlatformConfig({ qq: { accounts: [], seq: 3 } })
  assert.equal(anyChanged, false)
  assert.deepEqual(config.qq, { accounts: [], seq: 3 })
})

test('补 instanceId：按数组顺序补 type、type:2…，并提升 seq；字段全部保留', () => {
  const { section, changed } = normalizePlatformSection('feishu', {
    accounts: [{ appId: 'a' }, { appId: 'b' }, { appId: 'c' }],
    seq: 0,
  })
  assert.equal(changed, true)
  assert.deepEqual(section.accounts.map((account) => account.instanceId), ['feishu', 'feishu:2', 'feishu:3'])
  assert.deepEqual(section.accounts.map((account) => account.appId), ['a', 'b', 'c'])
  assert.equal(section.seq, 3)
  assert.equal(normalizePlatformSection('feishu', section).changed, false)
})

test('重复/非法 instanceId 重分配，其余字段保留', () => {
  const duplicate = normalizePlatformSection('feishu', {
    accounts: [
      { instanceId: 'feishu', appId: 'a' },
      { instanceId: 'feishu', appId: 'b' },
    ],
    seq: 1,
  })
  assert.deepEqual(duplicate.section.accounts.map((account) => account.instanceId), ['feishu', 'feishu:2'])
  assert.deepEqual(duplicate.section.accounts.map((account) => account.appId), ['a', 'b'])

  const illegal = normalizePlatformSection('wechat', {
    accounts: [{ instanceId: 'not-a-wechat-id', token: 't' }],
  })
  assert.equal(illegal.section.accounts[0].instanceId, 'wechat')
  assert.equal(illegal.section.accounts[0].token, 't')
})

test('seq 提升到已有最大序号，且不回退', () => {
  const promoted = normalizePlatformSection('feishu', {
    accounts: [{ instanceId: 'feishu:5', appId: 'a' }],
    seq: 1,
  })
  assert.equal(promoted.section.seq, 5)
  assert.equal(promoted.changed, true)
})

test('normalizePlatformConfig 返回新对象、不原地修改入参，未变化类型保持原引用', () => {
  const config = { feishu: { appId: 'x' }, qq: { accounts: [], seq: 2 }, port: 3082 }
  const snapshot = JSON.parse(JSON.stringify(config))
  const result = normalizePlatformConfig(config)
  assert.deepEqual(config, snapshot, '入参不得被原地修改')
  assert.equal(result.changed, true)
  assert.equal(result.config.feishu.accounts[0].instanceId, 'feishu')
  assert.equal(result.config.qq, config.qq, '未变化的类型可保持原引用')
  assert.equal(result.config.port, 3082)
})

test('platformTypeOf 解析类型前缀', () => {
  assert.equal(platformTypeOf('feishu'), 'feishu')
  assert.equal(platformTypeOf('feishu:2'), 'feishu')
  assert.equal(platformTypeOf('telegram:12'), 'telegram')
  assert.equal(platformTypeOf(''), '')
  assert.equal(platformTypeOf(null), '')
})

// ---------------------------------------------------------------------------
// 2. nextAccount / patchAccount / removeAccount
// ---------------------------------------------------------------------------

test('nextAccount：新增账号一律 type:N，seq 只增不复用（含空类型首次添加）', () => {
  const first = nextAccount({ section: undefined, type: 'feishu', name: ' 小鲸 ' })
  assert.equal(first.account.instanceId, 'feishu:1', '空类型首次新增也用带序号格式')
  assert.equal(first.account.name, '小鲸')
  assert.equal(first.section.seq, 1)

  const second = nextAccount({ section: first.section, type: 'feishu' })
  assert.equal(second.account.instanceId, 'feishu:2')
  assert.equal(second.section.seq, 2)

  // 迁移来的首个账号（裸 feishu，seq=1）之后新增：feishu:2（契约 §1：新增 N ≥ 2）
  const migrated = normalizePlatformSection('feishu', { appId: 'x' }).section
  assert.equal(nextAccount({ section: migrated, type: 'feishu' }).account.instanceId, 'feishu:2')

  // 删除中间账号后不回收序号
  const removed = removeAccount(second.section, 'feishu:2')
  const third = nextAccount({ section: removed, type: 'feishu' })
  assert.equal(third.account.instanceId, 'feishu:3')
  assert.equal(third.section.seq, 3)
})

test('nextAccount 追加到末尾，不改现有顺序；非法类型抛错', () => {
  const existing = { accounts: [{ instanceId: 'qq', appId: 'a' }], seq: 1 }
  const { section } = nextAccount({ section: existing, type: 'qq', name: '二号' })
  assert.deepEqual(section.accounts.map((account) => account.instanceId), ['qq', 'qq:2'])
  assert.equal(section.accounts[1].name, '二号')
  assert.throws(() => nextAccount({ section: existing, type: 'dingtalk' }), /不支持的平台类型/)
})

test('patchAccount：只更新目标 account，其它账号/字段原样保留', () => {
  const section = {
    accounts: [
      { instanceId: 'feishu', appId: 'a', allowFrom: ['u1'] },
      { instanceId: 'feishu:2', appId: 'b', allowFrom: ['u2'] },
    ],
    seq: 2,
  }
  const next = patchAccount(section, 'feishu:2', { allowFrom: ['u3'], name: '二号' })
  assert.deepEqual(next.accounts[0], section.accounts[0], '其它账号不得被整体覆盖')
  assert.deepEqual(next.accounts[1].allowFrom, ['u3'])
  assert.equal(next.accounts[1].name, '二号')
  assert.equal(next.accounts[1].appId, 'b')
  assert.equal(next.seq, 2)
})

test('patchAccount：instanceId 不可被 patch 改写；目标不存在抛错；可处理旧格式段', () => {
  const section = { accounts: [{ instanceId: 'qq', appId: 'a' }], seq: 1 }
  const next = patchAccount(section, 'qq', { instanceId: 'hacked', appId: 'b' })
  assert.equal(next.accounts[0].instanceId, 'qq')
  assert.equal(next.accounts[0].appId, 'b')
  assert.throws(() => patchAccount(section, 'qq:9', { appId: 'x' }), /账号不存在/)

  const migrated = patchAccount({ appId: 'legacy' }, 'feishu', { name: '老账号' })
  assert.equal(migrated.accounts[0].appId, 'legacy')
  assert.equal(migrated.accounts[0].name, '老账号')
})

test('removeAccount：只删目标账号，保留 seq；不存在时原样返回；可移除最后一个账号', () => {
  const section = {
    accounts: [{ instanceId: 'qq' }, { instanceId: 'qq:2' }],
    seq: 2,
  }
  const removed = removeAccount(section, 'qq')
  assert.deepEqual(removed.accounts.map((account) => account.instanceId), ['qq:2'])
  assert.equal(removed.seq, 2)

  const noop = removeAccount(section, 'qq:99')
  assert.deepEqual(noop.accounts.map((account) => account.instanceId), ['qq', 'qq:2'])

  const emptied = removeAccount(removeAccount(section, 'qq'), 'qq:2')
  assert.deepEqual(emptied.accounts, [])
  assert.equal(emptied.seq, 2, '清空账号后 seq 保留，后续新增不复用已删除序号')
})

// ---------------------------------------------------------------------------
// 3. 重复凭证
// ---------------------------------------------------------------------------

test('findDuplicateCredential：feishu/qq 按 appId、telegram 按 botToken', () => {
  const feishuAccounts = [{ instanceId: 'feishu', appId: 'cli_a' }, { instanceId: 'feishu:2', appId: 'cli_b' }]
  const feishuDup = findDuplicateCredential({
    type: 'feishu', accounts: feishuAccounts, candidate: { appId: ' cli_b ' }, excludeInstanceId: 'feishu',
  })
  assert.equal(feishuDup.instanceId, 'feishu:2')
  assert.equal(findDuplicateCredential({
    type: 'feishu', accounts: feishuAccounts, candidate: { appId: 'cli_a' }, excludeInstanceId: 'feishu',
  }), null, '排除自身')
  assert.equal(findDuplicateCredential({
    type: 'qq', accounts: [{ instanceId: 'qq', appId: 'x' }], candidate: { appId: 'x' },
  }).instanceId, 'qq')
  assert.equal(findDuplicateCredential({
    type: 'telegram', accounts: [{ instanceId: 'telegram', botToken: '1:a' }], candidate: { botToken: '1:a' },
  }).instanceId, 'telegram')
  assert.equal(findDuplicateCredential({
    type: 'telegram', accounts: [{ instanceId: 'telegram', botToken: '1:a' }], candidate: { botToken: '2:b' },
  }), null)
})

test('findDuplicateCredential：空凭证不参与查重，wechat 用 token+accountId 组合', () => {
  const wechatAccounts = [{ instanceId: 'wechat', token: 't1', accountId: 'a1' }]
  assert.equal(findDuplicateCredential({
    type: 'feishu', accounts: [{ instanceId: 'feishu', appId: 'cli_a' }], candidate: { appId: '' },
  }), null)
  assert.equal(findDuplicateCredential({
    type: 'feishu', accounts: [{ instanceId: 'feishu', appId: 'cli_a' }], candidate: {},
  }), null)
  assert.equal(findDuplicateCredential({
    type: 'wechat', accounts: wechatAccounts, candidate: { token: 't1' },
  }), null, '组合键不完整时不查重')
  assert.equal(findDuplicateCredential({
    type: 'wechat', accounts: wechatAccounts, candidate: { token: 't1', accountId: 'a1' },
  }).instanceId, 'wechat')
  assert.equal(findDuplicateCredential({
    type: 'wechat', accounts: wechatAccounts, candidate: { token: 't1', accountId: 'a2' },
  }), null)
  assert.equal(findDuplicateCredential({ type: 'dingtalk', accounts: [], candidate: {} }), null)
  assert.equal(findDuplicateCredential({ type: 'feishu', accounts: null, candidate: { appId: 'x' } }), null)
})

// ---------------------------------------------------------------------------
// 4. displayName
// ---------------------------------------------------------------------------

test('displayNameFor：有备注名用备注名（trim），无则平台中文名 + 1 基序号', () => {
  assert.equal(displayNameFor({ type: 'feishu', label: '飞书', account: { name: '  小鲸  ' }, index: 2 }), '小鲸')
  assert.equal(displayNameFor({ type: 'feishu', label: '飞书', account: { name: '   ' }, index: 2 }), '飞书 2')
  assert.equal(displayNameFor({ type: 'feishu', label: '飞书', account: {}, index: 1 }), '飞书 1')
  assert.equal(displayNameFor({ type: 'telegram', label: 'Telegram', account: { name: '' }, index: 3 }), 'Telegram 3')
  // 未传平台中文名时回退内置中文名；序号缺失按 1
  assert.equal(displayNameFor({ type: 'qq', index: 1 }), 'QQ 1')
  assert.equal(displayNameFor({ type: 'wechat' }), '微信 1')
})

// ---------------------------------------------------------------------------
// 5. PlatformManager
// ---------------------------------------------------------------------------

test('PlatformManager：以 instanceId 为键，get 精确命中 + platformId 回退第一个实例', () => {
  const f1 = makeFakePlatform({ id: 'feishu', instanceId: 'feishu' }).platform
  const f2 = makeFakePlatform({ id: 'feishu', instanceId: 'feishu:2' }).platform
  const manager = makeFakeManagerWith([f1, f2])

  assert.equal(manager.get('feishu'), f1)
  assert.equal(manager.get('feishu:2'), f2)
  assert.equal(manager.resolve('feishu:2'), f2)
  assert.equal(manager.resolve('feishu'), f1)
  assert.equal(manager.get('telegram'), undefined)
  assert.equal(manager.get(null), undefined)
  assert.equal(manager.list().length, 2)
})

test('PlatformManager：只注册了 type:N 时，按 platformId 回退到该类型第一个实例', () => {
  const only = makeFakePlatform({ id: 'feishu', instanceId: 'feishu:2' }).platform
  const manager = makeFakeManagerWith([only])
  assert.equal(manager.get('feishu'), only)
  assert.equal(manager.get('feishu:2'), only)
})

test('PlatformManager：listByType / unregister / getStatus 键与元信息', () => {
  const f1 = makeFakePlatform({ id: 'feishu', instanceId: 'feishu', displayName: '小鲸' }).platform
  const f2 = makeFakePlatform({ id: 'feishu', instanceId: 'feishu:2' }).platform
  const w = makeFakePlatform({ id: 'wechat', instanceId: 'wechat' }).platform
  const manager = makeFakeManagerWith([f1, f2, w])

  assert.deepEqual(manager.listByType('feishu'), [f1, f2])
  assert.deepEqual(manager.listByType('qq'), [])

  const status = manager.getStatus()
  assert.deepEqual(Object.keys(status).sort(), ['feishu', 'feishu:2', 'wechat'])
  assert.equal(status['feishu:2'].instanceId, 'feishu:2')
  assert.equal(status['feishu:2'].platformId, 'feishu')
  assert.equal(status['feishu:2'].displayName, 'feishu')
  assert.equal(status.feishu.displayName, '小鲸')

  assert.equal(manager.unregister('feishu:2'), true)
  assert.equal(manager.unregister('feishu:2'), false)
  assert.equal(manager.get('feishu:2'), undefined)
  assert.deepEqual(manager.listByType('feishu'), [f1])
})

test('PlatformManager：无 instanceId 的旧实例仍以 id 为键；重复注册替换并 dispose 旧实例', () => {
  const legacy = makeFakePlatform({ id: 'qq', instanceId: undefined })
  legacy.platform.instanceId = undefined
  const manager = makeFakeManagerWith([legacy.platform])
  assert.equal(manager.get('qq'), legacy.platform)
  assert.equal(manager.instanceIdOf(legacy.platform), 'qq')

  const { platform: replacement } = makeFakePlatform({ id: 'qq', instanceId: 'qq' })
  manager.register(replacement)
  assert.equal(manager.get('qq'), replacement)
  // 旧实例是同一个键：register 会 dispose 被替换的那一个
  assert.equal(legacy.state.disposed, 1)
  assert.equal(manager.list().length, 1)
})

test('PlatformManager.getStatus：getStatus 抛错时仍返回带实例元信息的错误条目', () => {
  const broken = {
    id: 'qq',
    instanceId: 'qq:2',
    name: 'QQ',
    displayName: null,
    getStatus() { throw new Error('boom') },
  }
  const manager = makeFakeManagerWith([broken])
  const status = manager.getStatus()['qq:2']
  assert.equal(status.status, 'error')
  assert.equal(status.instanceId, 'qq:2')
  assert.equal(status.platformId, 'qq')
  assert.equal(status.displayName, 'QQ')
  assert.match(status.error, /boom/)
})

// ---------------------------------------------------------------------------
// 6. 同步编排（注入 fake 平台构造器）
// ---------------------------------------------------------------------------

function makeReconcileHarness({ start = true } = {}) {
  const created = []
  const restored = []
  const started = []
  const manager = new PlatformManager({ logger: silentLogger })
  const reconcile = (cfg, extra = {}) => reconcilePlatformInstances({
    platformManager: manager,
    sections: sectionsOf(cfg),
    logger: silentLogger,
    start,
    createInstance: (type, account, index) => {
      created.push({ type, instanceId: account.instanceId, index })
      const { platform } = makeFakePlatform({ id: type, instanceId: account.instanceId })
      platform.config = { ...account }
      return platform
    },
    restoreInstance: (service, type, account) => {
      restored.push({ type, instanceId: account.instanceId })
      service.config = { ...account }
    },
    startInstance: (service, type, account) => {
      const hasCredentials = type === 'telegram' ? Boolean(account.botToken) : Boolean(account.appId && account.appSecret)
      if (!hasCredentials) return false
      started.push(account.instanceId)
      return service.start()
    },
    ...extra,
  })
  return { manager, reconcile, created, restored, started }
}

test('同步：旧单对象迁移后按账号建实例，仅完整凭证的账号自动启动', async () => {
  const harness = makeReconcileHarness()
  const report = await harness.reconcile({
    feishu: { appId: 'cli_a', appSecret: 's' },
    telegram: { botToken: '1:a' },
    wechat: { token: 't' },
  })
  // PLATFORM_TYPES 顺序：wechat → qq → feishu → telegram；qq 缺失不建实例
  assert.deepEqual(harness.created.map((row) => row.instanceId), ['wechat', 'feishu', 'telegram'])
  assert.deepEqual([...report.started].sort(), ['feishu', 'telegram'])
  assert.equal(harness.manager.listByType('qq').length, 0, '缺失类型不注册实例')
  assert.equal(harness.manager.get('feishu').instanceId, 'feishu')
  assert.deepEqual(harness.restored.map((row) => row.instanceId), ['wechat', 'feishu', 'telegram'])
})

test('同步幂等：重复同步不重复创建实例，只回写配置', async () => {
  const config = { feishu: { accounts: [{ instanceId: 'feishu', appId: 'a', appSecret: 'b' }], seq: 1 } }
  const harness = makeReconcileHarness()
  await harness.reconcile(config)
  const createdAfterFirst = harness.created.length
  await harness.reconcile(config)
  assert.equal(harness.created.length, createdAfterFirst)
  assert.equal(harness.manager.listByType('feishu').length, 1)
})

test('同步：配置中消失的账号 stop+dispose+unregister；stop 失败不阻断其它账号', async () => {
  const manager = new PlatformManager({ logger: silentLogger })
  const a = makeFakePlatform({ id: 'feishu', instanceId: 'feishu' })
  const b = makeFakePlatform({ id: 'feishu', instanceId: 'feishu:2' })
  b.state.stoppedError = new Error('stop boom')
  manager.register(a.platform)
  manager.register(b.platform)

  const report = await reconcilePlatformInstances({
    platformManager: manager,
    sections: {
      feishu: { accounts: [{ instanceId: 'feishu' }], seq: 2 },
      qq: { accounts: [], seq: 0 },
      wechat: { accounts: [], seq: 0 },
      telegram: { accounts: [], seq: 0 },
    },
    logger: silentLogger,
    createInstance: (type, account) => makeFakePlatform({ id: type, instanceId: account.instanceId }).platform,
  })

  assert.deepEqual(report.removed, ['feishu:2'])
  assert.equal(b.state.stopped, 1)
  assert.equal(b.state.disposed, 1)
  assert.equal(manager.get('feishu:2'), undefined)
  assert.equal(manager.get('feishu'), a.platform, '其它账号不受影响')
  assert.ok(report.errors.some((row) => row.phase === 'stop' && row.instanceId === 'feishu:2'))
})

test('同步：移除最后一个账号后该类型 0 实例（不回退、不重建）', async () => {
  const manager = new PlatformManager({ logger: silentLogger })
  manager.register(makeFakePlatform({ id: 'qq', instanceId: 'qq' }).platform)
  const report = await reconcilePlatformInstances({
    platformManager: manager,
    sections: { qq: { accounts: [], seq: 1 } },
    logger: silentLogger,
    createInstance: (type, account) => makeFakePlatform({ id: type, instanceId: account.instanceId }).platform,
  })
  assert.deepEqual(report.removed, ['qq'])
  assert.deepEqual(manager.listByType('qq'), [])
})

test('同步：start=false 时不启动任何实例；restore 失败记录错误但继续', async () => {
  const starts = []
  const manager = new PlatformManager({ logger: silentLogger })
  await reconcilePlatformInstances({
    platformManager: manager,
    sections: { telegram: { accounts: [{ instanceId: 'telegram', botToken: '1:a' }], seq: 1 } },
    logger: silentLogger,
    start: false,
    createInstance: (type, account) => makeFakePlatform({ id: type, instanceId: account.instanceId }).platform,
    restoreInstance: () => { throw new Error('restore boom') },
    startInstance: () => { starts.push('called') },
  })
  assert.deepEqual(starts, [])
  assert.equal(manager.listByType('telegram').length, 1, 'restore 失败不影响实例注册')
})

// ---------------------------------------------------------------------------
// 7. RPC：instanceId 优先 / platformId 回退 / 增删账号 / 鉴权与错误
// ---------------------------------------------------------------------------

function makeRpcHarness({ platforms = [], deps = {}, authManager = null } = {}) {
  let handler
  const ctx = {
    connection: { rpc: { handle: (channel, fn) => { handler = fn; return () => {} } } },
    get: () => undefined,
  }
  const manager = makeFakeManagerWith(platforms)
  installBridgeRpc(ctx, {
    service: {},
    authManager,
    platformManager: manager,
    logger: silentLogger,
    ...deps,
  })
  assert.equal(typeof handler, 'function', 'RPC 通道应已注册')
  return { call: (endpoint, payload = {}) => handler(endpoint, payload), manager }
}

test('RPC 平台操作：instanceId 优先，响应带实例元信息', async () => {
  const f1 = makeFakePlatform({ id: 'feishu', instanceId: 'feishu', name: 'Feishu', displayName: '飞书 1' })
  const f2 = makeFakePlatform({ id: 'feishu', instanceId: 'feishu:2', name: 'Feishu', displayName: '飞书 2' })
  const { call } = makeRpcHarness({ platforms: [f1.platform, f2.platform] })

  const result = await call(BRIDGE_ENDPOINTS.platformLogin, { instanceId: 'feishu:2', platformId: 'feishu' })
  assert.equal(result.ok, true)
  assert.equal(f1.state.loginCount, 0)
  assert.equal(f2.state.loginCount, 1)
  assert.equal(result.value.instanceId, 'feishu:2')
  assert.equal(result.value.platformId, 'feishu')
  assert.equal(result.value.displayName, '飞书 2')
})

test('RPC 平台操作：缺 instanceId 时回退 platformId（旧客户端行为）', async () => {
  const f1 = makeFakePlatform({ id: 'telegram', instanceId: 'telegram' })
  const f2 = makeFakePlatform({ id: 'telegram', instanceId: 'telegram:2' })
  const { call } = makeRpcHarness({ platforms: [f1.platform, f2.platform] })

  const result = await call(BRIDGE_ENDPOINTS.platformStop, { platformId: 'telegram' })
  assert.equal(result.ok, true)
  assert.equal(f1.state.stopped, 1)
  assert.equal(f2.state.stopped, 0)
  assert.equal(result.value.instanceId, 'telegram')
})

test('RPC 平台操作：缺定位参数 / 未注册实例返回可读错误', async () => {
  const { call } = makeRpcHarness({ platforms: [] })
  const missing = await call(BRIDGE_ENDPOINTS.platformStart, {})
  assert.equal(missing.ok, false)
  assert.equal(missing.error.message, '缺少 instanceId/platformId 参数')

  const unknown = await call(BRIDGE_ENDPOINTS.platformStart, { instanceId: 'qq:9' })
  assert.equal(unknown.ok, false)
  assert.equal(unknown.error.message, '平台未注册: qq:9')
})

test('RPC platformSetConfig：重复凭证校验命中时返回 bad-request，且不调用 setConfig', async () => {
  const fake = makeFakePlatform({ id: 'feishu', instanceId: 'feishu:2' })
  let validated = null
  const { call } = makeRpcHarness({
    platforms: [fake.platform],
    deps: {
      validatePlatformAccountConfig: async (platform, patch) => {
        validated = { instanceId: platform.instanceId, patch }
        throw new Error('同一应用不能重复添加：该凭证已被「飞书 1」使用')
      },
    },
  })
  const result = await call(BRIDGE_ENDPOINTS.platformSetConfig, { instanceId: 'feishu:2', appId: 'cli_dup' })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'bad-request')
  assert.equal(result.error.message, '同一应用不能重复添加：该凭证已被「飞书 1」使用')
  assert.equal(validated.instanceId, 'feishu:2')
  assert.equal(validated.patch.appId, 'cli_dup')
  assert.equal(fake.state.config.appId, undefined, '校验失败不得落库/落内存')
})

test('RPC platformSetConfig：保存 payload 传给 setConfig 时剔除 instanceId/platformId', async () => {
  const fake = makeFakePlatform({ id: 'feishu', instanceId: 'feishu' })
  const { call } = makeRpcHarness({ platforms: [fake.platform] })
  const result = await call(BRIDGE_ENDPOINTS.platformSetConfig, {
    instanceId: 'feishu',
    platformId: 'feishu',
    name: '小鲸',
    maxMessageChars: 2000,
  })
  assert.equal(result.ok, true)
  assert.equal(fake.state.config.name, '小鲸')
  assert.equal(fake.state.config.maxMessageChars, 2000)
  assert.equal('instanceId' in fake.state.config, false)
  assert.equal('platformId' in fake.state.config, false)
})

test('RPC platformAddAccount：返回 ok({instanceId,status})；能力未接线时 internal', async () => {
  const fake = makeFakePlatform({ id: 'feishu', instanceId: 'feishu:2' })
  let added = null
  const { call } = makeRpcHarness({
    deps: {
      addPlatformAccount: async (payload) => {
        added = payload
        return { instanceId: 'feishu:2', status: fake.platform.getStatus() }
      },
    },
  })
  const result = await call(BRIDGE_ENDPOINTS.platformAddAccount, { platformId: 'feishu', name: '二号' })
  assert.equal(result.ok, true)
  assert.equal(result.value.instanceId, 'feishu:2')
  assert.equal(result.value.status.instanceId, 'feishu:2')
  assert.deepEqual(added, { platformId: 'feishu', name: '二号' })

  const { call: callWithout } = makeRpcHarness({})
  const notWired = await callWithout(BRIDGE_ENDPOINTS.platformAddAccount, { platformId: 'feishu' })
  assert.equal(notWired.ok, false)
  assert.equal(notWired.error.code, 'internal')
  assert.equal(notWired.error.message, '多账号能力未接线')
})

test('RPC platformRemoveAccount：返回 ok({ok,instanceId})；未接线/业务错误可读', async () => {
  const { call } = makeRpcHarness({
    deps: { removePlatformAccount: async ({ instanceId }) => ({ ok: true, instanceId }) },
  })
  const result = await call(BRIDGE_ENDPOINTS.platformRemoveAccount, { instanceId: 'feishu:2' })
  assert.equal(result.ok, true)
  assert.equal(result.value.ok, true)
  assert.equal(result.value.instanceId, 'feishu:2')

  const { call: failing } = makeRpcHarness({
    deps: {
      removePlatformAccount: async () => { throw new Error('账号不存在: feishu:9') },
    },
  })
  const missing = await failing(BRIDGE_ENDPOINTS.platformRemoveAccount, { instanceId: 'feishu:9' })
  assert.equal(missing.ok, false)
  assert.equal(missing.error.message, '账号不存在: feishu:9')

  const { call: callWithout } = makeRpcHarness({})
  const notWired = await callWithout(BRIDGE_ENDPOINTS.platformRemoveAccount, { instanceId: 'feishu' })
  assert.equal(notWired.ok, false)
  assert.equal(notWired.error.code, 'internal')
})

test('RPC platformAddAccount / platformRemoveAccount 走管理员鉴权', async () => {
  const authManager = {
    adminProtection: true,
    adminPolicy: 'password',
    hasAdminPassword: true,
    hasPassword: false,
    validateAdminSession: () => false,
  }
  let addCalls = 0
  let removeCalls = 0
  const { call } = makeRpcHarness({
    authManager,
    deps: {
      addPlatformAccount: async () => { addCalls += 1; return { instanceId: 'feishu:2', status: null } },
      removePlatformAccount: async () => { removeCalls += 1; return { ok: true } },
    },
  })
  const addResult = await call(BRIDGE_ENDPOINTS.platformAddAccount, { platformId: 'feishu' })
  assert.equal(addResult.ok, false)
  assert.match(addResult.error.message, /管理员权限/)
  const removeResult = await call(BRIDGE_ENDPOINTS.platformRemoveAccount, { instanceId: 'feishu' })
  assert.equal(removeResult.ok, false)
  assert.match(removeResult.error.message, /管理员权限/)
  assert.equal(addCalls, 0)
  assert.equal(removeCalls, 0)
})

test('RPC listPlatforms：键为 instanceId，值含 instanceId/platformId/displayName', async () => {
  const f1 = makeFakePlatform({ id: 'feishu', instanceId: 'feishu' })
  const f2 = makeFakePlatform({ id: 'feishu', instanceId: 'feishu:2' })
  const { call } = makeRpcHarness({ platforms: [f1.platform, f2.platform] })
  const result = await call(BRIDGE_ENDPOINTS.listPlatforms, {})
  assert.equal(result.ok, true)
  assert.deepEqual(Object.keys(result.value).sort(), ['feishu', 'feishu:2'])
  assert.equal(result.value['feishu:2'].instanceId, 'feishu:2')
  assert.equal(result.value['feishu:2'].platformId, 'feishu')
  // 未显式设置 displayName 时回退 name（服务类的中文/品牌名）
  assert.equal(result.value['feishu:2'].displayName, 'feishu')
})

// ---------------------------------------------------------------------------
// 8. 多实例隔离：cordis 服务名唯一 + 事件按 instanceId 过滤（Lead 裁定方案）
// ---------------------------------------------------------------------------

/** 模拟 cordis：同名服务重复 provide 会抛错（真机行为，node_modules/@deepseek-ai/cordis）。 */
function makeDuplicateAwareCtx() {
  const services = new Map()
  const events = {}
  const ctx = {
    on(event, fn) { (events[event] ??= []).push(fn); return () => { events[event] = (events[event] ?? []).filter((f) => f !== fn) } },
    async emit(event, ...args) { for (const fn of [...(events[event] ?? [])]) await fn(...args) },
    effect(fn) { return fn() },
    logger: () => silentLogger,
    sessions: { list: () => [], get: () => undefined },
    agents: { create: async () => ({}), get: () => undefined },
    reflect: {
      provide(name, value) {
        if (services.has(name)) throw new Error(`service "${name}" has been registered`)
        services.set(name, value)
        ctx[name] = value
        return () => { services.delete(name) }
      },
    },
    _services: services,
  }
  return ctx
}

test('同类型第二个实例可正常构造：instanceId 兼作 cordis 服务名，不再重名冲突', async () => {
  const ctx = makeDuplicateAwareCtx()
  const { FeishuGateway } = await import('../lib/feishu/gateway.js')
  const { TelegramGateway } = await import('../lib/telegram/gateway.js')
  const { QqGateway } = await import('../lib/qq/gateway.js')
  const { WechatGateway } = await import('../lib/wechat/gateway.js')

  const make = {
    feishu: (iid) => new FeishuGateway(ctx, { appId: '', appSecret: '', instanceId: iid }),
    telegram: (iid) => new TelegramGateway(ctx, { botToken: '', instanceId: iid }),
    qq: (iid) => new QqGateway({ ctx, logger: silentLogger, config: {}, instanceId: iid }),
    wechat: (iid) => new WechatGateway({ ctx, logger: silentLogger, config: {}, instanceId: iid }),
  }
  for (const type of PLATFORM_TYPES) {
    const first = make[type](type)
    const second = make[type](`${type}:2`)
    assert.equal(first.instanceId, type)
    assert.equal(second.instanceId, `${type}:2`)
    assert.ok(ctx._services.has(type), `${type} 服务已注册`)
    assert.ok(ctx._services.has(`${type}:2`), `${type}:2 服务已注册（不覆盖首个）`)
    first.dispose?.()
    second.dispose?.()
  }
})

test('两个 FeishuService 实例：各自网关独立，事件按 instanceId 不串', async () => {
  const { FeishuService } = await import('../lib/feishu/index.js')
  const ctx = makeDuplicateAwareCtx()
  const a = new FeishuService({ ctx, logger: silentLogger, config: {}, instanceId: 'feishu', onPersist: async () => {} })
  const b = new FeishuService({ ctx, logger: silentLogger, config: {}, instanceId: 'feishu:2', onPersist: async () => {} })
  try {
    assert.equal(a.gateway.instanceId, 'feishu')
    assert.equal(b.gateway.instanceId, 'feishu:2')
    assert.equal(a.node.gateway, a.gateway, '节点必须拿自己的网关，而不是 ctx.feishu 槽位')
    assert.equal(b.node.gateway, b.gateway)
    assert.equal(a.node.instanceId, 'feishu')
    assert.equal(b.node.instanceId, 'feishu:2')

    const hits = []
    a.node._handleInbound = (event) => { hits.push(`a:${event.text}`) }
    b.node._handleInbound = (event) => { hits.push(`b:${event.text}`) }

    await ctx.emit('feishu/message', { instanceId: 'feishu', chatId: 'c', senderId: 'u', text: 'A 的消息' })
    assert.deepEqual(hits, ['a:A 的消息'], 'A 账号的事件不得进入 B 账号的桥')

    await ctx.emit('feishu/message', { instanceId: 'feishu:2', chatId: 'c', senderId: 'u', text: 'B 的消息' })
    assert.deepEqual(hits, ['a:A 的消息', 'b:B 的消息'])

    // 兼容：旧的无 instanceId 事件按单实例语义放行（现有单账号路径不回归）
    await ctx.emit('feishu/message', { chatId: 'c', senderId: 'u', text: '兼容' })
    assert.deepEqual(hits, ['a:A 的消息', 'b:B 的消息', 'a:兼容', 'b:兼容'])
  } finally {
    a.dispose()
    b.dispose()
  }
})

test('四个平台的节点都按 instanceId 过滤入站事件', async () => {
  const { FeishuConversationNode } = await import('../lib/feishu/node.js')
  const { TelegramConversationNode } = await import('../lib/telegram/node.js')
  const { QqConversationNode } = await import('../lib/qq/node.js')
  const { WechatConversationNode } = await import('../lib/wechat/node.js')

  const cases = [
    { type: 'feishu', Node: FeishuConversationNode, event: 'feishu/message', inbound: '_handleInbound' },
    { type: 'telegram', Node: TelegramConversationNode, event: 'telegram/message', inbound: '_handleInbound' },
    { type: 'qq', Node: QqConversationNode, event: 'qq/message', inbound: '_handleInbound' },
    { type: 'wechat', Node: WechatConversationNode, event: 'wechat/message', inbound: '_handleInbound' },
  ]
  for (const { type, Node, event, inbound } of cases) {
    const ctx = makeDuplicateAwareCtx()
    const gateway = { id: type, instanceId: `${type}:2`, status: 'idle', accountId: 'acc', stopPollingLocal: false, sendText() {}, sendTyping() {}, sendMediaFile() {} }
    const node = new Node(ctx, {}, silentLogger, { gateway, instanceId: `${type}:2` })
    try {
      assert.equal(node.instanceId, `${type}:2`)
      const hits = []
      node[inbound] = (payload) => { hits.push(payload) }
      await ctx.emit(event, { instanceId: type, text: '别人的' })
      assert.deepEqual(hits, [], `${type} 节点不得处理其它实例的事件`)
      await ctx.emit(event, { instanceId: `${type}:2`, text: '自己的' })
      assert.equal(hits.length, 1, `${type} 节点必须处理本实例事件`)
    } finally {
      node.dispose()
    }
  }
})

test('同步：单个账号构造失败不阻断其它账号（create 错误仅记报告）', async () => {
  const manager = new PlatformManager({ logger: silentLogger })
  const report = await reconcilePlatformInstances({
    platformManager: manager,
    sections: {
      feishu: {
        accounts: [{ instanceId: 'feishu', appId: 'a' }, { instanceId: 'feishu:2', appId: 'b' }],
        seq: 2,
      },
    },
    logger: silentLogger,
    createInstance: (type, account) => {
      if (account.instanceId === 'feishu') throw new Error('boom')
      return makeFakePlatform({ id: type, instanceId: account.instanceId }).platform
    },
  })
  assert.deepEqual(report.errors.map((row) => `${row.phase}:${row.instanceId}`), ['create:feishu'])
  assert.deepEqual(report.created, ['feishu:2'])
  assert.equal(manager.getExact('feishu'), undefined, '失败的账号没有注册实例')
  assert.equal(manager.get('feishu:2').instanceId, 'feishu:2')
  // 兼容回退：只传 platformId 时命中该类型第一个（仅剩的）实例
  assert.equal(manager.get('feishu').instanceId, 'feishu:2')
})

// ---------------------------------------------------------------------------
// 9. 事件生产者侧：payload 必须带 instanceId（D1/D7，突变 ⑩）
// ---------------------------------------------------------------------------

function captureEmits(ctx) {
  const emitted = []
  const orig = ctx.emit.bind(ctx)
  ctx.emit = (event, ...args) => { emitted.push({ event, payload: args[0] }); return orig(event, ...args) }
  const lastOf = (event) => [...emitted].reverse().find((row) => row.event === event)
  return { emitted, lastOf }
}

test('D1 生产者：feishu/action 与 message/status 均带 instanceId', async () => {
  const { FeishuGateway } = await import('../lib/feishu/gateway.js')
  const ctx = makeDuplicateAwareCtx()
  const { lastOf } = captureEmits(ctx)
  const gw = new FeishuGateway(ctx, { appId: '', appSecret: '', instanceId: 'feishu:2' })
  try {
    gw._handleCardAction({ action: { value: { action: 'approve' } }, operator: { openId: 'ou_1' }, messageId: 'm', chatId: 'c' })
    assert.equal(lastOf('feishu/action')?.payload?.instanceId, 'feishu:2')

    gw._emitInbound({ chatId: 'c', chatType: 'p2p', senderId: 'ou_1', messageId: 'm', content: 'hi' })
    assert.equal(lastOf('feishu/message')?.payload?.instanceId, 'feishu:2')

    gw.setStatus('online')
    assert.equal(lastOf('feishu/status')?.payload?.instanceId, 'feishu:2')
  } finally {
    gw.dispose?.()
  }
})

test('D1/⑩ 生产者：telegram/action 与 status 均带 instanceId', async () => {
  const { TelegramGateway } = await import('../lib/telegram/gateway.js')
  const ctx = makeDuplicateAwareCtx()
  const { lastOf } = captureEmits(ctx)
  const gw = new TelegramGateway(ctx, { botToken: '', instanceId: 'telegram:2' })
  try {
    gw._handleCallbackQuery({ id: 'q1', data: 'approve', from: { id: 7 }, message: { chat: { id: 9 }, message_id: 3 } })
    assert.equal(lastOf('telegram/action')?.payload?.instanceId, 'telegram:2')

    gw.setStatus('online')
    assert.equal(lastOf('telegram/status')?.payload?.instanceId, 'telegram:2')
  } finally {
    gw.dispose?.()
  }
})

test('D7 生产者：qq / wechat 事件 payload 统一带 instanceId', async () => {
  const { QqGateway } = await import('../lib/qq/gateway.js')
  const { WechatGateway } = await import('../lib/wechat/gateway.js')

  const qqCtx = makeDuplicateAwareCtx()
  const qqCapture = captureEmits(qqCtx)
  const qq = new QqGateway({ ctx: qqCtx, logger: silentLogger, config: {}, instanceId: 'qq:3' })
  const wxCtx = makeDuplicateAwareCtx()
  const wxCapture = captureEmits(wxCtx)
  const wx = new WechatGateway({ ctx: wxCtx, logger: silentLogger, config: {}, instanceId: 'wechat:2' })
  try {
    qq.setStatus('connected')
    const qqStatus = qqCapture.lastOf('qq/status')?.payload
    assert.equal(qqStatus?.instanceId, 'qq:3')
    assert.equal(qqStatus?.status, 'connected', 'status 形状统一为对象')

    wx.setStatus('connected')
    assert.deepEqual(wxCapture.lastOf('wechat/status')?.payload, { instanceId: 'wechat:2', status: 'connected' })
    wx._emitPlatformError('wechat/error', new Error('boom'))
    const errPayload = wxCapture.lastOf('wechat/error')?.payload
    assert.equal(errPayload?.instanceId, 'wechat:2')
    assert.match(errPayload?.error?.message ?? '', /boom/)
  } finally {
    // wechat gateway 构造函数带 5 分钟清理 interval，必须 dispose 否则 node --test 不退出
    qq.dispose?.()
    wx.dispose?.()
  }
})

// ---------------------------------------------------------------------------
// 10. D2：真实 cordis 下同 instanceId 重建（服务名不复用）+ 槽位清理
// ---------------------------------------------------------------------------

test('D2：真实 cordis 下 创建→移除→同 instanceId 再创建 不再服务重名，槽位已清理', async () => {
  const { Context } = await import('@deepseek-ai/cordis')
  const { createPlatformAccountOps } = await import('../lib/platform/account-ops.js')
  const { FeishuGateway } = await import('../lib/feishu/gateway.js')

  const root = new Context()
  const cleanup = [] // 用例结束必须 stop，否则 cordis 常驻会让 node --test 不退出
  const store = { feishu: { accounts: [{ instanceId: 'feishu', appId: '', appSecret: '' }], seq: 1 } }
  const manager = new PlatformManager({ logger: silentLogger })
  const names = []
  const ops = createPlatformAccountOps({
    logger: silentLogger,
    ctx: root,
    loadNormalizedConfig: async () => JSON.parse(JSON.stringify(store)),
    updateConfig: async (mutate) => { mutate(store); return store },
    platformManager: manager,
    createInstance: (type, account, index, { serviceName }) => {
      names.push(serviceName)
      // serviceName 复用会在此抛 `service "feishu" has been registered`
      const gateway = new FeishuGateway(root, { appId: '', appSecret: '', instanceId: account.instanceId, serviceName })
      cleanup.push(gateway)
      return {
        id: type,
        instanceId: account.instanceId,
        name: 'Feishu',
        gateway,
        async stop() {},
        dispose() { gateway.dispose?.() },
      }
    },
    restoreInstance: () => {},
    startInstance: () => false,
    statusOf: (service) => ({ instanceId: service.instanceId, status: 'idle' }),
  })

  try {
    await ops.syncAccounts({ start: false })
    assert.deepEqual(names, ['feishu'])
    assert.ok(root.feishu, '首个实例占用 ctx.feishu 槽位')

    await ops.removeAccount({ instanceId: 'feishu' })
    assert.equal(root.feishu, undefined, '移除后槽位不得再指向已 dispose 的网关')
    assert.equal(manager.getExact('feishu'), undefined)

    // 模拟 importBackup 重新导入同一 instanceId（cordis 服务名不会随 dispose 释放）
    store.feishu = { accounts: [{ instanceId: 'feishu', appId: '', appSecret: '' }], seq: 1 }
    const report = await ops.syncAccounts({ start: false })
    assert.deepEqual(report.errors, [], '同 instanceId 重建必须成功（唯一服务名）')
    assert.deepEqual(names, ['feishu', 'feishu#1'])
    assert.ok(manager.getExact('feishu'))

    await ops.removeAccount({ instanceId: 'feishu' })
  } finally {
    for (const gateway of cleanup) {
      try { gateway.dispose?.() } catch { /* 忽略 */ }
    }
    try { await root.stop?.() } catch { /* 忽略 */ }
  }
})
