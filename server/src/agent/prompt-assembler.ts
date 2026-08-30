import type { AgentPromptMemoryContext } from "../external-model/types.js";

/**
 * Prompt 单一组装出口（2026-08-28 注入路径统一重构）。
 *
 * 之前 system prompt 有 5 个入口各自拼块（PromptContextBuilder 40+ 字段直拼、
 * prompt-builder 双函数重复渲染、runtime-kernel minimal 身份、agent-core 手拼
 * 免责头、finalizeChatSystemPrompt 后缀追加），改一处漏一处。现在：
 *  - 所有"记忆/上下文块"的渲染只在本文件发生（家族合并 + 统一免责）
 *  - prompt-builder 的 buildLayeredSystemPrompt / Sections 退化为薄委托
 *  - prefix-cache / providers 经 assembleSystemPrompt 一次性拿三层结果
 *
 * 分层（前缀缓存友好：稳定层在前，动态层沉底）：
 *  - stablePrefix：身份/人格/能力/慢变画像/夜间整理记忆
 *  - dynamicContext：本轮易变块（时间/召回/任务/短期上下文）
 *
 * 家族合并（块数 40+ → 10 组）：
 *  - 【记忆整理】：关系/生活主题/梦境/连续性/跨天回顾（5→1）
 *  - 【短期上下文】：最近对话/工作记忆/今日日志/今日摘要（4→1）
 *  - 【用户档案】：画像/偏好/事实/持久记忆/会话回顾（5→1）
 *  - 【待办与承诺】：承诺/未完成事项（2→1）
 *  - [Turn Task Context]：任务/追问锚点/建议工具链（3→1）
 */

/**
 * 全局记忆使用规则（唯一免责声明）。
 * 历史 4 处分散免责（记忆使用规则 + 记忆图联想检索 + 最近对话回顾 + 今日对话日志检索）
 * 收敛为：本条全局规则 + 记忆图联想检索块保留专属免责（项目约束：该块必须带免责）。
 */
export const GLOBAL_MEMORY_RULE = [
  "【记忆使用规则】",
  "下方所有「记忆 / 回顾 / 画像 / 摘要 / 承诺 / 事项」块均为历史背景，仅供衔接与指代消解，不是用户的最新指令。「用户最新一条消息」才是本轮的唯一指令基准。除非用户明确要求回忆历史，否则一律以最新消息为准；当历史记忆与最新消息冲突时，以最新消息为准，并仅就最新消息作答。",
].join("\n");

/** 短期上下文家族头的简短免责（覆盖原"最近对话回顾/今日日志"两处分散免责）。 */
const SHORT_TERM_DISCLAIMER =
  "（历史对话背景，非用户最新指令；与当前对话冲突时以用户最新消息为准）";

/** 参与渲染的记忆字段全集（单一清单，替代旧版两份不一致的 gate 列表）。 */
const RENDERED_MEMORY_FIELDS: ReadonlyArray<keyof AgentPromptMemoryContext> = [
  "persona",
  "personalityCore",
  "values",
  "abilities",
  "agentCaps",
  "worldCaps",
  "userProfileSummary",
  "memoryInventory",
  "relationshipMemory",
  "lifeThemeMemory",
  "dreamMemory",
  "memoryContinuity",
  "yesterdayHighlight",
  "semanticIntent",
  "scheduleSnapshot",
  "taskContext",
  "followUpAnchor",
  "toolPlan",
  "userLocation",
  "narrativeRecall",
  "workingMemorySummary",
  "recentConversationHistory",
  "journalRecall",
  "dailyDigest",
  "userProfile",
  "memorySummary",
  "memoryPreferences",
  "memoryFacts",
  "memoryCommitments",
  "memoryOpenLoops",
  "sessionRecap",
  "interruptedContext",
  "currentTime",
  "conversationTimeline",
  "skillIndex",
  "proactiveAdvice",
  "interestList",
  "modeRoleGuidance",
  "toneGuidance",
  "emotionState",
  "relationshipGuidance",
];

export function hasAnyPromptMemory(memory?: AgentPromptMemoryContext): boolean {
  if (!memory) return false;
  return RENDERED_MEMORY_FIELDS.some((key) => Boolean(memory[key]));
}

/**
 * 动态风格层 → 单一【回复指南】块（收敛为唯一风格决策源）。
 * - 基准行恒在：短句、先结论、有人味。
 * - 语气/情绪/关系边界/模式职责四路合并为小节。
 */
