// dsh-bridge 飞书 / Lark 网关（官方 Channel SDK 适配层）
//
// 飞书侧的协议细节全部交给官方 @larksuite/channel（Channel SDK）实现：
//   - 连接：WebSocket 长连接、自动重连、心跳、保活看门狗、连接状态快照
//   - 入站：事件验签解密、事件归一化（NormalizedMessage）、去重、过期丢弃、
//     按会话串行、群聊 @ 提及策略、bot 回环防护
//   - 出站：markdown → 飞书富文本渲染、超长内容按代码块安全分片、限流重试、
//     格式错误自动降级纯文本、流式打字机卡片（CardKit 原生 streaming_mode）
//   - 媒体：图片/文件上传（含 SSRF 防护）与消息资源流式下载
//
// 本文件只做「会话桥 ↔ SDK」之间的映射，不自行实现任何协议逻辑。
// 参考文档（本地留档）：docs/dev/lark-sdk/

import fs from 'node:fs/promises'
import path from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import { createLarkChannel, registerApp, Domain, LoggerLevel } from './lark-bundled.mjs'
import { syncSlashCommands, isPermissionErrorCode } from './slash-commands.js'
import { normalizeFeishuMarkdown, hasMarkdownTable, splitMarkdownForCards, buildMarkdownCard } from './markdown.js'
import { isCommentPeerId, extractCommentInput } from './comment.js'

/** 图片扩展名（按扩展名选择发送为图片消息，其余走文件消息） */
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'])

/** 流式卡片首屏占位文案（SDK 在建卡时写入，随后被首片内容覆盖） */
const STREAM_INITIAL_TEXT = '正在思考…'

export class FeishuGateway extends Service {
  static name = 'feishu'

  /**
   * @param {object} ctx Cordis 上下文
   * @param {object} [config] { appId, appSecret, domain, maxMessageChars, sendChunkDelayMs }
   */
  constructor(ctx, config = {}) {
    // issue #78：instanceId 用于事件隔离；serviceName 是唯一 cordis 服务名
    // （D2：cordis 服务名不随 dispose 释放，重复创建必须换名）
    const instanceId = config.instanceId || 'feishu'
    super(ctx, config.serviceName || instanceId, true)
    this.ctx = ctx
    this.instanceId = instanceId
    this.logger = ctx.logger?.('feishu') ?? console
    this.config = {
      appId: '',
      appSecret: '',
      domain: 'feishu',
      // 会话工作目录：用于 outbound.allowedFileDirs（本地文件走 SDK 流式上传，不必读进内存）
      cwd: '',
      // 出站渲染参数：分片上限与流式节流（映射到 Channel SDK 的 outbound 配置）
      maxMessageChars: 2000,
      // 已创建的斜杠指令映射 { command: command_id }，用于更新/清理（只动自己创建的）
      slashCommandIds: {},
      ...config,
    }
    this.status = 'idle' // idle | starting | online | reconnecting | error | offline
    this.error = null
    this.botInfo = null
    /** @type {import('./lark-bundled.mjs').LarkChannel|null} 当前 SDK 通道实例 */
    this.channel = null
    this._closing = false
    this._startingPromise = null
    this._unsubscribes = []
    /** tenant_access_token 缓存（斜杠指令同步用；提前 3 分钟过期） */
    this._tenantToken = null
    /** 应用缺少斜杠指令权限时置位，本次连接内不再重试（避免刷日志） */
    this._slashCommandsDisabled = false
    /** 由 FeishuService 注入：把 { command: command_id } 映射持久化 */
    this.onSlashCommandIds = null
    /** 评论会话注册表：peerId → { target, commentId, isWhole }（评论回复出站用，带上限） */
    this._commentPeers = new Map()
  }

  get configured() {
    return Boolean(this.config.appId && this.config.appSecret)
  }

