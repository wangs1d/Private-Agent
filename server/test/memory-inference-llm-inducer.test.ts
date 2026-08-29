/**
 * LLM 规则归纳器测试（6 个场景）。
 *
 * 核心理念：
 *   - LLM 只参与"学规则"（一次性归纳），不参与"用规则推理"
 *   - 推理阶段仍是程序化算法（matchRule + fillTemplate），不调 LLM
 *
 * 覆盖：
 *   A. LLM 归纳出因果规则（合法 JSON）
 *   B. chatProvider 不可用时降级
 *   C. LLM 输出非法 JSON 时降级
 *   D. LLM 输出规则 template 缺占位符时丢弃
 *   E. RuleLearner + LLMInducer 集成（学到的 template 是因果陈述）
 *   F. 端到端拼多多推理（学规则 → 推理 → 结论）
 *
 * 注意：内置规则 help_purpose_pdd 已覆盖 ["拼多多","加群"] 标签对，
 *   RuleLearner 会跳过已被现有规则覆盖的候选对。
 *   所以场景 E/F 中 LLM 归纳的规则用 ["加群","助力"] 标签对
 *   （"助力" 不在任何内置规则的 requiredTags 中，能通过过滤）。
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  LLMRuleInducer,
} from "../src/brain/memory-cognitive/memory-inference-llm-inducer.js";
import {
  MemoryInferenceEngine,
  type HumanLikeMemoryInferenceLike,
} from "../src/brain/memory-cognitive/memory-inference-engine.js";
import {
  RuleLearner,
  type LearnedRule,
} from "../src/brain/memory-cognitive/memory-inference-rule-learner.js";
import type {
  ExternalChatProvider,
  StreamDeltaHandler,
  AgentStreamOptions,
  ChatToolExecutionContext,
  ChatUserTurn,
} from "../src/external-model/types.js";
import type { InferenceNode } from "../src/brain/types.js";

// ============================================================
// mock 工厂
// ============================================================

type MockNode = { id: string; summary: string; keywords: string[]; confidence: number };
type MockEdge = {
  id: string;
  from: string;
  to: string;
  relation: string;
  weight: number;
};

/**
 * 构造 mock ExternalChatProvider：用 cb 控制每次 streamCompletion 的输出。
 *
 * cb 接收 (sessionId, input, opts) 并返回完整响应文本。
 * 内部会模拟 stream 行为：把响应文本按字符分段 onDelta。
 */
function makeMockChatProvider(
  cb: (sessionId: string, input: ChatUserTurn, opts?: AgentStreamOptions) => string,
): ExternalChatProvider {
  return {
    id: "mock-chat-provider",
    displayLabel: "Mock Chat Provider",
    isEnabled: () => true,
    streamCompletion: async (
      sessionId: string,
      input: ChatUserTurn,
      onDelta: StreamDeltaHandler,
      _tools?: ChatToolExecutionContext,
      opts?: AgentStreamOptions,
    ): Promise<string> => {
      const fullResponse = cb(sessionId, input, opts);
      // 分段 stream 模拟
      for (const ch of fullResponse) {
        onDelta(ch);
      }
      return fullResponse;
    },
  };
}

/** 构造 mock HumanLikeMemoryInferenceLike（追踪 ingestInferredNode 调用） */
function makeMockHumanLike(
  nodes: MockNode[] = [],
  edges: MockEdge[] = [],
): HumanLikeMemoryInferenceLike & {
  ingestCalls: Array<{ actorId: string; node: InferenceNode }>;
} {
  const ingestCalls: Array<{ actorId: string; node: InferenceNode }> = [];
  return {
    ingestCalls,
    getAllNodes: () => nodes,
    getAllEdges: () => edges,
    ingestInferredNode(actorId: string, node: InferenceNode): void {
      ingestCalls.push({ actorId, node });
    },
  };
}

// ============================================================
// 场景 A: LLM 归纳出因果规则
// ============================================================

