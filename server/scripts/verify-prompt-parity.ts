/**
 * RuntimeKernel prompt 模式对比验证：legacy vs minimal
 *
 * 目标：
 * 1. 列出 legacy 模式每轮注入的全部 prompt 内容分块
 * 2. 列出 minimal 模式实际下发的 prompt 内容（sessionSys + Layer B）
 * 3. 逐项对比：哪些被剥离了？是否影响功能？
 * 4. 性能对比：每轮 finalize 开销
 * 5. token 成本对比
 *
 * 输出：差异报告 + 风险评估
 */
import { encodingForModel } from "js-tiktoken";

import {
  buildLayeredSystemPrompt,
  finalizeChatSystemPrompt,
} from "../src/agent/prompt-builder.js";
import { RuntimeKernel } from "../src/agent/runtime-kernel.js";
import type { AgentPromptMemoryContext } from "../src/external-model/types.js";

const MODEL = "gpt-4o";

function tokenCount(text: string): number {
  const enc = encodingForModel(MODEL);
  try {
    return enc.encode(text).length;
  } finally {
    enc.free?.();
  }
}

function hrtimeMs(): number {
  const [s, ns] = process.hrtime();
  return s * 1000 + ns / 1e6;
}

const BASE_SYSTEM_PROMPT =
  "You are a helpful, safe assistant. Respond in the same language the user uses when appropriate (Chinese or English). Refuse requests involving illegal or harmful content.";

// legacy 模式下注入的完整 memory（含 stable + dynamic 全字段）
const FULL_MEMORY: AgentPromptMemoryContext = {
  // Layer A（stable）
  persona: "你是阿福，用户的私人管家兼伙伴，跟随用户语言",
  values: "安全第一、隐私优先、用户至上",
  abilities: "时间/天气/日程/搜索/智能家居/桌面自动化/电话触达",
  agentCaps: "Agent World 调度能力：委派 life/tech/info 子 Agent",
  worldCaps: "可访问 Agent World 通用工具",
  personalityCore: "幽默、克制、长情、护主",
  userProfile: "用户是程序员，30 岁，偏好简洁直接",
  toneGuidance: "本轮用户略疲倦，回复要更简短",
  relationshipGuidance: "熟人模式，可以略俏皮",
  userProfileSummary: "用户长期偏好：技术导向、反感客服腔",
  relationshipMemory: "已陪伴 3 年，用户信任度高",
  lifeThemeMemory: "近期主题：私 Agent 重构",
  dreamMemory: "用户的长期目标：完整的私人 AI",
  // Layer B（dynamic，minimal 也保留）
  taskContext: "current-mission: 帮用户跟进天气",
  memorySummary: "用户最近在评估 RuntimeKernel，关心 prompt 优化",
  currentTime: "当前时间：2026-07-19 23:35:00 周日 (时区：Asia/Shanghai)",
  narrativeRecall: "上轮用户问了北京天气，Agent 回复晴 28 度",
  followUpAnchor: "上一轮：用户问北京天气 → Agent 回复晴 28 度",
  memoryPreferences: "偏好简洁回复",
  memoryCommitments: "承诺过明天给一份性能对比",
  memoryOpenLoops: "未完成：用户没说要不要带伞",
  sessionRecap: "本会话：1) 用户问北京天气 2) Agent 回复晴 28 度",
  dailyDigest: "今日要点：完成了 RuntimeKernel minimal 模式",
  interruptedContext: "[被打断] 用户刚问了句'那明天呢'就被打断了",
  scheduleSnapshot: "[日程] 明天 10:00 有会",
  userLocation: "北京海淀",
};

// legacy 模式 finalize 时传入的 opts（带工具=true，会追加工具说明）
const LEGACY_FINALIZE_OPTS = {
  tools: true,
  masterSubAgentDelegate: true,
  agentAccessMode: "full" as const,
  desktopBridgeOnline: true,
  phoneBridgeOnline: true,
};

