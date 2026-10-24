// dsh-bridge QQ 网关（官方 @tencent-connect/qqbot-nodejs 适配层）
//
// QQ 侧的协议细节全部交给腾讯官方 SDK 实现（与本仓飞书走官方 Channel SDK 的做法一致）：
//   - 连接：WebSocket 长连接、HELLO/IDENTIFY/RESUME/心跳、按关闭码分类重连、退避策略
//   - 鉴权：AppID + AppSecret 换 access_token（缓存 + 提前刷新 + 失效重取）
//   - 入站：事件归一化（C2C / 群 / 频道 / 私信 / 互动）、@提及标记清洗、引用解析、
//     去重、限流、按会话串行、错误兜底（Koa 式中间件链，全部用 SDK 内置实现）
//     注意：SDK 的高层 facade 不给频道(guild)/频道私信(dm)派生 replyTarget，因此
//     `bot.on('message')` 只覆盖单聊与群聊（本插件的能力范围）；频道场景需要时
//     可走 `bot.messageApi.sendChannelMessage`（见 SDK USAGE.md §15.2）。
//   - 出站：文本 / Markdown / 按钮键盘 / Ark / Embed / 富媒体（含 ≥5MB 自动分片上传）/
//     输入状态 / 被动回复 msg_id / 互动事件 event_id / 撤回
//   - 流式：C2C `stream_messages`（replace 语义 + 节流 + msg_seq/index 序列）
//
// 本文件只做「会话桥 ↔ SDK」之间的映射，不自行实现任何协议逻辑。
// 官方 SDK 由 scripts/bundle-qq.mjs 预打包为 lib/qq/qqbot-bundled.mjs（发布物不含 node_modules）。
//
// 平台文档：https://bot.q.qq.com/wiki/develop/api-v2/
// SDK 文档：https://github.com/tencent-connect/qqbot-nodejs

import fs from 'node:fs'
import path from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import {
  QQBot,
  MsgType,
  MediaFileType,
  ApiError,
  GatewayErrorCode,
  errorHandler,
  messageFilter,
  contentSanitizer,
  rateLimiter,
  concurrencyGuard,
  mentionGate,
  quoteRef,
  historyBuffer,
  typingIndicator,
  FileKVStore,
  kvSessionPersistence,
  ReplyLimiter,
} from './qqbot-bundled.mjs'

/** 单条消息文本上限（QQ 平台限制 ~5000 字符，插件默认按 2000 分块以适配手机端阅读） */
const MAX_MESSAGE_CHARS = 2000

/** 流式消息节流（平台建议 ≥300ms；SDK 内部会把更小的值抬到 300） */
const STREAM_THROTTLE_MS = 500

/** 被动回复限额：单聊每条消息最多 4 次、群聊 5 次（官方 FAQ），按 scope 分别取值 */
const PASSIVE_REPLY_LIMIT_C2C = 4
const PASSIVE_REPLY_LIMIT_GROUP = 5

/** 断流标记的存活时间（一轮对话足够长；到点自动清理，避免长跑内存增长） */
const STREAM_BROKEN_TTL_MS = 10 * 60_000

/** stop() 等待 SDK start() 收尾的上限：超时后继续收尾，不无限阻塞调用方 */
const STOP_WAIT_TIMEOUT_MS = 5_000

/**
 * 给 Promise 加超时（超时 resolve 而非 reject，调用方自己决定语义）。
 * 定时器 unref，避免阻止进程退出。
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @returns {Promise<void>}
 */
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(), ms)
    if (typeof timer.unref === 'function') timer.unref()
    Promise.resolve(promise).then(
      () => { clearTimeout(timer); resolve() },
      (err) => { clearTimeout(timer); reject(err) },
    )
  })
}

/** 媒体类型按扩展名映射（SDK 要求显式指定 fileType） */
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'])
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.webm', '.avi', '.mkv'])
const VOICE_EXTS = new Set(['.silk', '.amr', '.wav', '.mp3'])

/** 连接状态值（供 UI 与桥的离线守卫使用） */
const STATUS = {
  IDLE: 'idle',
  STARTING: 'starting',
  CONNECTED: 'connected',
  RECONNECTING: 'reconnecting',
  ERROR: 'error',
  OFFLINE: 'offline',
}

/**
 * SDK GatewayError 的终态错误码。
 *
 * 两者语义不同，处理也要区分：
 *   - `FATAL_CLOSE`（4914/4915）：机器人被下线/封禁，**需人工处理**，重连必然再失败 → error（保留原因）；
 *   - `RETRY_EXHAUSTED`：仅是本插件给 SDK 设了重连上限（maxAttempts: 10），
 *     网络恢复后重连即可 → error（可重启）。
 */
const FATAL_CLOSE_CODE = GatewayErrorCode?.FATAL_CLOSE
const RETRY_EXHAUSTED_CODE = GatewayErrorCode?.RETRY_EXHAUSTED

/**
 * 按扩展名推断 QQ 媒体类型。
 * @param {string} filePath
 * @returns {number} MediaFileType
 */
export function mediaFileTypeOf(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase()
  if (IMAGE_EXTS.has(ext)) return MediaFileType.IMAGE
  if (VIDEO_EXTS.has(ext)) return MediaFileType.VIDEO
  if (VOICE_EXTS.has(ext)) return MediaFileType.VOICE
  return MediaFileType.FILE
}

/** 把 SDK 的 Logger 接口适配到 cordis 日志器（info/error 必填，warn/debug 可选）。 */
function makeSdkLogger(logger) {
  const call = (level) => (msg, meta) => {
    const fn = logger?.[level] ?? logger?.info
    if (typeof fn !== 'function') return
    try {
      if (meta === undefined) fn.call(logger, '[qq] %s', msg)
      else fn.call(logger, '[qq] %s %o', msg, meta)
    } catch { /* 日志失败不致命 */ }
  }
  return {
    info: call('info'),
    error: call('error'),
    warn: call('warn'),
    debug: call('debug'),
  }
}

/**
 * QQ 网关：持有官方 SDK 的 QQBot 实例，向会话桥暴露 sendText/sendMedia/typing/流式能力，
 * 并把 SDK 事件归一化为 cordis 事件（`qq/message` / `qq/action` / `qq/status`）。
 *
 * 作为 cordis Service 注册（服务名按实例唯一，支持同平台多账号）。
 */