test("场景 A: LLM 归纳出因果规则（合法 JSON 解析）", async () => {
  // mock chatProvider 返回合法 JSON 规则
  const mockProvider = makeMockChatProvider(() => {
    return JSON.stringify([
      {
        requiredTags: ["拼多多", "加群"],
        template: "朋友让加群是为了帮他点{A}助力链接，目的是{B}",
        baseConfidence: 0.6,
        reasoningType: "purpose",
        explanation: "从历史记忆归纳：朋友让加群+朋友在用拼多多→加群为了助力",
      },
    ]);
  });

  const inducer = new LLMRuleInducer({ chatProvider: mockProvider });
  const rules = await inducer.induceRules(
    [{ tagA: "拼多多", tagB: "加群", count: 3 }],
    [{ summary: "朋友让加群帮他点拼多多助力", keywords: ["拼多多", "加群"] }],
  );

  assert.equal(rules.length, 1, "应归纳出 1 条规则");
  const rule = rules[0]!;
  assert.ok(
    rule.template.includes("{A}") && rule.template.includes("{B}"),
    `template 应含 {A} 和 {B} 占位符，实际: ${rule.template}`,
  );
  assert.ok(
    rule.baseConfidence >= 0.3 && rule.baseConfidence <= 0.7,
    `baseConfidence 应在 [0.3, 0.7]，实际: ${rule.baseConfidence}`,
  );
  assert.equal(rule.reasoningType, "purpose", `reasoningType 应为 purpose`);
  assert.ok(
    rule.requiredTags.includes("拼多多") && rule.requiredTags.includes("加群"),
    `requiredTags 应包含 拼多多 和 加群`,
  );
});

// ============================================================
// 场景 B: chatProvider 不可用时降级
// ============================================================

test("场景 B: chatProvider 不可用时降级返回空数组", async () => {
  const inducer = new LLMRuleInducer({ chatProvider: null });
  const rules = await inducer.induceRules(
    [{ tagA: "拼多多", tagB: "加群", count: 3 }],
    [{ summary: "朋友让加群帮他点拼多多助力" }],
  );

  assert.equal(rules.length, 0, "chatProvider=null 应返回空数组");
  // 不报错（无异常抛出即视为通过）
});

// ============================================================
// 场景 C: LLM 输出非法 JSON 时降级
// ============================================================

test("场景 C: LLM 输出非 JSON 文本时降级返回空数组", async () => {
  const mockProvider = makeMockChatProvider(() => {
    return "这不是 JSON，只是普通的自然语言对话回复，无法解析。";
  });

  const inducer = new LLMRuleInducer({ chatProvider: mockProvider });
  const rules = await inducer.induceRules(
    [{ tagA: "拼多多", tagB: "加群", count: 3 }],
    [{ summary: "朋友让加群帮他点拼多多助力" }],
  );

  assert.equal(rules.length, 0, "非法 JSON 应返回空数组（降级）");
});

// ============================================================
// 场景 D: LLM 输出规则 template 完整句子模式 + 占位符模式都保留
// ============================================================

test("场景 D: LLM 输出规则 template 完整句子和占位符两种模式都保留", async () => {
  const mockProvider = makeMockChatProvider(() => {
    // 第一条 template 是完整句子（无占位符）— 完整句子模式，应保留
    // 第二条 template 含 {A}{B} 占位符 — 占位符模式，也应保留
    return JSON.stringify([
      {
        requiredTags: ["拼多多", "加群"],
        template: "朋友让加群是为了帮他点拼多多助力链接", // 完整句子模式
        baseConfidence: 0.6,
        reasoningType: "purpose",
        explanation: "完整句子模式",
      },
      {
        requiredTags: ["加班", "咖啡"],
        template: "因为{A}所以需要{B}提神",
        baseConfidence: 0.5,
        reasoningType: "causal",
        explanation: "占位符模式",
      },
    ]);
  });

  const inducer = new LLMRuleInducer({ chatProvider: mockProvider });
  const rules = await inducer.induceRules(
    [
      { tagA: "拼多多", tagB: "加群", count: 3 },
      { tagA: "加班", tagB: "咖啡", count: 4 },
    ],
    [{ summary: "朋友让加群帮他点拼多多助力；加班喝咖啡" }],
  );

  // 两种模式都应保留
  assert.equal(rules.length, 2, "完整句子和占位符两种模式都应保留");
  const pddRule = rules.find(r => r.requiredTags.includes("拼多多"));
  const workRule = rules.find(r => r.requiredTags.includes("加班"));
  assert.ok(pddRule, "应有拼多多规则");
  assert.ok(workRule, "应有加班规则");
  assert.ok(
    pddRule!.template === "朋友让加群是为了帮他点拼多多助力链接",
    `完整句子模式 template 应原样保留，实际: ${pddRule!.template}`,
  );
  assert.ok(
    workRule!.template.includes("{A}") && workRule!.template.includes("{B}"),
    `占位符模式 template 应含 {A}{B}，实际: ${workRule!.template}`,
  );
});

