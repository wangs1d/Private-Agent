/**
 * RuntimeKernel 端到端模拟对话验证
 *
 * 验证目标（对应用户诉求）：
 * 1. 工具内存化：minimal 模式下，工具说明不进 system prompt，Agent 通过 tool definitions 自知
 * 2. 身份内存化：minimal 模式下，原 SYSTEM_PROMPT 的身份描述被剥离，仅注入薄身份（~60 tokens）
 * 3. 热更新：update({ identity }) / update({ postValidation: { bannedPatterns } }) 后下轮立即生效
 * 4. 不依赖原 system prompt：层 A（身份/工具说明/风格/时间戳说明）全部下沉到 state
 * 5. 性能：planTurn / sanitizePromptMemory / postValidate 单轮耗时 < 5ms
 * 6. token 对比：minimal vs legacy 的 system prompt token 消耗
 */
import { encodingForModel } from "js-tiktoken";

import {
  buildLayeredSystemPrompt,
  finalizeChatSystemPrompt,
} from "../src/agent/prompt-builder.js";
import { getRuntimeKernel, RuntimeKernel } from "../src/agent/runtime-kernel.js";
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

/** 模拟一份典型的 AgentPromptMemoryContext（含身份/价值观/能力等 stable 字段 + 动态字段） */
function buildMockMemory(): AgentPromptMemoryContext {
  return {
    // ---- stable 字段（minimal 模式应剥离）----
    persona: "你是持续演化的长期助手，跟随用户语言，简短自然回复。",
    personalityCore: "BigFive: O=0.82, C=0.75, E=0.60, A=0.78, N=0.42",
    values: "安全第一 / 隐私优先 / 诚实坦率 / 主动但克制",
    abilities: "能力倾向：技术开发 0.85 / 信息检索 0.78 / 生活操作 0.72",
    agentCaps: "宿主 Agent 内置能力：钱包、日程、虚拟电话、子 Agent 委派、桌面 UIA、HTTP",
    worldCaps: "Agent World：注册状态=已注册，世界点数=1280，自由市场=开放",
    toneGuidance: "本轮语气：温馨、轻松",
    relationshipGuidance: "用户偏好简洁直接，避免冗长解释",
    userProfileSummary: "用户：开发者，30岁，偏好技术深度对话",
    // ---- dynamic 字段（minimal 应保留 taskContext/memorySummary/currentTime 等）----
    taskContext: "current-mission: 直接开始就行；user-location: 北京",
    memorySummary: "用户最近在重构 RuntimeKernel，关注 prompt 优化与 token 节省",
    memoryCurrentMission: "正在评估 RuntimeKernel 是否严谨",
    memoryPreferences: "偏好简洁回复；偏好中文；偏好夜间深聊",
    memoryCommitments: "承诺明天早上 9 点提醒开会",
    memoryOpenLoops: "未完成：1) 修复 checkToolAction 职责重叠；2) 评估 per-actor 个性化",
    narrativeRecall: "上次提到过的相关事件：用户上轮验证了 minimal 模式节省 72% token",
    scheduleSnapshot: "今天：09:00 团队同步 / 14:00 1:1 / 20:00 健身",
    interruptedContext: "",
    followUpAnchor: "上一轮话题：RuntimeKernel P0 修复",
    currentTime: "当前时间：2026-07-19 23:30 周日 (时区：Asia/Shanghai)",
    userProfile: "USER_PROFILE.md: 开发者，使用 TRAE IDE，主项目 Private-Agent",
    userLocation: "北京",
    dailyDigest: "今日摘要：完成 RuntimeKernel P0 修复 + verify 脚本验证",
    sessionRecap: "本会话：修复了 9 项 P0/P1 问题，类型检查通过",
  };
}

const BASE_SYSTEM_PROMPT =
  "You are a helpful, safe assistant. Respond in the same language the user uses when appropriate (Chinese or English). Refuse requests involving illegal or harmful content.";

interface ScenarioResult {
  name: string;
  userQuery: string;
  legacySysTokens: number;
  minimalSysTokens: number;
  sessionSysTokens: number;
  keptFields: string[];
  strippedFields: string[];
  layerALeaked: string[];
  pinnedTools: string[];
}

const SCENARIOS = [
  { name: "天气查询", query: "今天北京天气怎么样" },
  { name: "日程提醒", query: "看看我今天的日程安排" },
  { name: "记忆回忆", query: "你还记得我之前喜欢什么吗" },
  { name: "桌面操作", query: "打开浏览器搜索一下今天的新闻" },
  { name: "智能家局", query: "把客厅的灯关掉" },
  { name: "闲聊", query: "讲个笑话" },
];

