import { getRecallCompressThreshold } from "./env.js";

/**
 * 记忆架构重构：召回压缩器去 LLM 化。
 * 原实现超阈值时用 LLM（temperature 0.2）把记忆条目重写为要点列表——
 * 这是标准幻觉注入口（小模型改写会合并/曲解/脑补事实）。
 * 新实现只做确定性按条目边界截断（不伤语义、不引入改写）。
 */
export class AgenticMemoryRecallCompressor {
  async compress(recallText: string): Promise<string> {
    const threshold = getRecallCompressThreshold();
    if (!recallText || recallText.length <= threshold) return recallText;
    return this.truncateSimple(recallText, threshold);
  }

  private truncateSimple(text: string, maxLen: number): string {
    if (text.length <= maxLen) return text;
    const headerEnd = text.indexOf("\n");
    const header = headerEnd > 0 ? text.slice(0, headerEnd) : "";
    const body = headerEnd > 0 ? text.slice(headerEnd + 1) : text;
    const entries = body.split("\n\n");
    const kept: string[] = [];
    let total = header ? header.length + 1 : 0;

    for (const entry of entries) {
      if (total + entry.length + 2 > maxLen) break;
      kept.push(entry);
      total += entry.length + 2;
    }

    const result = header ? `${header}\n${kept.join("\n\n")}` : kept.join("\n\n");
    if (result.length < text.length) {
      return `${result}\n\n（共 ${entries.length} 条，已截断至 ${kept.length} 条）`;
    }
    return result;
  }
}
