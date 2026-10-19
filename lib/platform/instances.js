// 平台多账号（同平台多实例）纯函数模块 — issue #78
//
// config.json 的平台段从"单对象"升级为 `{ accounts: [...], seq }`：
//   - accounts 数组顺序 = 面板展示顺序；
//   - seq 为每个类型独立的单调递增计数器，新增账号取 `${type}:${seq}`，
//     已删除的序号永不复用（避免会话/白名单串号）；
//   - 旧格式（`config[type] = { appId, ... }`）读路径仍兼容，由本模块无损迁移。
//
// 本模块只做纯数据变换：不读文件、不依赖 ctx / logger，便于直接单测。
// 所有函数都不原地修改入参（返回新对象/新数组）。

/** 支持多账号的平台类型（与现有 platform.id 一致）。 */
export const PLATFORM_TYPES = ['wechat', 'qq', 'feishu', 'telegram']

/** 单个平台类型的账号数量上限（契约 §5，Lead 裁定 4）。 */
export const MAX_ACCOUNTS_PER_TYPE = 10

/** 平台中文名兜底（正常情况下由 lib/index.js 传入服务类的 this.name）。 */
export const PLATFORM_TYPE_LABELS = {
  wechat: '微信',
  qq: 'QQ',
  feishu: '飞书',
  telegram: 'Telegram',
}

/**
 * 各类型用于「同类型内唯一」校验的凭证字段（契约 §5）。
 * 单字段按值比较；wechat 为组合键（token + accountId 必须同时非空才参与查重）。
 */
