// dsh-bridge 平台管理器
//
// 注册/协调多个 IM 平台适配器（Platform 子类），向主插件与 RPC 层提供：
//   - 统一的多平台状态聚合（getStatus）
//   - 平台实例查找（get / resolve，兼容旧客户端只传 platformId）
//   - 按类型枚举（listByType）与注销（unregister）
//   - 统一生命周期（dispose）
//
// issue #78 起 Map 的键为 instanceId（`platform.instanceId ?? platform.id`）：
// 同一平台类型可注册多个账号实例；旧调用只传 platformId 时回退到该类型第一个实例。
//
// 主插件注入已构造的平台实例列表，本类只负责登记与聚合，不负责构造平台。

export class PlatformManager {
  /**
   * @param {object} opts
   * @param {object} opts.logger       日志器
   */
  constructor({ logger } = {}) {
    this.logger = logger
    this.platforms = new Map() // instanceId -> Platform
  }

  /** 实例键：优先显式 instanceId，未设置时回退 platform.id（保持旧单实例语义）。 */
  instanceIdOf(platform) {
    return platform?.instanceId ?? platform?.id
  }

  /** 注册一个平台实例。重复注册同 instanceId 时替换旧实例并 dispose 旧的。 */
  register(platform) {
    if (!platform || !platform.id) {
      this.logger?.warn?.('[dsh-bridge] PlatformManager.register: 平台缺少 id，已忽略')
      return platform
    }
    const instanceId = this.instanceIdOf(platform)
    const existing = this.platforms.get(instanceId)
    if (existing && existing !== platform) {
      try {
        const result = existing.dispose()
        if (result instanceof Promise) {
          // 异步 dispose，记录警告（当前架构假定同步清理）
          this.logger?.warn?.(`[dsh-bridge] Platform ${instanceId} dispose is async but not awaited (may leave dangling resources)`)
        }
      } catch { /* 忽略 */ }
    }
    this.platforms.set(instanceId, platform)
    this.logger?.info?.(`[dsh-bridge] platform registered: ${instanceId} (${platform.name ?? ''})`)
    return platform
  }

  /**
   * 获取平台实例：先按 instanceId 精确命中；未命中时兼容回退到该类型第一个实例
   * （`platform.id === platformId`）——旧客户端只传 platformId 时行为不变。
   * 不存在返回 undefined。
   */
  get(platformId) {
    if (platformId == null) return undefined
    const exact = this.platforms.get(platformId)
    if (exact) return exact
    for (const platform of this.platforms.values()) {
      if (platform?.id === platformId) return platform
    }
    return undefined
  }

  /** get 的语义别名（契约 §7：RPC 统一用 resolve）。 */
  resolve(platformIdOrInstanceId) {
    return this.get(platformIdOrInstanceId)
  }

  /** 所有已注册平台实例（数组，非 id 列表；保持既有返回结构不变）。 */
  list() {
    return [...this.platforms.values()]
  }

  /** 某平台类型下的全部账号实例（按注册顺序）。 */
  listByType(type) {
    return this.list().filter((platform) => platform?.id === type)
  }

  /** 按 instanceId 精确查找（不做类型回退；同步编排用）。 */
  getExact(instanceId) {
    return this.platforms.get(instanceId)
  }

  /** 只从 Map 移除实例（不负责 stop/dispose），返回是否移除成功。 */
  unregister(instanceId) {
    return this.platforms.delete(instanceId)
  }

  /** 聚合所有平台状态：{ [instanceId]: status }，status 额外带实例元信息。 */
  getStatus() {
    const out = {}
    for (const platform of this.platforms.values()) {
      const instanceId = this.instanceIdOf(platform)
      const platformId = platform?.id ?? instanceId
      try {
        const status = platform.getStatus()
        out[instanceId] = {
          ...status,
          instanceId,
          platformId,
          displayName: platform.displayName ?? status?.displayName ?? platform.name ?? platformId,
        }
      } catch (err) {
        // 防御性读取 platform.name（getter 可能抛异常）
        let name = instanceId
        try { name = platform.name ?? instanceId } catch { /* 忽略 */ }
        out[instanceId] = {
          id: platformId,
          name,
          status: 'error',
          error: err?.message ?? String(err),
          instanceId,
          platformId,
          displayName: platform.displayName ?? name,
        }
      }
    }
    return out
  }

  /** 释放所有平台。 */
  dispose() {
    for (const platform of this.platforms.values()) {
      try { platform.dispose() } catch { /* 忽略 */ }
    }
    this.platforms.clear()
  }
}