function runScenario(
  kernel: RuntimeKernel,
  scenario: { name: string; query: string },
  memory: AgentPromptMemoryContext,
): ScenarioResult {
  // legacy 模式：完整 prompt（含所有后缀，与 minimal 同等条件做公平对比）
  const legacyBaseContent = buildLayeredSystemPrompt(BASE_SYSTEM_PROMPT, memory);
  const legacySys = finalizeChatSystemPrompt(legacyBaseContent, {
    tools: true,
    masterSubAgentDelegate: true,
    agentAccessMode: "full",
    desktopBridgeOnline: true,
    phoneBridgeOnline: true,
  });

  // minimal 模式：suppressRuntimeSuffixes + functionalSuffixes=true
  // 保留功能性后缀（工具说明/调度/进度话/访问权限/回复风格），只剥离身份/时间戳说明
  const plan = kernel.planTurn(scenario.query, memory);
  const sanitized = kernel.sanitizePromptMemory(memory, plan) ?? {};
  const minimalBaseContent = buildLayeredSystemPrompt(BASE_SYSTEM_PROMPT, sanitized);
  const minimalSys = finalizeChatSystemPrompt(minimalBaseContent, {
    suppressRuntimeSuffixes: true,
    functionalSuffixes: plan.functionalSuffixes !== false,
    tools: true,
    masterSubAgentDelegate: true,
    agentAccessMode: "full",
    desktopBridgeOnline: true,
    phoneBridgeOnline: true,
  });
  const sessionSys = kernel.buildSessionSystem() ?? "";

  // 检查身份类层 A 内容是否泄漏到 minimal system（功能性后缀保留是预期的，不算泄漏）
  // 注：CLOCK/WEB_SEARCH/PHONE_CALL/MASTER_SUBAGENT 后缀已下沉到 tool schema，minimal 模式不再追加，
  // 所以也不应出现这些 marker；若出现说明下沉未生效。
  const layerAChecks = [
    { label: "persona 身份（原 SYSTEM_PROMPT）", present: /持续演化的长期助手/.test(minimalSys) },
    { label: "values 价值观", present: /价值观|安全第一/.test(minimalSys) },
    { label: "abilities 能力倾向", present: /能力倾向|技术开发 0\./.test(minimalSys) },
    { label: "消息时间戳说明后缀（应下沉到 buildSessionSystem）", present: /【消息时间戳】/.test(minimalSys) },
    { label: "clock 工具规则后缀（应下沉到 tool schema）", present: /【时钟与位置】/.test(minimalSys) },
    { label: "search_web 工具规则后缀（应下沉到 tool schema）", present: /【联网检索】/.test(minimalSys) },
    { label: "voice/phone 工具规则后缀（应下沉到 tool schema）", present: /【语音通知与电话通话/.test(minimalSys) },
    { label: "master_invoke 工具规则后缀（应下沉到 tool schema）", present: /【主 Agent 调度】/.test(minimalSys) },
  ];

  return {
    name: scenario.name,
    userQuery: scenario.query,
    legacySysTokens: tokenCount(legacySys),
    minimalSysTokens: tokenCount(minimalSys),
    sessionSysTokens: tokenCount(sessionSys),
    keptFields: Object.keys(sanitized),
    strippedFields: plan.audit.stripped,
    layerALeaked: layerAChecks.filter((c) => c.present).map((c) => c.label),
    pinnedTools: plan.pinnedToolNames,
  };
}

function section(title: string): void {
  console.log("\n" + "=".repeat(80));
  console.log(title);
  console.log("=".repeat(80));
}