export class QqGateway extends Service {
  /**
   * @param {object} opts
   * @param {object} opts.ctx             Cordis 上下文
   * @param {object} opts.logger          插件日志器
   * @param {object} [opts.config]        凭证与运行参数（appId/appSecret/...）
   * @param {(patch: object) => (void|Promise<void>)} [opts.onPersist] 持久化回调
   * @param {string} [opts.instanceId]    账号实例标识（事件隔离）
   * @param {string} [opts.serviceName]   唯一 cordis 服务名
   * @param {string} [opts.dataDir]       SDK 会话持久化目录（RESUME 跨重启）
   */
  constructor({ ctx, logger, config = {}, onPersist, instanceId, serviceName, dataDir } = {}) {
    const resolvedInstanceId = instanceId || 'qq'
    super(ctx, serviceName || config.serviceName || resolvedInstanceId)
    this.ctx = ctx
    this.instanceId = resolvedInstanceId
    this.logger = logger
    this.onPersist = onPersist || (() => {})
    this.config = {
      appId: String(config.appId || ''),
      appSecret: String(config.appSecret || ''),
      // 是否拥有 Markdown 权限：未审核的机器人发 msg_type=2 会被拒，需退回纯文本
      markdownSupport: config.markdownSupport !== false,
      // 群聊是否需要 @机器人（官方 GROUP_AT_MESSAGE_CREATE 已保证，仅在开启全量群消息时生效）
      requireMentionInGroup: config.requireMentionInGroup !== false,
      // 数据目录（SDK 会话持久化）
      dataDir: String(dataDir || config.dataDir || ''),
      // 单条消息上限
      maxMessageChars: Number(config.maxMessageChars) >= 200 ? Number(config.maxMessageChars) : MAX_MESSAGE_CHARS,
      // 流式节流
      streamThrottleMs: Number(config.streamThrottleMs) > 0 ? Number(config.streamThrottleMs) : STREAM_THROTTLE_MS,
      // 自定义 API 基址（仅测试/私有部署）
      baseUrl: String(config.baseUrl || ''),
      tokenBaseUrl: String(config.tokenBaseUrl || ''),
      // 自定义 intents（不传则用 SDK 的 FULL_INTENTS）
      intents: Number.isFinite(Number(config.intents)) ? Number(config.intents) : undefined,
      // 同一条入站消息允许的被动回复次数上限（单聊 / 群聊分别按官方上限）
      passiveReplyLimit: Number(config.passiveReplyLimit) > 0 ? Number(config.passiveReplyLimit) : PASSIVE_REPLY_LIMIT_C2C,
      passiveReplyLimitGroup: Number(config.passiveReplyLimitGroup) > 0 ? Number(config.passiveReplyLimitGroup) : PASSIVE_REPLY_LIMIT_GROUP,
    }

    this.statusValue = STATUS.IDLE
    this.error = null
    /** @type {import('./qqbot-bundled.mjs').QQBot|null} */
    this.bot = null
    this.botInfo = null
    /** @type {import('./qqbot-bundled.mjs').FileKVStore|null} */
    this._sessionStore = null
    /** 被动回复限额（每条入站消息最多回复 N 次，超限降级主动消息；单聊/群聊上限不同） */
    this._replyLimiters = {
      c2c: new ReplyLimiter({ limit: this.config.passiveReplyLimit }),
      group: new ReplyLimiter({ limit: this.config.passiveReplyLimitGroup }),
    }
    /** 本轮流式已放弃的标记（P0-5）：`${scope}:${peerId}` */
    this._streamBroken = new Set()
    /** 已被平台判定过期的被动回复锚点（msg_id/event_id），不再复用（P0-7） */
    this._expiredReplyIds = new Set()
    /** 最近的被动回复候选（msg_id / event_id），按 `${scope}:${targetId}` 归档 */
    this._replyIds = new Map()
    this._stopRequested = false
    this._startingPromise = null
    this._runPromise = null

    /** @type {Map<string, { stream: object, text: string }>} 进行中的流式会话 */
    this._streams = new Map()
  }

  // ---- 只读属性 ----

  get status() { return this.statusValue }
  get configured() { return Boolean(this.config.appId && this.config.appSecret) }
  get accountId() { return this.botInfo?.id || this.botInfo?.username || '' }

  get capabilities() {
    return {
      supportsGroup: true,
      supportsMedia: true,
      supportsVoice: true,
      supportsTyping: true,
      supportsStreaming: true,
      supportsButtons: true,
      supportsQuote: true,
      maxMessageChars: this.config.maxMessageChars,
    }
  }

  setStatus(status, error = null) {
    this.statusValue = status
    this.error = error ? String(error?.message || error) : null
    try {
      this.ctx.emit?.('qq/status', { instanceId: this.instanceId, status, error: this.error })
    } catch { /* 事件订阅失败不致命 */ }
  }

  // ---- 配置 ----

  /**
   * 更新凭证/配置。返回值表示凭证是否发生变化（调用方可据此决定是否重连）。
   * @param {object} values
   */
  setCredentials(values = {}) {
    const before = { appId: this.config.appId, appSecret: this.config.appSecret }
    if (values.appId !== undefined) this.config.appId = String(values.appId ?? '')
    if (values.appSecret !== undefined) this.config.appSecret = String(values.appSecret ?? '')
    if (values.clientSecret !== undefined) this.config.appSecret = String(values.clientSecret ?? '')
    if (values.markdownSupport !== undefined) this.config.markdownSupport = values.markdownSupport !== false
    if (values.requireMentionInGroup !== undefined) {
      this.config.requireMentionInGroup = values.requireMentionInGroup !== false
    }
    if (values.maxMessageChars !== undefined) {
      const val = Number(values.maxMessageChars)
      if (val >= 200) this.config.maxMessageChars = val
    }
    if (values.baseUrl !== undefined) this.config.baseUrl = String(values.baseUrl ?? '')
    return this.config.appId !== before.appId || this.config.appSecret !== before.appSecret
  }