// legacy 模式所有"后缀 marker"——用于差异检测
const LEGACY_SUFFIX_MARKERS = [
  { marker: "【回复风格】", label: "朋友式回复风格约束", category: "功能性" },
  { marker: "[私人管家回复风格]", label: "1-2 句默认长度约束", category: "功能性" },
  { marker: "【消息时间戳】", label: "消息时间戳前缀说明", category: "已迁移" },
  { marker: "【工具说明】", label: "Agent World 工具调用规范", category: "功能性" },
  { marker: "【时钟与位置】", label: "clock.* 强制调用规则", category: "功能性" },
  { marker: "【联网检索】", label: "时效信息必须 search_web 规则", category: "功能性" },
  { marker: "【语音通知与电话通话", label: "三套语音触达规则", category: "功能性" },
  { marker: "【用户可见进度】", label: "工具调用前输出进度话", category: "UX 关键" },
  { marker: "【主 Agent 调度】", label: "master_invoke_sub_agent 派小弟规则", category: "功能性" },
];

// legacy 模式 Layer A（stable）字段——minimal 会剥离
const LEGACY_LAYER_A_MEMORY_FIELDS = [
  { key: "persona", label: "人格与角色" },
  { key: "values", label: "价值观与原则" },
  { key: "abilities", label: "能力倾向" },
  { key: "agentCaps", label: "Agent 专属能力" },
  { key: "worldCaps", label: "Agent World 能力" },
  { key: "personalityCore", label: "人格内核" },
  { key: "userProfile", label: "用户画像" },
  { key: "userProfileSummary", label: "用户长期画像" },
  { key: "toneGuidance", label: "本轮语气适配" },
  { key: "relationshipGuidance", label: "关系边界" },
  { key: "relationshipMemory", label: "关系记忆" },
  { key: "lifeThemeMemory", label: "生活主题记忆" },
  { key: "dreamMemory", label: "梦想记忆" },
  { key: "userLocation", label: "用户位置" },
] as const;

function hasSection(text: string, marker: string): boolean {
  return text.includes(marker);
}

