/**
 * 6 个子 Agent 验收测试：静态工具暴露 + 真实 LLM 委派执行（需 MOONSHOT/OPENAI 密钥）。
 *
 * 用法：npx tsx scripts/subagent-acceptance-test.ts
 *       npx tsx scripts/subagent-acceptance-test.ts --static-only
 *       npx tsx scripts/subagent-acceptance-test.ts --visual-full
 */
import "dotenv/config";

import { isDesktopVisualControlChatToolsEnabled } from "../src/tools/desktop-visual-chat-tools.js";
import { createDesktopVisualAgentFromEnv } from "../src/services/desktop-visual-agent-subprocess.js";
import { DesktopBridgeCoordinator } from "../src/services/desktop-bridge-coordinator.js";
import { registerDesktopVisualTools } from "../src/tools/desktop-visual-tools.js";
import { getAgentRuntimeConfig } from "../src/agent/agent-runtime-config.js";
import { createExternalChatProviderFromEnv } from "../src/external-model/index.js";
import { PromptContextBuilder } from "../src/agent/prompt-context-builder.js";
import { InfoHubService } from "../src/services/info-hub-service.js";
import { UpstreamSearchService } from "../src/services/upstream-search-service.js";
import { MasterAgentCoordinator } from "../src/services/master-agent-coordinator.js";
import type { OrchestrateTaskOptions } from "../src/services/master-agent-coordinator.js";
import { buildSubAgentChatTools } from "../src/services/master-agent-tool-filter.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import { registerWebTools } from "../src/tools/web-tools.js";
import { registerClockTools } from "../src/tools/clock-tools.js";
import { registerWeatherTools } from "../src/tools/weather-tools.js";
import { registerWalletTools } from "../src/tools/wallet-tools.js";
import { registerCapabilityQueryTools } from "../src/tools/agent-capability-query-tools.js";
import { registerSelfProgrammingTools } from "../src/tools/self-programming-tools.js";
import { registerAISkillGenerationTools } from "../src/tools/ai-skill-generation-tools.js";
import { SkillManager } from "../src/skills/index.js";
import { WeatherService } from "../src/services/weather-service.js";
import type { SubAgentType } from "../src/services/master-agent-types.js";
import type { ToolExecutedInfo } from "../src/external-model/types.js";

const ACTOR = "subagent-acceptance-test";
const STATIC_ONLY = process.argv.includes("--static-only");
const VISUAL_FULL = process.argv.includes("--visual-full");

type AcceptanceCase = {
  type: SubAgentType;
  userPrompt: string;
  taskDescription: string;
  requiredTools: string[];
  accessMode: "sandbox" | "full";
};

/** 面向用户的验收话术（主 Agent 对话中可直接发送） */
export const ACCEPTANCE_USER_PROMPTS: Record<SubAgentType, string> = {
  life: "【验收-life】帮我查一下真实钱包余额，告诉我具体数字。",
  info: "【验收-info】搜索一下 Python 官方最近一条新闻标题，只查不买。",
  tech: "【验收-tech】查一下 Node.js 当前 LTS 版本号是什么。",
  creative: "【验收-creative】写一句 8 字以内的咖啡 Slogan，主题：早晨活力。",
  security: "【验收-security】评估向好友转账 800 元是否有风险，给出审批结论。",
  general: "【验收-general】告诉我现在几点（精确到分钟）。",
};

const CASES: AcceptanceCase[] = [
  {
    type: "life",
    userPrompt: ACCEPTANCE_USER_PROMPTS.life,
    taskDescription:
      "验收测试：必须调用 wallet.get_balance 查询余额，在报告最后一行写出「余额=XXX元」，XXX 为工具返回的数字。",
    requiredTools: ["wallet.get_balance"],
    accessMode: "sandbox",
  },
  {
    type: "info",
    userPrompt: ACCEPTANCE_USER_PROMPTS.info,
    taskDescription:
      "验收测试：必须调用 search_web 搜索「Python 官方 新闻」，在报告中引用至少一条搜索结果的标题。",
    requiredTools: ["search_web"],
    accessMode: "sandbox",
  },
  {
    type: "tech",
    userPrompt: ACCEPTANCE_USER_PROMPTS.tech,
    taskDescription:
      "验收测试：调用 search_web 搜索「Node.js LTS version」，在报告中给出搜索到的版本信息。",
    requiredTools: ["search_web"],
    accessMode: "sandbox",
  },
  {
    type: "creative",
    userPrompt: ACCEPTANCE_USER_PROMPTS.creative,
    taskDescription:
      "验收测试：写一句不超过 8 个汉字的咖啡品牌 Slogan（主题：早晨活力）。可直接输出，不必调用工具。",
    requiredTools: [],
    accessMode: "sandbox",
  },
  {
    type: "security",
    userPrompt: ACCEPTANCE_USER_PROMPTS.security,
    taskDescription:
      "验收测试：先调用 wallet.get_balance 查余额，再评估「向好友转账800元」风险。报告必须包含 APPROVED、REJECTED 或 NEED_CONFIRM 之一。",
    requiredTools: ["wallet.get_balance"],
    accessMode: "sandbox",
  },
  {
    type: "general",
    userPrompt: ACCEPTANCE_USER_PROMPTS.general,
    taskDescription:
      "验收测试：必须调用 clock.get_current_time，在报告中写出工具返回的本地时间（时:分）。",
    requiredTools: ["clock.get_current_time"],
    accessMode: "sandbox",
  },
];