  setStatus(status, error = null) {
    this.status = status
    this.error = error ? String(error?.message || error) : null
    this.ctx.emit('feishu/status', {
      instanceId: this.instanceId,
      status: this.status,
      error: this.error,
      botInfo: this.botInfo,
      configured: this.configured,
    })
  }

  updateConfig(cfg = {}) {
    this.config = { ...this.config, ...cfg }
  }

  /** 别名：外部（备份导入 / 恢复）以 setCredentials 调用 */
  setCredentials(cfg = {}) {
    this.updateConfig(cfg)
  }

  // ---- SDK 通道工厂（测试注入点） ----

  _createChannel(options) {
    return createLarkChannel(options)
  }

  _registerApp(options) {
    return registerApp(options)
  }

  _requireChannel() {
    if (!this.channel) {
      throw new Error('飞书通道未启动：请先配置应用凭证并连接')
    }
    return this.channel
  }

  /**
   * SDK 日志器适配：SDK 的 LoggerProxy 会按级别调用 error/warn/info/debug/trace，
   * 缺哪个方法就会抛错，因此这里补齐五个方法并统一转发到插件日志器。
   */
  _sdkLogger() {
    return {
      error: (...args) => this.logger?.error?.(...args),
      warn: (...args) => this.logger?.warn?.(...args),
      info: (...args) => this.logger?.info?.(...args),
      debug: (...args) => this.logger?.debug?.(...args),
      trace: () => {},
    }
  }

  /** 路径是否落在 allowedFileDirs 内（用于决定"交给 SDK 读盘"还是"自己读 Buffer"） */
  _isInsideAllowedDirs(filePath) {
    const resolved = path.resolve(filePath)
    return this._allowedFileDirs().some((dir) => {
      const base = path.resolve(dir)
      return resolved === base || resolved.startsWith(base.endsWith(path.sep) ? base : base + path.sep)
    })
  }

  /** 允许 SDK 直接读盘的目录（本地文件源白名单；不在其中则回退 Buffer） */
  _allowedFileDirs() {
    const dirs = [this.config.cwd, process.cwd()].filter((dir) => typeof dir === 'string' && dir.trim())
    return [...new Set(dirs)]
  }

  /** 出站渲染参数 → Channel SDK OutboundConfig */
  _outboundOptions() {
    const chunkLimit = Number(this.config.maxMessageChars)
    return {
      // 超长内容按此上限分片（SDK 负责在代码块边界安全切分）
      textChunkLimit: Number.isFinite(chunkLimit) && chunkLimit >= 200 ? chunkLimit : 2000,
      streamInitialText: STREAM_INITIAL_TEXT,
      // 本地文件源白名单：命中则 SDK 流式读盘上传，避免大文件读进内存
      allowedFileDirs: this._allowedFileDirs(),
    }
  }

  _channelOptions() {
    return {
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      domain: this.config.domain === 'lark' ? Domain.Lark : Domain.Feishu,
      source: 'dsh-bridge',
      logger: this._sdkLogger(),
      // 只放行 SDK 的告警与错误，避免 info 级噪声（如每次连接握手明细）
      loggerLevel: LoggerLevel.warn,
      policy: {
        // 群聊要求 @ 机器人才响应（SDK 默认值，此处显式声明以免默认值变化）
        requireMention: true,
        // 两个机器人互 @ 会无限往返：启用 SDK 内置滑动窗口守卫；
        // onTrip 用 'reject' 而非默认的 'drop'，这样被静默停回时我们能留一条日志
        botLoopGuard: { enabled: true, windowMs: 60_000, maxBotMentions: 5, scope: 'chat', onTrip: 'reject' },
      },
      // 审批卡片与消息共用会话队列会在「消息处理等待卡片点击」时互锁，故卡片动作独立排队
      safety: { chatQueue: { cardActions: 'separate' } },
      outbound: this._outboundOptions(),
      // 填充发送者昵称（每会话一次缓存查询）：群聊里让 agent 知道"谁在说话"、审批卡显示发起人
      resolveSenderNames: true,
      // SDK 内置看门狗：连接假死时强制重连，仍失败则回调上报
      keepalive: {
        enabled: true,
        onUnrecoverable: (err) => {
          this.logger.error?.('[dsh-bridge feishu] 连接不可恢复：%s', err?.message ?? err)
          this.setStatus('error', err instanceof Error ? err : new Error(String(err)))
        },
      },
    }
  }

