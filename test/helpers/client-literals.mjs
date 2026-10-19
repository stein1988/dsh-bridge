// 客户端文案盘点：用 espree 解析 client/index.js，收集「用户可见字符串」候选。
//
// 用途（见 test/panel-i18n.test.mjs）：
//   - 字典完整性：源码里每个含中文的字面量（含模板静态片段）都必须在 panelEn 词典
//     或内部文案白名单里，否则显式失败 —— 新加的中文文案不会悄悄漏翻；
//   - 字典有效性：panelEn 里每个键都必须仍被源码引用（改文案后旧词条要删掉）。
//
// 只认字符串字面量与模板静态片段；正则字面量（如 /^\d+\s+(item|items|项|个)/）不是
// 文案，不参与统计。
import { parse } from 'espree';

// 「需要翻译」的字符：汉字 + 全角标点/全角形式。
// 只用汉字判定会漏掉「IPv4（4）」「${label}：${reason}」这类只含全角标点的文案——
// 它们在英文界面下会原样残留中文标点（独立验收实测过）。
const TRANSLATABLE_RE = /[\u3400-\u9fff\u3000-\u303f\uff01-\uff60\uffe0-\uffe6]/;

export function needsTranslation(text) {
  return typeof text === 'string' && TRANSLATABLE_RE.test(text);
}

function walk(node, visit) {
  if (!node || typeof node.type !== 'string') return;
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === 'parent') continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) if (child && typeof child.type === 'string') walk(child, visit);
    } else if (value && typeof value.type === 'string') {
      walk(value, visit);
    }
  }
}

/**
 * 收集「需要翻译」的字符串字面量 / 模板静态片段（汉字或全角标点）。
 * @param {string} source - JS 源码
 * @returns {{ value: string, kind: 'string'|'template', line: number }[]}
 */
export function collectClientLiterals(source) {
  const ast = parse(source, {
    ecmaVersion: 'latest',
    sourceType: 'module',
    loc: true,
    range: true,
  });
  const out = [];
  walk(ast, (node) => {
    if (node.type === 'Literal' && typeof node.value === 'string' && needsTranslation(node.value)) {
      out.push({ value: node.value, kind: 'string', line: node.loc.start.line });
    } else if (node.type === 'TemplateElement' && needsTranslation(node.value.cooked)) {
      out.push({ value: node.value.cooked, kind: 'template', line: node.loc.start.line });
    }
  });
  return out;
}
