// dsh-bridge Feishu / Lark conversation node
// 把飞书 Channel SDK 归一化后的入站消息交给平台无关的 ConversationBridge 处理，
// 出站经 FeishuGateway（官方 Channel SDK）发送文本 / 卡片 / 文件，轮次内使用流式卡片。

import fs from 'node:fs'
import path from 'node:path'
import { ConversationBridge } from '../platform/conversation-bridge.js'
import { cumulativeSlices } from '../platform/stream-slices.js'
import { buildCommentPeerId, isCommentPeerId } from './comment.js'

/** 审批结果 → 卡片标题/配色（CardKit header template 取值：blue/green/red/orange/grey…） */
const APPROVAL_RESOLUTIONS = {
  approved: { emoji: '✅', text: '**已批准执行**', template: 'green' },
  rejected: { emoji: '❌', text: '**已拒绝执行**', template: 'red' },
  timeout: { emoji: '⏰', text: '**已超时（自动拒绝）**', template: 'grey' },
  cancelled: { emoji: '⚪', text: '**已取消**（任务中止）', template: 'grey' },
}

/** 纯媒体消息类型：SDK 归一化后的 content 是占位标记（如 `![](image_key)`、`<file .../>`），
 *  不投喂给模型；附件一律以下载后的本地路径描述（与既有行为一致）。 */
const MEDIA_ONLY_TYPES = new Set(['image', 'file', 'audio', 'video', 'media', 'sticker'])