  // ---- 生命周期 ----

  async start() {
    if (!this.configured) {
      this.setStatus('idle')
      return false
    }
    if (this.status === 'online') return true
    if (this._startingPromise) return this._startingPromise

    this._closing = false
    this.setStatus('starting')

    this._startingPromise = (async () => {
      // 旧实例（断线重连 / 凭证变更）先释放，避免双连接分流事件
      await this._teardownChannel()
      try {
        const channel = this._createChannel(this._channelOptions())
        this.channel = channel
        this._bindChannelEvents(channel)
        await channel.connect()
        this.botInfo = this._toBotInfo(channel.getBotIdentity())
        this.setStatus('online')
        this.logger.info?.(
          '[dsh-bridge feishu] 已连接飞书开放平台：%s (%s)',
          this.botInfo.appName || '(unknown)',
          this.botInfo.openId || this.config.appId,
        )
        // 斜杠指令面板同步（默认开启，异步执行，失败不影响消息收发）
        void this.syncSlashCommands()
        return true
      } catch (err) {
        this.logger.error?.('[dsh-bridge feishu] 连接失败：%s', err?.message ?? err)
        await this._teardownChannel()
        this.setStatus('error', err)
        return false
      } finally {
        this._startingPromise = null
      }
    })()

    return this._startingPromise
  }

  async stop() {
    this._closing = true
    await this._teardownChannel()
    this.botInfo = null
    this.setStatus('offline')
    return true
  }

  dispose() {
    void this.stop()
  }

  async _teardownChannel() {
    this._tenantToken = null
    this._slashCommandsDisabled = false
    for (const off of this._unsubscribes) {
      try { off?.() } catch { /* 忽略退订异常 */ }
    }
    this._unsubscribes = []
    const channel = this.channel
    this.channel = null
    if (!channel) return
    try {
      await channel.disconnect()
    } catch (err) {
      this.logger.warn?.('[dsh-bridge feishu] disconnect 异常：%s', err?.message ?? err)
    }
  }

  /** NormalizedMessage / cardAction → 会话桥事件；错误与连接状态变化 → 状态事件 */
  _bindChannelEvents(channel) {
    const offMessage = channel.on('message', (msg) => this._emitInbound(msg))
    const offAction = channel.on('cardAction', (evt) => this._handleCardAction(evt))
    const offError = channel.on('error', (err) => {
      this.logger.error?.('[dsh-bridge feishu] 通道错误 [%s]：%s', err?.code ?? 'unknown', err?.message ?? err)
    })
    // 策略拒绝（未 @、白名单外、bot 回环等）留痕：默认仅在 debug 级，便于用户自查"为什么没响应"
    const offReject = channel.on('reject', (evt) => {
      this.logger.debug?.('[dsh-bridge feishu] 消息被策略拒绝 reason=%s chat=%s sender=%s', evt?.reason, evt?.chatId, evt?.senderId)
    })
    const offComment = channel.on('comment', (evt) => this._emitComment(evt))
    const offReconnecting = channel.on('reconnecting', () => this.setStatus('reconnecting'))
    const offReconnected = channel.on('reconnected', () => this.setStatus('online'))
    this._unsubscribes = [offMessage, offAction, offComment, offError, offReject, offReconnecting, offReconnected]
  }

