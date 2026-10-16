// DSH 私有存储读取（workspace.json / session_projcache.json 兜底）
// 自 conversation-bridge.js 拆出。策略：内存服务（workspaceRegistry）优先，
// 仅当内存服务缺失时才落盘读 DSH 存储；文件不存在时安全返回空值。
// 注意：不再以 ctx._mock 作为跳过依据——测试通过提供内存服务或注入 DSH_HOME 保持隔离。
import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'

export function getArchivedSessionIds(ctx) {
  const archived = new Set()
  // 1. 尝试从 ctx.workspaceRegistry 内存服务读取
  try {
    const list = ctx?.workspaceRegistry?.archivedSessionIds
    if (Array.isArray(list)) {
      for (const id of list) {
        if (id) archived.add(String(id))
      }
      return archived
    }
  } catch { /* ignore */ }

  // 2. 尝试从 DSH workspace 存储文件（$DSH_HOME/storages/workspace.json）读取兜底
  {
    try {
      const home = process.env.DSH_HOME || join(homedir(), '.dsh')
      const wsFile = join(home, 'storages', 'workspace.json')
      if (existsSync(wsFile)) {
        const data = JSON.parse(readFileSync(wsFile, 'utf8'))
        const fileArchived = data?.global?.archivedSessionIds
        if (Array.isArray(fileArchived)) {
          for (const id of fileArchived) {
            if (id) archived.add(String(id))
          }
        }
      }
    } catch { /* ignore */ }
  }

  return archived
}

/**
 * 安全探测 ctx 上的非 inject 属性。
 * 宿主 cordis 上下文对插件未在 inject 中声明的属性读取会直接抛错
 * （'cannot get property "x" without inject'），因此内存注入点（测试夹具用）
 * 必须经 try/catch 探测，绝不能让异常外溢到命令路径。
 *
 * 这不仅是"防御性写法"，而是**崩溃边界**：探测点若位于宿主的 session 事件回调里
 * （会话桥 onEvent），未捕获的 cordis 异常会冒泡成 `dsh: fatal load failure`，
 * 让整个宿主进程退出（实测 2026-10-16 03:02 因 workspaceChanges 未探测而崩溃重启）。
 */
export function peekCtxProperty(ctx, key) {
  if (!ctx) return undefined
  try { return ctx[key] } catch { return undefined }
}

// 读取单个 per-record 投影缓存文件，返回其 record（消费方期望的形状）。
// 文件形状：{ version, record: { identity, rows } }
function readProjRecordFile(file) {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    const record = data?.record
    if (record && typeof record === 'object') return record
  } catch { /* 损坏/半写文件：视为无缓存（宿主自身也把该格式视为可丢弃的派生数据） */ }
  return undefined
}

/**
 * 读取 DSH 官方持久化会话缓存元数据（标题、是否空白、创建时间等）。
 *
 * DSH 0.1.7 起 `session_projcache` 领域改为 **per-record 布局**：
 *   `<DSH_HOME>/storages/session_projcache/sessions/<sessionId>.json`（每条会话一个文件，
 *   顶层 `{ version, record: { identity, rows } }`）。
 * 0.1.6 及更早则是单文件 `<DSH_HOME>/storages/session_projcache.json`
 * （`{ tables: { sessions: { <id>: { identity, rows } } } }`）。
 * 见 @deepseek-ai/dsh-session-projection-cache 的 projectionCacheDomainSpec
 * （`layout: 'per-record'`）。
 *
 * 两种布局都必须支持：只读旧路径会让升级到 0.1.7 的用户标题全部退化为「新会话」，
 * 只读新路径则会让未升级用户回归。故此处返回一个**按 id 惰性读取**的代理对象：
 *   - 消费方（session-catalog）只按 sessionId 取值，从不遍历 keys，
 *     因此无需为一次 /sessions 同步读取数百个文件（本机实测 470 个）；
 *   - 形状与旧布局一致（直接给出 `{ identity, rows }`），消费方无需感知差异。
 */