  /** 凭证是否与给定值一致（避免无谓重连）。 */
  credentialsMatch({ appId, appSecret, clientSecret } = {}) {
    const secret = appSecret !== undefined ? appSecret : clientSecret
    if (appId !== undefined && String(appId ?? '') !== this.config.appId) return false
    if (secret !== undefined && String(secret ?? '') !== this.config.appSecret) return false
    return true
  }

  // ---- 生命周期 ----

  /**
   * 启动长连接（幂等：重复调用复用同一次启动流程）。
   *
   * 竞态防护（P0-1）：`_stopRequested` 必须在 `await _teardownBot()` **之后**再判一次。
   * 否则用户在"启动中"窗口点断开时，stop() 置位的标志会被忽略，start() 继续建连，
   * 最终 status=connected 但 `_stopRequested=true` —— 此后所有入站消息被
   * `_bindBotEvents` 首行的守卫**静默丢弃**，且因 connected 短路再也无法自愈。
   *
   * 凭证变更（P0-4）：已连接时不能直接短路返回 true——必须比较运行中 bot 的凭证，
   * 不一致就重建连接，否则"保存并连接"会谎报成功（旧连接照跑，新凭证永不生效）。
   */
  async start() {
    if (!this.configured) {
      this.setStatus(STATUS.IDLE)
      return false
    }
    // 已在建连流程中：复用同一次启动（不要并发开第二条连接）
    if (this._startingPromise) return this._startingPromise
    // 已连接：仅当凭证未变才视为"无需动作"，否则落到下面重建
    if (this.statusValue === STATUS.CONNECTED && !this._credentialsStale()) return true

    this._stopRequested = false
    this.setStatus(STATUS.STARTING)

    const starting = (async () => {
      // 旧实例（断线重连 / 凭证变更）先释放，避免双连接分流事件
      await this._teardownBot()
      // 释放期间用户可能点了「断开」：此时不得继续建连，也不能把 stopRequested 留在 true
      if (this._stopRequested) {
        this.setStatus(STATUS.IDLE)
        return false
      }
      try {
        const bot = this._createBot()
        this.bot = bot
        this._bindBotEvents(bot)
        // 有意不 await：SDK 的 start() 会一直 resolve 到连接结束（长连接生命周期），
        // 这里只需挂上错误处理并保存 run 句柄，start()（本方法）应立即返回。
        // 显式 void 标注意图，避免被误读为漏写 await（js/missing-await）。
        this._runPromise = void bot.start().catch((err) => this._onStartRejected(err))
        return true
      } catch (err) {
        this.logger?.error?.('[dsh-bridge qq] 启动失败：%s', err?.message ?? err)
        this.setStatus(STATUS.ERROR, err)
        return false
      }
    })()

    this._startingPromise = starting
    let result
    try {
      result = await starting
    } catch (err) {
      // 启动流程内部已把错误写进状态（setStatus(ERROR)），这里只负责清句柄后上抛
      if (this._startingPromise === starting) this._startingPromise = null
      throw err
    }
    if (this._startingPromise === starting) this._startingPromise = null
    return result
  }

  /**
   * 运行中的 bot 凭证是否已与当前 config 不一致（P0-4）。
   *
   * 真实 SDK 的 QQBot 提供 `getCredentials()`；若替身/未来 transport 没有该方法，
   * 这里**宁可重建**（返回 true）也不静默跳过——凭证变更后不重建会沿用旧连接，
   * 用户看到"已连接"却始终连的是旧账号，比多一次重连昂贵得多。
   */
  _credentialsStale() {
    const bot = this.bot
    if (!bot) return true
    if (typeof bot.getCredentials !== 'function') return true
    try {
      const live = bot.getCredentials()
      if (!live) return true
      return String(live.appId ?? '') !== this.config.appId
        || String(live.clientSecret ?? live.appSecret ?? '') !== this.config.appSecret
    } catch {
      return true
    }
  }

  /** 解绑后置 offline：凭证已清除，与 idle（已配置但未启动）语义区分。 */
  markUnbound() {
    this._stopRequested = true
    this.setStatus(STATUS.OFFLINE)
  }

  /** 停止长连接（保留凭证与配置）。 */
  async stop() {
    this._stopRequested = true
    // 若正处在启动流程中，等它收尾——否则 stop() 返回后那次 start() 仍会把 bot 建起来
    const starting = this._startingPromise
    if (starting) {
      try { await starting } catch { /* 启动失败已记日志 */ }
    }
    await this._teardownBot()
    this.setStatus(STATUS.IDLE)
    return true
  }

  dispose() {
    void this.stop()
    super.dispose?.()
  }

  /** SDK 工厂（测试注入点）。 */
  _createBot() {
    const logger = makeSdkLogger(this.logger)
    const options = {
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      accountId: this.instanceId,
      markdownSupport: this.config.markdownSupport,
      logger,
      transport: 'websocket',
      // 外层由 PlatformManager 管生命周期，这里给重连设上限让失败能及时上抛，
      // 由 start() 的 catch 更新状态（而不是无声地无限重连）。
      reconnect: { maxAttempts: 10 },
    }
    if (this.config.baseUrl) options.baseUrl = this.config.baseUrl
    if (this.config.tokenBaseUrl) options.tokenBaseUrl = this.config.tokenBaseUrl
    if (this.config.intents !== undefined) options.intents = this.config.intents
    const persistence = this._sessionPersistence()
    if (persistence) options.sessionPersistence = persistence

    const bot = new QQBot(options)
    this._installMiddlewares(bot)
    return bot
  }

  /**
   * RESUME 会话持久化：把 sessionId / lastSeq 落到 `$DSH_HOME/dsh-bridge/qq-session-<instance>.json`。
   * 进程重启后可跳过 IDENTIFY 直接 RESUME，缩短恢复时间并减少漏消息。
   */
  _sessionPersistence() {
    const dir = this.config.dataDir
    if (!dir) return undefined
    try {
      this._sessionStore = new FileKVStore({
        dir,
        fileName: `qq-session-${this.instanceId.replace(/[^\w.-]/g, '_')}.json`,
      })
      return kvSessionPersistence({ store: this._sessionStore, accountId: this.instanceId })
    } catch (err) {
      this.logger?.warn?.('[dsh-bridge qq] 会话持久化初始化失败（忽略）：%s', err?.message ?? err)
      return undefined
    }
  }