  _emitInbound(msg) {
    this.ctx.emit('feishu/message', {
      instanceId: this.instanceId,
      // 出站目标一律使用会话 chat_id（oc_…）：飞书已限制按用户 open_id 主动发消息（错误码 230101）
      peerId: msg.chatId,
      chatId: msg.chatId,
      chatType: msg.chatType,
      isGroup: msg.chatType === 'group',
      // 发送者身份（open_id）：白名单与审批决议者校验使用
      senderId: msg.senderId,
      senderName: msg.senderName,
      messageId: msg.messageId,
      // 话题群（threadId 非空）出站要留在话题内；replyToMessageId 用于补齐"引用消息"上下文
      threadId: msg.threadId ?? '',
      replyToMessageId: msg.replyToMessageId ?? '',
      text: msg.content,
      rawContentType: msg.rawContentType,
      resources: msg.resources ?? [],
      mentionedBot: msg.mentionedBot,
      createTime: msg.createTime,
    })
  }

  /** 云文档评论事件 → 会话桥（正文需异步拉取，见 fetchComment） */
  _emitComment(evt) {
    this.ctx.emit('feishu/comment', {
      instanceId: this.instanceId,
      fileToken: evt?.fileToken ?? '',
      fileType: evt?.fileType ?? '',
      commentId: evt?.commentId ?? '',
      replyId: evt?.replyId ?? '',
      operatorId: evt?.operator?.openId ?? '',
      mentionedBot: Boolean(evt?.mentionedBot),
      timestamp: Number(evt?.timestamp) || Date.now(),
    })
  }

  /**
   * 拉取评论正文并登记评论会话（供出站回复）。
   * @returns {Promise<{text:string, quote:string, isWhole:boolean, replyId:string}|null>}
   */
  async fetchComment({ peerId, fileToken, fileType, commentId }) {
    const channel = this._requireChannel()
    const target = await channel.comments.resolveTarget(fileToken, fileType)
    if (!target) {
      this.logger.debug?.('[dsh-bridge feishu] 评论目标不支持：fileType=%s', fileType)
      return null
    }
    const fetched = await channel.comments.fetch(target, commentId)
    if (!fetched) {
      this.logger.debug?.('[dsh-bridge feishu] 评论不存在或不可见：%s', commentId)
      return null
    }
    this._registerCommentPeer(peerId, { target, commentId, isWhole: Boolean(fetched.isWhole) })
    return extractCommentInput(fetched)
  }

  _registerCommentPeer(peerId, entry) {
    if (!peerId) return
    this._commentPeers.set(peerId, entry)
    // 带上限：只保留最近 200 个评论会话（避免长跑内存增长）
    while (this._commentPeers.size > 200) {
      const oldest = this._commentPeers.keys().next().value
      this._commentPeers.delete(oldest)
    }
  }

  /** 评论回复（纯文本；整篇文档评论直接发顶层，省掉 SDK 的 in-thread 探测） */
  async sendCommentReply(peerId, text) {
    const entry = this._commentPeers.get(peerId)
    if (!entry) throw new Error('评论会话未登记：请先由评论事件触发')
    const channel = this._requireChannel()
    await channel.comments.reply(entry.target, entry.commentId, text, entry.isWhole ? { topLevel: true } : undefined)
  }

  _handleCardAction(evt) {
    const value = evt?.action?.value ?? {}
    this.ctx.emit('feishu/action', {
      instanceId: this.instanceId,
      operatorId: evt?.operator?.openId ?? '',
      operatorName: evt?.operator?.name ?? '',
      action: value.action ?? evt?.action?.tag,
      value,
      messageId: evt?.messageId,
      chatId: evt?.chatId,
    })
    const actionName = value.action === 'approve' ? '已批准' : value.action === 'reject' ? '已拒绝' : '已操作'
    return { toast: { type: 'success', content: `操作成功：${actionName}` } }
  }

  _toBotInfo(identity) {
    if (!identity) return null
    return { openId: identity.openId || '', appName: identity.name || '', userId: identity.userId }
  }

  // ---- 出站 ----

