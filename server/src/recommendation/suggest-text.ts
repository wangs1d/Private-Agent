/**
 * 建议结果的文本投影：给 LLM 的紧凑摘要（工具回执正文明语），让模型口头
 * 回复能落到具体数据上。结构化卡片不经此——卡片由 tool-card-registry 从
 * 结构化字段确定性构建。
 */

import type { SuggestResult } from "./suggest-engine.js";

export function buildAdvisorSuggestionText(result: SuggestResult): string {
  const lines: string[] = [];
  for (const c of result.candidates) {
    lines.push(`【${c.brand} ${c.name}｜${c.priceLabel}】`);
    for (const r of c.reasons) lines.push(`  + ${r}`);
    for (const t of c.cautions) lines.push(`  - ${t}`);
    if (c.image) lines.push(`  图：${c.image}`);
    for (const v of c.videos) {
      lines.push(`  视频：${v.title}${v.url ? `（${v.url}）` : ""}`);
    }
  }
  if (result.compare && result.compare.rows.length > 0) {
    lines.push("对比：");
    for (const row of result.compare.rows) {
      lines.push(`  ${row.label}：${row.values.join(" vs ")}`);
    }
  }
  return lines.join("\n");
}