  /**
   * 中间件链：全部使用官方 SDK 内置实现（顺序即洋葱皮顺序）。
   *
   * 访问控制的分工说明——白名单的**最终裁决**仍在会话桥
   * （lib/platform/conversation-bridge.js），因为白名单是插件的持久化配置、且群聊有
   * "首条消息自动授权"语义。这里只做"回声过滤 / 去重 / 内容清洗 / 引用解析 / 限流 / 串行"
   * 这类与业务无关的协议级保护。
   */
  _installMiddlewares(bot) {
    // 1. 错误兜底（最外层）：下游抛错时回一句可读提示，避免用户侧静默无响应
    bot.use(errorHandler())
    // 2. 回声 + 去重：QQ 在群聊里会把机器人自己的消息回推，且可能重复推送同一事件
    bot.use(messageFilter({ skipSelfEcho: true }))
    // 3. 内容清洗：去掉 `<@!appId>` 提及标记与表情标签
    bot.use(contentSanitizer({ stripBotMention: true, parseFaceTags: true }))
    // 4. 限流：防止单个用户/群刷爆（三层滑动窗口）
    bot.use(rateLimiter({
      perSender: { max: 20, windowMs: 60_000 },
      perGroup: { max: 60, windowMs: 60_000 },
      global: { max: 200, windowMs: 60_000 },
      // 注意：这里的 mCtx 是 SDK 的 MiddlewareContext（非 cordis ctx），不访问 cordis 服务
      onLimit: (mCtx, tier) => {
        this.logger?.warn?.('[dsh-bridge qq] 入站限流（%s）：sender=%s', tier, mCtx?.message?.senderId ?? '?')
      },
    }))
    // 5. 引用解析：QQ 的引用消息原文只在 msg_elements[0] 里，SDK 负责还原
    bot.use(quoteRef({ maxSize: 500, preferMsgElements: true }))
    // 6. 群历史缓冲：群内未被 @ 的消息也进上下文，让模型知道"刚才聊了什么"
    bot.use(historyBuffer({ limit: 10, recordOnSkip: true }))
    // 7. 群聊 @门控（requireMentionInGroup=false 时放行所有群消息）
    bot.use(mentionGate({
      requireMentionInGroup: this.config.requireMentionInGroup,
      passthrough: !this.config.requireMentionInGroup,
    }))
    // 8. 同会话串行：避免同一用户/群的并发处理（QQ 流式 replace 共享 msg_seq 会冲突）
    bot.use(concurrencyGuard({ strategy: 'queue', maxQueue: 20 }))
    // 9. C2C 自动输入状态（SDK 内部会跳过群聊）
    bot.use(typingIndicator())
  }

  /** 绑定 SDK 事件 → cordis 事件。 */
  _bindBotEvents(bot) {
    bot.on('ready', (data) => {
      const user = data?.user ?? data?.d?.user ?? null
      if (user) {
        this.botInfo = { id: String(user.id ?? ''), username: String(user.username ?? '') }
        void this.persist({ accountId: this.botInfo.id })
      }
      this.setStatus(STATUS.CONNECTED)
      this.logger?.info?.('[dsh-bridge qq] 已连接 QQ 开放平台：%s', this.botInfo?.id || this.config.appId)
    })

    bot.on('resumed', () => {
      this.setStatus(STATUS.CONNECTED)
      this.logger?.info?.('[dsh-bridge qq] 会话已恢复（RESUMED）')
    })

    bot.on('disconnected', (event) => {
      const willReconnect = event?.willReconnect !== false
      this.logger?.warn?.('[dsh-bridge qq] 连接断开 code=%s reason=%s willReconnect=%s',
        event?.code ?? '?', event?.reason ?? '', willReconnect)
      this.setStatus(willReconnect ? STATUS.RECONNECTING : STATUS.ERROR, willReconnect ? null : event?.reason)
    })

    bot.on('error', (err) => {
      // 可恢复错误：只记日志，不改变连接状态（SDK 会自行重连）
      this.logger?.warn?.('[dsh-bridge qq] SDK 错误：%s', err?.message ?? err)
    })

    bot.on('message', async (mCtx, msg) => {
      if (this._stopRequested) return
      await this._handleInbound(mCtx, msg)
    })

    bot.on('interaction', async (_iCtx, event) => {
      if (this._stopRequested) return
      this._handleInteraction(event)
    })

    bot.on('rawEvent', (rawCtx) => {
      // 平台新增事件无需 SDK 升级即可观测（群成员变动、好友增删、入群申请等）
      this.logger?.debug?.('[dsh-bridge qq] raw event: %s', rawCtx?.eventType ?? '?')
    })
  }

  /** start() 被拒（终态错误）：区分"需人工处理"与"可重启"。 */
  _onStartRejected(err) {
    if (this._stopRequested) return
    const code = err?.code
    const fatalClose = code === FATAL_CLOSE_CODE
    const retryExhausted = code === RETRY_EXHAUSTED_CODE
    const detail = fatalClose
      ? `机器人被下线或封禁（关闭码 ${err?.closeCode ?? '?'}），需到 QQ 开放平台处理`
      : retryExhausted
        ? `重连次数已用尽（${err?.message ?? 'max attempts'}），网络恢复后可点「重新连接」`
        : (err?.message ?? String(err))
    this.logger?.error?.('[dsh-bridge qq] 连接终止（%s）：%s%s', fatalClose ? '终态' : '可重启', detail,
      fatalClose ? '' : '；可点「重新连接」重试')
    // 都用 error：UI 的 statusLabel 对 'offline' 显示为"未连接"（会丢掉错误原因），
    // 对 'error' 显示"错误"并保留 login.error 文案，用户才能自诊。
    // 区别只在日志文案（终态 / 可重启）与是否提示重连。
    this.setStatus(STATUS.ERROR, detail)
  }

