/**
 * 建议话术的实时个性化（每轮实时决策，非固定话术）。
 *
 * 流程：shopping.suggest handler 先用引擎从商品库确定性检索候选，
 * 再把「用户画像/习惯摘要 + 候选结构化数据 + 用户本轮原话」交给一次
 * ephemeral LLM 调用做实时决策——重排候选、按用户场景改写理由、剔除
 * 不适合项——最后由 applyPersonalization 确定性回填。LLM 不可用/输出
 * 非法时整体降级为商品库原始文案（primary 是实时决策，降级只是兜底）。
 *
 * grounding 纪律：候选的参数/价格/口碑/视频永远来自商品库（本模块覆盖），
 * 图片来自商品库或 handler 侧的确定性网搜补图（life-tools），LLM 只重排与
 * 改写 reasons/cautions/summary 文本。
 */

import type { SuggestCandidate, SuggestResult } from "./suggest-engine.js";

export type PersonalizationLlmOutput = {
  summary?: string;
  candidates?: Array<{
    productId?: string;
    reasons?: unknown;
    cautions?: unknown;
  }>;
};

export type SuggestPersonalizationPort = {
  /** 用户画像/习惯摘要（无画像或拉取失败返回 null，跳过个性化） */
  buildUserContext: (actorId: string, userRequest?: string) => Promise<string | null>;
  /** ephemeral 单轮 LLM 调用（system=规则，user=数据块）；不可用返回 null */
  llmComplete: ((system: string, userText: string) => Promise<string>) | null;
};

export const PERSONALIZATION_RULES_PROMPT = `你是购物建议的个性化组织器。基于【用户画像与习惯】和【候选商品数据】，为这位用户实时组织本轮推荐话术。

要求：
1) 只使用画像与商品数据中出现的事实（参数/价格/评价/用户画像条目），禁止编造参数、编造评价、编造用户没有表达过的偏好
2) 结合用户画像与习惯改写每个候选的 reasons：落到用户的具体场景（通勤/预算/已有设备/作息/偏好），每条不超过 30 字
3) cautions 同样按用户场景改写（对这位用户真正要紧的注意点放前面）
4) 重排 candidates：最贴合该用户的在前；明确不适合该用户的候选可以剔除
5) summary 一句话（不超过 40 字），直接给结论，说明为什么这么排
6) 只输出 JSON，格式：
{"summary":"…","candidates":[{"productId":"…","reasons":["…"],"cautions":["…"]}]}
不要输出任何解释文字。`;

export function buildPersonalizationUserPrompt(input: {
  userRequest: string;
  userContext: string;
  candidatesJson: string;
}): string {
  return `【用户本轮原话/意图】
${input.userRequest}

【用户画像与习惯】
${input.userContext}

【候选商品数据】
${input.candidatesJson}`;
}

/** 手工校验 + 回填：LLM 决策只影响 order/summary/reasons/cautions 文本 */
export function applyPersonalization(
  result: SuggestResult,
  rawLlmText: string,
  logger?: { error: (msg: string) => void },
): { result: SuggestResult; applied: boolean } {
  let parsed: PersonalizationLlmOutput;
  try {
    const jsonText = extractJsonBlock(rawLlmText);
    parsed = JSON.parse(jsonText) as PersonalizationLlmOutput;
  } catch (err) {
    logger?.error(
      `[shopping.suggest] 个性化决策输出非法，降级商品库文案：${err instanceof Error ? err.message : String(err)}`,
    );
    return { result, applied: false };
  }

  if (!Array.isArray(parsed.candidates) || parsed.candidates.length === 0) {
    return { result, applied: false };
  }

  const byId = new Map<string, SuggestCandidate>(
    result.candidates.map((c) => [c.productId, c]),
  );
  const personalized: SuggestCandidate[] = [];
  const seen = new Set<string>();
  for (const entry of parsed.candidates) {
    const id = typeof entry?.productId === "string" ? entry.productId : "";
    const base = byId.get(id);
    if (!base || seen.has(id)) continue; // 未知/重复 id 一律丢弃（不信任幻觉商品）
    seen.add(id);
    personalized.push({
      ...base,
      reasons: toStringList(entry.reasons, base.reasons, 3),
      cautions: toStringList(entry.cautions, base.cautions, 3),
    });
  }
  // LLM 漏掉的既有候选按原顺序补回（不丢真实匹配结果）
  for (const c of result.candidates) {
    if (!seen.has(c.productId)) personalized.push(c);
  }
  if (personalized.length === 0) return { result, applied: false };

  return {
    result: {
      ...result,
      summary:
        typeof parsed.summary === "string" && parsed.summary.trim().length > 0
          ? parsed.summary.trim()
          : result.summary,
      candidates: personalized,
    },
    applied: true,
  };
}

function toStringList(raw: unknown, fallback: string[], max: number): string[] {
  const list = (Array.isArray(raw) ? raw : [])
    .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    .map((x) => x.trim())
    .slice(0, max);
  return list.length > 0 ? list : fallback;
}

/** 宽容提取 JSON：模型偶发包 ``` 代码块或前后缀 */
function extractJsonBlock(text: string): string {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  if (fenced?.[1]) return fenced[1].trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}