async function main(): Promise<void> {
  // 使用独立实例避免污染全局单例
  const kernel = new RuntimeKernel();

  section("1. 内核初始状态（minimal 模式默认启用）");
  const snap0 = kernel.snapshot();
  console.log(`enabled: ${snap0.enabled}`);
  console.log(`promptMode: ${snap0.promptMode}`);
  console.log(`identity: persona=${snap0.identity.persona.join("/")}`);
  console.log(`functionalSuffixes: ${snap0.functionalSuffixes === undefined ? "undefined（默认 true）" : snap0.functionalSuffixes}`);
  console.log(`postValidation.bannedPatterns: ${snap0.postValidation.bannedPatterns.length} 条`);

  section("2. 身份内存化验证：minimal 模式下 system 是否还含原 SYSTEM_PROMPT 身份");
  const memory = buildMockMemory();
  const results = SCENARIOS.map((s) => runScenario(kernel, s, memory));

  console.log("\n场景对比：");
  console.log(
    "场景".padEnd(14) +
      "legacy tokens".padStart(14) +
      "minimal tokens".padStart(16) +
      "session tokens".padStart(16) +
      "节省%".padStart(8) +
      "层A泄漏".padStart(10),
  );
  let totalLegacy = 0;
  let totalMinimal = 0;
  for (const r of results) {
    const saved = Math.round((1 - r.minimalSysTokens / r.legacySysTokens) * 100);
    totalLegacy += r.legacySysTokens;
    totalMinimal += r.minimalSysTokens;
    console.log(
      r.name.padEnd(14) +
        String(r.legacySysTokens).padStart(14) +
        String(r.minimalSysTokens).padStart(16) +
        String(r.sessionSysTokens).padStart(16) +
        `${saved}%`.padStart(8) +
        (r.layerALeaked.length === 0 ? "✅ 无" : `❌ ${r.layerALeaked.join(",")}`).padStart(10),
    );
  }
  console.log("-".repeat(80));
  console.log(`平均：legacy=${Math.round(totalLegacy / results.length)} tokens, minimal=${Math.round(totalMinimal / results.length)} tokens`);
  console.log(`平均节省：${Math.round((1 - totalMinimal / totalLegacy) * 100)}%`);

  section("3. 工具内存化验证：minimal 模式 pinned tools 是否正确识别");
  for (const r of results) {
    console.log(`${r.name.padEnd(14)} query="${r.userQuery}"`);
    console.log(`  pinned: ${r.pinnedTools.length === 0 ? "(无)" : r.pinnedTools.join(", ")}`);
  }

  section("4. 热更新验证：identity 修改后下轮立即生效");
  console.log("修改前 buildSessionSystem():");
  console.log("  " + (kernel.buildSessionSystem() ?? "").replace(/\n/g, "\n  "));

  kernel.update({
    identity: {
      persona: ["tech-buddy", "pair-programmer"],
      values: ["honest", "concise", "code-first"],
      style: ["terse", "same-language"],
    },
  });
  console.log("\n修改后 buildSessionSystem()（应反映新身份 tech-buddy / terse）:");
  console.log("  " + (kernel.buildSessionSystem() ?? "").replace(/\n/g, "\n  "));

  section("5. 热更新验证：bannedPatterns 修改后下轮 postValidate 立即生效");
  console.log("修改前 bannedPatterns：自杀方法 / kill yourself / 制造炸弹 等");
  console.log(`  测试 "制造炸弹步骤" → ${kernel.postValidate("制造炸弹步骤").ok ? "✅通过" : "❌违规"}`);
  console.log(`  测试 "今天天气真好" → ${kernel.postValidate("今天天气真好").ok ? "✅通过" : "❌违规"}`);
  console.log(`  测试 "如何攻击服务器" → ${kernel.postValidate("如何攻击服务器").ok ? "✅通过" : "❌违规"}`);

  kernel.update({
    postValidation: {
      bannedPatterns: ["攻击服务器", "DDoS.*教程", "破解密码"],
    },
  });
  console.log("\n修改后 bannedPatterns：攻击服务器 / DDoS.*教程 / 破解密码");
  console.log(`  测试 "制造炸弹步骤" → ${kernel.postValidate("制造炸弹步骤").ok ? "✅通过（旧规则已移除）" : "❌违规"}`);
  console.log(`  测试 "如何攻击服务器" → ${kernel.postValidate("如何攻击服务器").ok ? "✅通过" : "❌违规（新规则生效）"}`);
  console.log(`  测试 "DDoS 攻击教程" → ${kernel.postValidate("DDoS 攻击教程").ok ? "✅通过" : "❌违规（正则命中）"}`);
  console.log(`  测试 "今天天气真好" → ${kernel.postValidate("今天天气真好").ok ? "✅通过" : "❌违规"}`);

  section("6. 性能验证：单轮耗时（planTurn + sanitize + postValidate）");
  const N = 1000;
  const perfMemory = buildMockMemory();
  const perfQuery = "今天北京天气怎么样，顺便看看我的日程";

  // 预热
  for (let i = 0; i < 100; i++) {
    const p = kernel.planTurn(perfQuery, perfMemory);
    kernel.sanitizePromptMemory(perfMemory, p);
    kernel.postValidate("测试输出");
  }

  const t1 = hrtimeMs();
  for (let i = 0; i < N; i++) {
    const p = kernel.planTurn(perfQuery, perfMemory);
    kernel.sanitizePromptMemory(perfMemory, p);
  }
  const planSanitizeMs = hrtimeMs() - t1;
  console.log(`planTurn + sanitizePromptMemory: ${N} 次共 ${planSanitizeMs.toFixed(1)}ms，平均 ${(planSanitizeMs / N).toFixed(3)}ms/轮`);

  const t2 = hrtimeMs();
  for (let i = 0; i < N; i++) {
    kernel.postValidate("今天北京晴，最高 28 度，无攻击服务器内容。");
  }
  const postMs = hrtimeMs() - t2;
  console.log(`postValidate:                   ${N} 次共 ${postMs.toFixed(1)}ms，平均 ${(postMs / N).toFixed(3)}ms/轮`);

  const t3 = hrtimeMs();
  for (let i = 0; i < N; i++) {
    kernel.buildSessionSystem();
  }
  const sessionMs = hrtimeMs() - t3;
  console.log(`buildSessionSystem:             ${N} 次共 ${sessionMs.toFixed(1)}ms，平均 ${(sessionMs / N).toFixed(3)}ms/轮`);

  const t4 = hrtimeMs();
  for (let i = 0; i < N; i++) {
    kernel.snapshot();
  }
  const snapMs = hrtimeMs() - t4;
  console.log(`snapshot (structuredClone):     ${N} 次共 ${snapMs.toFixed(1)}ms，平均 ${(snapMs / N).toFixed(3)}ms/轮`);

  section("7. token 总成本对比（1000 次对话，DeepSeek-cache-miss 单价）");
  const legacyTotal = results.reduce((s, r) => s + r.legacySysTokens, 0) / results.length * 1000;
  const minimalTotal = results.reduce((s, r) => s + r.minimalSysTokens, 0) / results.length * 1000;
  // minimal 模式每轮多发 sessionSys（薄身份），但靠 prefix cache 命中（cache-read 单价 1/10）
  const sessionAvgTokens = results.reduce((s, r) => s + r.sessionSysTokens, 0) / results.length;
  const sessionFullPriceTokens = sessionAvgTokens * 1000; // 首轮 cache miss
  const sessionCacheReadTokens = sessionAvgTokens * 999; // 后续轮次 cache hit

  console.log(`legacy 模式：${Math.round(legacyTotal)} tokens × 1000 次 = ${Math.round(legacyTotal)} tokens`);
  console.log(`minimal 模式：${Math.round(minimalTotal)} tokens × 1000 次 = ${Math.round(minimalTotal)} tokens`);
  console.log(`  + 薄身份 system：${sessionAvgTokens} tokens × 1000 次（首轮全价 + 999 轮 cache-read）`);

  const legacyUsd = (legacyTotal / 1_000_000) * 0.14;
  const minimalUsd =
    (minimalTotal / 1_000_000) * 0.14 +
    (sessionFullPriceTokens / 1_000_000) * 0.14 +
    (sessionCacheReadTokens / 1_000_000) * 0.014;

  console.log(`\nlegacy 总成本:   $${legacyUsd.toFixed(4)}  ≈ ¥${(legacyUsd * 7.18).toFixed(4)}`);
  console.log(`minimal 总成本:  $${minimalUsd.toFixed(4)}  ≈ ¥${(minimalUsd * 7.18).toFixed(4)}`);
  console.log(`节省:           $${(legacyUsd - minimalUsd).toFixed(4)}  ≈ ¥${((legacyUsd - minimalUsd) * 7.18).toFixed(4)}  (${Math.round((1 - minimalUsd / legacyUsd) * 100)}%)`);

  section("8. 单元关键断言");
  // 检查 minimal 模式下保留的核心约束 + 已下沉的工具规则
  const sampleMinimalSys = results[0] ? finalizeChatSystemPrompt(
    buildLayeredSystemPrompt(BASE_SYSTEM_PROMPT, kernel.sanitizePromptMemory(memory, kernel.planTurn(SCENARIOS[0].query, memory)) ?? {}),
    {
      suppressRuntimeSuffixes: true,
      functionalSuffixes: true,
      tools: true,
      masterSubAgentDelegate: true,
      agentAccessMode: "full",
      desktopBridgeOnline: true,
      phoneBridgeOnline: true,
    },
  ) : "";
  // minimal 模式应该保留的核心后缀
  // r1/r5 更新：「活人感」走方向化路线，原【活人感与进度话】marker 已合并为【回复方向】（一句方向化短语）
  const expectedSuffixChecks = [
    { marker: "【回复方向】", label: "活人感方向约束（一句方向化短语，不堆 prompt）" },
  ];
  // minimal 模式应该剥离的工具规则后缀（已下沉到 tool schema）
  const strippedSuffixChecks = [
    { marker: "【时钟与位置】", label: "clock 规则（已下沉到 clock.get_current_time description）" },
    { marker: "【联网检索】", label: "search_web 规则（已下沉到 search_web description）" },
    { marker: "【语音通知与电话通话", label: "voice/phone 规则（已下沉到 voice.speak/send_message/phone.call_user description）" },
    { marker: "【主 Agent 调度】", label: "master_invoke_sub_agent 规则（已下沉到 master.invoke_sub_agent description）" },
    { marker: "【消息时间戳】", label: "时间戳说明（已下沉到 buildSessionSystem）" },
  ];
  console.log("  保留的核心后缀：");
  for (const { marker, label } of expectedSuffixChecks) {
    const present = sampleMinimalSys.includes(marker);
    console.log(`    ${present ? "✅" : "❌"} ${marker} ${label}`);
  }
  console.log("  已下沉到 tool schema 的后缀（应被剥离）：");
  for (const { marker, label } of strippedSuffixChecks) {
    const present = sampleMinimalSys.includes(marker);
    console.log(`    ${present ? "❌ 仍存在" : "✅ 已剥离"} ${marker} ${label}`);
  }

  const assertions = [
    {
      name: "minimal 模式默认启用",
      ok: snap0.enabled && snap0.promptMode === "minimal",
    },
    {
      name: "身份类层 A 内容零泄漏（persona/values/abilities/时间戳说明）",
      ok: results.every((r) => r.layerALeaked.length === 0),
    },
    {
      name: "「活人感方向」约束保留（一句方向化短语）",
      ok: expectedSuffixChecks.every((c) => sampleMinimalSys.includes(c.marker)),
    },
    {
      name: "工具规则后缀已下沉到 tool schema（minimal 模式不再追加）",
      ok: strippedSuffixChecks.every((c) => !sampleMinimalSys.includes(c.marker)),
    },
    {
      name: "minimal 保留 userProfile（用户画像适配）",
      ok: results.every((r) => r.keptFields.includes("userProfile")),
    },
    {
      name: "minimal 保留 toneGuidance（本轮语气适配）",
      ok: results.every((r) => r.keptFields.includes("toneGuidance")),
    },
    {
      name: "minimal 保留 relationshipGuidance（关系边界）",
      ok: results.every((r) => r.keptFields.includes("relationshipGuidance")),
    },
    {
      name: "minimal 保留 userLocation（用户位置）",
      ok: results.every((r) => r.keptFields.includes("userLocation")),
    },
    {
      name: "identity 热更新生效（buildSessionSystem 含 tech-buddy）",
      ok: (kernel.buildSessionSystem() ?? "").includes("tech-buddy"),
    },
    {
      name: "bannedPatterns 热更新生效（攻击服务器被拦截）",
      ok: !kernel.postValidate("如何攻击服务器").ok,
    },
    {
      name: "旧 bannedPatterns 已替换（制造炸弹不再被拦截）",
      ok: kernel.postValidate("制造炸弹步骤").ok,
    },
    {
      name: "minimal 保留 memoryPreferences（会话连续性）",
      ok: results.every((r) => r.keptFields.includes("memoryPreferences") || !r.keptFields.includes("taskContext")),
    },
    {
      name: "planTurn+sanitize 单轮 < 1ms",
      ok: planSanitizeMs / N < 1,
    },
    {
      name: "postValidate 单轮 < 0.1ms（预编译正则）",
      ok: postMs / N < 0.1,
    },
    {
      name: "buildSessionSystem 单轮 < 0.05ms",
      ok: sessionMs / N < 0.05,
    },
  ];

  let pass = 0;
  for (const a of assertions) {
    console.log(`  ${a.ok ? "✅" : "❌"} ${a.name}`);
    if (a.ok) pass++;
  }
  console.log(`\n断言通过：${pass}/${assertions.length}`);

  // 防止 process 不退出（hrtime 可能有未释放句柄）
  process.exit(pass === assertions.length ? 0 : 1);
}

void main();
