// 轮次进行中的「状态/活动」文案：把宿主工具调用翻译成用户可读的一行状态。
//
// 为什么做：Web 端在轮次中会显示「正在分析请求 / 正在运行命令 / 正在编辑文件 …」，
// 而 IM 侧此前只在心跳里给一句「[处理中] 第 N 轮 | M 次工具调用」——用户看不到
// agent 到底在干什么，长任务期间体感像"卡住了"。
//
// 关键设计：**工具→活动种类的映射直接对齐宿主的实现**，而不是自己另发明一套。
// 宿主的口径在 `dsh-client-ui-chat` 的 `activity(name)`（本机核实于
// node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js），
// 对应文案是 `message.stepProcess.*` 语言键。对齐后：
//   - IM 与 Web 对同一工具给出同一说法，用户不必学两套；
//   - 宿主后续增删映射时，我们只需跟着调整这一处（并有测试锁住当前口径）。
//
// 本模块是**纯函数**（无 IO、无状态），便于单测与各平台复用。

/** 活动种类 → 进行中文案（对齐宿主 message.stepProcess.<kind>）。 */
const ACTIVITY_TEXT = {
  thinking: '正在分析请求',
  read: '正在读取文件',
  readImage: '正在读取图片',
  write: '正在写入文件',
  search: '正在搜索代码',
  edit: '正在编辑文件',
  commands: '正在运行命令',
  code: '正在运行代码',
  webSearch: '正在搜索网页',
  webFetch: '正在访问网页',
  subagents: '正在协调子智能体',
  plan: '正在更新计划',
  questions: '等待你的操作',
  tools: '正在调用工具',
}

/**
 * 工具名 → 活动种类（**逐条对齐宿主 `activity()`**）。
 *
 * 保持与宿主同构：宿主判断顺序是先精确名、再前缀/集合匹配，最后兜底 'tools'。
 * @param {string} name 工具名
 * @returns {string} 活动种类
 */
export function activityOf(name) {
  const n = String(name ?? '')
  if (n === 'read') return 'read'
  if (n === 'read_image') return 'readImage'
  if (n === 'grep' || n === 'glob' || n.endsWith('_inspect')) return 'search'
  if (n === 'write') return 'write'
  if (n === 'edit' || n === 'apply_patch') return 'edit'
  if (['bash', 'pwsh', 'exec_command', 'write_stdin'].includes(n) || n.startsWith('terminal_')) return 'commands'
  if (n === 'run_code') return 'code'
  if (n === 'web_search') return 'webSearch'
  if (n === 'web_fetch') return 'webFetch'
  if (n === 'subagent' || n.startsWith('subagent_')) return 'subagents'
  if (['todo_write', 'create_goal', 'update_goal', 'get_goal'].includes(n)) return 'plan'
  if (n === 'ask_user_question' || n === 'request_user_input') return 'questions'
  return 'tools'
}

/** 活动种类 → 用户可读文案（未知种类兜底为「正在调用工具」）。 */
export function activityText(kind) {
  return ACTIVITY_TEXT[kind] ?? ACTIVITY_TEXT.tools
}

/** 活动种类对应的图标（IM 里一眼可辨，比纯文字更快读懂）。 */
const ACTIVITY_ICON = {
  thinking: '💭',
  read: '📖',
  readImage: '🖼',
  write: '✍️',
  search: '🔍',
  edit: '📝',
  commands: '⌨️',
  code: '▶️',
  webSearch: '🔎',
  webFetch: '🌐',
  subagents: '🤖',
  plan: '📋',
  questions: '❓',
  tools: '🔧',
}

export function activityIcon(kind) {
  return ACTIVITY_ICON[kind] ?? ACTIVITY_ICON.tools
}

/** 详情字段的取值优先级（对齐宿主 LIVE_TOOL_DETAIL_KEYS，截取其中信息量最高的前几个）。 */
const DETAIL_KEYS = [
  'description', 'command', 'cmd', 'file_path', 'path', 'pattern', 'query', 'queries',
  'url', 'uri', 'title', 'objective', 'task', 'task_name', 'name', 'question', 'prompt', 'message',
]

/** 详情最大字符数（对齐宿主 LIVE_TOOL_DETAIL_MAX_CHARS）。 */
export const DETAIL_MAX_CHARS = 160

/**
 * 从工具参数里提取一行「细节」（如命令全文、文件名），供状态行展示。
 *
 * 目的：`⌨️ 正在运行命令（npm test）` 比光说「正在运行命令」有用得多。
 * 参数缺失/非字符串时返回空串（不硬造内容）。
 *
 * @param {object} args 工具调用参数（已解析对象；也容忍 JSON 字符串）
 * @returns {string}
 */
export function toolDetail(args) {
  let obj = args
  if (typeof args === 'string') {
    try { obj = JSON.parse(args) } catch { return '' }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return ''
  for (const key of DETAIL_KEYS) {
    const v = obj[key]
    const text = typeof v === 'string'
      ? v
      : (Array.isArray(v) && v.every((x) => typeof x === 'string') ? v.join(', ') : '')
    const norm = text.replace(/\s+/g, ' ').trim()
    if (!norm) continue
    return norm.length > DETAIL_MAX_CHARS ? `${norm.slice(0, DETAIL_MAX_CHARS - 1)}…` : norm
  }
  return ''
}

/**
 * 生成轮次进行中的状态行。
 *
 * @param {{ turn?: number, toolName?: string, args?: object|string }} info
 * @returns {string} 形如 `💭 正在分析请求` 或 `⌨️ 正在运行命令（npm test）`
 */
export function formatActivityLine({ turn, toolName, args } = {}) {
  const s = activityParts({ turn, toolName, args })
  const head = s.detail ? `${s.icon} ${s.text}（${s.detail}）` : `${s.icon} ${s.text}`
  return s.turn ? `${head} · 第 ${s.turn} 轮` : head
}

/**
 * 状态行的**结构化**形式：把"受控文案"与"用户可控细节"分开。
 *
 * 为什么需要：`detail` 直接来自工具参数（命令原文、文件名…），其中可能含 markdown
 * 元字符（`*` `_` `` ` `` `[]` 等）。平台若把它整行塞进斜体/引用等样式里，这些字符会
 * **截断样式**（如 `echo *bold*` 会让斜体提前闭合，渲染错乱）。
 * 分开之后，各平台可以只对受控部分加样式、对 detail 做转义或代码包裹。
 *
 * @returns {{ turn:number, kind:string, icon:string, text:string, detail:string, suffix:string }}
 *   turn 为 0 表示无轮次信息；suffix 形如 ` · 第 3 轮`（已含前导分隔符，便于直接拼接）
 */
export function activityParts({ turn, toolName, args } = {}) {
  const kind = toolName ? activityOf(toolName) : 'thinking'
  const n = Number(turn)
  const hasTurn = Number.isFinite(n) && n > 0
  return {
    turn: hasTurn ? n : 0,
    kind,
    icon: activityIcon(kind),
    text: activityText(kind),
    detail: toolDetail(args),
    suffix: hasTurn ? ` · 第 ${n} 轮` : '',
  }
}

/**
 * 转义 markdown 元字符，使其在强调/引用等样式内**原样显示**、不改变结构。
 *
 * 用于状态行的 detail（命令原文等用户可控内容）：不转义时 `echo *bold*` 会破坏
 * 外层斜体，甚至把后续正文吞进样式里。
 *
 * @param {string} text
 * @returns {string}
 */
export function escapeMarkdown(text) {
  return String(text ?? '').replace(/([\\`*_{}[\]()#+\-.!|~>])/g, '\\$1')
}
