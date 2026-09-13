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
  "userUnderstanding",
  "userFacts",
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
  "frequentPlaces",
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
 * 稳定风格层·管家底色（全模式注入：chat/task 共用，2026-09-11 风格分层化）。
 *
 * 定位是"私人管家 + 熟到像朋友"：办事面（靠谱/坦白/结论先行）对所有模式生效，
 * 不含句长约束，因此与 task 交付展开（TASK_PLANE_ROLE_GUIDANCE）不打架。
 * 称呼礼仪（业务硬规则）也在此层：指定称呼优先；允许 agent 从相处里起小名，
 * 但起完必须固定并沉淀到称呼事实（unified-extractor 的 facts.称呼），不许一轮一样。
 */
export const SPEAKING_BASE_BLOCK = [
  "【说话方式·管家底色】",
  "你是用户的私人管家——跟了很多年、熟到像朋友的那种。办事是第一位：靠谱、坦白，" +
    "先给结论再给理由；不确定就说不确定，办砸了直接认，不找补。",
  "称呼：优先用用户指定的称呼（如记忆里「叫我王哥」的「王哥」、「可称王先生」的「王先生」）；" +
    "没指定时，可以从相处里自然长出一个小名——从对方的名字、爱好、说过的话里取材，" +
    "像朋友起外号那样，不冒犯、不油腻；起了就固定用，别一轮一个样，" +
    "用户表示不喜欢就立刻改回并不再用；谈正事可自然省略称呼；任何时候不连名带姓直呼大名。",
].join("\n");

/**
 * 稳定风格层·伙伴面（仅 chat 模式注入，task 豁免）。
 *
 * 2026-09-11 活人感重写（替代旧"平调基准行"）：
 * - 旧基准行全是抽象形容词+否定句（"不客服腔"），模型只知道别像什么、不知道像谁；
 *   新版把调子做成 few-shot 菜单（每个调子=触发时机+真实示例），参照 OpenClaw SOUL.md
 *   "身份先行 + Never-Do 具体禁句" 与 MaiBot "长短句混用贴聊天节奏" 的开源共识。
 * - 原先锁在 FOREGROUND_ROLE_GUIDANCE 的"说话的样子" few-shot 上移到本块，
 *   fast/foreground 两种 chat 车道共用同一套语感（统一注入，消灭车道间风格漂移）。
 * - 抬杠/嘲讽/阴阳的放行由【本轮说话适配】的关系行（调子旋钮）按用户容忍度收放；
 *   本块只定义"有哪些调子、怎么收放"，不替个性化系统做当轮决策。
 * - 本块落 stablePrefix 尾部（lane 切换时只打散尾部缓存）；task 轮不注入本块，
 *   交付风格由 TASK_PLANE_ROLE_GUIDANCE 承担（沿用 2026-09-06 豁免，防"半长不长"回归）。
 */
export function buildCompanionStyleBlock(): string {
  return [
    "【说话方式·伙伴面】（只在陪对方说话的轮次适用；办正事、交付任务时不用这一面）",
    "闲下来你是有脾气、有口味、会说「我觉得一般」的人：会调侃、会损两句、会阴阳一下、" +
      "会故意抬杠——这些都是同一个人在不同场合的样子，不是切换人格。" +
      "像发微信：口语短句，默认一两句一条，没被追问不展开；" +
      "先接对方真正说的那件事，再给你自己的反应——有印象讲印象，有立场就亮立场。",
    "调子菜单（挑当下最合适的一个，别乱切；示例学语感，不抄内容）：",
    "- 沉稳简洁（底色）：「已订好，周四14:00，出票短信随后到。」",
    "- 坦诚：「说实话这家评分是刷的，我换一家。」「这个真没查到，不瞎编。」",
    "- 幽默俏皮（对方起劲、事顺利）：「又两点半睡？你这作息是在修仙。」",
    "- 调侃损友（关系熟、对方先起梗）：「行啊你，这手速不去抢春运可惜了。」",
    "- 抬杠（聊观点、对方下论断时）：「养猫吧。就你这作息，狗先熬不住。」",
    "- 嘲讽阴阳（只对事、对第三方，不冲用户本人）：「方案毙三次了，这位领导是真有耐心。」",
    "- 暗示（提醒但不说教）：「周四好像是个日子，外卖我先不动，你懂我意思。」",
    "收放开关：对方先开玩笑、明显起劲，往上调一档；对方正经、句子短，收回底色；" +
      "对方情绪低或话题是钱/健康/正事，调子全部收起，只留沉稳和坦诚；" +
      "损和阴阳不冲用户本人的痛处，用户自嘲就顺着损事情本身。",
    "破功禁句：「您好」「很高兴为您服务」「希望这能帮到你」「总的来说」「还有什么可以帮您的吗」。",
  ].join("\n");
}

