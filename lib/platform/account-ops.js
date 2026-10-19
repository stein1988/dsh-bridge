// 平台账号运行时编排（issue #78 / verifier D2、D3、D4）
//
// 把「新增 / 移除 / 凭证查重 / 账号实例同步」的编排从 lib/index.js 抽成可注入依赖的
// factory：装配级单测可以用 fake 的 config 读写 / PlatformManager / 实例构造器覆盖
// 「查重命中不落库、移除确实删配置、并发同步不重复构造」等关键分支。
//
// 约定：
//   - 所有写操作（add / remove / sync）都在**同一个串行队列**里执行，避免
//     "config 已删、管理器又复活" 这类交错；
//   - 每次实例创建都分配**唯一 cordis 服务名**（首次 instanceId，重复创建 instanceId#1、
//     instanceId#2…）：cordis 的服务名不会随实例 dispose 释放，复用会抛
//     `service "x" has been registered`（verifier D2 实测）；
//   - create 失败不静默：reconcile 报告里的 errors 由调用方检查（importBackup 用
//     assertNoCreateErrors 抛可读错误，RPC 转成 bad-request）。

import {
  PLATFORM_TYPES,
  PLATFORM_TYPE_LABELS,
  normalizePlatformSection,
  nextAccount,
  removeAccount,
  findDuplicateCredential,
  displayNameFor,
  platformTypeOf,
  reconcilePlatformInstances,
} from './instances.js'

/**
 * 同步报告里若存在 `create` 阶段的失败，抛出可读错误（避免账号只写日志、面板看不到）。
 *
 * @param {{errors?: Array<{phase: string, instanceId: string, message: string}>}} report
 * @param {{action?: string}} [opts]
 */
export function assertNoCreateErrors(report, { action = '平台账号同步' } = {}) {
  const failures = (report?.errors ?? []).filter((row) => row?.phase === 'create')
  if (failures.length === 0) return
  const ids = failures.map((row) => row.instanceId).join('、')
  const first = failures[0]?.message ?? ''
  throw new Error(`${action}失败：${failures.length} 个账号未能创建（${ids}）${first ? `：${first}` : ''}`)
}

/**
 * @param {object} deps
 * @param {object} [deps.logger]
 * @param {object} [deps.ctx]                 cordis 上下文（维护 ctx.<platform> 兼容槽位）
 * @param {() => Promise<object>} deps.loadNormalizedConfig  读取并规范化后的 config
 * @param {(mutate: Function) => Promise<object>} deps.updateConfig  读-改-写事务
 * @param {import('./manager.js').PlatformManager} deps.platformManager
 * @param {(type: string, account: object, index: number, opts: {serviceName: string}) => object} deps.createInstance
 * @param {(service: object, type: string, account: object, created: boolean) => any} [deps.restoreInstance]
 * @param {(service: object, type: string, account: object) => any} [deps.startInstance]
 * @param {(service: object) => object} [deps.statusOf]
 * @param {(type: string, firstInstance: object|undefined) => void} [deps.onInstancesChanged]
 */