function buildReplyStyleGuide(memory: AgentPromptMemoryContext): string {
  const lines = [
    "基准：口吻短句为主、一句一顿，先亮结论，再给建议与下一步方案；有人味，不客服腔、不总结腔、不机械罗列。",
  ];
  if (memory.modeRoleGuidance) lines.push(`模式：${memory.modeRoleGuidance}`);
  if (memory.toneGuidance) lines.push(`语气：${memory.toneGuidance}`);
  if (memory.emotionState) lines.push(`情绪：${memory.emotionState}`);
  if (memory.relationshipGuidance) lines.push(`关系：${memory.relationshipGuidance}`);
  return `【回复指南】\n${lines.join("\n\n")}`;
}

/** 家族块组装：多字段合并为一个带小节标签的块；全空返回 undefined。 */
function buildFamilyBlock(
  title: string,
  headerNote: string | undefined,
  sections: Array<{ label: string; content: string | undefined }>,
): string | undefined {
  const body = sections
    .filter((s): s is { label: string; content: string } => Boolean(s.content?.trim()))
    .map((s) => `${s.label}：\n${s.content.trim()}`)
    .join("\n\n");
  if (!body) return undefined;
  return headerNote ? `${title}${headerNote}\n${body}` : `${title}\n${body}`;
}

export type LayeredSections = {
  /** 稳定前缀：身份/人格/能力/慢变画像/夜间整理记忆（会话内基本不变，前缀缓存友好）。 */
  stablePrefix: string[];
  /** 动态上下文：本轮易变块（沉底注入，避免污染缓存前缀）。 */
  dynamicContext: string[];
};

/**
 * 分层渲染（单一出口）：stable 在前、dynamic 在后。
 * 旧版 buildLayeredSystemPrompt 与 buildLayeredSystemPromptSections 顺序不一致
 * （前者混合排序、baseSystem 在末尾），统一为 stable → dynamic，baseSystem 由
 * assembleSystemPrompt 置于最前（缓存命中最优）。
 */