/** 完全访问 + 视觉 RPA 验收（需 DESKTOP_VISUAL_AGENT_ENABLED 或电脑桥接） */
const VISUAL_FULL_CASES: AcceptanceCase[] = [
  {
    type: "tech",
    userPrompt: "【验收-tech-视觉】完全访问模式下，委派 tech 子Agent 验证视觉管线",
    taskDescription:
      "验收测试：必须调用 desktop.visual.run_task，参数 stub=true，task=\"验证视觉执行管线\"。在报告中写出工具返回的 ok 字段。",
    requiredTools: ["desktop.visual.run_task"],
    accessMode: "full",
  },
  {
    type: "info",
    userPrompt: "【验收-info-视觉】完全访问模式下，委派 info 子Agent 截图读屏",
    taskDescription:
      "验收测试：必须调用 desktop.visual.screenshot 截取当前屏幕，在报告中描述从截图/工具结果中识别到的至少一个可见文字或窗口标题。只查不买，禁止 wallet.purchase。",
    requiredTools: ["desktop.visual.screenshot"],
    accessMode: "full",
  },
  {
    type: "tech",
    userPrompt: "【验收-tech-视觉】完全访问模式下，委派 tech 子Agent 截图分析",
    taskDescription:
      "验收测试：必须调用 desktop.visual.screenshot，描述屏幕上可见的前 2 个应用/窗口区域。不要执行危险系统操作。",
    requiredTools: ["desktop.visual.screenshot"],
    accessMode: "full",
  },
];

const CRITICAL_CHAT_TOOLS: Partial<Record<SubAgentType, string[]>> = {
  life: ["wallet.get_balance", "wallet.purchase"],
  info: ["search_web", "fetch_web", "info.inspect_webpage"],
  tech: ["search_web", "self.generate_skill"],
  creative: ["search_web"],
  security: ["wallet.get_balance", "wallet.get_transactions"],
  general: ["search_web", "wallet.get_balance"],
};

type CoordinatorInternals = MasterAgentCoordinator & {
  currentTurnUserMessage: string | null;
  currentTurnOrchestrateOpts: OrchestrateTaskOptions | null;
};

function buildMinimalRegistry(enableVisual = false): ToolRegistry {
  const registry = new ToolRegistry();
  const skillManager = new SkillManager();
  registry.setSkillManager(skillManager);
  const infoHub = new InfoHubService();
  const upstream = new UpstreamSearchService(infoHub);
  registerWebTools(registry, infoHub, upstream);
  registerClockTools(registry);
  registerWeatherTools(registry, new WeatherService());
  registerWalletTools(registry);
  registerCapabilityQueryTools(registry, { skillManager, worldService: null });
  registerSelfProgrammingTools(registry, skillManager);
  registerAISkillGenerationTools(registry, createExternalChatProviderFromEnv(), skillManager);
  if (enableVisual) {
    const localAgent = createDesktopVisualAgentFromEnv();
    const bridge = new DesktopBridgeCoordinator();
    registerDesktopVisualTools(registry, { localAgent, bridge });
  }
  return registry;
}

function staticVisualToolExposure(coordinator: MasterAgentCoordinator): Array<{
  type: SubAgentType;
  ok: boolean;
  missing: string[];
}> {
  const want = [
    { type: "info" as const, tools: ["desktop.visual.screenshot", "desktop.visual.run_task"] },
    { type: "tech" as const, tools: ["desktop.visual.screenshot", "desktop.visual.run_task"] },
  ];
  return want.map(({ type, tools }) => {
    const cap = coordinator.getSubAgentCapabilities().get(type);
    if (!cap) return { type, ok: false, missing: tools };
    const exposed = buildSubAgentChatTools(cap, "visual", [])
      .map((t) => (t.type === "function" ? t.function?.name : ""))
      .filter(Boolean);
    const missing = tools.filter((n) => !exposed.includes(n));
    return { type, ok: missing.length === 0, missing };
  });
}