const CREDENTIAL_FIELDS = {
  wechat: ['token', 'accountId'],
  qq: ['appId'],
  feishu: ['appId'],
  telegram: ['botToken'],
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function nonEmptyString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeSeq(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

/**
 * 从 instanceId 取平台类型：`feishu` / `feishu:2` → `feishu`。
 * 非法/空值返回空串（调用方据此拒绝）。
 */
export function platformTypeOf(instanceId) {
  if (typeof instanceId !== 'string') return ''
  const idx = instanceId.indexOf(':')
  return idx === -1 ? instanceId : instanceId.slice(0, idx)
}

/** instanceId 是否形如 `type` 或 `type:N`（N ≥ 1 的十进制整数）。 */
function isValidInstanceId(type, instanceId) {
  if (typeof instanceId !== 'string') return false
  if (instanceId === type) return true
  const prefix = `${type}:`
  if (!instanceId.startsWith(prefix)) return false
  const suffix = instanceId.slice(prefix.length)
  return /^[1-9]\d*$/.test(suffix)
}

/** instanceId 携带的序号（裸 `type` 视为 1，非法返回 0）。 */
function instanceSeqOf(type, instanceId) {
  if (instanceId === type) return 1
  const prefix = `${type}:`
  if (typeof instanceId !== 'string' || !instanceId.startsWith(prefix)) return 0
  const n = Number(instanceId.slice(prefix.length))
  return Number.isSafeInteger(n) && n > 0 ? n : 0
}

/** 旧格式判定：除 accounts/seq 之外还有字段（说明是"原来的单对象"）。 */
function legacyFieldsOf(raw) {
  const fields = {}
  for (const key of Object.keys(raw)) {
    if (key === 'accounts' || key === 'seq') continue
    fields[key] = raw[key]
  }
  return fields
}

/**
 * 规范化某个平台的配置段。
 *
 * 迁移规则（契约 §2）：
 *   - 无 `accounts` 数组（或为空）且存在旧字段 → 整体搬进首个账号（instanceId = type，seq = 1），
 *     旧对象所有键原样保留（含未知字段）；
 *   - `accounts` 已存在但账号缺 instanceId / instanceId 非法 / 重复 → 按数组顺序补
 *     `type`、`type:N`，并提升 seq，其它字段保留；
 *   - `config[type]` 完全缺失 → 返回空段（不凭空合成账号，维持缺失语义）；
 *   - `accounts: []` 原样保留（0 账号是合法状态）。
 *
 * 幂等：对已规范化输出再次调用，`changed === false`。
 *
 * @param {string} type 平台类型
 * @param {unknown} raw config[type] 原始值
 * @returns {{ section: { accounts: object[], seq: number }, changed: boolean }}
 */
export function normalizePlatformSection(type, raw) {
  if (raw == null || !isPlainObject(raw)) {
    // 缺失（不合成账号）或垃圾值（归一为空段，需写回）
    return { section: { accounts: [], seq: 0 }, changed: raw != null }
  }

  const rawAccounts = Array.isArray(raw.accounts) ? raw.accounts : null
  const legacyFields = legacyFieldsOf(raw)
  const hasLegacyFields = Object.keys(legacyFields).length > 0

  if (rawAccounts == null) {
    // 无 accounts 数组：只有存在旧明细键才算"旧单对象"，否则视为空段
    if (!hasLegacyFields) {
      // 形如 {} / { seq: n } 的空段：保持空账号，仅归一 seq
      const seq = normalizeSeq(raw.seq)
      return { section: { accounts: [], seq }, changed: false }
    }
    // D5：legacyFields 若自带 instanceId（脏数据）不得覆盖迁移结果的类型 id；
    // D6：不得把 seq 回退——旧段若已有更大 seq 则保留，避免序号复用
    const detailFields = { ...legacyFields }
    delete detailFields.instanceId
    const account = { instanceId: type, ...detailFields }
    const seq = Math.max(1, normalizeSeq(raw.seq))
    return { section: { accounts: [account], seq }, changed: true }
  }

  if (rawAccounts.length === 0) {
    // D6：accounts 数组存在（哪怕为空）就是新格式，绝不复活成幽灵账号，也不重置 seq
    return { section: { ...raw, accounts: [], seq: normalizeSeq(raw.seq) }, changed: false }
  }

  // 已有账号：先保留合法且不重复的 instanceId，统计已用序号
  const used = new Set()
  const normalizedAccounts = []
  for (const entry of rawAccounts) {
    const source = isPlainObject(entry) ? entry : {}
    const candidate = source.instanceId
    if (isValidInstanceId(type, candidate) && !used.has(candidate)) {
      used.add(candidate)
      normalizedAccounts.push({ ...source })
    } else {
      normalizedAccounts.push({ ...source, instanceId: null }) // 占位，第二轮分配
    }
  }

  let maxUsedSeq = 0
  for (const instanceId of used) maxUsedSeq = Math.max(maxUsedSeq, instanceSeqOf(type, instanceId))
  let seq = Math.max(normalizeSeq(raw.seq), maxUsedSeq, 1)

  // 第二遍：按数组顺序给缺失/非法/重复的账号分配新 instanceId
  for (let i = 0; i < normalizedAccounts.length; i += 1) {
    const account = normalizedAccounts[i]
    if (account.instanceId) continue
    let nextId
    if (!used.has(type)) {
      nextId = type
    } else {
      do {
        seq += 1
        nextId = `${type}:${seq}`
      } while (used.has(nextId))
    }
    used.add(nextId)
    account.instanceId = nextId
    maxUsedSeq = Math.max(maxUsedSeq, instanceSeqOf(type, nextId))
  }

  seq = Math.max(seq, maxUsedSeq)

  // 保证 instanceId 是账号对象的第一个键（与写入侧格式一致，稳定 changed 判定）
  const accounts = normalizedAccounts.map((account) => {
    const { instanceId, ...rest } = account
    return { instanceId, ...rest }
  })
  const section = { ...raw, accounts, seq }
  return { section, changed: JSON.stringify(section) !== JSON.stringify(raw) }
}

/**
 * 对 config 中四个平台段统一规范化（返回新对象，不原地改入参）。
 * 未发生变化的类型保持原引用。
 *
 * @param {object} config 完整 config.json 对象
 * @returns {{ config: object, changed: boolean }}
 */
export function normalizePlatformConfig(config) {
  const source = isPlainObject(config) ? config : {}
  const out = { ...source }
  let changed = false
  for (const type of PLATFORM_TYPES) {
    const result = normalizePlatformSection(type, source[type])
    if (result.changed) {
      out[type] = result.section
      changed = true
    }
  }
  return { config: out, changed }
}

/**
 * 按 instanceId 合并 patch（read-modify-write：只动目标账号，其它账号原样保留）。
 * 目标不存在时抛错（调用方应视为内部错误/参数错误）。
 *
 * @param {object} section 平台配置段（新旧格式均可，内部先规范化）
 * @param {string} instanceId 目标账号
 * @param {object} patch 要合并的字段
 * @returns {{ accounts: object[], seq: number }} 新配置段
 */
export function patchAccount(section, instanceId, patch) {
  const type = platformTypeOf(instanceId)
  if (!PLATFORM_TYPES.includes(type)) throw new Error(`非法的 instanceId: ${instanceId}`)
  const { section: normalized } = normalizePlatformSection(type, section)
  const idx = normalized.accounts.findIndex((account) => account.instanceId === instanceId)
  if (idx === -1) throw new Error(`账号不存在: ${instanceId}`)
  const merged = {
    ...normalized.accounts[idx],
    ...(isPlainObject(patch) ? patch : {}),
    instanceId, // instanceId 是主键，不允许被 patch 改写
  }
  const accounts = [...normalized.accounts]
  accounts[idx] = merged
  return { ...normalized, accounts }
}

/**
 * 生成一个新账号并追加到末尾（契约：追加末尾，不改现有顺序；seq 只增不复用）。
 *
 * instanceId = `${type}:${seq + 1}`（seq 为该类型当前计数器；已删除的序号不回收）。
 * 迁移来的首个账号使用裸 `type`（见 normalizePlatformSection），新增账号一律带 `:N`。
 *
 * @param {{ section?: object, type: string, name?: string }} opts
 * @returns {{ section: { accounts: object[], seq: number }, account: object }}
 */
export function nextAccount({ section, type, name } = {}) {
  if (!PLATFORM_TYPES.includes(type)) throw new Error(`不支持的平台类型: ${type}`)
  const { section: normalized } = normalizePlatformSection(type, section)
  // D3：上限校验下沉到纯函数，任何新增账号路径都必须经过这里
  if (normalized.accounts.length >= MAX_ACCOUNTS_PER_TYPE) {
    throw new Error(`单个平台最多添加 ${MAX_ACCOUNTS_PER_TYPE} 个账号`)
  }
  const usedSeq = Math.max(
    normalizeSeq(normalized.seq),
    ...normalized.accounts.map((account) => instanceSeqOf(type, account.instanceId)),
    0,
  )
  const nextSeq = usedSeq + 1
  const instanceId = `${type}:${nextSeq}`
  const account = { instanceId }
  const trimmedName = nonEmptyString(name)
  if (trimmedName) account.name = trimmedName
  return {
    section: { ...normalized, accounts: [...normalized.accounts, account], seq: nextSeq },
    account,
  }
}

/**
 * 从配置段移除指定账号（保留其它账号与 seq；序号不回收）。
 * 账号不存在时返回内容等价的新段（调用方先做存在性校验）。
 */
export function removeAccount(section, instanceId) {
  const type = platformTypeOf(instanceId)
  if (!PLATFORM_TYPES.includes(type)) throw new Error(`非法的 instanceId: ${instanceId}`)
  const { section: normalized } = normalizePlatformSection(type, section)
  return {
    ...normalized,
    accounts: normalized.accounts.filter((account) => account.instanceId !== instanceId),
  }
}

/**
 * 查找与 candidate 凭证重复的"同类型其它账号"。
 * 空凭证不参与查重；找不到返回 null。
 *
 * @param {{ type: string, accounts: object[], candidate: object, excludeInstanceId?: string }} opts
 * @returns {object|null} 冲突账号
 */
export function findDuplicateCredential({ type, accounts, candidate, excludeInstanceId } = {}) {
  const fields = CREDENTIAL_FIELDS[type]
  if (!fields || !Array.isArray(accounts) || !isPlainObject(candidate)) return null
  const wanted = fields.map((field) => nonEmptyString(candidate[field]))
  if (wanted.some((value) => !value)) return null // 凭证未填完整：不参与查重
  const hit = accounts.find((account) => {
    if (!isPlainObject(account)) return false
    if (account.instanceId === excludeInstanceId) return false
    return fields.every((field, index) => nonEmptyString(account[field]) === wanted[index])
  })
  return hit ?? null
}

/**
 * 账号展示名：优先用户填的备注名 `account.name`（trim 后非空，也兼容显式 label），
 * 否则 `${平台中文名} ${该类型内 1 基序号}`（序号 = 数组下标，契约裁定 3）。
 *
 * @param {{ type: string, label?: string, account?: object, index?: number }} opts
 *   label 为平台中文名（lib/index.js 传服务类的 this.name），account.name 为用户备注名。
 * @returns {string}
 */
export function displayNameFor({ type, label, account, index } = {}) {
  const userName = nonEmptyString(account?.name) || nonEmptyString(label?.accountName)
  if (userName) return userName
  const platformLabel = nonEmptyString(label) || PLATFORM_TYPE_LABELS[type] || type || ''
  const order = Number.isFinite(index) && index > 0 ? Math.floor(index) : 1
  return `${platformLabel} ${order}`
}

/**
 * 平台账号实例同步编排（依赖注入，便于用 fake service 单测）。
 *
 * 语义（契约 §5）：
 *   - desired 中不存在的已注册实例：stop（失败只记日志）→ dispose（失败只记日志）→ unregister；
 *   - desired 中缺失的实例：createInstance → register；
 *   - desired 中已存在的实例：同样回调 restoreInstance 回写配置；
 *   - start=true 时只对"本次新建且 startInstance 判定有完整凭证"的实例启动。
 *
 * 返回报告便于测试与日志：{ created, removed, restored, started, errors }。
 *
 * @param {object} opts
 * @param {import('./manager.js').PlatformManager} opts.platformManager
 * @param {Record<string, {accounts: object[], seq: number}>} opts.sections 各类型目标配置段
 * @param {(type: string, account: object, index: number) => (object|Promise<object>)} opts.createInstance
 * @param {(service: object, type: string, account: object, created: boolean) => any} [opts.restoreInstance]
 * @param {(service: object, type: string, account: object) => any} [opts.startInstance]
 * @param {boolean} [opts.start=true]
 * @param {object} [opts.logger]
 */
export async function reconcilePlatformInstances({
  platformManager,
  sections,
  createInstance,
  restoreInstance,
  startInstance,
  start = true,
  logger,
} = {}) {
  if (!platformManager || typeof platformManager.listByType !== 'function' || typeof createInstance !== 'function') {
    throw new Error('reconcilePlatformInstances: 缺少 platformManager / createInstance')
  }
  const report = { created: [], removed: [], restored: [], started: [], errors: [] }
  const recordError = (phase, instanceId, err) => {
    const message = err?.message ?? String(err)
    report.errors.push({ phase, instanceId, message })
    logger?.warn?.('dsh-bridge: 平台账号同步 %s 失败（%s）：%s', phase, instanceId, message)
  }
  const exactOf = (instanceId) => (typeof platformManager.getExact === 'function'
    ? platformManager.getExact(instanceId)
    : platformManager.get(instanceId))
  const instanceIdOfPlatform = (platform) => platform?.instanceId ?? platform?.id

  for (const type of PLATFORM_TYPES) {
    const section = sections?.[type] ?? { accounts: [], seq: 0 }
    const desired = Array.isArray(section.accounts) ? section.accounts : []
    const desiredIds = new Set(desired.map((account) => account?.instanceId).filter(Boolean))

    // 1) 移除配置里已不存在的实例
    for (const platform of platformManager.listByType(type)) {
      const instanceId = instanceIdOfPlatform(platform)
      if (!instanceId || desiredIds.has(instanceId)) continue
      try {
        await platform.stop?.()
      } catch (err) {
        recordError('stop', instanceId, err)
      }
      try {
        platform.dispose?.()
      } catch (err) {
        recordError('dispose', instanceId, err)
      }
      platformManager.unregister(instanceId)
      report.removed.push(instanceId)
    }

    // 2) 创建缺失实例 / 回写已存在实例
    for (let index = 0; index < desired.length; index += 1) {
      const account = desired[index]
      const instanceId = account?.instanceId
      if (!instanceId) continue
      let service = exactOf(instanceId)
      let created = false
      if (!service) {
        try {
          service = await createInstance(type, account, index + 1)
          platformManager.register(service)
          created = true
          report.created.push(instanceId)
        } catch (err) {
          // 单个账号构造失败不阻断其它账号（例如宿主服务异常）
          recordError('create', instanceId, err)
          continue
        }
      }
      if (typeof restoreInstance === 'function') {
        try {
          await restoreInstance(service, type, account, created)
          report.restored.push(instanceId)
        } catch (err) {
          recordError('restore', instanceId, err)
        }
      }
      if (start && created && typeof startInstance === 'function') {
        try {
          const started = await startInstance(service, type, account)
          if (started !== false) report.started.push(instanceId)
        } catch (err) {
          recordError('start', instanceId, err)
        }
      }
    }
  }
  return report
}
