// 本轮改动摘要 / 统一 diff 生成（纯函数，便于单测）
//
// 数据来源：宿主 `@deepseek-ai/dsh-workspace-changes` 服务（Web 端「改动/交付物」面板的同一份数据）
//   ctx.workspaceChanges.summary(sessionId, seq) → {
//     turn, cwd, total, added, deleted,
//     files: [{ path, display, added, deleted, binary?, oversized? }]   // 已按 display 排序、条数受宿主 cap
//   }
//   ctx.workspaceChanges.diff(sessionId, seq, index, signal) → { kind:'text', hunks:[{oldStart,oldLines,newStart,newLines,lines[]}] }
//                                                           | { kind:'binary'|'oversized', path, display }
//
// 本模块只负责「把这些数据变成 IM 里可读的摘要文本 / 可下载的 patch 文本」，不做任何 IO。

/** 单个文件的改动量标注（二进制/过大文件宿主不给行数） */
function describeCounts(file) {
  if (file?.oversized) return '过大，未统计'
  if (file?.binary) return '二进制'
  return `+${Number(file?.added) || 0}/-${Number(file?.deleted) || 0}`
}

/** 去掉可能破坏 Markdown 代码块的字符（路径里出现反引号时） */
function safeLabel(text) {
  return String(text ?? '').replace(/`/g, '')
}

/**
 * 生成本轮改动摘要文本；**没有改动时返回空串**（调用方据此静默，不刷屏）。
 *
 * @param {object} summary ctx.workspaceChanges.summary(...) 的返回值
 * @param {object} [opts]
 * @param {number} [opts.maxFiles=8] 最多逐条列出的文件数（其余折成"…等 N 个"）
 * @returns {string}
 */
export function formatChangesDigest(summary, { maxFiles = 8 } = {}) {
  const total = Number(summary?.total) || 0
  if (!summary || total <= 0) return ''
  const files = Array.isArray(summary.files) ? summary.files : []
  const added = Number(summary.added) || 0
  const deleted = Number(summary.deleted) || 0

  const head = `📝 **本轮改动** ${total} 个文件（+${added}/-${deleted}）`
  const shown = files.slice(0, Math.max(0, maxFiles))
  const lines = shown.map((f) => `- \`${safeLabel(f?.display || f?.path || '(未知)')}\` ${describeCounts(f)}`)
  const rest = total - shown.length
  if (rest > 0) lines.push(`- …共 ${total} 个（其余 ${rest} 个未逐条列出）`)
  if (lines.length === 0) lines.push(`- （宿主未提供逐文件明细，共 ${total} 个）`)
  return [head, ...lines].join('\n')
}

/**
 * 生成统一 diff（.patch）文本：逐文件 `diff --git` + `---/+++` + hunk 头 + hunk 行。
 * 与 `git apply` 的路径匹配不保证（宿主给的是 display 路径，可能是 `../` 或 `~` 形式），
 * 主要用途是"发给用户看/存档"，因此保留宿主原样 display 作为路径。
 *
 * @param {object} summary
 * @param {Array<object|undefined>} diffs 与 summary.files 同序的 diff 结果
 * @returns {string}
 */
export function buildUnifiedPatch(summary, diffs = []) {
  const total = Number(summary?.total) || 0
  const files = Array.isArray(summary.files) ? summary.files : []
  const head = [
    `# dsh-bridge 本轮改动（第 ${Number(summary?.turn) || 0} 轮）`,
    `# 共 ${total} 个文件，+${Number(summary?.added) || 0}/-${Number(summary?.deleted) || 0}`,
    `# 工作区：${safeLabel(summary?.cwd || '(未知)')}`,
    '',
  ].join('\n')

  const body = files.map((file, i) => {
    const display = safeLabel(file?.display || file?.path || `file-${i}`)
    const diff = diffs[i]
    const header = [`diff --git a/${display} b/${display}`, `--- a/${display}`, `+++ b/${display}`]
    if (!diff || diff.kind === 'binary' || diff.kind === 'oversized') {
      const why = diff?.kind === 'oversized' ? '文件过大，未提供行级 diff' : diff?.kind === 'binary' ? '二进制文件，无行级 diff' : '宿主未提供该文件的 diff'
      return [...header, `# ${why}`, ''].join('\n')
    }
    const hunks = Array.isArray(diff.hunks) ? diff.hunks : []
    if (hunks.length === 0) return [...header, '# 无行级差异', ''].join('\n')
    const hunkText = hunks.map((h) => {
      const head2 = `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`
      const lines = Array.isArray(h.lines) ? h.lines : []
      return [head2, ...lines].join('\n')
    }).join('\n')
    return [...header, hunkText, ''].join('\n')
  }).join('\n')

  return head + body
}

/** patch 附件文件名（含轮次，便于用户区分） */
export function changesPatchFileName(turn) {
  const n = Number(turn) || 0
  return `changes-turn-${n}.patch`
}
