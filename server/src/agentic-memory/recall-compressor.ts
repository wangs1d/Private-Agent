import OpenAI from "openai";

import {
  resolveOpenAiApiKey,
  getAgenticMemoryLlmModel,
  getRecallCompressThreshold,
} from "./env.js";

export class AgenticMemoryRecallCompressor {
  async compress(recallText: string): Promise<string> {
    const threshold = getRecallCompressThreshold();
    if (!recallText || recallText.length <= threshold) return recallText;

    const apiKey = resolveOpenAiApiKey();
    if (!apiKey) {
      return this.truncateSimple(recallText, threshold);
    }

    try {
      const openai = new OpenAI({ apiKey });
      const response = await openai.chat.completions.create({
        model: getAgenticMemoryLlmModel(),
        temperature: 0.2,
        max_tokens: 600,
        messages: [
          {
            role: "system",
            content: [
              "你是记忆压缩器。将检索到的记忆条目压缩为极简要点列表，每条不超过一行。",
              "保留：关键事实、用户偏好、Agent承诺、待办事项、重要日期。",
              "丢弃：冗余信息、低相关度条目、纯寒暄。",
              "输出格式：每行一条「- 要点」，不超过15条。",
            ].join("\n"),
          },
          { role: "user", content: recallText },
        ],
      });
      const compressed = response.choices[0]?.message?.content?.trim();
      if (!compressed) return this.truncateSimple(recallText, threshold);

      return `以下为 Mem0 记忆图联想检索（已压缩）：\n${compressed}`;
    } catch {
      return this.truncateSimple(recallText, threshold);
    }
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
