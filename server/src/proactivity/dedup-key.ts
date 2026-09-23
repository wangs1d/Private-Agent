/**
 * 语义去重键归一化（dedup-key）—— 跨触发源的"同一件事"识别。
 *
 * 缺口：此前 dedupKey 靠 producer 拼「kind + 文本前 48 字」——同一件事换个说法
 * （LLM 文案每次生成、模板参数差异）就会绕过 24h 去重窗口造成重发。
 * 归一化规则（保守，避免误合并不相关的两件事）：
 *   1. 全角/半角统一、小写化
 *   2. 去标点/空白/emoji 装饰符
 *   3. 中文数字与阿拉伯数字不互转（保守），保留内容区分度
 * 输出：归一化后的文本（producer 自己截断拼 kind）。
 */

/** 归一化：小写 + 去空白/标点（保留 CJK、字母、数字） */
export function normalizeDedupText(text: string): string {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .slice(0, 48);
}

/** 组合键：kind + 归一化文本（跨说法稳定，同一 kind 内防重发） */
export function semanticDedupKey(kind: string, text: string): string {
  return `${kind}:${normalizeDedupText(text)}`;
}
