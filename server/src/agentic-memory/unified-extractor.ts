/**
 * 统一结构化抽取器（P1-6，用户决策 2026-09-04）。
 *
 * 高信号写入此前的 LLM 链：decideMemoryWrite（决策）→ Mem0 infer（抽取）→
 * commitment-extractor（承诺识别）——最多 3 次调用，且前两次的输入高度重叠。
 * 本模块合并为**一次调用**，同时产出：
 *   - decision：写入决策（remember/decay/reject，替代 decideMemoryWrite）
 *   - memories：独立可召回的陈述条目（替代 Mem0 infer，落库走 infer:false）
 *   - commitments：承诺识别（含 category，替代 commitment-extractor）
 *   - corrections：用户纠正（"不对，是周二"→ oldClaim/newClaim，驱动账本
 *     supersession + 溯源级联作废，见 bootstrap 钩子）
 *
 * 失败/无 key 返回 null → 调用方整体回退旧三段路径（渐进降级，不阻塞写入）。
 */

import OpenAI from "openai";

import { getAgenticMemoryLlmModel, resolveOpenAiApiKey } from "./env.js";
import type { ExtractedCommitment } from "./commitment-board.js";

export interface UnifiedCorrection {
  oldClaim: string;
  newClaim: string;
}

/**
 * 原子身份事实（用户事实注册表入参）：attribute 用受控词表内的中文标签
 * （名字/配偶/父亲/生日/居住地/职业…），词表外标签由注册表归一失败后丢弃。
 */
export interface UnifiedFact {
  attribute: string;
  value: string;
  confidence?: number;
}

export interface UnifiedExtraction {
  decision: "remember" | "decay" | "reject";
  semanticClass?: string;
  /** 独立、自包含、可长期召回的陈述条目（第三人称、含时间/人物等要素） */
  memories: string[];
  commitments: ExtractedCommitment[];
  corrections: UnifiedCorrection[];
  /** 用户第一人称明确主张的身份事实（注册表属性级 upsert + 旧值级联作废） */
  facts: UnifiedFact[];
}

export function isMemoryUnifiedExtractEnabled(): boolean {
  const raw = process.env.AGENT_MEMORY_UNIFIED_EXTRACT_ENABLED?.trim();
  if (raw === undefined || raw === "") return true;
  return raw === "1" || raw === "true" || raw === "yes";
}

const SYSTEM_PROMPT = [
  "你是记忆写入处理器，一次完成五件事，输出严格 JSON（不要任何其他文字）：",
  "{",
  '"decision":"remember|decay|reject",  // remember=值得长期记住；decay=临时上下文；reject=无价值/重复/敏感',
  '"semanticClass":"事实|偏好|计划|承诺|人物|事件|其他",',
  '"memories":["独立、自包含、可长期召回的陈述（第三人称，保留时间/人物/因果要素；无则空数组）"],',
  '"facts":[{"attribute":"属性标签","value":"属性值","confidence":0到1}]  // 用户身份事实，无则空数组',
  "  // attribute 只能取：名字|配偶|父亲|母亲|儿子|女儿|孩子|兄弟姐妹|生日|老家|居住地|职业|公司|学校|宠物",
  "  // 仅当用户以第一人称明确主张当前事实时收录（如「我老婆是刘浩存」「我叫小明」「我住在杭州」）；",
  "  // 假设、玩笑、疑问、转述他人、影视剧情一律不收；同句主张多个属性逐条收录",
  '"commitments":[{"text":"承诺内容（第三人称）","committedBy":"user|agent|third_party","deadline":"ISO 8601 或 null","confidence":0到1,"evidence":"原文片段","category":"报价|交付|会面|转账|其他"}],',
  '"corrections":[{"oldClaim":"被纠正的旧陈述","newClaim":"纠正后的新陈述"}]  // 用户明确否认/更正既有信息时才有',
  "}",
  "规则：memories 合并重复信息、拒绝寒暄；",
  "承诺只收真正的承诺（排除意愿/假设/客套）；对话中转述的第三方承诺",
  "（如「老板说下周三前交付」「他说周五前发货」）也是承诺，committedBy=third_party；",
  "deadline 的相对时间（明天/周五/下周三/晚上8点）必须结合输入给出的当前时间",
  "换算为绝对 ISO 8601 时间，无法确定才用 null；",
  "corrections 仅当文本在否定或更正「旧信息」时输出（如「不对，会议改到周三了」），",
  "无法确定旧陈述原文时用最接近的概括。",
].join("\n");

interface RawUnified {
  decision?: unknown;
  semanticClass?: unknown;
  memories?: unknown;
  commitments?: unknown;
  corrections?: unknown;
  facts?: unknown;
}

function asStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((v): v is string => typeof v === "string")
    .map((s) => s.trim())
    .filter((s) => s.length >= 4)
    .slice(0, 8);
}

/** 从 LLM 输出剥 JSON（容忍 ``` 围栏与前后杂文；导出供测试） */
export function parseJsonObject(output: string): RawUnified | null {
  const fenced = output.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1]! : output;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1)) as RawUnified;
  } catch {
    return null;
  }
}