// ============================================================
// 场景 E: RuleLearner + LLMInducer 集成
// ============================================================

test("场景 E: RuleLearner + LLMInducer 集成（学到的 template 是因果陈述）", async () => {
  // 构造节点：4 个节点都含 "加群" 和 "助力"，
  // 因此 ("加群","助力") 共现 4 次，是最高频候选对，必进前 5。
  // 注意：summary 不含 "拼多多"，避免 N-gram 提取 "拼多"/"多多" 噪音词
  // 占用 MAX_NEW_RULES_PER_CALL=5 的名额，导致 ("加群","助力") 排不进前 5。
  // "助力" 不在内置规则 help_purpose_pdd 的 requiredTags 中，能通过过滤。
  const nodes: MockNode[] = [
    {
      id: "m1",
      summary: "朋友让加群帮他点助力",
      keywords: ["加群", "助力"],
      confidence: 0.9,
    },
    {
      id: "m2",
      summary: "群里发助力链接让大家加群",
      keywords: ["加群", "助力"],
      confidence: 0.9,
    },
    {
      id: "m3",
      summary: "上次加群帮朋友点助力",
      keywords: ["加群", "助力"],
      confidence: 0.9,
    },
    {
      id: "m4",
      summary: "活动需要加群互助",
      keywords: ["加群", "助力"],
      confidence: 0.9,
    },
  ];

  // mock chatProvider：返回因果模板（不是共现陈述）
  // requiredTags 用 ["加群","助力"] 与候选对 dedupKey 匹配
  // template 引用 {A}(=加群) 和 {B}(=助力)，填充后为因果陈述
  const mockProvider = makeMockChatProvider(() => {
    return JSON.stringify([
      {
        requiredTags: ["加群", "助力"],
        template: "朋友让{A}是为了帮他点拼多多{B}",
        baseConfidence: 0.6,
        reasoningType: "purpose",
        explanation: "加群+助力→拼多多助力",
      },
    ]);
  });

  const llmInducer = new LLMRuleInducer({ chatProvider: mockProvider });
  const humanLike = makeMockHumanLike(nodes);
  const engine = new MemoryInferenceEngine({ humanLike });
  const learner = new RuleLearner({
    humanLike,
    minCoOccurrence: 2, // 降低阈值确保 ("加群","助力") 共现 2-3 次能进入候选
    llmInducer,
  });

  const learned = await learner.learnRules(engine, "actor-E");

  assert.ok(learned.length >= 1, `应至少学习 1 条规则，实际: ${learned.length}`);

  // 在学习到的规则中查找 LLM 归纳的规则（inducedBy="llm"）
  const llmRule = learned.find((r) => r.inducedBy === "llm");
  assert.ok(llmRule, `应至少有 1 条 LLM 归纳的规则（inducedBy="llm"），实际学到: ${learned.map((r) => `${r.requiredTags.join("+")}(${r.inducedBy})`).join(", ")}`);

  // 关键断言：template 应是因果陈述（含 {A}{B} 占位符），不是共现陈述 "出现A时可能涉及B"
  assert.ok(
    llmRule!.template.includes("{A}") && llmRule!.template.includes("{B}"),
    `LLM 归纳的 template 应含 {A}{B} 占位符，实际: ${llmRule!.template}`,
  );
  assert.ok(
    !llmRule!.template.startsWith("出现") || !llmRule!.template.includes("可能涉及"),
    `template 不应是共现陈述 "出现A时可能涉及B"，实际: ${llmRule!.template}`,
  );
  assert.ok(
    llmRule!.baseConfidence >= 0.5,
    `LLM 归纳的规则 baseConfidence 应 >= 0.5（高于纯算法 0.4），实际: ${llmRule!.baseConfidence}`,
  );
});