  async _teardownBot() {
    const bot = this.bot
    this.bot = null
    this.botInfo = null
    // 关闭所有在途流（避免悬挂）
    for (const entry of this._streams.values()) {
      try { entry.stream?.cancel?.() } catch { /* 忽略 */ }
    }
    this._streams.clear()
    this._streamBroken.clear()
    this._expiredReplyIds.clear()
    // 重建连接后旧 bot 的被动回复锚点必然失效（msg_id 归属于旧连接上下文），必须清空
    this._replyIds.clear()
    if (!bot) {
      this._runPromise = null
      return
    }
    try {
      bot.stop()
    } catch (err) {
      this.logger?.warn?.('[dsh-bridge qq] bot.stop 异常：%s', err?.message ?? err)
    }
    const run = this._runPromise
    this._runPromise = null
    if (run) {
      // 带上限等待：SDK 的 start() 在极端情况（token 请求挂起/自定义 transport 永不 settle）
      // 可能长时间不返回，不能让 stop() 无限阻塞（复核实测可阻塞 9.7s、自定义 transport 可无上限）。
      try { await withTimeout(run, STOP_WAIT_TIMEOUT_MS) } catch { /* 拒绝已由 _onStartRejected 处理；超时也继续收尾 */ }
    }
  }

  async persist(patch) {
    try {
      await this.onPersist(patch)
    } catch (err) {
      this.logger?.warn?.('[dsh-bridge qq] persist failed: %s', err?.message ?? err)
    }
  }

  // ---- 入站 ----

  /**
   * SDK 入站消息 → cordis `qq/message`（供会话桥消费）。
   *
   * SDK 已完成事件归一化（kind/senderId/groupOpenid/attachments/mentions），
   * 这里只做"业务语义"映射：scope、授权主体、被动回复候选、引用上下文。
   */
  async _handleInbound(mCtx, msg) {
    const scope = msg.kind === 'group' ? 'group' : 'c2c'
    const isGroup = scope === 'group'
    // 出站目标：群聊用群 openid，单聊用用户 openid
    const peerId = isGroup ? (msg.groupOpenid ?? msg.senderId) : msg.senderId
    if (!peerId) return

    // 被动回复候选：普通消息记 msg_id（供无上下文的出站使用）
    this._rememberReplyId(scope, peerId, { kind: 'msg', id: msg.messageId })

    // 引用上下文（SDK quoteRef 中间件解析结果；群里模型要知道"他在回哪句"）
    const quote = mCtx?.state?.quote
    const quotedText = typeof quote?.text === 'string' && quote.text.trim() ? quote.text.trim() : ''
    const quotedAttachments = Array.isArray(quote?.attachments)
      ? quote.attachments.map((a) => ({
        contentType: a.contentType,
        url: a.url,
        filename: a.filename,
        asrText: a.asrText,
      }))
      : []

    // 群历史缓冲（SDK historyBuffer 中间件）：把「未被 @ 的群聊」作为上下文交给模型，
    // 否则模型只看到被 @ 的那一句，接不上前面在聊什么。
    const history = isGroup && Array.isArray(mCtx?.state?.history)
      ? mCtx.state.history
        .filter((entry) => entry && typeof entry.content === 'string' && entry.content.trim())
        .map((entry) => ({
          senderName: entry.senderName ?? '',
          senderId: entry.senderId ?? '',
          content: entry.content,
        }))
      : []

    this.ctx.emit?.('qq/message', {
      instanceId: this.instanceId,
      type: 'message',
      scope,
      isGroup,
      senderId: msg.senderId,
      senderName: msg.senderName ?? '',
      peerId: String(peerId),
      groupId: isGroup ? String(msg.groupOpenid ?? peerId) : '',
      text: msg.content ?? '',
      messageId: msg.messageId,
      msgSeq: undefined,
      timestamp: msg.timestamp,
      attachments: Array.isArray(msg.attachments) ? msg.attachments : [],
      msgType: msg.msgType,
      mentions: msg.mentions,
      quotedText,
      quotedAttachments,
      history,
      raw: msg,
    })
  }

  /** 互动事件（按钮点击）→ cordis `qq/action`。 */
  _handleInteraction(event) {
    const scope = event?.group_openid ? 'group' : 'c2c'
    const peerId = event?.group_openid || event?.user_openid || ''
    const senderId = event?.group_member_openid || event?.user_openid || ''
    if (!peerId) return
    this._rememberReplyId(scope, peerId, { kind: 'event', id: event.id })

    const buttonData = event?.data?.resolved?.button_data
    let data
    if (typeof buttonData === 'string') {
      try { data = JSON.parse(buttonData) } catch { data = buttonData }
    }
    this.ctx.emit?.('qq/action', {
      instanceId: this.instanceId,
      type: 'interaction',
      scope,
      isGroup: scope === 'group',
      peerId: String(peerId),
      groupId: scope === 'group' ? String(peerId) : '',
      senderId: String(senderId),
      interactionId: event.id,
      buttonId: event?.data?.resolved?.button_id ?? '',
      buttonData: data,
      messageId: event?.data?.resolved?.message_id ?? '',
      raw: event,
    })
  }

  /** 记录被动回复候选（有界，避免长跑内存增长）。 */
  _rememberReplyId(scope, targetId, entry) {
    if (!targetId || !entry?.id) return
    const key = `${scope}:${targetId}`
    const list = this._replyIds.get(key) ?? []
    list.push({ ...entry, at: Date.now() })
    // 被动回复窗口：群聊 5 分钟、单聊 60 分钟
    const ttl = scope === 'group' ? 5 * 60_000 : 60 * 60_000
    const now = Date.now()
    const fresh = list.filter((item) => now - item.at <= ttl).slice(-10)
    this._replyIds.set(key, fresh)
    if (this._replyIds.size > 200) {
      // 简单淘汰最早插入的键（Map 保序）
      const oldest = this._replyIds.keys().next().value
      if (oldest !== undefined && oldest !== key) this._replyIds.delete(oldest)
    }
  }

  /**
   * 解析本次出站应使用的被动回复目标。
   *
   * QQ 限制：同一条入站消息最多被被动回复 N 次（单聊 4 次 / 群聊 5 次），超限或过期后
   * 必须降级主动消息（无 msg_id），否则发送会失败。这里按 ReplyLimiter 记账。
   *
   * @param {'c2c'|'group'} scope
   * @param {string} targetId
   * @param {string} [preferredMsgId] 显式指定的 msg_id（通常来自本轮入站）
   * @returns {{ kind: 'msg'|'proactive', id?: string }}
   */
  resolvePassiveTarget(scope, targetId, preferredMsgId) {
    const limiter = this._replyLimiters[scope === 'group' ? 'group' : 'c2c']
    const candidates = []
    if (preferredMsgId) candidates.push({ kind: 'msg', id: preferredMsgId })
    for (const item of [...(this._replyIds.get(`${scope}:${targetId}`) ?? [])].reverse()) {
      candidates.push({ kind: item.kind, id: item.id })
    }
    for (const candidate of candidates) {
      if (this._expiredReplyIds.has(candidate.id)) continue
      if (limiter.checkLimit(candidate.id).allowed) {
        limiter.record(candidate.id)
        return candidate
      }
    }
    return { kind: 'proactive' }
  }