function staticToolExposure(coordinator: MasterAgentCoordinator): Array<{
  type: SubAgentType;
  ok: boolean;
  exposed: string[];
  missing: string[];
}> {
  const caps = coordinator.getSubAgentCapabilities();
  return (["life", "tech", "info", "creative", "security", "general"] as SubAgentType[]).map((type) => {
    const cap = caps.get(type);
    if (!cap) return { type, ok: false, exposed: [], missing: ["capability missing"] };
    const tools = buildSubAgentChatTools(cap, CASES.find((c) => c.type === type)?.taskDescription ?? "");
    const exposed = tools
      .map((t) => (t.type === "function" ? t.function?.name : ""))
      .filter(Boolean);
    const critical = CRITICAL_CHAT_TOOLS[type] ?? [];
    const missing = critical.filter((n) => !exposed.includes(n));
    return { type, ok: missing.length === 0, exposed, missing };
  });
}

async function runLiveCase(
  coordinator: CoordinatorInternals,
  testCase: AcceptanceCase,
): Promise<{
  type: SubAgentType;
  ok: boolean;
  delegated: boolean;
  toolsCalled: string[];
  missingTools: string[];
  reportSnippet: string;
  error?: string;
}> {
  const toolsCalled: string[] = [];
  const messageId = `acceptance-${testCase.type}-${Date.now()}`;

  coordinator.currentTurnUserMessage = testCase.userPrompt;
  coordinator.currentTurnOrchestrateOpts = {
    chatUserMessageId: messageId,
    agentAccessMode: testCase.accessMode,
    onToolExecuted: (info: ToolExecutedInfo) => {
      toolsCalled.push(info.toolName);
    },
  };

  try {
    const result = await coordinator.handleInvokeSubAgentTool(
      {
        agentType: testCase.type,
        taskDescription: testCase.taskDescription,
        userStatusLine: `正在验收 ${testCase.type} 子Agent…`,
      },
      {
        sessionId: ACTOR,
        chatUserMessageId: messageId,
        agentAccessMode: testCase.accessMode,
      },
    );

    const report = String(result.report ?? result.message ?? result.error ?? "");
    const delegated = result.ok === true && !result.deduplicated;

    const missingTools = testCase.requiredTools.filter((t) => !toolsCalled.includes(t));

    const creativeOk = testCase.type === "creative" && delegated && report.length >= 4;
    const toolsOk = testCase.requiredTools.length === 0 ? creativeOk || delegated : missingTools.length === 0;
    const ok = Boolean(result.ok) && delegated && toolsOk;

    return {
      type: testCase.type,
      ok,
      delegated,
      toolsCalled: [...toolsCalled],
      missingTools,
      reportSnippet: report.slice(0, 280).replace(/\s+/g, " "),
      error: result.ok ? undefined : String(result.error ?? "unknown"),
    };
  } catch (e) {
    return {
      type: testCase.type,
      ok: false,
      delegated: false,
      toolsCalled: [...toolsCalled],
      missingTools: testCase.requiredTools,
      reportSnippet: "",
      error: e instanceof Error ? e.message : String(e),
    };
  } finally {
    coordinator.currentTurnUserMessage = null;
    coordinator.currentTurnOrchestrateOpts = null;
  }
}

