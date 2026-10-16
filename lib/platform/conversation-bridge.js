// dsh-bridge 平台无关的会话桥（核心类）
//
// 本模块只保留 ConversationBridge 类本身（白名单、会话生命周期、审批桥、
// 出站 digest/心跳、入站路由入口）。拆分出去的模块：
//   - message-split.js    出站分块 + [SEND_FILE] 指令解析（纯函数）
//   - dsh-storage.js      DSH 私有存储读取兜底（workspace.json / projcache）
//   - session-catalog.js  会话目录组织 / 渲染 / 格式化
//   - commands.js         斜杠命令解释器（routeCommand）
//
// 平台相关的部分由子类（或组合）提供：
//   - sendText(text, opts) / sendTyping(state)：向当前 peer 发送
//   - extractTextFrom(message)：从平台消息提取文本
//   - isGroupMessage(message)：判断群消息
//   - handlePlatformInbound(message)：消息解析（返回 { senderId, text, isGroup } 或 null）
//
// 本类不直接依赖任何 IM 协议，只消费 DSH 官方服务：
//   ctx.sessions / ctx.agents / ctx.approval / ctx.sessionPersistence / ctx.workspaceRegistry

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import fsp from 'node:fs/promises'
import {
  formatChangesDigest,
  buildUnifiedPatch,
  changesPatchFileName,
} from './changes-digest.js'
import { stat } from 'node:fs/promises'
import path, { normalize, isAbsolute } from 'node:path'
import { resolveFilePath } from './message-split.js'
import { splitForIM, textOfAssistantMessage, extractAndStripSendFileDirectives, extractFilePathsFromText, isPathAllowedForSend } from './message-split.js'
import { routeCommand } from './commands.js'
import { peekCtxProperty } from './dsh-storage.js'
import { listSessions, listWorkspaces, validateWorkspacePath, renderSessions, sessionsInDisplayOrder, describeTurnEnd, helpText, fmtTime, fmtSessionId, sessionLabel, sessionHeaderOf } from './session-catalog.js'

export { textOfAssistantMessage } from './message-split.js'

// ---------------------------------------------------------------------------
// 出站分块（通用：按平台 maxMessageChars 硬分块 + 保留 fenced code block）
// ---------------------------------------------------------------------------


function digestLine(session) {
  const open = describeOpenTurn(session?.events)
  if (!open) return null
  const steps = open.tools > 0 ? `${open.tools} 次工具调用` : '思考中'
  const last = open.lastTool ? ` | 最近: ${open.lastTool}` : ''
  return `[处理中] 第 ${open.turn} 轮 | ${steps}${last}`
}

/**
 * 判断会话是否有**未闭合**的 turn（即正在跑任务），返回结构化描述或 null。
 * 依据：事件流里最后一次 turn/start 之后没有配对的 turn/end。
 * 这是 Web/IM「正在思考 / 工具调用中」的同一判据；消息摘要与重启前探测共用它，
 * 避免两处各写一套导致结论不一致。
 *
 * @param {Array} events 会话事件流（session.events）
 * @returns {{turn:number, tools:number, lastTool:(string|undefined)}|null}
 */
export function describeOpenTurn(events) {
  let turn = 0
  let tools = 0
  let lastTool = undefined
  let inTurn = false
  for (const event of events ?? []) {
    if (event.type === 'turn/start') {
      turn = event.data?.turn ?? 0
      inTurn = true
      tools = 0
      lastTool = undefined
    } else if (event.type === 'turn/end') {
      inTurn = false
    } else if (event.type === 'tool/call' && inTurn) {
      tools += 1
      lastTool = event.data?.name
    }
  }
  if (!inTurn || turn === 0) return null
  return { turn, tools, lastTool }
}