  // ---- 出站 ----

  /**
   * 把 scope/peerId 组装成 SDK 的 ReplyTarget（附带被动回复候选）。
   *
   * 被动回复有两种锚点：
   *   - 普通消息 → `msg_id`（ReplyTarget.msgId）
   *   - 互动事件（按钮点击）→ `event_id`（SDK 的 sendMarkdown 不支持，需走 `send({extra})`）
   * 候选来自 `_replyIds`（含两类），按 ReplyLimiter 记账，超限/过期后降级主动消息。
   */
  _replyTarget(peerId, opts = {}) {
    const scope = opts.scope === 'group' ? 'group' : 'c2c'
    const passive = this.resolvePassiveTarget(scope, String(peerId), opts.msgId)
    const target = { scope, targetId: String(peerId) }
    const out = { target, passive }
    if (passive.kind === 'msg') target.msgId = passive.id
    if (passive.kind === 'event') out.eventId = passive.id
    return out
  }

  /**
   * 统一的被动回复发送：有 event_id 时走 `bot.send({ extra: { event_id } })`，
   * 否则走 SDK 的便捷方法。msg_id 过期（40034005）时自动去掉锚点重试一次。
   *
   * @param {(opts: {passive: object, eventId?: string}) => Promise<any>} exec
   *   实际发送闭包，入参是本次解析出的被动回复候选
   */
  async _sendWithPassiveReply(peerId, opts, exec) {
    let plan = this._replyTarget(peerId, opts)
    try {
      return await exec(plan)
    } catch (err) {
      if (!this._isExpiredMsgId(err) || plan.passive.kind === 'proactive') throw err
      // P0-7：msg_id/event_id 过期 → 去掉锚点重试一次（降级主动消息）。
      // 否则用户侧表现为"消息直接丢失"（文档此前承诺的降级行为实际没实现）。
      this.logger?.warn?.('[dsh-bridge qq] 被动回复锚点已过期（%s），降级为主动消息重试',
        plan.passive.kind === 'event' ? 'event_id' : 'msg_id')
      // 把该锚点记为"已耗尽"，后续不再选它（不再依赖 ReplyLimiter 的私有字段）
      this._expiredReplyIds.add(plan.passive.id)
      if (this._expiredReplyIds.size > 500) {
        const oldest = this._expiredReplyIds.values().next().value
        if (oldest !== undefined) this._expiredReplyIds.delete(oldest)
      }
      plan = { target: { scope: plan.target.scope, targetId: plan.target.targetId }, passive: { kind: 'proactive' } }
      return exec(plan)
    }
  }

  /** 发送纯文本（msg_type=0）。 */
  async sendText(peerId, content, opts = {}) {
    const bot = this._requireBot()
    const text = String(content ?? '')
    if (!bot || !text.trim()) return { success: false, error: 'bot 未连接或内容为空' }
    try {
      const res = await this._sendWithPassiveReply(peerId, opts, ({ target, eventId }) => bot.send({
        target,
        msgType: MsgType.TEXT,
        content: text,
        ...(eventId ? { extra: { event_id: eventId } } : {}),
      }))
      return { success: true, id: res?.id ?? null }
    } catch (err) {
      return this._sendError('sendText', err)
    }
  }

  /** 发送 Markdown（msg_type=2），可选挂按钮键盘。 */
  async sendMarkdown(peerId, markdown, opts = {}) {
    const bot = this._requireBot()
    const content = String(markdown ?? '')
    if (!bot || !content.trim()) return { success: false, error: 'bot 未连接或内容为空' }
    try {
      const res = await this._sendWithPassiveReply(peerId, opts, ({ target, eventId }) => bot.send({
        target,
        msgType: MsgType.MARKDOWN,
        markdown: { content },
        keyboard: opts.keyboard,
        ...(eventId ? { extra: { event_id: eventId } } : {}),
      }))
      return { success: true, id: res?.id ?? null }
    } catch (err) {
      // 只有 50056（"不允许发送 markdown content"）才是权限类错误，降级纯文本。
      // 50055/50057 是**内容/参数非法**，降级会把真正的语法 bug 掩盖掉，必须暴露。
      if (this._isMarkdownForbidden(err)) {
        this.logger?.warn?.('[dsh-bridge qq] Markdown 权限不足，降级纯文本')
        return this.sendText(peerId, stripMarkdown(content), opts)
      }
      return this._sendError('sendMarkdown', err)
    }
  }

  /** 发送带按钮的文本消息（msg_type=0 + keyboard）。 */
  async sendKeyboard(peerId, content, keyboard, opts = {}) {
    const bot = this._requireBot()
    if (!bot) return { success: false, error: 'bot 未连接' }
    try {
      const res = await this._sendWithPassiveReply(peerId, opts, ({ target, eventId }) => bot.send({
        target,
        msgType: MsgType.TEXT,
        content: String(content ?? ''),
        keyboard,
        ...(eventId ? { extra: { event_id: eventId } } : {}),
      }))
      return { success: true, id: res?.id ?? null }
    } catch (err) {
      return this._sendError('sendKeyboard', err)
    }
  }

  /**
   * 发送富媒体（图片/视频/语音/文件）：SDK 负责上传（≥5MB 自动分片）后再发消息。
   * @param {string} peerId
   * @param {{ filePath?: string, buffer?: Buffer, url?: string, fileType?: number, fileName?: string }} media
   */
  async sendMedia(peerId, media = {}, opts = {}) {
    const bot = this._requireBot()
    if (!bot) return { success: false, error: 'bot 未连接' }
    const fileType = Number(media.fileType) || mediaFileTypeOf(media.filePath || media.fileName || '')
    try {
      const res = await this._sendWithPassiveReply(peerId, opts, ({ target }) => bot.sendMedia({
        target,
        fileType,
        localPath: media.filePath,
        buffer: media.buffer,
        url: media.url,
        fileName: media.fileName,
      }))
      return { success: true, id: res?.message?.id ?? res?.upload?.file_uuid ?? null }
    } catch (err) {
      return this._sendError('sendMedia', err)
    }
  }