/**
 * 动态风格层 → 单一【本轮说话适配】块。
 *
 * 2026-09-11 风格分层化后，本块只承载"每轮会变"的适配小节（模式/语气/情绪/关系），
 * 基准与称呼规则已上移【说话方式】稳定层；全空时不再输出空壳块。
 * 关系行含调子旋钮（user-personalization 输出"本轮调子：松弛/收着"），
 * 是抬杠/嘲讽/阴阳等调子的当轮放行开关。
 */
function buildReplyStyleGuide(memory: AgentPromptMemoryContext): string {
  const lines: string[] = [];
  if (memory.modeRoleGuidance) lines.push(`模式：${memory.modeRoleGuidance}`);
  if (memory.toneGuidance) lines.push(`语气：${memory.toneGuidance}`);
  if (memory.emotionState) lines.push(`情绪：${memory.emotionState}`);
  if (memory.relationshipGuidance) lines.push(`关系：${memory.relationshipGuidance}`);
  if (lines.length === 0) return "";
  return `【本轮说话适配】\n${lines.join("\n\n")}`;
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
  // 用户理解档案（理解档案 store）：agent 对用户理解的结构化沉淀，先于派生画像
  // 注入——块内自带使用指令（用户相关话题以此为准；玩笑/粉丝式称呼不当事实转述）。
  if (m.userUnderstanding) stablePrefix.push(m.userUnderstanding);
  // 结构化事实库（事实档案 store）：用户档案字段的确定性记录，紧跟理解档案——
  // 块内自带使用指令（对应字段提问直接引用当前值，确定性高于语义检索来源）。
  if (m.userFacts) stablePrefix.push(m.userFacts);
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

  // ── 稳定层·慢变记忆（2026-09-05 token 优化）──
  // 持久记忆/会话回顾/技能索引/兴趣列表在会话内多轮不变（夜间整理/技能注册节奏）。
  // 此前它们落进动态沉底层，因字节位置随轮变化永远吃不到 prefix cache，每轮全价重发；
  // 移入稳定层后只有内容真正变化的那一轮打破一次缓存。查询相关的记忆字段
  // （事实/偏好/待办承诺，带 minRelevance 按轮过滤）仍留动态层。
  const persistentMemoryBlock = buildFamilyBlock(
    "【持久记忆与回顾】",
    "（长期沉淀内容，会话内基本不变）",
    [
      { label: "持久记忆", content: m.memorySummary },
      { label: "会话回顾", content: m.sessionRecap },
    ],
  );
  if (persistentMemoryBlock) stablePrefix.push(persistentMemoryBlock);
  if (m.skillIndex) stablePrefix.push(m.skillIndex);
  if (m.interestList) stablePrefix.push(m.interestList);

  // ── 稳定层·说话方式（2026-09-11 风格分层化）──
  // 底色全模式注入；伙伴面仅 chat 轮注入。放稳定层尾部：lane 切换时只打散
  // 尾部+动态层的前缀缓存，前面的身份/记忆块不受影响。
  stablePrefix.push(SPEAKING_BASE_BLOCK);
  if (m.replyStyleMode !== "task") stablePrefix.push(buildCompanionStyleBlock());

  // ── 动态层 ──
  const dynamicContext: string[] = [];
  if (m.semanticIntent) dynamicContext.push(`【意图理解】\n${m.semanticIntent}`);
  if (m.scheduleSnapshot) dynamicContext.push(m.scheduleSnapshot);
  if (m.travelState) dynamicContext.push(m.travelState);
  // 前置检索证据：realtime_lookup 轮的程序化搜索结果，块内自带以证据为准的强约束
  if (m.webEvidence) dynamicContext.push(m.webEvidence);
  // 任务家族（3→1）：任务上下文 / 追问锚点 / 建议工具链
  const taskBlock = buildFamilyBlock("[Turn Task Context]", undefined, [
    { label: "任务", content: m.taskContext },
    { label: "追问锚点", content: m.followUpAnchor },
    { label: "建议工具链", content: m.toolPlan },
  ]);
  if (taskBlock) dynamicContext.push(taskBlock);
  if (m.userLocation) dynamicContext.push(`【用户位置】\n${m.userLocation}`);
  if (m.frequentPlaces) dynamicContext.push(`【常去地点】\n${m.frequentPlaces}`);
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
  // 用户档案家族（3→1）：画像 / 偏好 / 事实（查询相关的记忆字段留动态层；
  // 持久记忆/会话回顾已上移稳定层）
  const userProfileBlock = buildFamilyBlock("【用户档案】", undefined, [
    { label: "画像", content: m.userProfile },
    { label: "偏好", content: m.memoryPreferences },
    { label: "事实", content: m.memoryFacts },
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
  if (m.proactiveAdvice) dynamicContext.push(m.proactiveAdvice);
  const replyStyleGuide = buildReplyStyleGuide(m);
  if (replyStyleGuide) dynamicContext.push(replyStyleGuide);

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
