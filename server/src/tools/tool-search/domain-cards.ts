/**
 * 域卡（Domain Cards）——延迟工具目录的能力面展示（2026-10-01 S1）。
 *
 * 根修目标：元认知盲区。检索（无论 BM25 多准）只能回应"模型已经想找"的查询，
 * "不知道有这个能力所以不搜"的漏召结构性无法治愈。域卡把全部能力域+工具名
 * 以 ~1.2k token 常驻在指导语位置（消息尾部动态区，前缀缓存不受影响），模型
 * 每轮都知道"我有什么"，简单参数工具可按名直呼 tool_call（零往返），复杂参数
 * 工具用 tool_discover({domain}) 确定性拉取全族 schema。
 *
 * 卡片从语料派生（不手工维护，MCP/技能注册即自动刷新），同语料签名恒同字节。
 */
import type { ChatCompletionTool } from "openai/resources/chat/completions";

import { DOMAIN_REGISTRY, domainsForTool } from "./tool-category.js";
import { firstSentence } from "./schema-slim.js";

/** 卡片工具清单每域上限（超出的长尾域截断并标注；misc 域本就受控） */
const CARD_TOOLS_PER_DOMAIN = 14;

function nameOf(tool: ChatCompletionTool): string {
  return tool.type === "function" ? tool.function?.name ?? "" : "";
}

/**
 * 生成域卡文本（确定性：registry 顺序 + 域内按语料序，同签名恒同输出）。
 * @param corpus 全量可检索语料（含当轮可见工具——卡片覆盖完整能力面，
 *               不随当轮可见集抖动，换取跨轮字节稳定）
 */
export function buildDomainCards(corpus: ChatCompletionTool[]): string {
  const byDomain = new Map<string, string[]>();
  for (const tool of corpus) {
    const name = nameOf(tool);
    if (!name) continue;
    for (const domain of domainsForTool(name)) {
      const list = byDomain.get(domain) ?? [];
      if (!list.includes(name)) list.push(name);
      byDomain.set(domain, list);
    }
  }

  const lines: string[] = [];
  for (const def of DOMAIN_REGISTRY) {
    const names = byDomain.get(def.name);
    if (!names || names.length === 0) continue; // 语料无此域（edition/模块裁剪）→ 卡片不出现
    const shown = names.slice(0, CARD_TOOLS_PER_DOMAIN);
    const more = names.length - shown.length;
    lines.push(
      `- ${def.name}｜${def.summary}：${shown.join("·")}` + (more > 0 ? `（+${more}）` : ""),
    );
  }
  if (lines.length === 0) return "";

  return [
    "【能力域目录】以下是延迟目录按域组织的全部能力（当轮可见工具之外的都在这里）：",
    "简单参数的工具可直接 tool_call 按名调用；参数复杂的先用 tool_discover({domain:\"域名\"}) 拉取该域工具的参数 schema 再调用；",
    "不确定该用哪个域时可用 tool_discover({query:\"...\"}) 按语义检索。动手类任务先查此目录，不要凭常识断言做不到。",
    ...lines,
  ].join("\n");
}