  /** 发送本地媒体文件（会话桥的 sendMediaFile 入口）。 */
  async sendMediaFile(peerId, filePath, opts = {}) {
    if (!filePath || !fs.existsSync(filePath)) {
      return { success: false, error: `文件不存在：${filePath}` }
    }
    return this.sendMedia(peerId, {
      filePath,
      fileName: path.basename(filePath),
      fileType: mediaFileTypeOf(filePath),
    }, opts)
  }

  /** 发送输入状态（仅 C2C 支持；群聊直接跳过）。 */
  async sendTyping(peerId, opts = {}) {
    const bot = this.bot
    if (!bot) return { ok: false }
    const scope = opts?.scope === 'group' ? 'group' : 'c2c'
    if (scope === 'group') return { ok: true }
    const duration = Math.min(Number(opts?.durationSeconds) || 8, 60)
    try {
      await bot.sendTyping({ scope: 'c2c', targetId: String(peerId) }, duration)
      return { ok: true }
    } catch (err) {
      this.logger?.debug?.('[dsh-bridge qq] typing 失败：%s', err?.message ?? err)
      return { ok: false }
    }
  }

  /** 撤回机器人自己发送的消息（发送超过 2 分钟不可撤回）。 */
  async recallMessage(peerId, messageId, opts = {}) {
    const bot = this._requireBot()
    if (!bot) return { success: false, error: 'bot 未连接' }
    const scope = opts.scope === 'group' ? 'group' : 'c2c'
    try {
      await bot.recallMessage({ scope, targetId: String(peerId) }, String(messageId))
      return { success: true }
    } catch (err) {
      return this._sendError('recallMessage', err)
    }
  }

  /** 确认互动事件（QQ 要求 5 秒内 ACK；超过会被客户端判定为失败）。 */
  async acknowledgeInteraction(interactionId, code = 0) {
    const bot = this.bot
    if (!bot || !interactionId) return { success: false }
    try {
      await bot.acknowledgeInteraction(String(interactionId), code)
      return { success: true }
    } catch (err) {
      this.logger?.warn?.('[dsh-bridge qq] 互动回应失败：%s', err?.message ?? err)
      return { success: false, error: err?.message }
    }
  }

  // ---- 流式（C2C only）----

  /**
   * 更新一条 C2C 流式消息（QQ `stream_messages`，replace 语义）。
   *
   * 会话桥按轮次调用：同一 streamKey 复用同一个 StreamSession，
   * `done: true` 时收尾（input_state=DONE）。
   *
   * @param {string} peerId
   * @param {string} fullText 截至目前的**全文**（不是增量）
   * @param {{ streamKey?: string, msgId?: string, scope?: string, done?: boolean }} [opts]
   */
  async sendStream(peerId, fullText, opts = {}) {
    const bot = this._requireBot()
    if (!bot) return { success: false, error: 'bot 未连接' }
    const scope = opts.scope === 'group' ? 'group' : 'c2c'
    // QQ 流式仅支持单聊；群聊直接走普通 Markdown
    if (scope === 'group') return this.sendMarkdown(peerId, fullText, opts)

    const key = opts.streamKey || `${scope}:${peerId}`
    const text = String(fullText ?? '')

    // P0-5：本轮流式已放弃（额度耗尽 / 开流失败 / update 抛错）。
    //   - 非 done 片段：直接丢弃。否则每片都发一条**递增全文**，用户被刷屏
    //     （实测 3 片段 → 4 条重复全文）；
    //   - done：把**最终全文**发一次，保证正文完整送达且只发一条。
    if (this._streamBroken.has(key)) {
      if (!opts.done) return { success: true, skipped: true }
      this._streamBroken.delete(key)
      return this.sendMarkdown(peerId, text, { ...opts, scope: 'c2c' })
    }

    // P0-2：没有在途流却收到 done —— 说明前一片已经失败并降级过。
    // 此时**不能**新建一个空 StreamSession 再 complete（那会发出一条 content_raw="" 的
    // 空白流式消息，正文彻底丢失），而是直接以单条 Markdown 发出本轮全文。
    if (!this._streams.has(key) && opts.done) {
      return this.sendMarkdown(peerId, text, { ...opts, scope: 'c2c' })
    }

    let entry = this._streams.get(key)
    if (!entry) {
      const passive = this.resolvePassiveTarget('c2c', String(peerId), opts.msgId)
      if (passive.kind !== 'msg') {
        // 没有可用的 msg_id：不能开流（SDK 会抛）。标记断流后本片丢弃，
        // 由 turn/end 的 done 把最终全文发一次（避免"首片就发、后续又发"的重复）。
        this.logger?.warn?.('[dsh-bridge qq] 无可用 msg_id，本轮改为单条 Markdown 收尾')
        this._markStreamBroken(key)
        return { success: true, skipped: true }
      }
      try {
        const stream = bot.openStream({
          target: { scope: 'c2c', targetId: String(peerId), msgId: passive.id },
          throttleMs: this.config.streamThrottleMs,
        })
        entry = { stream, text: '' }
        this._streams.set(key, entry)
      } catch (err) {
        this.logger?.warn?.('[dsh-bridge qq] 开启流式失败，本轮改为单条 Markdown 收尾：%s', err?.message ?? err)
        if (opts.done) {
          // 首帧就是 done：直接发一条普通 Markdown，不能只标记断流（否则正文丢失）
          return this.sendMarkdown(peerId, text, { ...opts, scope: 'c2c' })
        }
        this._markStreamBroken(key)
        return { success: true, skipped: true }
      }
    }
    try {
      entry.text = text
      // P0-2：`StreamSession.complete()` 用的是它内部的 pendingText（上一次 update 的内容），
      // **不是**本次入参。若不先 update，DONE 帧会落后一版、最终正文丢失。
      await entry.stream.update(entry.text)
      if (opts.done) {
        await entry.stream.complete()
        this._streams.delete(key)
      }
      return { success: true }
    } catch (err) {
      this._streams.delete(key)
      // 先取消 SDK 侧的节流定时器：否则降级发出的整条 Markdown 之后，
      // 挂起的 flush 还会再推一次旧内容（用户看到重复/回退）。
      try { entry.stream.cancel?.() } catch { /* 取消失败不致命 */ }
      // D 项（P0）：**done 帧失败必须兜底发一次普通 Markdown**。
      // 此前无论哪一帧失败都只标记断流并返回 skipped，而 node 侧在调用 done 前
      // 已清空 `_turnText`（turn/end 已消费），此后没有任何路径补发 → 整轮正文丢失
      // （实测：前面帧成功显示"第一段"，done 被拒后最终全文从未送达）。
      if (opts.done) {
        this.logger?.warn?.('[dsh-bridge qq] 流式收尾失败，降级单条 Markdown 补发全文：%s', err?.message ?? err)
        this._streamBroken.delete(key)
        return this.sendMarkdown(peerId, text, { ...opts, scope: 'c2c' })
      }
      this.logger?.warn?.('[dsh-bridge qq] 流式更新失败，本轮改为单条 Markdown 收尾：%s', err?.message ?? err)
      this._markStreamBroken(key)
      return { success: true, skipped: true }
    }
  }