export function createPlatformAccountOps({
  logger,
  ctx,
  loadNormalizedConfig,
  updateConfig,
  platformManager,
  createInstance,
  restoreInstance,
  startInstance,
  statusOf,
  onInstancesChanged,
} = {}) {
  if (typeof loadNormalizedConfig !== 'function' || typeof updateConfig !== 'function'
    || !platformManager || typeof createInstance !== 'function') {
    throw new Error('createPlatformAccountOps: 缺少必需依赖（loadNormalizedConfig/updateConfig/platformManager/createInstance）')
  }

  let queue = Promise.resolve()
  // instanceId -> 已分配过的 cordis 服务名次数（服务名不复用：cordis 不释放已注册名）
  const serviceNames = new Map()
  // type -> 当前占用 ctx.<platform> 槽位的 instanceId（本模块自己记账，避免误清别人的槽位）
  const slotOwners = new Map()

  /** 为一次实例创建分配唯一 cordis 服务名。 */
  function allocateServiceName(instanceId) {
    const used = serviceNames.get(instanceId) ?? 0
    serviceNames.set(instanceId, used + 1)
    return used === 0 ? instanceId : `${instanceId}#${used}`
  }

  /** 串行执行器：所有写操作共用，返回本次 task 的结果（可 reject 给调用方）。 */
  function runExclusive(task) {
    const run = queue.then(task)
    queue = run.then(() => undefined, (err) => {
      logger?.error?.('dsh-bridge: 平台账号操作失败：%s', err?.stack ?? err)
    })
    return run
  }

  /** 占用 ctx.<platform> 兼容槽位（失败不致命：只影响旧读取方）。 */
  function assignSlot(type, service) {
    const target = service?.gateway ?? service
    try { ctx[type] = target } catch { /* 只读/框架托管时忽略 */ }
    slotOwners.set(type, service?.instanceId ?? type)
  }

  /** 清空 ctx.<platform> 槽位（实例被移除后不得再指向已 dispose 的网关）。 */
  function clearSlot(type) {
    try { delete ctx[type] } catch { /* 忽略 */ }
    try { if (ctx?.[type]) ctx[type] = undefined } catch { /* 忽略 */ }
    slotOwners.delete(type)
  }

  /** 同步某个类型的槽位/首实例回调（仅在占位实例变化时写，减少对框架托管的干扰）。 */
  function refreshType(type) {
    const first = platformManager.listByType(type)[0]
    const firstId = first?.instanceId ?? first?.id
    if (!first) {
      if (slotOwners.has(type)) clearSlot(type)
    } else if (slotOwners.get(type) !== firstId) {
      assignSlot(type, first)
    }
    onInstancesChanged?.(type, first)
  }

  /** 按 config 规范化结果创建/恢复/清理实例（同步核心，调用方负责串行化）。 */
  async function reconcile({ start = true } = {}) {
    const stored = await loadNormalizedConfig()
    const sections = {}
    for (const type of PLATFORM_TYPES) {
      sections[type] = normalizePlatformSection(type, stored?.[type]).section
    }
    const report = await reconcilePlatformInstances({
      platformManager,
      sections,
      logger,
      start,
      createInstance: (type, account, index) => createInstance(type, account, index, {
        serviceName: allocateServiceName(account.instanceId),
      }),
      restoreInstance,
      startInstance,
    })
    for (const type of PLATFORM_TYPES) refreshType(type)
    return report
  }

  /** 公开的账号同步入口（串行化）。 */
  function syncAccounts(options = {}) {
    return runExclusive(() => reconcile(options))
  }

  /** 运行期新增账号（RPC platformAddAccount）：类型/上限校验 → 追加 → 同步并启动。 */
  function addAccount({ platformId, name } = {}) {
    const type = typeof platformId === 'string' ? platformId : ''
    if (!PLATFORM_TYPES.includes(type)) {
      return Promise.reject(new Error(`不支持的平台类型: ${type || '(空)'}`))
    }
    return runExclusive(async () => {
      let created = null
      await updateConfig((stored) => {
        const { section } = normalizePlatformSection(type, stored[type])
        // 上限校验在 nextAccount 内（D3），超限时 mutate 抛错 → 不落库
        const result = nextAccount({ section, type, name })
        stored[type] = result.section
        created = result.account
        return stored
      })
      await reconcile({ start: true })
      const service = platformManager.getExact(created.instanceId)
      return {
        instanceId: created.instanceId,
        status: service && typeof statusOf === 'function' ? statusOf(service) : null,
      }
    })
  }

  /** 运行期移除账号（RPC platformRemoveAccount）：允许移除最后一个账号（回到 0 账号）。 */
  function removeAccountById({ instanceId } = {}) {
    if (!instanceId || typeof instanceId !== 'string') {
      return Promise.reject(new Error('缺少 instanceId 参数'))
    }
    const type = platformTypeOf(instanceId)
    if (!PLATFORM_TYPES.includes(type)) {
      return Promise.reject(new Error(`账号不存在: ${instanceId}`))
    }
    return runExclusive(async () => {
      const stored = await loadNormalizedConfig()
      const { section } = normalizePlatformSection(type, stored?.[type])
      if (!section.accounts.some((account) => account.instanceId === instanceId)) {
        throw new Error(`账号不存在: ${instanceId}`)
      }

      const platform = platformManager.getExact(instanceId)
      if (platform) {
        try {
          await platform.stop?.()
        } catch (err) {
          logger?.warn?.('dsh-bridge: 停用平台实例 %s 失败（继续移除）：%s', instanceId, err?.message ?? err)
        }
        try {
          platform.dispose?.()
        } catch (err) {
          logger?.warn?.('dsh-bridge: 释放平台实例 %s 失败（继续移除）：%s', instanceId, err?.message ?? err)
        }
        platformManager.unregister(instanceId)
      }

      await updateConfig((current) => {
        const { section: currentSection } = normalizePlatformSection(type, current?.[type])
        current[type] = removeAccount(currentSection, instanceId)
        return current
      })

      // 槽位顺位/清空：被移除的是当前占位实例时不得留下已 dispose 的网关
      refreshType(type)
      return { ok: true, instanceId }
    })
  }

  /** 同类型内凭证唯一性校验（platformSetConfig 保存前）。 */
  async function validateAccountConfig(platform, patch) {
    const instanceId = platform?.instanceId ?? platform?.id
    const type = platform?.id ?? platformTypeOf(instanceId)
    if (!PLATFORM_TYPES.includes(type)) return
    const stored = await loadNormalizedConfig()
    const { section } = normalizePlatformSection(type, stored?.[type])
    const candidate = { ...(platform?.config ?? {}), ...(patch ?? {}) }
    const duplicate = findDuplicateCredential({
      type,
      accounts: section.accounts,
      candidate,
      excludeInstanceId: instanceId,
    })
    if (!duplicate) return
    const index = section.accounts.findIndex((account) => account.instanceId === duplicate.instanceId)
    const displayName = displayNameFor({
      type,
      label: PLATFORM_TYPE_LABELS[type] ?? platform?.name,
      account: duplicate,
      index: index + 1,
    })
    throw new Error(`同一应用不能重复添加：该凭证已被「${displayName}」使用`)
  }

  return {
    syncAccounts,
    addAccount,
    removeAccount: removeAccountById,
    validateAccountConfig,
    allocateServiceName,
    runExclusive,
  }
}