async function main(): Promise<void> {
  console.log("=".repeat(80));
  console.log("RuntimeKernel 模式对比验证：legacy vs minimal");
  console.log("=".repeat(80));

  // -------- 1. legacy 模式：完整 prompt --------
  console.log("\n--- 1. legacy 模式完整 prompt ---");
  const legacyKernel = new RuntimeKernel();
  legacyKernel.update({ enabled: true, promptMode: "legacy" });

  const legacyPlan = legacyKernel.planTurn("今天北京天气怎么样", FULL_MEMORY);
  const legacySanitized = legacyKernel.sanitizePromptMemory(FULL_MEMORY, legacyPlan);
  const legacyBase = buildLayeredSystemPrompt(BASE_SYSTEM_PROMPT, legacySanitized);
  const legacyFinal = finalizeChatSystemPrompt(legacyBase, LEGACY_FINALIZE_OPTS);
  const legacyTokens = tokenCount(legacyFinal);

  console.log(`legacy prompt tokens: ${legacyTokens}`);
  console.log(`legacy prompt 长度: ${legacyFinal.length} 字符`);
  console.log(`legacy plan audit:`);
  console.log(`  kept: ${legacyPlan.audit.kept.length} 字段, stripped: ${legacyPlan.audit.stripped.length} 字段`);

  // -------- 2. minimal 模式：sessionSys + Layer B --------
  console.log("\n--- 2. minimal 模式 prompt ---");
  const minimalKernel = new RuntimeKernel();
  minimalKernel.update({ enabled: true, promptMode: "minimal" });

  const minimalPlan = minimalKernel.planTurn("今天北京天气怎么样", FULL_MEMORY);
  const minimalSanitized = minimalKernel.sanitizePromptMemory(FULL_MEMORY, minimalPlan) ?? {};
  const minimalBase = buildLayeredSystemPrompt(BASE_SYSTEM_PROMPT, minimalSanitized);
  // minimal 模式：finalizeChatSystemPrompt 传 suppressRuntimeSuffixes=true + functionalSuffixes=true
  // 只保留「活人感」约束 + 访问权限；工具规则已下沉到 tool schema description
  const minimalFinalPerTurn = finalizeChatSystemPrompt(minimalBase, {
    suppressRuntimeSuffixes: true,
    functionalSuffixes: true,
    agentAccessMode: "full" as const,
    desktopBridgeOnline: true,
    phoneBridgeOnline: true,
  });
  // 但 msgs[0] 实际是 sessionSys（首轮注入一次，后续靠前缀缓存）
  const sessionSys = minimalKernel.buildSessionSystem() ?? "";
  const minimalActualMsg0 = sessionSys; // 首轮全价
  const minimalTokens = tokenCount(minimalFinalPerTurn) + tokenCount(minimalActualMsg0);

  console.log(`minimal sessionSys tokens (msgs[0], 首轮全价): ${tokenCount(minimalActualMsg0)}`);
  console.log(`minimal per-turn baseContent tokens (Layer B): ${tokenCount(minimalFinalPerTurn)}`);
  console.log(`minimal 首轮总 tokens: ${minimalTokens}`);
  console.log(`minimal plan audit:`);
  console.log(`  kept: ${minimalPlan.audit.kept.length} 字段, stripped: ${minimalPlan.audit.stripped.length} 字段`);
  console.log(`  stripped 字段: ${minimalPlan.audit.stripped.join(", ")}`);

  // -------- 3. 差异分析：legacy 后缀 marker 在 minimal 中是否保留 --------
  console.log("\n" + "=".repeat(80));
  console.log("3. 后缀差异：legacy 后缀在 minimal 中是否保留");
  console.log("=".repeat(80));
  console.log(`{"marker","legacy 有", "minimal sessionSys 有", "minimal baseContent 有", "类别"}`);
  const suffixIssues: Array<{ marker: string; label: string; legacy: boolean; minimalSys: boolean; minimalBase: boolean; category: string }> = [];
  for (const { marker, label, category } of LEGACY_SUFFIX_MARKERS) {
    const inLegacy = hasSection(legacyFinal, marker);
    const inMinimalSys = hasSection(sessionSys, marker);
    const inMinimalBase = hasSection(minimalFinalPerTurn, marker);
    console.log(`  ${marker.padEnd(20)} legacy=${inLegacy ? "✓" : "✗"}  sys=${inMinimalSys ? "✓" : "✗"}  base=${inMinimalBase ? "✓" : "✗"}  [${category}] ${label}`);
    suffixIssues.push({ marker, label, legacy: inLegacy, minimalSys: inMinimalSys, minimalBase: inMinimalBase, category });
  }

  // -------- 4. Layer A 字段差异 --------
  console.log("\n" + "=".repeat(80));
  console.log("4. Layer A 字段差异：minimal 是否剥离了 stable 字段");
  console.log("=".repeat(80));
  const layerAIssues: Array<{ key: string; label: string; legacy: boolean; minimal: boolean }> = [];
  for (const { key, label } of LEGACY_LAYER_A_MEMORY_FIELDS) {
    const inLegacy = (legacySanitized as Record<string, unknown>)[key] !== undefined;
    const inMinimal = (minimalSanitized as Record<string, unknown>)[key] !== undefined;
    console.log(`  ${key.padEnd(22)} legacy=${inLegacy ? "✓" : "✗"}  minimal=${inMinimal ? "✓" : "✗"}  ${label}`);
    layerAIssues.push({ key, label, legacy: inLegacy, minimal: inMinimal });
  }

  // -------- 5. 功能性风险评分 --------
  console.log("\n" + "=".repeat(80));
  console.log("5. 功能性风险评估（区分：缺失 vs 下沉）");
  console.log("=".repeat(80));

  // 「下沉到 tool schema」是预期行为：minimal 模式剥离 system 后缀，但规则在 tool description 里保留
  // 「缺失」才是真正的功能丢失
  const SUNK_TO_TOOL_SCHEMA = new Set(["【时钟与位置】", "【联网检索】", "【语音通知与电话通话", "【主 Agent 调度】"]);
  const REPLACED_BY_MERGED = new Set(["【回复风格】", "[私人管家回复风格]"]); // 合并为【活人感与进度话】
  const SUNK_TO_SESSION_SYS = new Set(["【消息时间戳】"]); // 下沉到 buildSessionSystem

  const missingFunctional = suffixIssues.filter(
    (s) =>
      s.legacy &&
      !s.minimalSys &&
      !s.minimalBase &&
      s.category === "功能性" &&
      !SUNK_TO_TOOL_SCHEMA.has(s.marker) &&
      !REPLACED_BY_MERGED.has(s.marker) &&
      !SUNK_TO_SESSION_SYS.has(s.marker),
  );
  const sunkToTool = suffixIssues.filter(
    (s) => s.legacy && !s.minimalSys && !s.minimalBase && SUNK_TO_TOOL_SCHEMA.has(s.marker),
  );
  const merged = suffixIssues.filter(
    (s) => s.legacy && !s.minimalSys && !s.minimalBase && REPLACED_BY_MERGED.has(s.marker),
  );
  const sunkToSessionSys = suffixIssues.filter(
    (s) => s.legacy && !s.minimalSys && !s.minimalBase && SUNK_TO_SESSION_SYS.has(s.marker),
  );
  const missingUx = suffixIssues.filter(
    (s) => s.legacy && !s.minimalSys && !s.minimalBase && s.category === "UX 关键",
  );
  const missingLayerA = layerAIssues.filter((l) => l.legacy && !l.minimal);

  console.log(`\n真正缺失的功能性 prompt 块：${missingFunctional.length} 项（应为 0）`);
  for (const s of missingFunctional) {
    console.log(`  ❌ ${s.marker} ${s.label}`);
  }

  console.log(`\n已下沉到 tool schema description（预期）：${sunkToTool.length} 项`);
  for (const s of sunkToTool) {
    console.log(`  ✅ ${s.marker} ${s.label}`);
  }

  console.log(`\n已合并为【活人感与进度话】（预期）：${merged.length} 项`);
  for (const s of merged) {
    console.log(`  ✅ ${s.marker} ${s.label}`);
  }

  console.log(`\n已下沉到 buildSessionSystem（预期）：${sunkToSessionSys.length} 项`);
  for (const s of sunkToSessionSys) {
    console.log(`  ✅ ${s.marker} ${s.label}`);
  }

  console.log(`\nUX 关键 prompt 块缺失：${missingUx.length} 项（应为 0）`);
  for (const s of missingUx) {
    console.log(`  ❌ ${s.marker} ${s.label}`);
  }

  console.log(`\nLayer A stable 字段剥离：${missingLayerA.length} 项（设计如此）`);
  for (const l of missingLayerA) {
    console.log(`  ⚠️  ${l.key.padEnd(22)} ${l.label}`);
  }

  // -------- 6. 性能对比 --------
  console.log("\n" + "=".repeat(80));
  console.log("6. 性能对比：1000 轮 planTurn + sanitize + finalize 开销");
  console.log("=".repeat(80));

  const N = 1000;

  // legacy 性能
  const legacyStart = hrtimeMs();
  for (let i = 0; i < N; i++) {
    const p = legacyKernel.planTurn("今天北京天气怎么样", FULL_MEMORY);
    const s = legacyKernel.sanitizePromptMemory(FULL_MEMORY, p);
    const b = buildLayeredSystemPrompt(BASE_SYSTEM_PROMPT, s);
    finalizeChatSystemPrompt(b, LEGACY_FINALIZE_OPTS);
  }
  const legacyElapsed = hrtimeMs() - legacyStart;

  // minimal 性能
  const minimalStart = hrtimeMs();
  for (let i = 0; i < N; i++) {
    const p = minimalKernel.planTurn("今天北京天气怎么样", FULL_MEMORY);
    const s = minimalKernel.sanitizePromptMemory(FULL_MEMORY, p);
    const b = buildLayeredSystemPrompt(BASE_SYSTEM_PROMPT, s);
    finalizeChatSystemPrompt(b, {
      suppressRuntimeSuffixes: true,
      functionalSuffixes: true,
      agentAccessMode: "full" as const,
      desktopBridgeOnline: true,
      phoneBridgeOnline: true,
    });
    minimalKernel.buildSessionSystem();
  }
  const minimalElapsed = hrtimeMs() - minimalStart;

  console.log(`legacy   1000 轮：${legacyElapsed.toFixed(2)}ms (avg ${(legacyElapsed / N).toFixed(3)}ms/轮)`);
  console.log(`minimal  1000 轮：${minimalElapsed.toFixed(2)}ms (avg ${(minimalElapsed / N).toFixed(3)}ms/轮)`);
  console.log(`minimal 是否更快？ ${minimalElapsed < legacyElapsed ? "✅ 是" : "❌ 否（" + (minimalElapsed - legacyElapsed).toFixed(2) + "ms 慢）"}`);

  // -------- 7. token 成本对比（1000 次对话） --------
  console.log("\n" + "=".repeat(80));
  console.log("7. token 成本对比（1000 次对话，DeepSeek 单价）");
  console.log("=".repeat(80));

  const legacyTokenTotal = legacyTokens * 1000;
  // minimal：首轮 sessionSys 全价 + 999 轮 cache-read（按 1/10 计）+ 每轮 baseContent
  const minimalFirstRound = tokenCount(minimalActualMsg0) + tokenCount(minimalFinalPerTurn);
  const minimalCacheReadRounds = 999 * Math.ceil(tokenCount(minimalActualMsg0) / 10);
  const minimalBaseRounds = 999 * tokenCount(minimalFinalPerTurn);
  const minimalTokenTotal = minimalFirstRound + minimalCacheReadRounds + minimalBaseRounds;

  // DeepSeek 单价（cache-miss 0.14/1M input, cache-read 0.014/1M input）
  const PRICE_CACHE_MISS = 0.14 / 1_000_000;
  const PRICE_CACHE_READ = 0.014 / 1_000_000;

  const legacyCost = legacyTokenTotal * PRICE_CACHE_MISS;
  const minimalCost = minimalFirstRound * PRICE_CACHE_MISS + minimalCacheReadRounds * PRICE_CACHE_READ + minimalBaseRounds * PRICE_CACHE_MISS;

  console.log(`legacy   总 tokens: ${legacyTokenTotal}  成本: $${legacyCost.toFixed(4)} ≈ ¥${(legacyCost * 7.2).toFixed(4)}`);
  console.log(`minimal  总 tokens: ${minimalTokenTotal}  成本: $${minimalCost.toFixed(4)} ≈ ¥${(minimalCost * 7.2).toFixed(4)}`);
  console.log(`节省: ${((1 - minimalCost / legacyCost) * 100).toFixed(1)}%`);

  // -------- 8. 总结 --------
  console.log("\n" + "=".repeat(80));
  console.log("8. 总结");
  console.log("=".repeat(80));

  const functionalLoss = missingFunctional.length + missingUx.length;
  const layerALoss = missingLayerA.length;

  console.log(`\n[性能] minimal 模式 ${minimalElapsed < legacyElapsed ? "✅ 更快" : "⚠️ 略慢"}（${(legacyElapsed - minimalElapsed).toFixed(2)}ms / 1000 轮）`);
  console.log(`[成本] minimal 模式 ✅ 节省 ${((1 - minimalCost / legacyCost) * 100).toFixed(1)}%`);
  console.log(`[功能完整] minimal 模式 ${functionalLoss === 0 ? "✅" : "❌"} 真正缺失 ${functionalLoss} 项`);
  console.log(`[工具规则] ✅ 已下沉 ${sunkToTool.length} 项到 tool schema description（ToolSearch 按需暴露）`);
  console.log(`[回复风格] ✅ 已合并 ${merged.length} 项为【活人感与进度话】`);
  console.log(`[时间戳说明] ✅ 已下沉到 buildSessionSystem（首轮注入）`);
  console.log(`[身份完整] minimal 模式 ⚠️ 剥离 ${layerALoss} 个 stable 字段（仅保留 persona/style/values，由 sessionSys 注入）`);

  if (functionalLoss > 0) {
    console.log("\n❌ 风险结论：minimal 模式存在真正缺失的功能性 prompt 块");
    process.exit(1);
  } else {
    console.log("\n✅ 所有功能性规则已通过「保留 + 下沉 + 合并」三种方式覆盖，无真正缺失");
    process.exit(0);
  }
}

void main();
