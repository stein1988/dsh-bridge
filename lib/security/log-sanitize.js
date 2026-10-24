// 日志值净化：防止日志注入（log injection / log forging）
//
// 背景（CodeQL js/log-injection）：日志里拼接的**外部可控字符串**（用户消息、
// 远端返回的错误信息、文件名等）可能包含换行（`\n` / `\r`）与控制字符。攻击者一旦
// 能注入换行，就能在日志文件里**伪造一整行新日志**（例如伪造一条"审批已通过"），
// 也可以借超长单行撑爆日志采集器。
//
// 本模块只做一件事：把单行日志里要拼进去的动态值变成"一行且安全"。
// 用法：logger.warn('... 失败: %s', sanitizeLogValue(err?.message))

/**
 * 需要剔除的字符：C0 控制字符 + DEL + C1 控制字符。
 * 匹配控制字符正是本模块的**目的**，故显式豁免 no-control-regex。
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g

/** 单条日志值默认最大长度（超出截断，避免超长输入撑爆日志/采集器） */
export const LOG_VALUE_MAX_LEN = 500

/**
 * 净化一个将写入日志的动态值。
 *
 * - 换行/回车 → 空格（保留可读性，同时杜绝伪造新行）
 * - 其它控制字符 → 直接剔除
 * - 超长截断并标注实际长度
 * - 非字符串安全转换（Error → message；对象 → JSON；null/undefined → ''）
 *
 * @param {unknown} value 原始值
 * @param {{ maxLen?: number }} [opts]
 * @returns {string} 可安全拼接进单行日志的字符串
 */
export function sanitizeLogValue(value, { maxLen = LOG_VALUE_MAX_LEN } = {}) {
  let text
  if (value == null) return ''
  if (typeof value === 'string') text = value
  else if (value instanceof Error) text = value.message || value.name || 'Error'
  else if (typeof value === 'object') {
    try { text = JSON.stringify(value) } catch { text = String(value) }
  } else text = String(value)

  const oneLine = text
    // 先折叠换行（含 \r\n）为一个空格
    .replace(/[\r\n]+/g, ' ')
    // 再剔除其余控制字符
    .replace(CONTROL_CHARS, '')

  const limit = Number.isFinite(maxLen) && maxLen > 0 ? maxLen : LOG_VALUE_MAX_LEN
  return oneLine.length > limit ? `${oneLine.slice(0, limit)}…(${oneLine.length} chars)` : oneLine
}