/** 导出供测试：结构规范化（决策校验/承诺字段/纠正项） */
export function normalize(raw: RawUnified): UnifiedExtraction | null {
  const decision =
    raw.decision === "remember" || raw.decision === "decay" || raw.decision === "reject"
      ? raw.decision
      : null;
  if (!decision) return null;

  const commitments = Array.isArray(raw.commitments)
    ? (raw.commitments as Array<Record<string, unknown>>)
        .map((c) => {
          const text = typeof c.text === "string" ? c.text.trim() : "";
          const committedBy =
            c.committedBy === "user" || c.committedBy === "agent" || c.committedBy === "third_party"
              ? c.committedBy
              : null;
          const evidence = typeof c.evidence === "string" ? c.evidence.trim() : "";
          const conf = Number(c.confidence);
          if (!text || !committedBy || !evidence) return null;
          let deadline: string | null = null;
          if (typeof c.deadline === "string" && c.deadline.trim() && !/^null$/i.test(c.deadline.trim())) {
            const ts = Date.parse(c.deadline);
            if (Number.isFinite(ts)) deadline = new Date(ts).toISOString();
          }
          return {
            text,
            committedBy,
            deadline,
            confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0,
            evidence,
            ...(typeof c.category === "string" && c.category.trim() ? { category: c.category.trim() } : {}),
          } as ExtractedCommitment;
        })
        .filter((c): c is ExtractedCommitment => c !== null)
        .slice(0, 5)
    : [];

  const corrections = Array.isArray(raw.corrections)
    ? (raw.corrections as Array<Record<string, unknown>>)
        .map((c) => {
          const oldClaim = typeof c.oldClaim === "string" ? c.oldClaim.trim() : "";
          const newClaim = typeof c.newClaim === "string" ? c.newClaim.trim() : "";
          return oldClaim && newClaim ? { oldClaim, newClaim } : null;
        })
        .filter((c): c is UnifiedCorrection => c !== null)
        .slice(0, 3)
    : [];

  const facts = Array.isArray(raw.facts)
    ? (raw.facts as Array<Record<string, unknown>>)
        .map((f) => {
          const attribute = typeof f.attribute === "string" ? f.attribute.trim() : "";
          const value = typeof f.value === "string" ? f.value.trim() : "";
          if (!attribute || !value) return null;
          const conf = Number(f.confidence);
          return {
            attribute,
            value,
            ...(Number.isFinite(conf) ? { confidence: Math.max(0, Math.min(1, conf)) } : {}),
          } as UnifiedFact;
        })
        .filter((f): f is UnifiedFact => f !== null)
        .slice(0, 6)
    : [];

  return {
    decision,
    ...(typeof raw.semanticClass === "string" ? { semanticClass: raw.semanticClass } : {}),
    memories: decision === "reject" ? [] : asStringArray(raw.memories),
    commitments,
    corrections,
    facts,
  };
}

/** 最小 LLM 客户端外观（测试注入 fake；生产传 OpenAI 实例） */
export interface UnifiedLlmClient {
  chat: {
    completions: {
      create(args: {
        model: string;
        temperature: number;
        messages: Array<{ role: string; content: string }>;
      }): Promise<{ choices?: Array<{ message?: { content?: string } }> }>;
    };
  };
}

/**
 * 单次 LLM 完成写入决策 + 记忆抽取 + 承诺识别 + 纠正识别。
 * 任何失败返回 null（调用方回退旧路径），绝不抛错、绝不阻塞写入主链路。
 * 4 字下限为纯卫生闸（挡"好的/哈哈"）：口语承诺可以很短（"明天发你"），
 * 路由不看词表——识别交给 LLM。
 */
export async function extractUnified(
  text: string,
  opts?: { client?: UnifiedLlmClient; model?: string; now?: Date },
): Promise<UnifiedExtraction | null> {
  const body = text.trim();
  if (!body || body.length < 4) return null;
  const apiKey = resolveOpenAiApiKey();
  if (!apiKey && !opts?.client) return null;
  const now = opts?.now ?? new Date();
  // 本地时区 ISO（+08:00 等）：相对时间换算要按用户墙钟，UTC 会差一天
  const tzMin = -now.getTimezoneOffset();
  const tzSign = tzMin >= 0 ? "+" : "-";
  const tzStr = `${tzSign}${String(Math.floor(Math.abs(tzMin) / 60)).padStart(2, "0")}:${String(Math.abs(tzMin) % 60).padStart(2, "0")}`;
  const nowIso = new Date(now.getTime() - tzMin * 60_000).toISOString().replace("Z", tzStr);

  try {
    const openai = opts?.client ?? new OpenAI({ apiKey });
    const response = await openai.chat.completions.create({
      model: opts?.model ?? getAgenticMemoryLlmModel(),
      temperature: 0,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `当前时间：${nowIso}\n\n对话文本：\n${body.slice(0, 8000)}` },
      ],
    });
    const output = response.choices?.[0]?.message?.content?.trim() ?? "";
    if (!output) return null;

    const { recordLlmUsageByChars } = await import("../services/llm-token-audit.js");
    recordLlmUsageByChars({
      stage: "memory_unified_extract",
      inputChars: body.length,
      outputChars: output.length,
      model: getAgenticMemoryLlmModel(),
    });

    return normalize(parseJsonObject(output) ?? {});
  } catch (err) {
    console.warn(
      "[unified-extractor] 抽取失败（回退旧路径）:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}