function summarizeError(error) {
  if (error && typeof error === 'object' && 'message' in error) {
    return String(error.message).slice(0, 200)
  }
  return String(error).slice(0, 200)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 判断某个路径是否为可用的绝对目录。
 * 用于校验从配置恢复出来的 cwd：DSH 只拒绝非绝对路径，不会替调用方创建目录，
 * 不校验就会把会话建在一个不存在的 cwd 上。
 * @param {unknown} path
 * @returns {Promise<boolean>}
 */
async function isUsableDirectory(path) {
  if (typeof path !== 'string' || path.length === 0 || !isAbsolute(path)) return false
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// 会话桥基类
// ---------------------------------------------------------------------------

export class ConversationBridge {
  /**
   * @param {object} opts
   * @param {object} opts.ctx            Cordis 上下文
   * @param {object} opts.logger         日志器
   * @param {object} [opts.config]       已持久化配置（allowFrom/间隔/活动会话等）
   * @param {object} opts.platform       所属 Platform 实例（提供 accountId/capabilities）—— 必需
   * @param {(senderId: string) => void} [opts.onFirstSender]
   * @param {(sessionId: string) => void} [opts.onActiveSessionChange]
   */
  constructor({ ctx, logger, config = {}, platform, onFirstSender, onActiveSessionChange } = {}) {
    if (!platform) {
      throw new Error('ConversationBridge requires a platform instance')
    }
    
    this.ctx = ctx
    this.logger = logger
    this.platform = platform
    this.onFirstSender = onFirstSender
    this.onActiveSessionChange = onActiveSessionChange

    const maxChars = platform.capabilities?.maxMessageChars ?? 2000
    const rawMax = Number(config.maxMessageChars)
    const safeMaxChars = (Number.isFinite(rawMax) && rawMax > 0) ? rawMax : maxChars
    this.config = {
      allowFrom: Array.isArray(config.allowFrom) ? config.allowFrom : [],
      digestIntervalSec: config.digestIntervalSec ?? 300,
      approvalTimeoutSec: config.approvalTimeoutSec ?? 600,
      maxMessageChars: safeMaxChars,
      sendChunkDelayMs: config.sendChunkDelayMs ?? 1500,
      cwd: config.cwd,
      agentPreset: config.agentPreset,
      agentProvider: config.agentProvider,
      agentModel: config.agentModel,
      // 群聊自动授权开关：默认关闭，防止任意陌生群 @机器人 即获得访问权（T2.5）
      groupAutoApprove: config.groupAutoApprove === true,
      // 本轮改动摘要：默认开启——IM 用户也能看到"这轮改了哪些文件"（数据来自宿主 workspaceChanges）
      changesDigest: config.changesDigest !== false,
    }

    // 从配置恢复活动会话（v0.2.1：重启后保持会话）
    // 注意：不在构造函数里调用 _pickDefaultSession()，由 loadConfig 回调负责恢复，避免竞态覆盖
    this.activeSessionId = config.activeSessionId ?? null
    this.peerId = null
    this.pending = new Map() // number -> PendingApproval
    this.approvalCounter = 0
    this.disposers = []
    // 可选服务 workspaceChanges 的句柄（由 _bindChangesService 动态注入后写入）
    this._changesSvc = null

    // 配置恢复状态追踪（用于防止 handleInbound 在配置加载前处理消息）
    this._restoringConfig = null
    this._restoringSessionMap = new Map() // sessionId -> Promise<Agent|null>

    // T2.3：sessionId -> { outboundPeer, senderId }
    // 记录每轮对话的发起者：出站事件流（assistant/turn/end/心跳/SEND_FILE/审批）绑定到
    // 发起轮次的 peer，而不是"最近一条入站的 peer"，防止 A 任务进行中 B 来消息把回复串到 B 的窗口
    this._turnPeers = new Map()
    // 本轮改动摘要（workspace/changes）：sessionId → 最近一次的 { seq, turn }
    this._lastChanges = new Map()
    // 已播报过的 turn（宿主对同一轮可能追加多次事件）
    this._changesAnnounced = new Map()
    // turn/end 之后 _turnPeers 会被清空，而 workspace/changes 事件在其后到达 → 为摘要保留出站绑定
    this._lastTurnPeers = new Map()
    // 入站串行队列：handleInbound 内部读写 this.peerId 等共享状态，并发入站会造成串扰
    this._inboundQueue = Promise.resolve()

    this._attachOutbound()
    this._attachApprovalBridge()
  }

  get gatewayAccountId() {
    return this.platform?.accountId ?? ''
  }

  activeSession() {
    if (!this.activeSessionId) return undefined
    return this.ctx.sessions?.get(this.activeSessionId)
  }

  activeAgent() {
    if (!this.activeSessionId) return undefined
    return this.ctx.agents?.get(this.activeSessionId)
  }

  ownsAgent(agent) {
    return this.activeSessionId !== null && agent?.session?.id === this.activeSessionId
  }

  isAllowed(senderId) {
    if (!Array.isArray(this.config.allowFrom)) return false
    if (this.config.allowFrom.length === 0) return false
    return this.config.allowFrom.includes(senderId)
  }

  setActiveSession(session) {
    this.stopAllHeartbeats()
    this._dropDigestState(this.activeSessionId)
    this.activeSessionId = session.id
    try { this.onActiveSessionChange?.(session.id) } catch { /* 持久化失败不致命 */ }
  }

  // 仅按 ID 设置活动会话（持久化会话可能没有内存 session 对象），
  // 发消息时通过 re-attach 逻辑拉起 agent。
  setActiveSessionById(id) {
    if (!id) return
    this.stopAllHeartbeats()
    this._dropDigestState(this.activeSessionId)
    this.activeSessionId = id
    try { this.onActiveSessionChange?.(id) } catch { /* 持久化失败不致命 */ }
  }

  // 释放指定会话的 digest 状态（活动会话切换后旧状态不再使用）
  _dropDigestState(sessionId) {
    if (sessionId && this._digestState) this._digestState.delete(sessionId)
  }

  async _pickDefaultSession() {
    const sessions = await listSessions(this)
    if (sessions.length > 0) this.setActiveSessionById(sessions[0].id)
  }

  // ---- Agent preset 组装（DSH ≥0.1.5 的 agent plane 挂载）----
  //
  // DSH 0.1.5 起把 agent plane（工具、提示词段、技能目录）整体挪到了 agent preset 后面：
  // 宿主 composition 里 tool-fs / tool-bash / tool-jobs / tool-skill 等行被显式禁用，
  // 改由每个会话在创建时挂载 preset 提供。挂载只发生在 agents.create / agents.resume 的
  // setup 回调里——DSH 自己的会话控制器就是 `resolve()` + `mount(agentCtx, id)`；
  // 只往 meta 里写 agentPreset 不会挂载任何东西，该会话会落在"空 preset 层"，
  // 表现为工具集残缺（dsh-agent-presets 会打 "published without joining an agent preset" 警告）。
  //
  // 旧版 DSH（agent plane 仍在宿主层、无 agentPresets 服务）保持原行为，不传 setup。
  // 配置或历史里记着一个本机不存在的 preset 时，回退到 DSH 默认 preset 并告警，
  // 绝不在空层上建会话，也不把 not-found 错误直接甩给用户。
  async _composeAgentPreset(presetId) {
    // 空串/纯空白视为"未配置"（设置页清除该字段后就是空串），交给 DSH 默认预设
    const wanted = typeof presetId === 'string' && presetId.trim().length > 0 ? presetId.trim() : undefined
    const presets = this.ctx.get?.('agentPresets')
    if (!presets?.resolve || !presets?.mount) {
      return { agentPreset: wanted, setup: undefined, fallbackFrom: undefined }
    }
    let resolvedId
    let fallbackFrom
    try {
      resolvedId = (await presets.resolve(wanted)).id
    } catch (err) {
      if (!wanted) throw err
      const reason = err instanceof Error ? err.message : String(err)
      this.logger?.warn?.(`[dsh-bridge ${this.platform.id}] agent preset "${wanted}" unavailable (${reason}); falling back to the default preset`)
      resolvedId = (await presets.resolve(undefined)).id
      fallbackFrom = wanted
    }
    return {
      agentPreset: resolvedId,
      fallbackFrom,
      setup: async (agentCtx) => { await presets.mount(agentCtx, resolvedId) },
    }
  }

  async createSession(prompt, cwdOverride) {
    // 使用 DSH 原生格式 session-${uuid}，与 ctx.sessions 持久化系统兼容
    const sessionId = `session-${randomUUID()}`
    try {
      const workspaces = await listWorkspaces(this)
      const defaultWsPath = workspaces.length > 0 ? workspaces[0].path : process.cwd()
      let cwd = cwdOverride || this.config.cwd || defaultWsPath
      let cwdNotice = ''
      // 校验指定目录存在且是目录，防止路径遍历
      if (cwdOverride) {
        const validation = await validateWorkspacePath(this, cwdOverride)
        if (!validation.valid) {
          await this.sendText(validation.error)
          return
        }
      } else if (this.config.cwd && !(await isUsableDirectory(this.config.cwd))) {
        // 配置里恢复出来的工作区不可用（换机器、目录被删、写成相对路径等）：
        // 回落首个已注册工作区并明确告知——DSH 只拒绝非绝对路径，不会替我们建目录，
        // 静默沿用会让会话建在一个不存在的 cwd 上
        this.logger?.warn?.(`[dsh-bridge ${this.platform.id}] configured cwd "${this.config.cwd}" is not a usable directory; falling back to ${defaultWsPath}`)
        cwdNotice = `\n- ⚠️ 配置的工作区 \`${this.config.cwd}\` 不可用，本次会话改用 \`${defaultWsPath}\``
        cwd = defaultWsPath
      }
      const composition = await this._composeAgentPreset(this.config.agentPreset)
      const meta = { cwd }
      if (composition.agentPreset) meta.agentPreset = composition.agentPreset
      const agentOptions = {}
      if (this.config.agentProvider) agentOptions.provider = this.config.agentProvider
      if (this.config.agentModel) agentOptions.model = this.config.agentModel
      if (!agentOptions.provider || !agentOptions.model) {
        try {
          const def = this.ctx.get?.('agentDefaultModel')?.currentSelection?.()
          if (def) {
            if (!agentOptions.provider && def.provider) agentOptions.provider = def.provider
            if (!agentOptions.model && def.model) agentOptions.model = def.model
          }
        } catch { /* 默认模型服务不可用则忽略，交由 DSH 自行处理 */ }
      }
      // 注意：不预创建 ctx.sessions——agents.create 会自己 prepare+enter session
      // 旧版 DSH 没有 setup 概念，仅在确有 preset 组装时才带上该键
      const createOptions = { sessionId, meta, agentOptions }
      if (composition.setup) createOptions.setup = composition.setup
      const handle = await this.ctx.agents.create(createOptions)
      this.setActiveSession(handle.agent.session)

      // 同步挂载进 DSH 工作区账本 (workspaceRegistry)，使新会话在 Web 侧边栏和 /list 中精准归组
      try {
        const reg = this.ctx.workspaceRegistry
        const entities = reg?.list ? (await reg.list()) : []
        const normCwd = normalize(cwd).toLowerCase()
        const match = (entities || []).find((ws) => ws?.path && normalize(ws.path).toLowerCase() === normCwd)
        if (match?.attachSession) await match.attachSession(sessionId)
      } catch { /* 账本写入失败不影响会话创建 */ }

      if (prompt) {
        const platformName = this.platform?.name || 'IM客户端'
        const promptWithContext = `${prompt}\n\n<!-- [dsh-bridge 提示] 当前用户正通过【${platformName}】与你对话。若用户明确要求发送、导出或传送文件/图片/报表/代码脚本产物，请在本地生成/准备好文件后，在回复正文中附带明确发送指令：\n[SEND_FILE: <本地文件绝对路径>]\n例如：[SEND_FILE: C:\\path\\to\\report.xlsx]\n网关会自动解析该指令并将该文件直传至用户的聊天窗口，且在聊天文本中自动隐藏该指令。在日常编写代码、回复普通文本或未请求发送文件时，请勿输出此指令。 -->`
        handle.agent.followup(createUserMessage({
          content: [{ type: 'text', text: promptWithContext }],
          source: { kind: 'user' },
        }))
      }
      const wsDetail = cwd ? `\n- **工作区**：\`${cwd}\`${cwdNotice}` : ''
      // 配置的 preset 在本机不存在时，回退必须让用户看得见（否则又会变成"配了不生效"）
      const presetNotice = composition.fallbackFrom
        ? `\n- ⚠️ 配置的 Agent 预设 \`${composition.fallbackFrom}\` 在本机不存在，本次会话使用默认预设 \`${composition.agentPreset}\``
        : ''
      const hint = prompt ? '' : '\n\n> 💡 发送任意消息即可直接与 Agent 对话。'
      await this.sendText(`✓ **已创建新会话**\n- **会话 ID**：\`${fmtSessionId(handle.agent.session.id)}\`${wsDetail}${presetNotice}${hint}`)
    } catch (error) {
      await this.sendText(`❌ **创建会话失败**：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // ---- 审批 ----

  nextApprovalNumber() {
    this.approvalCounter += 1
    return this.approvalCounter
  }

  registerApproval(number, approval) {
    this.pending.set(number, approval)
  }

  clearApproval(number) {
    const entry = this.pending.get(number)
    if (entry) {
      clearTimeout(entry.timer)
      this.pending.delete(number)
    }
  }

  // 取消并拒绝审批（用于 dispose 清理）
  cancelApproval(number) {
    const entry = this.pending.get(number)
    if (entry) {
      clearTimeout(entry.timer)
      this.pending.delete(number)
      entry.resolve('rejected')  // 触发 Promise，防止泄漏
    }
  }

  resolveApproval(text, senderId = null) {
    const entries = [...this.pending.entries()]
    if (entries.length === 0) return false
    let outcome
    if (text === '/yes') outcome = 'allowed-once'
    else if (text === '/no') outcome = 'rejected'
    if (outcome) {
      const [number, entry] = entries[entries.length - 1]
      // 双重检查：确保此 number 仍在 pending 中（防止超时竞态）
      if (!this.pending.has(number)) return false
      if (!this._approvalAllowed(entry, senderId)) return false
      this.clearApproval(number)
      entry.resolve(outcome)
      return true
    }
    if ((text === '1' || text === '2') && entries.length === 1) {
      const [number, entry] = entries[0]
      // 双重检查：确保此 number 仍在 pending 中（防止超时竞态）
      if (!this.pending.has(number)) return false
      if (!this._approvalAllowed(entry, senderId)) return false
      this.clearApproval(number)
      entry.resolve(text === '1' ? 'allowed-once' : 'rejected')
      return true
    }
    return false
  }

  // 审批发起者校验：仅允许发起审批时的 peer（handleInbound 的 sender）决议，
  // 防止群聊/多用户场景下其他成员代批工具执行。senderId 为 null 时放行（内部路径）。
  _approvalAllowed(entry, senderId) {
    if (senderId == null) return true
    if (entry.peerId && entry.peerId !== senderId) {
      this.logger?.warn?.(`[dsh-bridge ${this.platform?.id}] approval #${entry.number} blocked: sender ${senderId} is not the initiator ${entry.peerId}`)
      return false
    }
    return true
  }

  stopAllHeartbeats() {
    if (this._digestState) {
      for (const state of this._digestState.values()) {
        if (state && state.heartbeat) {
          clearInterval(state.heartbeat)
          state.heartbeat = undefined
        }
      }
    }
  }

  dispose() {
    this.stopAllHeartbeats()
    for (const disposer of this.disposers) {
      try { disposer() } catch { /* 忽略 */ }
    }
    this.disposers = []
    for (const number of [...this.pending.keys()]) this.cancelApproval(number)
    // 清理所有引用，防止内存泄漏
    this._turnPeers?.clear()
    this._lastChanges?.clear()
    this._changesAnnounced?.clear()
    this._lastTurnPeers?.clear()
    this._inboundQueue = Promise.resolve()
    this.peerId = null
    this.activeSessionId = null
    this._restoringConfig = null
  }

  // ---- 入站核心（平台无关）----
  //
  // 子类解析出平台消息后调用本方法：
  //   await bridge.handleInbound({ senderId, text, isGroup, outboundPeer })
  //   - outboundPeer（可选）：该平台的"会话级发送目标"（如 QQ 群 { peerId, scope }、
  //     Telegram { peerId: chatId }），用于把本轮的出站事件流绑定回发起会话；
  //     不传时出站回退到 this.peerId。
  //
  // 入站按 bridge 串行执行：处理过程会读写共享的 peer/会话状态，并发入站会互相踩踏。
  // 消息处理本身轻量（重活是异步的 turn 事件流），串行代价可忽略。
  //
  // 返回：
  //   'ignored'   消息被忽略（未授权/群消息/空消息）
  //   'routed'    消息已路由到 agent
  handleInbound(message) {
    const task = this._inboundQueue.catch(() => {}).then(() => this._handleInboundSerialized(message))
    this._inboundQueue = task.catch(() => {})
    return task
  }

  async _handleInboundSerialized({ senderId, text, isGroup = false, outboundPeer, senderLabel = '' }) {
    try {
      // 等待配置恢复完成（防止启动时竞态）
      if (this._restoringConfig) {
        await this._restoringConfig
      }

      const sender = String(senderId ?? '').trim()
      if (!sender) return 'ignored'

      if (!this.isAllowed(sender)) {
        // 自动授权：
        //  - 单聊：白名单为空时，首个发消息的真实用户自动纳入白名单
        //  - 群聊：白名单为空时随首条消息自动授权；白名单非空时仅在
        //    config.groupAutoApprove 显式开启后才授权新群（默认关闭，
        //    防止任意陌生群 @机器人 一次即整群获得访问权）
        const shouldAutoApprove = Boolean(text?.trim()) && (
          this.config.allowFrom.length === 0 || // 白名单为空：单聊/群聊都自动授权
          (isGroup && this.config.groupAutoApprove === true)
        )
        if (shouldAutoApprove) {
          this.config.allowFrom = Array.from(new Set([...this.config.allowFrom, sender]))
          this.logger?.info?.(`[dsh-bridge ${this.platform.id}] auto-approved ${isGroup ? 'group' : 'sender'} ${sender} into allowlist`)
          try {
            await this.onFirstSender?.(sender)
          } catch (err) {
            this.logger?.warn?.(`[dsh-bridge ${this.platform.id}] failed to persist first sender: ${err instanceof Error ? err.message : String(err)}`)
          }
        } else {
          this.logger?.info?.(`[dsh-bridge ${this.platform.id}] media-only first message from ${sender} not auto-approved (waiting for text)`)
        }

        // 如果仍未通过白名单，拒绝处理（防止绕过白名单）
        if (!this.isAllowed(sender)) {
          this.logger?.info?.(`[dsh-bridge ${this.platform.id}] ignore message from non-allowlisted sender ${sender} (never fed to model)`)
          return 'ignored'
        }
      }

      // 仅在不支持群聊的平台忽略群消息（QQ 等支持群聊的平台放行）
      if (isGroup && !this.platform?.capabilities?.supportsGroup) {
        this.logger?.info?.(`[dsh-bridge ${this.platform.id}] ignore group message from ${sender} (no group support)`)
        return 'ignored'
      }

      const fullText = text?.trim() ?? ''
      if (!fullText) {
        this.logger?.info?.(`[dsh-bridge ${this.platform.id}] ignore empty message from ${sender}`)
        return 'ignored'
      }

      this.peerId = sender

      // 记录本轮发起者：出站事件流绑定回发起会话（T2.3）。outboundPeer 由平台节点传入
      // 其"会话级发送目标"（QQ 群/Telegram chat 等），未传则不记录（出站回退 this.peerId）。
      if (this.activeSessionId && outboundPeer) {
        this._turnPeers.set(this.activeSessionId, { outboundPeer, senderId: sender, senderLabel })
      }

      if (await routeCommand(this, fullText, sender)) return 'routed'

      let agent = this.activeAgent()
      if (!agent && this.activeSessionId) {
        const sessionId = this.activeSessionId
        if (this._restoringSessionMap.has(sessionId)) {
          try {
            await this._restoringSessionMap.get(sessionId)
          } catch { /* 错误已在原始 Promise 中捕获 */ }
          agent = this.activeAgent()
        } else {
          const restorePromise = (async () => {
            // agent 不在内存（DSH 重启后或切换到持久化会话）→ re-attach。
            try {
              const agentOptions = {}
              if (this.config.agentProvider) agentOptions.provider = this.config.agentProvider
              if (this.config.agentModel) agentOptions.model = this.config.agentModel
              if (!agentOptions.provider || !agentOptions.model) {
                try {
                  const def = this.ctx.get?.('agentDefaultModel')?.currentSelection?.()
                  if (def) {
                    if (!agentOptions.provider && def.provider) agentOptions.provider = def.provider
                    if (!agentOptions.model && def.model) agentOptions.model = def.model
                  }
                } catch { /* ignore */ }
              }

              // 判断该 session 是否已持久化：已持久化 → agents.resume（从持久化加载历史恢复，
              // 避免 agents.create 用空 seed 与已持久化事件冲突）；未持久化 → agents.create。
              // 注意：list() 在新版 DSH 返回 `{ header, revision, sizeBytes }` 快照，必须经
              // sessionHeaderOf 取 header；旧写法直接读 entry.id 会恒为 undefined，把已存在
              // 的会话误判成"未持久化"，随后 create 抛 `session "..." already exists`（issue #39）。
              let persisted = false
              let storedPreset
              try {
                const entries = await this.ctx.sessionPersistence?.list?.()
                const matched = Array.isArray(entries)
                  ? sessionHeaderOf(entries.find((entry) => sessionHeaderOf(entry)?.id === sessionId))
                  : undefined
                persisted = Boolean(matched)
                storedPreset = matched?.agentPreset
              } catch { /* 读取失败则按未持久化处理 */ }

              // 恢复会话按其自身记录的 preset 组装（与 DSH 会话控制器一致）；未记录则用桥配置，
              // 都为空时交给 DSH 默认 preset。记录值失效时 _composeAgentPreset 会回退默认并告警。
              const composition = await this._composeAgentPreset(persisted ? (storedPreset ?? this.config.agentPreset) : this.config.agentPreset)

              let handle
              if (persisted) {
                handle = await this.ctx.agents.resume({
                  resumeSessionId: sessionId,
                  agentOptions,
                  setup: composition.setup,
                })
              } else {
                const meta = { cwd: this.config.cwd || process.cwd() }
                if (composition.agentPreset) meta.agentPreset = composition.agentPreset
                handle = await this.ctx.agents.create({
                  sessionId,
                  meta,
                  agentOptions,
                  setup: composition.setup,
                })
              }
              const resumedAgent = handle?.agent
              this.logger?.info?.(`[dsh-bridge ${this.platform.id}] re-attached agent to session ${sessionId} (${persisted ? 'resume' : 'create'})`)
              return resumedAgent
            } catch (err) {
              const reason = err instanceof Error ? err.message : String(err)
              this.logger?.warn?.(`[dsh-bridge ${this.platform.id}] failed to re-attach agent: ${reason}`)
              // 清除失效的 activeSessionId，避免用户误以为还在旧会话中
              if (this.activeSessionId === sessionId) {
                this.activeSessionId = null
              }
              await this.sendText(`❌ **恢复会话失败**：${reason}\n\n> 发送 \`/new <提示词>\` 可新建一个会话。`)
              return null
            }
          })().finally(() => {
            this._restoringSessionMap.delete(sessionId)
          })

          this._restoringSessionMap.set(sessionId, restorePromise)
          agent = await restorePromise
        }
      }
      if (!agent) {
        await this.sendText(`> 💤 **当前没有活动会话**\n> 发送 \`/new <提示词>\` 开始新会话，或发送 \`/sessions\` 查看已有会话。`)
        return 'routed'
      }

      // 针对微信/IM客户端用户，注入上下文提示，规范 Agent 仅在需要向用户发送文件附件时输出 [SEND_FILE: <文件绝对路径>]
      const promptWithContext = `${fullText}\n\n<!-- [dsh-bridge 提示] 当前用户正通过【${this.platform.name}】与你对话。若用户明确要求发送、导出或传送文件/图片/报表/代码脚本产物，请在本地生成/准备好文件后，在回复正文中附带明确发送指令：\n[SEND_FILE: <本地文件绝对路径>]\n例如：[SEND_FILE: C:\\path\\to\\report.xlsx]\n网关会自动解析该指令并将该文件直传至用户的聊天窗口，且在聊天文本中自动隐藏该指令。在日常编写代码、回复普通文本或未请求发送文件时，请勿输出此指令。 -->`

      const messageValue = createUserMessage({
        content: [{ type: 'text', text: promptWithContext }],
        source: { kind: 'user' },
      })
      agent.followup(messageValue)
      await this.sendTyping(1).catch(() => {})
      return 'routed'
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      this.logger?.error?.(`[dsh-bridge ${this.platform.id}] unhandled error in handleInbound: ${errMsg}\n${err instanceof Error ? err.stack : ''}`)
      await this.sendText(`❌ **执行出错**：${errMsg}`).catch(() => {})
      return 'ignored'
    }
  }

  // ---- 发送（子类覆盖 _sendTextNow，不要覆盖 sendText）----

  // 出站发送串行队列：所有 sendText 依次执行，杜绝并发分块交错乱序，
  // 以及 QQ 流式 replace 共享 _msgSeq 的并发冲突
  _enqueueSend(task) {
    const queue = (this._sendQueue ??= Promise.resolve())
    const run = queue.then(task, task)
    this._sendQueue = run.catch(() => {})
    return run
  }

  /** 向当前 peer 发送文本（自动分块 + typing 指示）。经串行队列执行。
   *  opts.outboundPeer（可选）：覆盖发送目标（T2.3，绑定到发起轮次的会话 peer）。 */
  sendText(text, opts = {}) {
    return this._enqueueSend(() => this._sendTextNow(text, opts))
  }

  /** 出站目标解析；子类可覆盖（例：飞书单聊必须发 chat_id 而非发送者 open_id） */
  resolveSendTarget(opts = {}) {
    return opts?.outboundPeer?.peerId ?? this.peerId ?? this.config.allowFrom?.[0]
  }

  async _sendTextNow(text, opts = {}) {
    if (this.platform?.status === 'idle' || this.platform?.status === 'offline') return
    const peer = this.resolveSendTarget(opts)
    if (!peer) return
    const chunks = splitForIM(text, this.config.maxMessageChars)
    if (chunks.length === 0) return
    await this.sendTyping(1).catch(() => {})
    try {
      for (let i = 0; i < chunks.length; i++) {
        let result
        try {
          result = await this.platform.sendText(peer, chunks[i])
        } catch (err) {
          // 适配器可能直接透传 gateway 抛出的异常（telegram/feishu），统一按失败分块处理，
          // 避免调用方 `void this.sendText(...)` 逃逸成 unhandled rejection
          result = { success: false, error: err?.message ?? String(err) }
        }
        if (result && result.success === false) {
          this.logger?.warn?.(`[dsh-bridge ${this.platform.id}] outbound chunk ${i + 1}/${chunks.length} failed: ${result.error}`)
          break
        }
        if (i < chunks.length - 1 && this.config.sendChunkDelayMs > 0) {
          await sleep(this.config.sendChunkDelayMs)
        }
      }
    } finally {
      await this.sendTyping(2).catch(() => {})
    }
  }

  /** 发送 typing 状态（1=开始，2=停止）。子类可覆盖。 */
  async sendTyping(state) {
    const peer = this.peerId || this.config.allowFrom?.[0]
    if (!this.platform?.sendTyping || peer == null) return
    return this.platform.sendTyping(peer, state)
  }

  /** 有界 Map 写入（防止长跑/多会话下无限增长） */
  _rememberBounded(map, key, value, max = 32) {
    if (!map || key == null) return
    map.set(key, value)
    while (map.size > max) map.delete(map.keys().next().value)
  }

  /**
   * 播报"本轮改动"摘要（宿主 workspaceChanges 数据）。
   * 无改动不说话；同一轮重复事件只播一次；宿主没有该服务时静默跳过（兼容老宿主）。
   */
  async _announceChanges(session, event, sendOpts = {}) {
    if (this.config.changesDigest !== true) return
    // 服务句柄由 _bindChangesService()（用宿主官方的 ctx.get 读可选服务）在 attach 时取得，
    // 存在 this._changesSvc；拿不到时为 null，本条静默跳过（老宿主属正常）。
    // 末尾的 peek 只是兜底（例如构造时服务尚未就绪、之后才可用）。
    const svc = this._changesSvc ?? peekCtxProperty(this.ctx, 'workspaceChanges')
    const seq = event?.seq
    if (!svc?.summary || !session?.id || seq == null) return
    let summary
    try {
      summary = svc.summary(session.id, seq)
    } catch (err) {
      this.logger?.debug?.(`[dsh-bridge ${this.platform.id}] workspaceChanges.summary failed: ${err?.message ?? err}`)
      return
    }
    if (!summary?.total) return
    this._rememberBounded(this._lastChanges, session.id, { seq, turn: summary.turn })
    if (this._changesAnnounced.get(session.id) === summary.turn) return
    this._rememberBounded(this._changesAnnounced, session.id, summary.turn)

    const text = formatChangesDigest(summary)
    if (text) void this.sendText(text, sendOpts)
  }

  /**
   * 把当前会话最近一轮改动导出成 .patch 附件（`/diff` 指令）。
   * 数据全部来自宿主 workspaceChanges（读的是宿主缓存的快照），不扫描工作区以外的任何文件。
   */
  async sendSessionDiff(opts = {}) {
    const sessionId = this.activeSessionId
    // 同 _announceChanges：走动态注入拿到的句柄（未 inject 的服务直接取属性会抛错，
    // 且该错误会从宿主事件回调冒泡成 fatal load failure）
    const svc = this._changesSvc ?? peekCtxProperty(this.ctx, 'workspaceChanges')
    const last = sessionId ? this._lastChanges.get(sessionId) : null
    if (!svc?.summary || !svc?.diff || !sessionId || !last) {
      await this.sendText('ℹ️ 当前会话还没有可导出的改动记录（本轮无文件改动，或宿主未提供 changes 服务）。', opts)
      return
    }
    const summary = svc.summary(sessionId, last.seq)
    if (!summary?.total) {
      await this.sendText('ℹ️ 本轮没有文件改动，暂无 diff 可导出。', opts)
      return
    }

    const diffs = []
    for (let i = 0; i < summary.files.length; i++) {
      const ctl = new AbortController()
      const timer = setTimeout(() => ctl.abort(), 10_000)
      if (typeof timer.unref === 'function') timer.unref()
      try {
        diffs.push(await svc.diff(sessionId, last.seq, i, ctl.signal))
      } catch (err) {
        this.logger?.debug?.(`[dsh-bridge ${this.platform.id}] workspaceChanges.diff(${i}) failed: ${err?.message ?? err}`)
        diffs.push(undefined)
      } finally {
        clearTimeout(timer)
      }
    }

    const fileName = changesPatchFileName(summary.turn)
    let filePath
    let tempDir
    try {
      // 不往共享临时目录里写**可预测文件名**（CWE-377 / CodeQL js/insecure-temporary-file）：
      // os.tmpdir() 通常是 1777 的公共目录，攻击者（同机其它用户或本地低权限进程）可以预先
      // 建好同名文件/符号链接，让我们写到别人的目标上（覆盖文件或借链接写任意路径）。
      // 改为 mkdtemp 建一个 0700 的私有随机目录，patch 写在其内，用完连目录一起删。
      tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-bridge-diff-'))
      filePath = path.join(tempDir, fileName)
      await fsp.writeFile(filePath, buildUnifiedPatch(summary, diffs), { encoding: 'utf8', mode: 0o600 })
    } catch (err) {
      if (tempDir) await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {})
      await this.sendText(`❌ 导出改动补丁失败（写入临时文件）：${err?.message ?? err}`, opts)
      return
    }

    const target = this.resolveSendTarget(opts)
    try {
      if (typeof this.platform?.sendMediaFile !== 'function' || !target) throw new Error('当前平台不支持发送文件')
      const res = await this.platform.sendMediaFile(target, filePath, opts)
      if (res && res.success === false) throw new Error(res.error || 'sendMediaFile failed')
      await this.sendText(
        `📎 已导出本轮改动补丁：\`${fileName}\`（${summary.total} 个文件，+${Number(summary.added) || 0}/-${Number(summary.deleted) || 0}）`,
        opts,
      )
    } catch (err) {
      this.logger?.warn?.(`[dsh-bridge ${this.platform.id}] sendSessionDiff failed: ${err?.message ?? err}`)
      await this.sendText(`❌ 导出改动补丁失败：${err?.message ?? err}`, opts)
    } finally {
      // 附件已上传完成，清理临时文件与私有临时目录
      if (tempDir) void fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {})
      else void fsp.unlink(filePath).catch(() => {})
    }
  }

  // ---- 出站事件绑定 ----

  /**
   * 取得可选的 `workspaceChanges` 服务句柄（改动摘要 / `/diff` 的数据源）。
   *
   * 三条路的取舍（都有实测依据）：
   *   1. 直接 `this.ctx.workspaceChanges`：未 inject 的服务在跨 realm 读取时 cordis **抛错**
   *      （cannot get property "..." without inject）。该异常发生在宿主 session 事件回调里，
   *      会冒泡成 `dsh: fatal load failure` → **整个宿主进程退出**（实测 2026-10-16 03:02 / 03:20
   *      连崩两次）。绝不可用。
   *   2. `ctx.inject(deps, cb)`：能拿到服务，但它是"注册一个子 fiber"的**装配期** API，
   *      在构造函数里调用会把子 fiber 的生命周期挂在调用方，且多一层异步回调时序，
   *      为此付出复杂度不划算（本仓也没别处这么用）。
   *   3. `ctx.get(name)`：**宿主官方为"可选服务"提供的读取接口**（cordis 内建，
   *      服务缺失时安全返回 undefined、不抛错）。本仓已有三处这么用
   *      （`this.ctx.get?.('agentPresets')`、`agentDefaultModel`），风格一致。
   *
   * 故优先用 `ctx.get`；个别夹具/老宿主没有 `get` 时，退回安全探测；两者都不行则保持 null，
   * 摘要与 `/diff` 静默降级（绝不外抛——本函数在构造函数路径上，抛错会让插件加载失败）。
   */
  _bindChangesService() {
    const ctx = this.ctx
    if (!ctx) return
    let svc
    try {
      svc = typeof ctx.get === 'function' ? ctx.get('workspaceChanges') : peekCtxProperty(ctx, 'workspaceChanges')
    } catch (err) {
      svc = peekCtxProperty(ctx, 'workspaceChanges')
      this.logger?.warn?.(`[dsh-bridge ${this.platform.id}] 读取 workspaceChanges 失败，将静默降级: ${err?.message ?? err}`)
    }
    this._changesSvc = svc ?? null
    // 留痕：真机上"摘要 / `/diff` 不工作"最常见的原因就是这个可选服务没绑上，
    // 而没有日志时用户只能看到"什么也没发生"，无法区分"本轮确实没改动"与"服务没绑上"。
    if (this._changesSvc?.summary) {
      this.logger?.info?.(`[dsh-bridge ${this.platform.id}] workspaceChanges 已就绪（改动摘要 / /diff 可用）`)
    } else {
      this.logger?.info?.(
        `[dsh-bridge ${this.platform.id}] 宿主未提供 workspaceChanges：改动摘要与 /diff 将静默跳过（老宿主属正常）`,
      )
    }
  }

  _attachOutbound() {
    this._digestState = new Map()
    this._bindChangesService()
    const stopHeartbeat = (state) => {
      if (state && state.heartbeat) {
        clearInterval(state.heartbeat)
        state.heartbeat = undefined
      }
    }
    const startHeartbeat = (session, state) => {
      stopHeartbeat(state)
      if (this.config.digestIntervalSec <= 0) return
      state.heartbeat = setInterval(() => {
        // 1. 必须依然是当前活动会话
        if (this.activeSessionId !== session.id) {
          stopHeartbeat(state)
          return
        }
        // 2. 检查会话当前是否真正处于 inTurn 状态中
        const line = digestLine(session)
        if (!line) {
          stopHeartbeat(state)
          return
        }
        // 心跳时同时刷新 typing 状态（微信 typing 只维持 15 秒）
        if (this.peerId) this.sendTyping(1).catch(() => {})
        const heartbeatTurn = this._turnPeers.get(session.id)
        // 评论类会话（飞书云文档评论：无流式、无卡片）不发进度摘要，避免把评论刷成多条
        if (heartbeatTurn?.outboundPeer?.comment) return
        void this.sendText(line, heartbeatTurn ? { outboundPeer: heartbeatTurn.outboundPeer } : {})
      }, this.config.digestIntervalSec * 1000)
      if (typeof state.heartbeat.unref === 'function') state.heartbeat.unref()
    }
    const onEvent = async (session, event) => {
      // 仅为活动会话创建 digest 状态：非活动会话即使有心跳残留，也会被心跳回调里的
      // 失活检查在下一个周期自行停止。若不过滤，任意会话事件都会在此堆积 Map entry（内存泄漏）
      if (session.id !== this.activeSessionId) return
      const state = this._digestState.get(session.id) ?? { startedTurns: new Set(), createdFiles: new Set() }
      this._digestState.set(session.id, state)

      if (event.type === 'turn/end') {
        stopHeartbeat(state)
        // 本轮已结束，清空轮次集合防止长期运行下无限累积
        state.startedTurns.clear()
      }
      if (this.platform?.status === 'idle' || this.platform?.status === 'offline') return

      // 出站事件绑定到发起本轮的会话 peer（T2.3）
      const turn = this._turnPeers.get(session.id)
      const sendOpts = turn ? { outboundPeer: turn.outboundPeer } : {}

      if (event.type === 'turn/start') {
        const turn = event.data?.turn
        state.createdFiles = new Set()
        if (turn != null && !state.startedTurns.has(turn)) {
          state.startedTurns.add(turn)
          // 不发送"[OK] 收到，开始处理…"，改用 typing 指示 + 心跳进度。
          if (this.peerId) this.sendTyping(1).catch(() => {})
        }
        startHeartbeat(session, state)
        return
      }
      // DSH 会话对象的工作目录在 header 内（SessionHeader.cwd），顶层没有 cwd；
      // 此前只读 sess.cwd → 白名单根回退到 config.cwd/process.cwd()，导致会话工作区内的附件
      // 被判为"工作区外"而静默丢弃（issue #72 补充报告）。保留 sess.cwd 兜底以兼容 mock/旧宿主。
      const getSessionCwd = (sess) => sess?.header?.cwd || sess?.cwd || this.config.cwd || process.cwd()

      if (event.type === 'tool/call') {
        // 工具执行仅在终端/状态中展示，文件直发由 AI 回复中的 [SEND_FILE: ...] 指令显式驱动，杜绝误判
        return
      }
      if (event.type === 'assistant/message') {
        const rawText = textOfAssistantMessage(event.data.message)
        if (rawText.trim()) {
          const cwd = getSessionCwd(session)
          const { cleanText, files } = extractAndStripSendFileDirectives(rawText, cwd)
          for (const f of files) {
            state.createdFiles.add(f)
          }
          // 仅向聊天窗口发送过滤掉 [SEND_FILE: ...] 控制指令后的纯净正文
          if (cleanText) {
            void this.sendText(cleanText, sendOpts)
          }
        }
        return
      }
      if (event.type === 'workspace/changes') {
        // 宿主在"完成的顶层轮次"后追加该事件：摘要留在宿主，用 (sessionId, seq) 取
        const peerOpts = turn ? sendOpts : (this._lastTurnPeers.get(session.id) ?? {})
        void this._announceChanges(session, event, peerOpts)
        return
      }
      if (event.type === 'turn/end') {
        stopHeartbeat(state)
        // 供 turn/end 之后到达的 workspace/changes 事件复用本轮出站绑定
        this._rememberBounded(this._lastTurnPeers, session.id, sendOpts)
        if (this.peerId) this.sendTyping(2).catch(() => {})
        const reason = event.data?.reason || {}
        if (reason.kind === 'error') {
          void this.sendText(`❌ **处理出错**：${summarizeError(reason.error)}`, sendOpts)
        } else if (reason.kind === 'aborted') {
          void this.sendText(`⏹ **任务已停止**`, sendOpts)
        } else if (reason.kind === 'max-tokens') {
          void this.sendText(`⚠️ **达到模型单轮输出上限，本轮内容已截断**`, sendOpts)
        }

        // 如果本轮 AI 显式指定了 [SEND_FILE: ...] 文件发送指令，直接上传并发送给用户
        if (state.createdFiles && state.createdFiles.size > 0) {
          const rawFiles = Array.from(state.createdFiles)
          const cwd = getSessionCwd(session)
          const targetPeer = sendOpts.outboundPeer?.peerId ?? this.peerId ?? this.config.allowFrom?.[0]

          if (typeof this.platform?.sendMediaFile === 'function' && targetPeer) {
            const uniqueFilesToSend = []
            for (const f of rawFiles) {
              const resolved = resolveFilePath(f, cwd)
              if (!resolved || uniqueFilesToSend.includes(resolved)) continue
              // 发送白名单：仅允许会话 cwd（及其子目录）内、且不命中敏感路径的文件，
              // 防止模型被提示注入后借 [SEND_FILE] 外发 .ssh/.credentials/.env 等任意本地文件。
              if (!isPathAllowedForSend(resolved, cwd)) {
                this.logger?.warn?.(`[dsh-bridge ${this.platform.id}] blocked SEND_FILE outside allowed workspace: ${resolved} (allowed root: ${cwd})`)
                continue
              }
              uniqueFilesToSend.push(resolved)
            }
            for (const resolved of uniqueFilesToSend) {
              try {
                this.logger?.info?.(`[dsh-bridge ${this.platform.id}] auto sendMediaFile to peer: ${resolved}`)
                const res = await this.platform.sendMediaFile(targetPeer, resolved, sendOpts)
                if (res && res.success === false) {
                  this.logger?.warn?.(`[dsh-bridge ${this.platform.id}] auto sendMediaFile ${resolved} failed: %s`, res.error)
                }
              } catch (err) {
                this.logger?.warn?.(`[dsh-bridge ${this.platform.id}] auto sendMediaFile ${resolved} failed: %s`, err?.message ?? err)
              }
            }
          }
          state.createdFiles.clear()
        }
        // 本轮结束，释放轮次绑定（审批/心跳等已不再需要）
        this._turnPeers.delete(session.id)
        return
      }
    }
    const listener = (session, event) => { void onEvent(session, event) }
    const disposer = this.ctx.on('session/event', listener)
    this.disposers.push(() => {
      for (const state of this._digestState.values()) stopHeartbeat(state)
      disposer()
    })
  }

  // ---- 审批桥 ----
  //
  // DSH 的审批分发是 cordis waterfall（顺序链）：监听器按注册序执行，
  // 不调用 next() 的监听器否决整条链。宿主 apiproxy 注册在先的 GUI 认领监听器
  // 会认领 approval/asked 事件并 veto 等待网页回答——若不 prepend，本桥永远没有
  // 机会执行，IM 端永远收不到审批卡片（工具调用最终以 unavailable 失败）。
  // 因此以 { prepend: true } 注册到链条最外层。
  //
  // 归属模型：IM 发起的轮次审批**只在 IM 决议**——不调用 next()，宿主 GUI 通道
  // 根本不打开。此前曾让 GUI 弹窗与 IM 卡片并行 race，但宿主的 pending 认领没有
  // 插件可用的收尾接口（只有 Web /api/respond 或 signal abort），IM 决议后 Web
  // 弹窗会永久残留（用户实测报告）。各通道只决议自己发起的轮次。

  _attachApprovalBridge() {
    const listener = async (req, next) => {
      // 只有"本轮由本桥发起"（_turnPeers 有该会话的轮次记录）时才拦截审批。
      // 仅凭 activeSessionId 匹配是不够的：重启恢复/默认挑选后它可能指向一个
      // Web 端发起的会话——那会让 Web 轮次的审批被劫持发去 IM（GUI 不弹窗、
      // 无人响应即自动拒绝）。Web 轮次必须直接放行给宿主 GUI 处理。
      const sessionId = req.agent?.session?.id
      const turn = sessionId ? this._turnPeers.get(sessionId) : null
      if (!turn || !this.ownsAgent(req.agent)) {
        // info 级别：这是用户可自诊的关键判定点（IM 没收到卡片时先看这行）
        this.logger?.info?.('[dsh-bridge %s] approval falls through to GUI: not an IM-initiated turn (session=%s, activeSession=%s, turnTracked=%s)', this.platform?.id, sessionId ?? '(none)', this.activeSessionId ?? '(none)', Boolean(turn))
        return next?.()
      }
      const peer = turn.outboundPeer?.peerId
      const initiator = turn.senderId
      if (!peer) {
        this.logger?.debug?.('[dsh-bridge %s] approval/request ignored: no active peer', this.platform?.id)
        return next?.()
      }
      const sendOpts = turn ? { outboundPeer: turn.outboundPeer } : {}

      const number = this.nextApprovalNumber()
      const timeoutSec = this.config.approvalTimeoutSec
      const timeoutMin = Math.max(1, Math.round(timeoutSec / 60))
      const prompt = [
        `## ⚠️ 操作权限确认 (#${number})`,
        '',
        '| 项目 | 详情 |',
        '| :--- | :--- |',
        `| **调用工具** | \`${req.toolName}\` |`,
        ...(req.reason ? [`| **申请原因** | ${String(req.reason).replace(/\|/g, '｜')} |`] : []),
        `| **等待超时** | ${timeoutMin} 分钟 (超时自动拒绝) |`,
        '',
        `> 回复 \`/yes\` (或 \`1\`) 批准执行`,
        `> 回复 \`/no\` (或 \`2\`) 拒绝执行`,
      ].join('\n')

      void this.sendText(prompt, sendOpts)

      let settled = false
      let timeoutFired = false
      let resolveIm
      const imPromise = new Promise((resolve) => { resolveIm = resolve })
      const settleIm = (outcome) => {
        if (settled) return
        settled = true
        this.clearApproval(number)
        resolveIm(outcome)
      }

      const timer = setTimeout(() => {
        timeoutFired = true
        settleIm('rejected')
      }, timeoutSec * 1000)
      if (typeof timer.unref === 'function') timer.unref()

      // turn 被停止/工具调用中止时 DSH 会 abort req.signal：同步取消 IM 侧待决审批
      const onSignalAbort = () => {
        timeoutFired = true
        settleIm('cancelled')
      }
      req.signal?.addEventListener('abort', onSignalAbort, { once: true })

      this.registerApproval(number, { number, request: req, resolve: resolveIm, timer, peerId: initiator })

      let outcome
      try {
        outcome = await imPromise
      } finally {
        req.signal?.removeEventListener('abort', onSignalAbort)
        clearTimeout(timer)
        settled = true
      }

      this.logger?.info?.('[dsh-bridge %s] approval #%d resolved: outcome=%s', this.platform?.id, number, outcome)

      // 仅在非超时/非中止路径发送确认消息（那些路径 resolve 已发生在定时器/abort 回调）
      if (!timeoutFired) {
        const label = outcome === 'allowed-once' ? `✓ **已批准执行**` : outcome === 'rejected' ? `❌ **已拒绝执行**` : `**[${outcome}]**`
        void this.sendText(`${label}（#${number}）`, sendOpts)
      }
      return outcome
    }
    const disposer = this.ctx.on('approval/request', listener, { prepend: true })
    this.disposers.push(disposer)
  }
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

// 导出，便于测试与复用
export const conversationBridgeHelpers = {
  splitForIM,
  digestLine,
  textOfAssistantMessage,
  resolveFilePath,
  extractFilePathsFromText,
  extractAndStripSendFileDirectives,
  sessionsInDisplayOrder,
  listSessions,
  renderSessions,
  listWorkspaces,
  sessionHeaderOf,
}