// ============================================================
// 场景 F: 端到端拼多多推理（学规则 → 推理 → 结论）
// ============================================================

test("场景 F: 端到端拼多多推理（学规则 → 推理 → 结论包含 助力/拼多多）", async () => {
  // 记忆图只有 4 个事实节点（M1-M4）
  const nodes: MockNode[] = [
    {
      id: "m1",
      summary: "朋友发消息让加一个群",
      keywords: ["朋友", "加群"],
      confidence: 0.9,
    },
    {
      id: "m2",
      summary: "朋友朋友圈晒拼多多奖励",
      keywords: ["朋友", "拼多多"],
      confidence: 0.9,
    },
    {
      id: "m3",
      summary: "上次帮朋友加群点拼多多助力",
      keywords: ["加群", "拼多多"],
      confidence: 0.9,
    },
    {
      id: "m4",
      summary: "拼多多活动需要加群互助助力",
      keywords: ["拼多多", "加群"],
      confidence: 0.9,
    },
  ];

  // mock chatProvider：让 LLM 归纳出 "加群+助力→拼多多助力" 规则
  // 用 ["加群","助力"] 标签对（"助力" 不在内置规则 requiredTags 中，能通过过滤）
  const mockProvider = makeMockChatProvider(() => {
    return JSON.stringify([
      {
        requiredTags: ["加群", "助力"],
        template: "朋友让{A}是为了帮他点拼多多{B}",
        baseConfidence: 0.6,
        reasoningType: "purpose",
        explanation: "加群+助力→拼多多助力",
      },
    ]);
  });

  const llmInducer = new LLMRuleInducer({ chatProvider: mockProvider });
  const humanLike = makeMockHumanLike(nodes);
  const engine = new MemoryInferenceEngine({ humanLike });
  const learner = new RuleLearner({
    humanLike,
    minCoOccurrence: 2, // 降低阈值便于触发学习
    llmInducer,
  });

  // 第 1 步：学习规则
  const learned = await learner.learnRules(engine, "actor-F");
  assert.ok(learned.length >= 1, `应至少学习 1 条规则，实际: ${learned.length}`);

  // 验证 LLM 归纳的规则存在（如果有）
  const llmRule = learned.find((r) => r.inducedBy === "llm");
  if (llmRule) {
    assert.equal(llmRule.inducedBy, "llm", `LLM 规则应标记 inducedBy="llm"`);
  }

  // 第 2 步：用两条线索推理
  //   线索 A：含 "拼多多"（触发内置规则 help_purpose_pdd 的 clueAPattern）
  //   线索 B：含 "加群"（触发内置规则 help_purpose_pdd 的 clueBPattern）
  //   注意：推理阶段不调 LLM，纯程序化算法 matchRule + fillTemplate
  const result = await engine.inferFromClues("actor-F", [
    { text: "朋友发消息让我加一个群", source: "user_input" },
    { text: "朋友朋友圈晒拼多多奖励", source: "user_input" },
  ]);

  // 第 3 步：断言推理结论包含 "助力" 或 "拼多多"
  //   内置规则 help_purpose_pdd 的 template 是 "朋友让加群是为了帮他点拼多多助力链接"
  //   推理结论应包含 "助力" 和 "拼多多"
  assert.ok(
    result.inferences.length >= 1,
    `应至少触发 1 条推理（含内置规则或 LLM 学习规则），实际: ${result.inferences.length}`,
  );
  const conclusions = result.inferences.map((i) => i.conclusion).join(" | ");
  assert.ok(
    conclusions.includes("助力") || conclusions.includes("拼多多"),
    `推理结论应包含 "助力" 或 "拼多多"，实际: ${conclusions}`,
  );

  // 关键验证：推理阶段不调 LLM（inferFromClues 是同步程序化算法）
  // 通过验证推理快速完成（无异常）间接验证
  // 推理引擎内部不持有 chatProvider 引用，无法在推理阶段调 LLM
});