function makePlatform(gateway) {
  return {
    id: 'feishu',
    name: 'Feishu / Lark',
    get status() { return gateway?.status ?? 'idle' },
    // 能力字段与 base.js 约定对齐
    capabilities: { supportsGroup: true, supportsMedia: true, supportsTyping: false, maxMessageChars: 2000 },
    async sendText(peerId, text, opts = {}) {
      return gateway?.sendText(peerId, text, opts)
    },
    async sendMediaFile(peerId, filePath, opts = {}) {
      return gateway?.sendMediaFile(peerId, filePath, opts)
    },
    async sendTyping() {},
  dispose() {},
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function splitChunksByNewline(content, maxChunk = 150) {
  const chunks = []
  let start = 0
  while (start < content.length) {
    if (content.length - start <= maxChunk) {
      chunks.push(content.slice(start))
      break
    }
    const windowStart = start + Math.floor(maxChunk * 0.6)
    const windowEnd = start + maxChunk
    let cut = content.lastIndexOf('\n', windowEnd)
    if (cut <= windowStart || cut === -1) cut = windowEnd
    chunks.push(content.slice(start, cut))
    start = cut
  }
  if (chunks.length <= 1 && content.length > 30) {
    const step = Math.max(20, Math.floor(content.length / 4))
    chunks.length = 0
    for (let i = 0; i < content.length; i += step) {
      chunks.push(content.slice(i, Math.min(i + step, content.length)))
    }
  }
  return chunks
}

function splitIntoIncremental(content, maxChunk = 150) {
  return cumulativeSlices(splitChunksByNewline(content, maxChunk))
}

/**
 * 按文件**魔数**推断真实格式（只认几种常见签名，识别不出返回 null、绝不瞎猜）。
 *
 * 为什么需要：飞书图片不带文件名，旧实现一律按 `.png` 命名，而图片实际多为 JPEG
 * （2026-10-16 真机实测：截图是 JPEG 字节却存成 .png，按扩展名读取报"格式不符"、
 * 用户也打不开）。文件/音视频同样可能缺文件名，会退化成无意义的 `.bin`。
 *
 * @param {Buffer} head 文件开头若干字节
 * @returns {string|null} 形如 '.jpg'；无法识别返回 null
 */
function sniffExtension(head) {
  if (!head || head.length < 3) return null
  const ascii = (start, len) => head.subarray(start, start + len).toString('ascii')
  // 图片
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return '.jpg'
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png'
  if (ascii(0, 3) === 'GIF') return '.gif'
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return '.webp'
  if (head[0] === 0x42 && head[1] === 0x4d) return '.bmp'
  // 文档 / 归档（docx/xlsx/pptx 本质是 zip，无法从魔数细分，统一给 .zip 更诚实）
  if (ascii(0, 4) === '%PDF') return '.pdf'
  if (head[0] === 0x50 && head[1] === 0x4b && (head[2] === 0x03 || head[2] === 0x05 || head[2] === 0x07)) return '.zip'
  if (head[0] === 0x1f && head[1] === 0x8b) return '.gz'
  if (ascii(0, 4) === 'Rar!') return '.rar'
  if (head[0] === 0x37 && head[1] === 0x7a && head[2] === 0xbc && head[3] === 0xaf) return '.7z'
  // 音视频
  if (ascii(0, 4) === 'fLaC') return '.flac'
  if (ascii(0, 3) === 'ID3') return '.mp3'
  if (ascii(0, 4) === 'OggS') return '.ogg'
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') return '.wav'
  if (head.length >= 12 && ascii(4, 4) === 'ftyp') return '.mp4'
  return null
}

/** 读取文件头部若干字节（失败返回 null）。 */
async function readHead(filePath, len = 16) {
  try {
    const fh = await fs.promises.open(filePath, 'r')
    try {
      const buf = Buffer.alloc(len)
      const { bytesRead } = await fh.read(buf, 0, len, 0)
      return buf.subarray(0, bytesRead)
    } finally {
      await fh.close()
    }
  } catch { return null }
}

/** 无意义/占位的扩展名：这些情况下按魔数校正不会覆盖用户的真实意图。 */
const PLACEHOLDER_EXTS = new Set(['', '.bin', '.dat', '.tmp'])

/**
 * 校正落盘文件的扩展名，使其与**实际字节**一致。
 *
 * 规则（刻意保守，避免"自作聪明"改掉用户明确给的名字）：
 *   - 图片：一律校正——飞书图片通常不带文件名，且实测存在扩展名与实际格式不符；
 *   - 其它资源：仅在**没有扩展名**或扩展名是占位值（.bin/.dat/.tmp）时按魔数补全，
 *     用户明确给的名字（如 `报告.pdf`）原样保留。
 * 识别不出格式就保持原样（宁可留 `.bin`，也不猜错）。
 *
 * @param {string} filePath 落盘路径
 * @param {boolean} isImage 资源是否声明为图片
 * @returns {Promise<string>} 校正后的路径（必要时已重命名）
 */
async function correctMediaExtension(filePath, isImage) {
  const current = path.extname(filePath).toLowerCase()
  const isPlaceholder = PLACEHOLDER_EXTS.has(current)
  // 图片之外、且已有明确扩展名 → 尊重用户给的名字，不动
  if (!isImage && !isPlaceholder) return filePath

  const head = await readHead(filePath)
  const wanted = sniffExtension(head)
  if (!wanted) return filePath
  // .jpeg 与 .jpg 等价，无需改名
  if (current === wanted || (wanted === '.jpg' && current === '.jpeg')) return filePath

  const renamed = path.join(path.dirname(filePath), `${path.basename(filePath, path.extname(filePath))}${wanted}`)
  try {
    await fs.promises.rename(filePath, renamed)
    return renamed
  } catch {
    // 重命名失败（跨设备/竞态）不致命：保留原路径
    return filePath
  }
}

export class FeishuConversationNode extends ConversationBridge {
  constructor(ctx, config, logger, { onFirstSender, onActiveSessionChange } = {}) {
    super({
      ctx,
      logger,
      config,
      platform: makePlatform(ctx.feishu),
      onFirstSender,
      onActiveSessionChange,
    })
    this.gateway = ctx.feishu
    this._lastPeer = null // { peerId(chat_id), senderId(open_id), isGroup }
    this._stream = null   // 当前轮次的流式卡片控制器 { to, setContent, finish }
    this._approvalOperatorName = '' // 最近一次按钮决议者昵称（飞书提供时用于卡片结果行）
    this._commentPeers = new Set()  // 已处理过的评论会话（同线程后续回复不再要求 @）
    this._commentBuffers = new Map() // 评论轮次的出站缓冲：peerId → 文本（turn/end 统一发一条）
    this._inTurn = false

    // 订阅网关入站消息事件
    this.disposers.push(this.ctx.on('feishu/message', (event) => this._handleInbound(event)))

    // 订阅云文档评论事件（@机器人 提问）
    this.disposers.push(this.ctx.on('feishu/comment', (event) => this._handleComment(event)))

    // 订阅卡片交互事件（审批按钮点击）
    this.disposers.push(this.ctx.on('feishu/action', (event) => this._handleAction(event)))

    // 连接断开/错误时收尾未完成的流式卡片，避免流式控制器悬挂
    this.disposers.push(this.ctx.on('feishu/status', (status) => {
      if (status?.status === 'offline' || status?.status === 'error') void this._finishStream()
    }))

    // 监听轮次事件：turn/start 开启流式会话，turn/end 收尾
    this.disposers.push(this.ctx.on('session/event', (session, event) => {
      if (session.id !== this.activeSessionId) return
      if (event.type === 'turn/start') {
        // 上一轮若因异常未收到 turn/end，先收尾旧卡片再开新一轮
        void this._finishStream()
        this._inTurn = true
      } else if (event.type === 'turn/end') {
        this._inTurn = false
        void this._finishStream()
        void this._flushCommentBuffers()
      }
    }))
  }

  async _handleInbound(event) {
    if (this.gateway?._closing || this.gateway?.status === 'offline') return
    const { chatId, senderId, isGroup, messageId, resources, rawContentType } = event
    const threadId = event.threadId ?? ''
    const senderName = event.senderName ?? ''
    this._lastPeer = { peerId: chatId, senderId, isGroup, messageId, threadId, senderName }

    // 纯媒体消息的 content 是 SDK 占位标记，不作为正文
    let text = MEDIA_ONLY_TYPES.has(rawContentType) ? '' : (event.text || '')

    let mediaFiles = []
    if (resources?.length) {
      mediaFiles = await this._processMedia({ messageId, resources }, this._activeSessionCwd() || this.config.cwd)
    }

    if (!text && mediaFiles.length === 0) {
      this.logger.debug?.(`[dsh-bridge feishu] ignore empty message from ${chatId}`)
      return
    }

    let fullText = text
    // 群聊里让 agent 知道"谁在说话"（昵称由 SDK 按会话成员表填充，p2p 无需标注）
    if (isGroup && senderName) fullText = `[来自 ${senderName}] ${fullText}`
    if (mediaFiles.length > 0) {
      const mediaDesc = mediaFiles.map((f) => `[文件: ${f.path}]`).join('\n')
      fullText = fullText ? `${fullText}\n\n${mediaDesc}` : mediaDesc
    }

    // 引用回复：拉取被引用消息正文作为上下文（否则模型看不到"他引用的那句话"）
    const quoted = await this._fetchQuotedContext(event)
    if (quoted) fullText = `[引用消息] ${quoted}\n\n${fullText}`

    this.logger.debug?.(`[dsh-bridge feishu] handling inbound message from ${chatId} (group=${isGroup}): ${fullText}`)

    // 如果还没有活动会话，且是首条消息，自动尝试选择最新已有会话
    if (!this.activeSessionId) {
      await this._pickDefaultSession().catch(() => {})
    }

    // 转交通用 ConversationBridge 路由
    // 单聊/群聊的出站目标统一是 chat_id（oc_…）——飞书已限制按发送者 open_id 主动发消息（230101）；
    // 群聊以"群"为授权主体，单聊以发送者 open_id 为身份（白名单 / 审批决议者校验）。
    return this.handleInbound({
      senderId: isGroup ? chatId : senderId,
      isGroup,
      text: fullText,
      senderLabel: senderName,
      outboundPeer: { peerId: chatId, isGroup, messageId, threadId },
    })
  }

  /**
   * 云文档评论入站：@机器人（或同一评论线程内的后续回复）→ 拉正文 → 交给会话桥。
   * 评论只能回纯文本、无卡片，因此合成 peer `comment:<fileToken>:<commentId>` 并在出站侧分流。
   */
  async _handleComment(event) {
    if (this.gateway?._closing || this.gateway?.status === 'offline') return
    const peerId = buildCommentPeerId(event)
    const known = this._commentPeers.has(peerId)
    if (!event.mentionedBot && !known) {
      this.logger.debug?.('[dsh-bridge feishu] 忽略未 @机器人 的评论：%s', peerId)
      return
    }

    let detail
    try {
      detail = await this.gateway.fetchComment({
        peerId,
        fileToken: event.fileToken,
        fileType: event.fileType,
        commentId: event.commentId,
      })
    } catch (err) {
      this.logger.warn?.('[dsh-bridge feishu] 拉取评论失败：%s', err?.message ?? err)
      return
    }
    if (!detail) return

    if (this._commentPeers.size >= 200) {
      const oldest = this._commentPeers.values().next().value
      this._commentPeers.delete(oldest)
    }
    this._commentPeers.add(peerId)
    this._lastPeer = { peerId, senderId: event.operatorId, isGroup: false, messageId: '', threadId: '', senderName: '' }

    let text = detail.text
    // 评论里的 @机器人 会被拍平成 `@<open_id>` 之类的占位，去掉机器人自身提及
    const botOpenId = this.gateway?.botInfo?.openId
    if (botOpenId) text = text.split(`@${botOpenId}`).join(' ')
    if (detail.quote) text = `[选中内容] ${detail.quote}\n\n${text}`
    text = text.trim()
    if (!text) {
      this.logger.debug?.('[dsh-bridge feishu] 评论正文为空，忽略：%s', peerId)
      return
    }

    if (!this.activeSessionId) await this._pickDefaultSession().catch(() => {})
    return this.handleInbound({
      senderId: event.operatorId,
      isGroup: false,
      text,
      outboundPeer: { peerId, isGroup: false, comment: true },
    })
  }

  /** 评论轮次的出站先缓冲，turn/end 时合并成一条评论回复（评论无流式/卡片） */
  async _flushCommentBuffers() {
    if (this._commentBuffers.size === 0) return
    const pending = [...this._commentBuffers.entries()]
    this._commentBuffers.clear()
    for (const [peerId, text] of pending) {
      try {
        await this.gateway.sendText(peerId, text)
      } catch (err) {
        this.logger.warn?.('[dsh-bridge feishu] 评论回复发送失败：%s', err?.message ?? err)
      }
    }
  }

  /**
   * 取"引用回复"的被引用正文（截断），失败静默降级为无上下文。
   * 只服务于普通会话的引用；话题群每条消息都带 parent_id/thread_id，若也去拉取会变成每条一次接口调用，
   * 且话题内的位置语义已由 replyInThread 承载，故跳过。
   */
  async _fetchQuotedContext(event) {
    if (!event?.replyToMessageId || event?.threadId) return ''
    try {
      const quoted = await this.gateway.fetchMessage(event.replyToMessageId)
      const content = String(quoted?.content ?? '').trim()
      if (!content) return ''
      return content.length > 600 ? `${content.slice(0, 600)}…` : content
    } catch (err) {
      this.logger.debug?.('[dsh-bridge feishu] 拉取引用消息失败：%s', err?.message ?? err)
      return ''
    }
  }

  /** 出站参数：话题群里的回复留在原话题内（普通会话保持不引用，观感与既往一致） */
  _replyOptions(source) {
    if (!source?.threadId || !source?.messageId) return {}
    return { replyTo: source.messageId, replyInThread: true }
  }

  /** 当前活动会话的工作区（DSH 把 cwd 放在 session.header.cwd；顶层无 cwd） */
  _activeSessionCwd() {
    const id = this.activeSessionId
    if (!id) return ''
    try {
      const sessions = this.ctx.sessions
      const sess = sessions?.get?.(id) ?? sessions?.list?.().find((s) => s?.id === id)
      return sess?.header?.cwd || sess?.cwd || ''
    } catch { return '' }
  }

  /**
   * 下载消息附件到会话工作区的 .feishu-media 目录。
   * SDK 的 downloadResourceToFile 直接流式落盘（大文件不进内存）。
   */
  async _processMedia({ messageId, resources }, sessionCwd) {
    if (!messageId || !resources?.length) return []
    const mediaDir = path.join(sessionCwd || this.config.cwd || process.cwd(), '.feishu-media')
    try { await fs.promises.mkdir(mediaDir, { recursive: true }) } catch {}

    const downloaded = []
    for (const resource of resources) {
      // SDK 约定：图片资源用 'image'，其余（文件/音视频/表情）统一 'file'
      const type = resource.type === 'image' ? 'image' : 'file'
      const fileName = resource.fileName
      const ext = fileName ? path.extname(fileName) : (type === 'image' ? '.png' : '.bin')
      const safeName = fileName
        ? path.basename(fileName)
        : `feishu_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`
      const filePath = path.join(mediaDir, safeName)
      try {
        const result = await this.gateway.downloadResourceToFile(messageId, resource.fileKey, type, filePath)
        const size = result?.bytesWritten ?? 0
        if (size <= 0) {
          this.logger.warn?.(`[dsh-bridge feishu] download media empty: ${safeName}`)
          continue
        }
        // 校正扩展名使其与**实际字节**一致：图片一律校正（飞书图片通常不带文件名，
        // 实测存在扩展名与实际格式不符）；文件/音视频在缺扩展名或为占位值（.bin 等）时
        // 按魔数补全，用户明确给的名字保持不动。
        const finalPath = await correctMediaExtension(filePath, resource.type === 'image')
        const finalName = path.basename(finalPath)
        downloaded.push({ filename: finalName, path: finalPath, size })
        this.logger.info?.(`[dsh-bridge feishu] downloaded media ${finalName} (${size} bytes)`)
      } catch (err) {
        this.logger.warn?.(`[dsh-bridge feishu] download media failed: ${err?.message ?? err}`)
      }
    }
    return downloaded
  }

  async _handleAction(event) {
    const { operatorId, operatorName, value } = event
    const approvalId = Number(value.approvalId)
    const action = value.action

    if (approvalId && (action === 'approve' || action === 'reject')) {
      const outcome = action === 'approve' ? 'allowed-once' : 'rejected'
      const pending = this.pending.get(approvalId)
      if (pending) {
        // 决议者校验：群聊按"群"整体授权（群内成员均可按钮决议，与 QQ 群模型一致），
        // 不校验成员级 operatorId；单聊严格限定发起者本人（operatorId === 发起者 open_id）。
        if (!pending.isGroup && pending.peerId && operatorId && pending.peerId !== operatorId) {
          this.logger?.warn?.('[dsh-bridge feishu] approval #%d blocked: operator %s is not the initiator %s', approvalId, operatorId, pending.peerId)
          return
        }
        this._approvalOperatorName = operatorName || ''
        this.clearApproval(approvalId)
        pending.resolve(outcome)
      }
      return
    }

    // ---- Agent 决策问答的按钮回调 ----
    // value: { action: 'ask', askId, askOption }（askOption 为选项下标，0-based）
    if (action === 'ask') {
      const askId = Number(value.askId)
      const entry = this.getAsk(askId)
      if (!entry) {
        this.logger?.info?.('[dsh-bridge feishu] ask #%s 按钮点击时问题已结束（或已超时并清理）', value.askId)
        return
      }
      // 作答者校验：单聊限定发起者本人；群聊允许群内成员（与审批同一模型）
      if (!entry.isGroup && entry.peerId && operatorId && entry.peerId !== operatorId) {
        this.logger?.warn?.('[dsh-bridge feishu] ask #%d blocked: operator %s is not the initiator %s', askId, operatorId, entry.peerId)
        return
      }
      const question = entry.questions?.[0]
      const options = Array.isArray(question?.options) ? question.options : []
      const idx = Number(value.askOption)
      if (!Number.isInteger(idx) || idx < 0 || idx >= options.length) return
      const label = String(options[idx]?.label ?? '')
      entry.resolve({ answers: [{ id: question.id, selected: [label] }] })
      return
    }
  }

  /**
   * 渲染"Agent 提问"卡片（单问单选）。
   *
   * 为什么用卡片而不是纯文字：手机端点选比手打 `/ask 1` 顺手得多；而选项文字的
   * 语义（哪个是推荐项、各自代价）需要排版才看得清。
   *
   * 复杂度受控的边界：只在"单问 + 单选 + 选项数适中"时走卡片（canRenderAsButtons），
   * 多选/多问/自由输入一律走文字（`/ask`），避免卡片不能表达时的误导。
   *
   * @returns {boolean} 是否成功送达卡片
   */
  async sendAskCard(peer, question, entry, promptText = '') {
    const options = Array.isArray(question?.options) ? question.options : []
    if (options.length === 0) return false

    const detail = String(question?.detail ?? '').replace(/\|/g, '｜').trim()
    const rows = []
    rows.push(`**${String(question?.question ?? '').replace(/\|/g, '｜')}**`)
    if (detail) rows.push('', detail)
    if (entry.timeoutSec > 0) {
      const min = Math.max(1, Math.round(entry.timeoutSec / 60))
      rows.push('', `> 等待超时：${min} 分钟（超时后 Agent 可能先继续其它工作，你稍后仍可 \`/ask\` 补答）`)
    }

    // 选项做成按钮：**整行铺满**（width: 'fill'）。
    //
    // 曾经的错误做法：把按钮塞进 `column_set` 的 `column`（width: 'weighted'）里。
    // `column` 会按权重分配宽度，而按钮在其中的可用宽度被压缩，长一点的选项文字
    // 会被中间截断成「现在发布 …」（2026-10-16 真机实测，用户截图确认）。
    // 飞书卡片 2.0 的 button 支持 `width: 'fill'`（官方示例：
    // docs/dev/lark-sdk/official-message-content.md 的推荐景点卡），直接铺满即可完整显示。
    //
    // 另外不再对文字做 slice 截断：截断同样会造成"选项看不全"；长文本交给卡片自身换行，
    // 卡片协议本身对 content 有长度上限，超限会在发送处报错并回退文字（有兜底）。
    const buttonElements = options.map((opt, i) => {
      const label = String(opt?.label ?? `选项 ${i + 1}`)
      const recommended = /\(recommended\)|（推荐）/i.test(label)
      const desc = String(opt?.description ?? '').trim()
      const text = `${recommended ? '⭐ ' : ''}${label}${desc ? ` — ${desc}` : ''}`
      return {
        tag: 'button',
        text: { tag: 'plain_text', content: text },
        type: recommended ? 'primary' : 'default',
        width: 'fill',
        size: 'medium',
        value: { action: 'ask', askId: entry.number, askOption: i },
      }
    })

    const elements = [{ tag: 'markdown', content: rows.join('\n') }]
    for (const el of buttonElements) elements.push(el)
    elements.push({ tag: 'markdown', content: '> 也可以文字回复：`/ask 1`（第 1 项）或 `/ask =你的答案`' })

    const card = {
      schema: '2.0',
      header: { title: { tag: 'plain_text', content: `❓ 需要你的决定 (#${entry.number})` }, template: 'blue' },
      body: { elements },
    }

    try {
      await this._finishStream()
      await this.gateway.sendCard(peer?.peerId ?? this.resolveSendTarget(entry.sendOpts), card, this._replyOptions(peer))
      return true
    } catch (err) {
      this.logger?.warn?.('[dsh-bridge feishu] 提问卡片发送失败（回退文字）：%s', err?.message ?? err)
      return false
    }
  }

  /**
   * 出站文本。
   * - 轮次内（turn 期间）：整轮共用一张 SDK 流式卡片（首片按 sendChunkDelayMs 打字机推进，
   *   后续输出覆盖为最新内容），由 SDK 负责建卡、节流、超限换卡与收尾；
   * - 轮次外（指令响应 / 系统提示 / 心跳摘要等）：单条 Markdown 消息，SDK 负责
   *   富文本渲染、超长分片、限流重试与格式错误降级。
   */
  /**
   * 出站目标解析（覆盖基类）：飞书单聊必须发会话 chat_id（oc_…），
   * 发送者 open_id 只用于身份校验（否则会触发 230101）。
   */
  resolveSendTarget(opts = {}) {
    const bound = opts?.outboundPeer && typeof opts.outboundPeer.isGroup === 'boolean' ? opts.outboundPeer : null
    return bound?.peerId || this._lastPeer?.peerId || this.peerId || ''
  }

  async _sendTextNow(text, opts = {}) {
    if (this.platform?.status === 'idle' || this.platform?.status === 'offline') return
    // T2.3：轮次绑定的 outboundPeer（{ peerId, isGroup }）优先生效
    const bound = opts?.outboundPeer && typeof opts.outboundPeer.isGroup === 'boolean' ? opts.outboundPeer : null
    const peerId = this.resolveSendTarget(opts)
    if (!peerId) return
    const content = String(text || '').trim()
    if (!content) return

    // 评论会话：无流式/无卡片，轮次内先缓冲、非轮次直接回一条纯文本
    if (isCommentPeerId(peerId)) {
      if (this._inTurn) {
        const buffered = this._commentBuffers.get(peerId)
        this._commentBuffers.set(peerId, buffered ? `${buffered}\n\n${content}` : content)
        return
      }
      try {
        await this.gateway.sendText(peerId, content)
      } catch (err) {
        this.logger.warn?.('[dsh-bridge feishu] 评论回复发送失败：%s', err?.message ?? err)
      }
      return
    }

    // 话题群：回复留在话题内（bound 优先，其次最近一次入站）
    const replyOpts = this._replyOptions(bound || this._lastPeer)

    try {
      // standalone：本次内容必须独立成条，不得并入轮次流式卡片。
      // 用于"本轮改动摘要"这类**轮次级通知**：宿主在 turn/end 之前发出 workspace/changes
      // （实测 seq 2945 < 2946），此时 _inTurn 仍为 true；若走 _sendTurnOutput 就会被并进
      // 正在输出的卡片、随即被 turn/end 的收尾覆盖 —— 用户侧表现为"摘要一条都收不到"。
      if (this._inTurn && !opts?.standalone) {
        await this._sendTurnOutput(peerId, content, replyOpts)
        return
      }
      // 独立成条前先收尾在途卡片，保证它排在正文之后、不会被后续流式输出吞掉
      if (opts?.standalone && this._stream) await this._finishStream()
      await this.gateway.sendText(peerId, content, replyOpts)
    } catch (err) {
      // 显式记录，绝不静默丢弃（历史问题：出站失败无日志，用户侧完全无感知）
      this.logger.warn?.('[dsh-bridge feishu] outbound send failed：%s', err?.message ?? err)
    }
  }

  async _sendTurnOutput(peerId, content, replyOpts = {}) {
    if (this._stream && this._stream.to === peerId) {
      await this._stream.setContent(content)
      return
    }
    // 目标会话变化（或上一轮残留）：先收尾旧卡片
    await this._finishStream()

    const stream = await this.gateway.openStream(peerId, replyOpts)
    this._stream = { to: peerId, streamRef: stream, setContent: stream.setContent, finish: stream.finish }

    // 首片打字机：与既有行为一致，按 sendChunkDelayMs（100–1000ms）逐段覆盖内容
    const delayMs = Math.min(Math.max(this.config.sendChunkDelayMs ?? 200, 100), 1000)
    const slices = splitIntoIncremental(content, 150)
    for (let i = 0; i < slices.length; i++) {
      if (this._stream?.streamRef !== stream) return
      await stream.setContent(slices[i])
      if (i < slices.length - 1) await sleep(delayMs)
    }
  }

  /** 收尾当前流式卡片（幂等）：关闭 SDK 的 streaming_mode，落定最终内容 */
  async _finishStream() {
    const current = this._stream
    this._stream = null
    if (!current) return
    try {
      await current.finish()
    } catch (err) {
      this.logger.debug?.('[dsh-bridge feishu] stream finish failed: %s', err?.message ?? err)
    }
  }

  /**
   * 审批卡片（CardKit JSON 2.0）。
   * - 待决：详情表 + 「批准 / 拒绝」按钮；
   * - 已决议：附加"决议结果"行、去掉按钮、表头换成结果配色。
   */
  _buildApprovalCard({ number, toolName, reason, timeoutMin, initiator = '', resolution = null }) {
    const meta = resolution ? (APPROVAL_RESOLUTIONS[resolution.status] ?? APPROVAL_RESOLUTIONS.rejected) : null
    const rows = [
      '| 项目 | 详情 |',
      '| :--- | :--- |',
      `| **调用工具** | \`${toolName}\` |`,
      ...(initiator ? [`| **发起人** | ${String(initiator).replace(/\|/g, '｜')} |`] : []),
      ...(reason ? [`| **申请原因** | ${String(reason).replace(/\|/g, '｜')} |`] : []),
      `| **等待超时** | ${timeoutMin} 分钟${resolution ? '' : '（超时自动拒绝）'} |`,
    ]
    if (meta) {
      const operator = resolution.operatorName ? ` · ${resolution.operatorName}` : ''
      rows.push('', `| **决议结果** | ${meta.emoji} ${meta.text}${operator} |`, '', '本次审批已结束')
    }

    // 注意：卡片 JSON 2.0（CardKit）**不支持 note 元素**——曾用它写"已结束"，
    // 服务端整卡更新返回 200861 unsupported tag note，导致结果态更新失败、卡片停在待办态。
    // 因此结果提示统一并入 markdown 元素。
    const elements = [{ tag: 'markdown', content: rows.join('\n') }]
    if (!meta) {
      elements.push({
        tag: 'column_set',
        flex_mode: 'flow',
        columns: [
          {
            tag: 'column',
            width: 'auto',
            elements: [{
              tag: 'button',
              text: { tag: 'plain_text', content: '✓ 批准执行' },
              type: 'primary',
              value: { action: 'approve', approvalId: number },
            }],
          },
          {
            tag: 'column',
            width: 'auto',
            elements: [{
              tag: 'button',
              text: { tag: 'plain_text', content: '✕ 拒绝执行' },
              type: 'danger',
              value: { action: 'reject', approvalId: number },
            }],
          },
        ],
      })
    }

    return {
      schema: '2.0',
      header: {
        title: {
          tag: 'plain_text',
          content: `${meta ? meta.emoji : '⚠️'} 操作权限确认 (#${number})`,
        },
        template: meta ? meta.template : 'orange',
      },
      body: { elements },
    }
  }

  // ---- 飞书专属卡片审批桥 ----
  //
  // 与基类（conversation-bridge）同一归属模型，仅卡片渲染不同：
  //   - 必须 { prepend: true } 注册：否则宿主 apiproxy 的 GUI 认领监听器先行否决，
  //     飞书卡片永远发不出（用户实测：飞书发起审批收不到卡片、Web 反而弹窗）；
  //   - 只拦截"本轮由飞书发起"的轮次（_turnPeers 门槛），Web 轮次放行给宿主；
  //   - 不调用 next()：IM 发起的审批只在 IM 决议，避免 Web 弹窗在 IM 决议后残留。

  _attachApprovalBridge() {
    const listener = async (req, next) => {
      const sessionId = req.agent?.session?.id
      const turn = sessionId ? this._turnPeers.get(sessionId) : null
      if (!turn || !this.ownsAgent(req.agent)) {
        this.logger?.info?.('[dsh-bridge feishu] approval falls through to GUI: not a feishu-initiated turn (session=%s)', sessionId ?? '(none)')
        return next?.()
      }
      const peer = turn.outboundPeer
      if (!peer?.peerId) return next?.()
      if (peer.comment) {
        // 评论会话没有可点的卡片：本轮审批交回宿主 GUI（用户可从远程面板处理）
        this.logger?.info?.('[dsh-bridge feishu] 评论发起的轮次：审批交回宿主 GUI (session=%s)', sessionId ?? '(none)')
        return next?.()
      }
      const initiator = turn.senderId
      const sendOpts = { outboundPeer: peer }

      const number = this.nextApprovalNumber()
      const timeoutSec = this.config.approvalTimeoutSec || 600
      const timeoutMin = Math.max(1, Math.round(timeoutSec / 60))
      const cardContext = {
        number, toolName: req.toolName, reason: req.reason, timeoutMin,
        initiator: turn.senderLabel || '',
      }

      // 优先创建 CardKit 卡片实体：决议后可**原地整卡更新**（内联卡片消息做不到），
      // 无需再补一条"已批准/已拒绝"的文字消息；创建失败则退回内联卡片 + 文字兜底。
      let cardId = null
      try {
        cardId = await this.gateway.createCard(this._buildApprovalCard(cardContext))
      } catch (err) {
        this.logger?.debug?.('[dsh-bridge feishu] 卡片实体创建失败，退回内联卡片：%s', err?.message ?? err)
      }

      // 先收尾本轮已有的流式卡片：否则用户在"审批卡之后"看到的续写会跑到**上方**那张旧卡片里
      // （卡片顺序：旧流式卡 → 审批卡 → 新流式卡，符合阅读顺序）
      await this._finishStream()

      let cardDelivered = false
      try {
        const cardOpts = this._replyOptions(peer)
        if (cardId) await this.gateway.sendCardRef(peer.peerId, cardId, cardOpts)
        else await this.gateway.sendCard(peer.peerId, this._buildApprovalCard(cardContext), cardOpts)
        cardDelivered = true
      } catch (err) {
        this.logger?.warn?.('[dsh-bridge feishu] approval card failed (%s), fallback to markdown', err?.message ?? err)
      }

      if (!cardDelivered) {
        const textFallback = [
          `## ⚠️ 操作权限确认 (#${number})`,
          '',
          `| 项目 | 详情 |`,
          `| :--- | :--- |`,
          `| **调用工具** | \`${req.toolName}\` |`,
          ...(req.reason ? [`| **申请原因** | ${String(req.reason).replace(/\|/g, '｜')} |`] : []),
          `| **等待超时** | ${timeoutMin} 分钟 (超时自动拒绝) |`,
          '',
          `> 回复 \`/yes\` (或 \`1\`) 批准执行`,
          `> 回复 \`/no\` (或 \`2\`) 拒绝执行`,
        ].join('\n')
        void this.sendText(textFallback, sendOpts)
      }

      // sequence 必须严格递增（飞书拒绝乱序更新）
      let cardSequence = 1
      const updateApprovalCard = async (status, operatorName = '') => {
        if (!cardId) return false
        try {
          await this.gateway.updateCardById(
            cardId,
            this._buildApprovalCard({ ...cardContext, resolution: { status, operatorName } }),
            cardSequence++,
          )
          return true
        } catch (err) {
          this.logger?.warn?.('[dsh-bridge feishu] 审批卡片更新失败：%s', err?.message ?? err)
          return false
        }
      }

      let settled = false
      let settledBy = null // 'timeout' | 'abort' | null（用户决议）
      let resolveIm
      const imPromise = new Promise((resolve) => { resolveIm = resolve })
      const settleIm = (outcome) => {
        if (settled) return
        settled = true
        this.clearApproval(number)
        resolveIm(outcome)
      }

      const timer = setTimeout(() => {
        settledBy = 'timeout'
        settleIm('rejected')
      }, timeoutSec * 1000)
      if (typeof timer.unref === 'function') timer.unref()

      // turn 被停止时 DSH 会 abort req.signal：同步取消飞书侧待决审批
      const onSignalAbort = () => {
        settledBy = 'abort'
        settleIm('cancelled')
      }
      req.signal?.addEventListener('abort', onSignalAbort, { once: true })

      // peerId 记录发起者：单聊 /yes 与卡片按钮都校验决议者身份；
      // 群聊把"群"整体作为授权主体（首个 @ 即授权整群），群内成员均可决议，不校验成员级 operatorId
      this.registerApproval(number, {
        number, request: req, resolve: resolveIm, timer,
        peerId: initiator,
        isGroup: Boolean(peer.isGroup),
      })

      let outcome
      try {
        outcome = await imPromise
      } finally {
        req.signal?.removeEventListener('abort', onSignalAbort)
        clearTimeout(timer)
        settled = true
      }

      this.logger?.info?.('[dsh-bridge feishu] approval #%d resolved: outcome=%s', number, outcome)

      if (settledBy === 'timeout') {
        // 卡片直接变成"已超时"，不再让按钮看起来还能点
        await updateApprovalCard('timeout')
      } else if (settledBy === 'abort') {
        await updateApprovalCard('cancelled')
      } else {
        const status = outcome === 'allowed-once' ? 'approved' : 'rejected'
        const updated = await updateApprovalCard(status, this._approvalOperatorName)
        // 卡片不可更新（内联卡片 / 更新失败）时，保留原有的文字确认
        if (!updated) {
          const label = outcome === 'allowed-once' ? `✓ **已批准执行**` : outcome === 'rejected' ? `❌ **已拒绝执行**` : `**[${outcome}]**`
          void this.sendText(`${label}（#${number}）`, sendOpts)
        }
      }
      return outcome
    }

    const disposer = this.ctx.on('approval/request', listener, { prepend: true })
    this.disposers.push(disposer)
  }

  dispose() {
    void this._flushCommentBuffers()
    this._commentPeers.clear()
    this._inTurn = false
    void this._finishStream()
    this._lastPeer = null
    super.dispose()
  }
}

export const feishuNodeHelpers = {
  makePlatform,
}