export function getSessionProjCache(ctx) {
  const injected = peekCtxProperty(ctx, 'sessionProjCache')
  if (injected) return injected

  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const legacyFile = join(home, 'storages', 'session_projcache.json')
  const recordDirs = resolveProjCacheDirs(home)

  // 旧布局（0.1.6-）：整份读入，形状已与消费方一致
  const legacy = (() => {
    try {
      if (!existsSync(legacyFile)) return null
      const data = JSON.parse(readFileSync(legacyFile, 'utf8'))
      const sessions = data?.tables?.sessions
      return sessions && typeof sessions === 'object' ? sessions : null
    } catch { return null }
  })()

  // 新布局（0.1.7+）：按 id 惰性读单文件；legacy 命中时优先用 legacy
  const cache = new Map()
  const lookup = (id) => {
    if (cache.has(id)) return cache.get(id)
    let record
    for (const dir of recordDirs) {
      for (const name of projRecordFileNames(id)) {
        try {
          const file = join(dir, name)
          if (existsSync(file)) { record = readProjRecordFile(file) }
        } catch { /* 读取失败视为无缓存 */ }
        if (record) break
      }
      if (record) break
    }
    cache.set(id, record)
    return record
  }
  return new Proxy(legacy ?? {}, {
    get(target, prop) {
      if (typeof prop !== 'string') return Reflect.get(target, prop)
      if (Object.prototype.hasOwnProperty.call(target, prop)) return target[prop]
      return lookup(prop)
    },
    has(target, prop) {
      if (typeof prop === 'string' && Object.prototype.hasOwnProperty.call(target, prop)) return true
      if (typeof prop !== 'string') return Reflect.has(target, prop)
      return !!lookup(prop)
    },
  })
}

/**
 * 投影缓存文件的候选文件名。
 *
 * 命中两种命名世代（都源自宿主的 per-record 布局）：
 *   - 官方 `session_projcache`：文件名为**裸 sessionId**（`<id>.json`）；
 *   - 第三方接管的域（本机实测 @michengai/dsh-archive-manager 的
 *     `session_projcache_archive_manager_v2`）：文件名是
 *     `session_<base64url(sha256(sessionId))>`（见其 projcache.js 的
 *     projectionCacheStorageKey，为规避文件名非法字符与长度限制）。
 * 只认其中一种就会在另一世代上读空 → /sessions 标题全部退化成「新会话」。
 */
function projRecordFileNames(id) {
  const names = [`${id}.json`]
  try {
    const hash = createHash('sha256').update(String(id), 'utf8').digest('base64url')
    names.push(`session_${hash}.json`)
  } catch { /* 哈希不可用时只试裸 id */ }
  return names
}

/**
 * 定位投影缓存的 per-record 目录（可多个，按优先级）。
 *
 * `session_projcache` 不是稳定路径：第三方插件可把该存储域整体改名（本机实测
 * dsh-archive-manager → `session_projcache_archive_manager_v2`，更早还有
 * `session_projcache_archive_manager`）。故全部列出、逐个尝试，官方默认路径放最后
 * 兜底；实际命中的那个由「该目录里是否有该会话的文件」决定，而不是靠猜。
 */
function resolveProjCacheDirs(home) {
  const base = join(home, 'storages')
  return [
    join(base, 'session_projcache_archive_manager_v2', 'sessions'),
    join(base, 'session_projcache_archive_manager', 'sessions'),
    join(base, 'session_projcache', 'sessions'),
  ]
}

/** 读取 DSH 官方注册的工作区列表及各自绑定的 sessionIds 列表 */
export async function getRegisteredWorkspaces(ctx) {
  const workspaces = []

  // 优先从内存服务获取
  if (ctx?.workspaceRegistry) {
    try {
      const list = await ctx.workspaceRegistry.list?.()
      if (Array.isArray(list)) {
        for (const w of list) {
          if (w && w.path) {
            workspaces.push({
              id: w.id || w.path,
              path: w.path,
              title: w.title || basename(w.path),
              sessionIds: Array.isArray(w.sessionIds) ? [...w.sessionIds] : [],
            })
          }
        }
        return workspaces
      }
    } catch { /* ignore */ }
  }

  // 兜底从 workspace.json 存储文件读取
  {
    try {
      const home = process.env.DSH_HOME || join(homedir(), '.dsh')
      const wsFile = join(home, 'storages', 'workspace.json')
      if (existsSync(wsFile)) {
        const data = JSON.parse(readFileSync(wsFile, 'utf8'))
        const wsIds = data?.global?.workspaceIds || Object.keys(data?.tables?.workspaces || {})
        const table = data?.tables?.workspaces || {}
        for (const wId of wsIds) {
          const ws = table[wId]
          if (ws && ws.path) {
            workspaces.push({
              id: wId,
              path: ws.path,
              title: ws.title || basename(ws.path),
              sessionIds: Array.isArray(ws.sessionIds) ? [...ws.sessionIds] : [],
            })
          }
        }
      }
    } catch { /* ignore */ }
  }

  return workspaces
}