  /**
   * 发送 Markdown 文本（非流式）。
   * @param {string} to 会话 chat_id（oc_…）
   * @param {string} text Markdown 正文
   * @param {object} [opts] SDK SendOptions：{ replyTo, replyInThread }（话题群留在话题内用）
   */
  async sendText(to, text, opts = {}) {
    const raw = String(text ?? '').trim()
    if (!raw) return null
    // 评论会话：只能发纯文本评论回复（无卡片/无流式），原样发送不做 Markdown 归一化
    if (isCommentPeerId(to)) {
      await this.sendCommentReply(to, raw)
      return null
    }
    const content = normalizeFeishuMarkdown(raw)
    // 含表格的内容改用交互卡片渲染：post（`md` 元素）在部分客户端（实测鸿蒙版飞书）不渲染表格，
    // 卡片走另一套渲染器、且与重构前观感一致；无表格仍走 SDK 的 post 路径（保留其分片/重试/降级）。
    if (!hasMarkdownTable(content)) return this._requireChannel().send(to, { markdown: content }, opts)
    return this._sendMarkdownCards(to, content, opts)
  }

  /**
   * 以交互卡片发送（含表格的回复）：按单条消息上限分片，跨片自动补表头，失败回退富文本。
   */
  async _sendMarkdownCards(to, content, opts = {}) {
    const channel = this._requireChannel()
    const limit = this._outboundOptions().textChunkLimit
    const chunks = splitMarkdownForCards(content, limit)
    const messageIds = []
    try {
      for (const chunk of chunks) {
        const res = await channel.send(to, { card: buildMarkdownCard(chunk) }, opts)
        if (res?.messageId) messageIds.push(res.messageId)
      }
      return { messageId: messageIds[0], chunkIds: messageIds }
    } catch (err) {
      if (messageIds.length > 0) {
        // 已发出部分分片：不重发整段（避免重复内容），只如实上报
        this.logger.warn?.('[dsh-bridge feishu] 卡片分片发送中断（已发出 %d/%d）：%s', messageIds.length, chunks.length, err?.message ?? err)
        return { messageId: messageIds[0], chunkIds: messageIds }
      }
      this.logger.warn?.('[dsh-bridge feishu] 卡片发送失败，回退富文本：%s', err?.message ?? err)
      return channel.send(to, { markdown: content }, opts)
    }
  }

  /**
   * 发送飞书原生交互卡片（审批按钮等）。
   * @param {string} to 会话 chat_id（oc_…）
   * @param {object} card CardKit JSON 2.0
   */
  async sendCard(to, card, opts = {}) {
    if (!card) return null
    return this._requireChannel().send(to, { card }, opts)
  }