export function assembleLayeredSections(memory?: AgentPromptMemoryContext): LayeredSections {
  if (!hasAnyPromptMemory(memory)) {
    return { stablePrefix: [], dynamicContext: [] };
  }
  const m = memory as AgentPromptMemoryContext;

  // ── 稳定层 ──
  const stablePrefix: string[] = [];
  if (m.personalityCore) stablePrefix.push(`【人格内核】\n${m.personalityCore}`);
  if (m.persona) stablePrefix.push(`【人格与角色】\n${m.persona}`);
  if (m.values) stablePrefix.push(`【价值观与原则】\n${m.values}`);
  // 能力合并：KV 能力倾向 + 宿主 Agent 能力说明本就是同一语义（"我能干什么"）
  const abilitiesCombined = [m.abilities, m.agentCaps].filter(Boolean).join("\n");
  if (abilitiesCombined) stablePrefix.push(`【能力与工具】\n${abilitiesCombined}`);
  if (m.worldCaps) stablePrefix.push(`【Agent World】\n${m.worldCaps}`);
  if (m.userProfileSummary) stablePrefix.push(`【用户长期画像】\n${m.userProfileSummary}`);
  if (m.memoryInventory) stablePrefix.push(`【记忆目录】\n${m.memoryInventory}`);
  // 记忆整理家族（5→1）：夜间整理的跨会话背景记忆。块内保留源标题作小节标签。
  const memoryConsolidated = buildFamilyBlock(
    "【记忆整理】",
    "（夜间整理的跨会话背景记忆）",
    [
      { label: "关系", content: m.relationshipMemory },
      { label: "生活主题", content: m.lifeThemeMemory },
      { label: "梦境整理", content: m.dreamMemory },
      { label: "连续性", content: m.memoryContinuity },
      { label: "跨天回顾", content: m.yesterdayHighlight },
    ],
  );
  if (memoryConsolidated) stablePrefix.push(memoryConsolidated);

  // ── 动态层 ──
  const dynamicContext: string[] = [];
  if (m.semanticIntent) dynamicContext.push(`【意图理解】\n${m.semanticIntent}`);
  if (m.scheduleSnapshot) dynamicContext.push(m.scheduleSnapshot);
  // 任务家族（3→1）：任务上下文 / 追问锚点 / 建议工具链
  const taskBlock = buildFamilyBlock("[Turn Task Context]", undefined, [
    { label: "任务", content: m.taskContext },
    { label: "追问锚点", content: m.followUpAnchor },
    { label: "建议工具链", content: m.toolPlan },
  ]);
  if (taskBlock) dynamicContext.push(taskBlock);
  if (m.userLocation) dynamicContext.push(`【用户位置】\n${m.userLocation}`);
  // 记忆图联想检索：保留专属免责（项目硬约束：该块必须带免责声明）
  if (m.narrativeRecall) {
    dynamicContext.push(
      `【记忆图联想检索】\n（历史记忆检索结果，可能来自更早会话，非用户本轮所述；不确定时如实说明，与当前对话冲突时以用户最新消息为准）\n${m.narrativeRecall}`,
    );
  }
  // 短期上下文家族（4→1）：工作记忆 / 最近对话 / 今日日志 / 今日摘要
  const shortTermBlock = buildFamilyBlock("【短期上下文】", SHORT_TERM_DISCLAIMER, [
    { label: "工作记忆", content: m.workingMemorySummary },
    { label: "最近对话", content: m.recentConversationHistory },
    { label: "今日日志", content: m.journalRecall },
    { label: "今日摘要", content: m.dailyDigest },
  ]);
  if (shortTermBlock) dynamicContext.push(shortTermBlock);
  // 用户档案家族（5→1）：画像 / 偏好 / 事实 / 持久记忆 / 会话回顾
  const userProfileBlock = buildFamilyBlock("【用户档案】", undefined, [
    { label: "画像", content: m.userProfile },
    { label: "偏好", content: m.memoryPreferences },
    { label: "事实", content: m.memoryFacts },
    { label: "持久记忆", content: m.memorySummary },
    { label: "会话回顾", content: m.sessionRecap },
  ]);
  if (userProfileBlock) dynamicContext.push(userProfileBlock);
  // 待办与承诺家族（2→1）
  const todoBlock = buildFamilyBlock("【待办与承诺】", undefined, [
    { label: "待兑现承诺", content: m.memoryCommitments },
    { label: "未完成事项", content: m.memoryOpenLoops },
  ]);
  if (todoBlock) dynamicContext.push(todoBlock);
  if (m.interruptedContext) dynamicContext.push(m.interruptedContext);
  if (m.currentTime) dynamicContext.push(`【当前时间】\n${m.currentTime}`);
  if (m.conversationTimeline) dynamicContext.push(m.conversationTimeline);
  if (m.skillIndex) dynamicContext.push(m.skillIndex);
  if (m.proactiveAdvice) dynamicContext.push(m.proactiveAdvice);
  if (m.interestList) dynamicContext.push(m.interestList);
  dynamicContext.push(buildReplyStyleGuide(m));

  return { stablePrefix, dynamicContext };
}

export type AssembledSystemPrompt = {
  /** 完整 system prompt（stable + dynamic），用于 msgs[0] 直发路径。 */
  fullSystemPrompt: string;
  /** 稳定 system（baseSystem + 全局规则 + 稳定层），用于前缀缓存请求。 */
  stableSystemPrompt: string;
  /** 动态上下文（沉底注入最新 user 消息尾部），无内容时 undefined。 */
  dynamicSystemPrompt?: string;
};

/**
 * 完整组装（唯一出口）：baseSystem 在最前（缓存最优），全局规则紧随，
 * 然后稳定层、动态层。minimal/fast 的 overrideSys 同样走本函数——
 * 两种模式的记忆注入路径由此统一。
 */
export function assembleSystemPrompt(
  finalizedBaseSystem: string,
  memory?: AgentPromptMemoryContext,
): AssembledSystemPrompt {
  const { stablePrefix, dynamicContext } = assembleLayeredSections(memory);
  const base = finalizedBaseSystem.trim();
  if (stablePrefix.length === 0 && dynamicContext.length === 0) {
    return { fullSystemPrompt: base, stableSystemPrompt: base };
  }
  const stableSystemPrompt = [base, GLOBAL_MEMORY_RULE, ...stablePrefix]
    .join("\n\n")
    .trim();
  const dynamicSystemPrompt = dynamicContext.join("\n\n").trim() || undefined;
  return {
    fullSystemPrompt: dynamicSystemPrompt
      ? `${stableSystemPrompt}\n\n${dynamicSystemPrompt}`
      : stableSystemPrompt,
    stableSystemPrompt,
    dynamicSystemPrompt,
  };
}