async function main(): Promise<void> {
  const rt = getAgentRuntimeConfig();
  const chat = createExternalChatProviderFromEnv();
  const visualEnabled = isDesktopVisualControlChatToolsEnabled();
  console.log(VISUAL_FULL ? "=== 子 Agent 视觉 RPA 验收（完全访问）===" : "=== 子 Agent 验收测试 ===");
  console.log(`masterDelegation.enabled=${rt.masterDelegation.enabled}`);
  console.log(`externalChat=${chat?.isEnabled() ? chat.displayLabel : "disabled"}`);
  console.log(`desktopVisual=${visualEnabled ? "enabled" : "disabled"}`);
  console.log(`DESKTOP_VISUAL_AGENT_ENABLED=${process.env.DESKTOP_VISUAL_AGENT_ENABLED ?? "(unset)"}`);
  console.log("");

  const registry = buildMinimalRegistry(visualEnabled);
  const promptBuilder = new PromptContextBuilder({
    agentMemorySyncService: null,
    worldService: null,
    skillManager: null,
    virtualPhoneService: null,
  });

  const coordinator = new MasterAgentCoordinator(
    chat!,
    registry,
    promptBuilder,
    {
      enableSubAgents: true,
      maxParallelTasks: 1,
      taskTimeoutMs: 120_000,
      techSubtaskTimeoutMs: 120_000,
      allowFallback: true,
    },
  ) as CoordinatorInternals;

  if (!chat?.isEnabled()) {
    console.error("❌ 未配置外部模型，无法运行 live 测试。");
    process.exit(1);
  }

  if (VISUAL_FULL) {
    if (!visualEnabled) {
      console.error("❌ 视觉 RPA 未启用。请设置 DESKTOP_VISUAL_AGENT_ENABLED=1 或 DESKTOP_BRIDGE_ENABLED=1");
      process.exit(1);
    }
    console.log("--- 阶段 1：完全访问下 info/tech 视觉工具暴露 ---");
    for (const row of staticVisualToolExposure(coordinator)) {
      console.log(`${row.ok ? "✅" : "❌"} ${row.type}: ${row.ok ? "desktop.visual.* 已暴露" : `缺失 ${row.missing.join(", ")}`}`);
    }
    console.log("");
    console.log("--- 阶段 2：Live 视觉 RPA 执行 ---");
    for (const c of VISUAL_FULL_CASES) {
      console.log(`  [${c.type}] ${c.userPrompt}`);
    }
    console.log("");
    const liveResults = [];
    for (const testCase of VISUAL_FULL_CASES) {
      process.stdout.write(`▶ ${testCase.type}-${testCase.requiredTools[0]?.split(".").pop()} … `);
      const started = Date.now();
      const result = await runLiveCase(coordinator, testCase);
      liveResults.push(result);
      const sec = ((Date.now() - started) / 1000).toFixed(1);
      console.log(result.ok ? `✅ (${sec}s)` : `❌ (${sec}s) ${result.error ?? ""}`);
      if (result.toolsCalled.length) console.log(`   工具: ${result.toolsCalled.join(", ")}`);
      if (result.reportSnippet) console.log(`   报告: ${result.reportSnippet}`);
      if (result.missingTools.length) console.log(`   未调用必需工具: ${result.missingTools.join(", ")}`);
    }
    console.log("");
    const staticOk = staticVisualToolExposure(coordinator).every((r) => r.ok);
    const liveOk = liveResults.every((r) => r.ok);
    console.log("--- 汇总 ---");
    console.log(`视觉工具暴露: ${staticOk ? "✅" : "❌"}`);
    console.log(`Live 视觉RPA: ${liveOk ? "✅ 全部通过" : `❌ ${liveResults.filter((r) => !r.ok).map((r) => `${r.type}/${r.missingTools[0] ?? "?"}`).join(", ")}`}`);
    process.exit(staticOk && liveOk ? 0 : 1);
  }

  console.log("--- 阶段 1：静态工具暴露 ---");
  const staticRows = staticToolExposure(coordinator);
  for (const row of staticRows) {
    const mark = row.ok ? "✅" : "❌";
    console.log(`${mark} ${row.type}: 暴露 ${row.exposed.length} 个工具`);
    if (row.missing.length) console.log(`   缺失关键工具: ${row.missing.join(", ")}`);
    else console.log(`   关键工具: ${(CRITICAL_CHAT_TOOLS[row.type] ?? []).join(", ")}`);
  }
  console.log("");

  if (STATIC_ONLY) {
    console.log("(仅静态检查，跳过 live 测试)");
    process.exit(staticRows.every((r) => r.ok) ? 0 : 1);
  }

  console.log("--- 阶段 2：Live 子 Agent 执行 ---");
  console.log("验收话术：");
  for (const c of CASES) {
    console.log(`  [${c.type}] ${c.userPrompt}`);
  }
  console.log("");

  const liveResults = [];
  for (const testCase of CASES) {
    process.stdout.write(`▶ ${testCase.type} … `);
    const started = Date.now();
    const result = await runLiveCase(coordinator, testCase);
    liveResults.push(result);
    const sec = ((Date.now() - started) / 1000).toFixed(1);
    console.log(result.ok ? `✅ (${sec}s)` : `❌ (${sec}s) ${result.error ?? ""}`);
    if (result.toolsCalled.length) console.log(`   工具: ${result.toolsCalled.join(", ")}`);
    if (result.reportSnippet) console.log(`   报告: ${result.reportSnippet}`);
    if (result.missingTools.length) console.log(`   未调用必需工具: ${result.missingTools.join(", ")}`);
  }

  console.log("");
  console.log("--- 汇总 ---");
  const staticOk = staticRows.every((r) => r.ok);
  const liveOk = liveResults.every((r) => r.ok);
  console.log(`静态工具暴露: ${staticOk ? "✅ 全部通过" : "❌ 存在缺失"}`);
  console.log(
    `Live 子Agent执行: ${liveOk ? "✅ 全部通过" : `❌ ${liveResults.filter((r) => !r.ok).map((r) => r.type).join(", ")} 未通过`}`,
  );

  process.exit(staticOk && liveOk ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