  /**
   * 发送本地文件/图片。
   *
   * 以 Buffer 作为媒体源：SDK 对「本地路径」源要求构造期配置 outbound.allowedFileDirs，
   * 而 dsh-bridge 的工作区目录在运行期可变（多工作区 / 会话级 cwd），无法事先枚举；
   * Buffer 是 SDK 文档明确支持的等价源（docs/dev/lark-sdk/README.zh.md「媒体 source」）。
   * 路径安全由上层会话桥的 SEND_FILE 白名单校验负责。
   */
  async sendMediaFile(to, filePath, opts = {}) {
    if (!filePath) return { success: false, error: '缺少文件路径' }
    if (isCommentPeerId(to)) {
      this.logger.warn?.('[dsh-bridge feishu] 评论会话不支持发送文件，已忽略：%s', filePath)
      return { success: false, error: '评论会话不支持发送文件' }
    }
    const fileName = path.basename(filePath)
    const isImage = IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase())
    // 命中 allowedFileDirs 的本地文件直接交给 SDK 读盘（流式，不占内存）；否则回退 Buffer
    const inAllowedDir = this._isInsideAllowedDirs(filePath)
    let source
    if (!inAllowedDir) {
      try {
        source = await fs.readFile(filePath)
      } catch (err) {
        const message = err?.message ?? String(err)
        this.logger.warn?.('[dsh-bridge feishu] 读取待发送文件失败 %s：%s', filePath, message)
        return { success: false, error: message }
      }
    } else {
      source = filePath
    }
    try {
      const result = isImage
        ? await this._requireChannel().send(to, { image: { source } }, opts)
        : await this._requireChannel().send(to, { file: { source, fileName } }, opts)
      return { success: true, messageId: result?.messageId }
    } catch (err) {
      const message = err?.message ?? String(err)
      this.logger.warn?.('[dsh-bridge feishu] 发送文件失败 %s：%s', fileName, message)
      return { success: false, error: message }
    }
  }

  /**
   * 创建 CardKit 卡片实体（`cardkit.v1.card.create`）。
   * 与"内联卡片消息"的区别：实体可被 {@link updateCardById} 原地整卡更新，
   * 因此审批卡片能在决议后直接变成结果态，而不是再补一条文字消息。
   *
   * @param {object} cardJson CardKit JSON 2.0
   * @returns {Promise<string|null>} card_id
   */
  async createCard(cardJson) {
    const res = await this._requireChannel().createCard(cardJson)
    return res?.cardId ?? null
  }

  /** 发送一条"引用卡片实体"的交互消息（消息内容随实体更新而重渲染） */
  async sendCardRef(to, cardId, opts = {}) {
    return this._requireChannel().send(to, { cardId }, opts)
  }

  /** 按 card_id 整卡更新；sequence 必须严格递增（飞书会拒绝乱序更新） */
  async updateCardById(cardId, cardJson, sequence) {
    return this._requireChannel().updateCardById(cardId, cardJson, sequence)
  }

  /**
   * 开启一段流式卡片（一轮 agent 输出对应一张卡片）。
   *
   * SDK 负责建卡、节流、超限自动换卡与收尾（关闭 streaming_mode）；
   * 调用方拿到控制器后按需 setContent 覆盖内容，最后 finish() 收尾。
   *
   * @param {string} to 会话 chat_id（oc_…）
   * @returns {Promise<{ setContent: (full: string) => Promise<void>, finish: () => Promise<void> }>}
   */
  async openStream(to, opts = {}) {
    const channel = this._requireChannel()
    let releaseFinish
    const finishGate = new Promise((resolve) => { releaseFinish = resolve })
    const state = { controller: null }
    let settleReady
    const ready = new Promise((resolve, reject) => { settleReady = { resolve, reject } })

    const run = channel
      .stream(to, {
        markdown: async (controller) => {
          state.controller = controller
          settleReady.resolve()
          await finishGate
        },
      }, opts)
      .catch((err) => {
        this.logger.warn?.('[dsh-bridge feishu] 流式卡片失败 [%s]：%s', err?.code ?? 'unknown', err?.message ?? err)
        settleReady.reject(err)
        return null
      })

    // 建卡失败（权限 / 网络）在这里抛出，由调用方降级为普通消息
    await ready

    let finished = false
    return {
      setContent: async (full) => {
        // 流式卡片同样按飞书 markdown 规则归一化（表格需空行分隔）
        await state.controller.setContent(normalizeFeishuMarkdown(full))
      },
      finish: async () => {
        if (finished) return
        finished = true
        releaseFinish()
        await run
      },
    }
  }

  /**
   * 取 tenant_access_token（经 SDK 生成的 auth.v3.tenantAccessToken.internal 获取，本地缓存）。
   * 走 SDK 生成接口而非裸 HTTP，token 获取/刷新规则仍由官方接口定义。
   */
  async _getTenantToken(client) {
    const now = Date.now()
    if (this._tenantToken && this._tenantToken.expiresAt > now) return this._tenantToken.token

    const res = await client.auth?.v3?.tenantAccessToken?.internal({
      data: { app_id: this.config.appId, app_secret: this.config.appSecret },
    })
    const body = res?.tenant_access_token ? res : (res?.data ?? {})
    const token = body.tenant_access_token
    if (!token) throw new Error(`获取 tenant_access_token 失败：${body.msg ?? res?.msg ?? 'unknown'}`)
    const expireSec = Number(body.expire) || 7200
    // 提前 3 分钟失效，避免边界过期（官方 token 有效期 2 小时）
    this._tenantToken = { token, expiresAt: now + Math.max(60, expireSec - 180) * 1000 }
    return token
  }

  /**
   * 把插件支持的指令注册到飞书输入框的「/」指令面板（Slash Command）。
   *
   * 默认开启、幂等：连接成功后异步执行；缺少权限时只记一条 warn 并停止重试，
   * 不影响消息收发（指令仍可手打，例如 `/help`）。
   */
  async syncSlashCommands() {
    if (this._slashCommandsDisabled) return { ok: false, error: { message: 'slash command sync disabled' } }
    const channel = this.channel
    // 防御式判断：正常连接后 rawClient 一定存在（Channel SDK 的逃生通道）
    if (!channel?.rawClient) {
      this.logger.debug?.('[dsh-bridge feishu] 跳过斜杠指令同步：通道未就绪')
      return { ok: false, error: { message: '通道未连接' } }
    }

    let result
    try {
      result = await syncSlashCommands({
        client: channel.rawClient,
        getToken: () => this._getTenantToken(channel.rawClient),
        logger: this.logger,
        managedIds: this.config.slashCommandIds ?? {},
      })
    } catch (err) {
      // 兜底：同步失败绝不能影响消息收发（调用方多为 void 调用）
      this.logger.warn?.('[dsh-bridge feishu] 斜杠指令同步异常：%s', err?.message ?? err)
      return { ok: false, error: { message: err?.message ?? String(err) } }
    }

    // 已创建/更新的映射需要落盘，便于后续更新与清理（含部分成功的情况）
    if (result.ids && JSON.stringify(result.ids) !== JSON.stringify(this.config.slashCommandIds ?? {})) {
      this.config.slashCommandIds = result.ids
      try {
        this.onSlashCommandIds?.(result.ids)
      } catch (err) {
        this.logger.warn?.('[dsh-bridge feishu] 斜杠指令映射持久化失败：%s', err?.message ?? err)
      }
    }

    if (result.ok) {
      this.logger.info?.(
        '[dsh-bridge feishu] 斜杠指令同步完成：新增 %d / 更新 %d / 已存在 %d / 清理 %d（客户端面板最长约 8 分钟后可见）',
        result.created.length, result.updated.length, result.adopted.length, result.deleted.length,
      )
      return result
    }

    if (isPermissionErrorCode(result.error?.code)) {
      this._slashCommandsDisabled = true
      this.logger.warn?.(
        '[dsh-bridge feishu] 未注册斜杠指令：应用缺少 application:app_slash_command 权限（或未发布）——%s。'
        + '可在开放平台补权限后重新发布，或使用面板「扫码一键创建应用」（默认已含该权限）。',
        result.error?.message,
      )
    } else {
      this.logger.warn?.('[dsh-bridge feishu] 斜杠指令同步失败：%s', result.error?.message)
    }
    return result
  }

  /** 取某条消息（归一化后）——用于补齐用户"引用回复"时的被引用内容 */
  fetchMessage(messageId) {
    return this._requireChannel().fetchMessage(messageId)
  }

  /**
   * 下载消息中的资源到本地文件（SDK 以流式落盘，避免大文件堆积在内存）。
   */
  downloadResourceToFile(messageId, fileKey, type, destPath) {
    return this._requireChannel().downloadResourceToFile(messageId, fileKey, type, destPath)
  }

  /**
   * 一键扫码创建应用（OAuth 2.0 设备码流程）。
   * 返回 { client_id, client_secret, user_info }，由上层持久化后连接。
   */
  registerApp(options) {
    return this._registerApp(options)
  }
}