  /**
   * 标记本轮流式已放弃（P0-5）：后续片段丢弃，done 时只发一次最终全文。
   * 带 TTL 自动清理，避免长跑内存增长。
   * @param {string} key
   */
  _markStreamBroken(key) {
    this._streamBroken.add(key)
    const timer = setTimeout(() => this._streamBroken.delete(key), STREAM_BROKEN_TTL_MS)
    if (typeof timer.unref === 'function') timer.unref()
  }

  /**
   * 收尾指定流（幂等）。
   * @param {object} [opts]
   * @param {boolean} [opts.abort] true = 不发 DONE 帧、直接取消挂起的节流推送
   *   （连接已断开时用：向断开的 socket 写数据只会产生无意义报错与重试）
   */
  async finishStream(peerId, opts = {}) {
    const scope = opts.scope === 'group' ? 'group' : 'c2c'
    const key = opts.streamKey || `${scope}:${peerId}`
    const entry = this._streams.get(key)
    if (!entry) return { success: true }
    this._streams.delete(key)
    if (opts.abort) {
      try { entry.stream.cancel?.() } catch { /* 取消失败不致命 */ }
      return { success: true }
    }
    try {
      await entry.stream.complete()
      return { success: true }
    } catch (err) {
      this.logger?.warn?.('[dsh-bridge qq] 流式收尾失败：%s', err?.message ?? err)
      return { success: false, error: err?.message }
    }
  }

  // ---- 平台管理（escape hatch：SDK 未封装的面板/菜单 REST）----

  /**
   * 调用任意 QQ OpenAPI（自动带 access_token 与刷新）。
   * SDK 只封装了消息/媒体/流式，自定义菜单与指令面板仍需走原始 REST。
   *
   * @param {'GET'|'POST'|'PUT'|'PATCH'|'DELETE'} method
   * @param {string} apiPath 形如 `/v2/menu`
   * @param {object} [body]
   */
  async apiCall(method, apiPath, body) {
    const bot = this._requireBot()
    if (!bot) throw new Error('QQ bot 未连接')
    const verb = String(method || 'GET').toUpperCase()
    if (verb === 'GET') return bot.api.get(apiPath)
    if (verb === 'DELETE') return bot.api.delete(apiPath)
    if (verb === 'PUT') return bot.api.put(apiPath, body)
    if (verb === 'PATCH') return bot.api.patch(apiPath, body)
    return bot.api.post(apiPath, body)
  }

  // ---- 内部工具 ----

  _requireBot() {
    if (!this.bot) {
      this.logger?.debug?.('[dsh-bridge qq] bot 未连接，本条出站已跳过')
      return null
    }
    return this.bot
  }

  /**
   * markdown 权限不足的业务错误码。
   *
   * 依据官方错误码表（bot-docs `openapi/error/error.md`）：
   *   - 50056 「不允许发送 markdown content」→ 权限类，降级纯文本是正确行为；
   *   - 50055 「无效的 markdown content」→ **内容**非法，降级会把真正的语法 bug 掩盖掉；
   *   - 50057「markdown 参数只支持原生语法或者模版二选一」→ **参数组合**错误，同理；
   *   - 304036「没有 markdown 模板的权限」→ 只与 `custom_template_id` 模板相关，
   *     本插件只用原生 markdown 语法，不属于该场景。
   * 故只把 50056 当作"无权限"，其余照常报错暴露。
   */
  _isMarkdownForbidden(err) {
    if (!(err instanceof ApiError)) return false
    return Number(err.bizCode) === 50056
  }

  /**
   * 被动回复锚点已过期（平台错误码 40034005「回复消息 msg_id 已过期」）。
   * 命中后应去掉锚点、以降级主动消息重试一次（P0-7）。
   */
  _isExpiredMsgId(err) {
    if (!(err instanceof ApiError)) return false
    return Number(err.bizCode) === 40034005
  }

  _sendError(op, err) {
    const detail = err instanceof ApiError
      ? `QQ API ${err.httpStatus} code=${err.bizCode ?? '-'}: ${err.bizMessage ?? err.message}`
      : (err?.message ?? String(err))
    this.logger?.warn?.('[dsh-bridge qq] %s 失败：%s', op, detail)
    return { success: false, error: detail }
  }
}

/** 去掉 Markdown 语法（无 markdown 权限时的纯文本降级）。 */
export function stripMarkdown(text) {
  return String(text ?? '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$1 $2')
    .replace(/\[([^\]]*)\]\(([^)]+)\)/g, '$1 $2')
    .trim()
}

export const gatewayConstants = {
  MAX_MESSAGE_CHARS,
  STREAM_THROTTLE_MS,
  PASSIVE_REPLY_LIMIT_C2C,
  PASSIVE_REPLY_LIMIT_GROUP,
  STREAM_BROKEN_TTL_MS,
  STATUS,
}
