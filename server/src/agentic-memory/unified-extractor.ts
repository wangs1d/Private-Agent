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
 * 对话理解条目（用户理解档案入参）：不是字面事实归一，而是「我对这句话的理解」
 * ——topic 用用户原话里的核心称谓/主题，note 必须保留语气与性质判断。
 * 例：用户说"我的老婆是刘浩存"（刘浩存为明星）→
 *   { topic: "老婆", kind: "fandom",
 *     note: "用户半开玩笑地自称'老婆'是明星刘浩存——粉丝式称呼，并非真实关系" }
 */
export interface UnifiedUnderstanding {
  topic: string;
  note: string;
  kind: "literal" | "joke" | "fandom" | "figurative" | "preference" | "correction" | "other";
  confidence?: number;
}

export interface UnifiedExtraction {
  decision: "remember" | "decay" | "reject";
  semanticClass?: string;
  /** 独立、自包含、可长期召回的陈述条目（第三人称、保留语气/性质/语境） */
  memories: string[];
  commitments: ExtractedCommitment[];
  corrections: UnifiedCorrection[];
  /** 对话理解（理解档案 topic 级 upsert + 演变历史） */
  understandings: UnifiedUnderstanding[];
}

export function isMemoryUnifiedExtractEnabled(): boolean {
  const raw = process.env.AGENT_MEMORY_UNIFIED_EXTRACT_ENABLED?.trim();
  if (raw === undefined || raw === "") return true;
  return raw === "1" || raw === "true" || raw === "yes";
}

const SYSTEM_PROMPT = [
  "你是记忆理解处理器，一次完成四件事，输出严格 JSON（不要任何其他文字）：",
  "{",
  '"decision":"remember|decay|reject",  // remember=值得长期记住；decay=临时上下文；reject=无价值/重复/敏感',
  '"semanticClass":"事实|偏好|计划|承诺|人物|事件|其他",',
  '"memories":["你对这段对话的理解记录（第三人称、自包含、可长期召回；无则空数组）"],',
  "  // memories 必须保留语气与性质（玩笑/粉丝式称呼/比喻/正式），不要剥掉语境输出字面断言：",
  "  // 例：用户说「我老婆是刘浩存」→「用户半开玩笑地自称'老婆'是明星刘浩存（粉丝式称呼）」，",
  "  // 而不是「用户的老婆是刘浩存」",
  '"understandings":[{"topic":"话题词","note":"你对这条内容的理解（第三人称，保留语气与性质判断）","kind":"literal|joke|fandom|figurative|preference|correction|other","confidence":0到1}]',
  "  // 用户关于自身/关系/偏好的值得记住的表达，逐条写理解；topic 用用户原话里的核心称谓（如：老婆|工作|居住地）",
  "  // kind 判断：公众人物/明星被冠以亲属称谓（老婆/老公/女儿…）默认是粉丝式称呼 kind=fandom，",
  "  // note 必须写明「粉丝式称呼，并非真实关系」——除非用户明确表示是真实关系；",
  "  // 玩笑/调侃 kind=joke；比喻夸张 kind=figurative；改口/更正 kind=correction（note 写明从什么改成什么）；",
  "  // 字面陈述（我叫X/我住在X）kind=literal",
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
  understandings?: unknown;
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

  const understandings = Array.isArray(raw.understandings)
    ? (raw.understandings as Array<Record<string, unknown>>)
        .map((u) => {
          const topic = typeof u.topic === "string" ? u.topic.trim() : "";
          const note = typeof u.note === "string" ? u.note.trim() : "";
          if (!topic || !note) return null;
          const conf = Number(u.confidence);
          return {
            topic,
            note,
            kind:
              typeof u.kind === "string" &&
              ["literal", "joke", "fandom", "figurative", "preference", "correction", "other"].includes(u.kind)
                ? u.kind
                : "other",
            ...(Number.isFinite(conf) ? { confidence: Math.max(0, Math.min(1, conf)) } : {}),
          } as UnifiedUnderstanding;
        })
        .filter((u): u is UnifiedUnderstanding => u !== null)
        .slice(0, 6)
    : [];

  return {
    decision,
    ...(typeof raw.semanticClass === "string" ? { semanticClass: raw.semanticClass } : {}),
    memories: decision === "reject" ? [] : asStringArray(raw.memories),
    commitments,
    corrections,
    understandings,
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
