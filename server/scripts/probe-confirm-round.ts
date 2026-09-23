/**
 * 办妥确认轮探针（2026-09-24 确认轮收口配套，参照 eval-chat-lane-tool-decision.ts 骨架）。
 *
 * 真实 LLM + 生产同源 system prompt（kernel 身份 + 【人格·静态】/mood +
 * FOREGROUND_ROLE_GUIDANCE + finalizeChatSystemPrompt 全量后缀含【联网检索】）+
 * 生产同源 chat 车道工具 schema。唯一合成点：calendar 创建工具返回固定成功结果
 * （不落库、不动 ScheduleTaskService）——生产里这一步只是写一行 DB，对模型的
 * 确认文案行为零影响。
 *
 * 测两件事：
 *  1. prompt 半：新指导语（确认一两句收尾 + 展开许可收窄到搜索轮）下，订阅
 *     「科技早报」的确认是否还是五段导购（2026-09-24 真机翻车原场景）；
 *  2. 闸半：把模型原话喂给 enforceReplyStyle(confirmationRound=true)，
 *     看确认轮 overlong 定罪与放行结果（生产链路里 detected-but-unchanged
 *     会再进隔离重写臂压缩，本探针只展示确定性闸的输出）。
 *
 * 用法：npx tsx scripts/probe-confirm-round.ts [--repeats=2]
 */
import "dotenv/config";
import { loadServerEnv } from "../src/config/load-server-env.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

loadServerEnv();

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repeats = Number.parseInt(process.argv.find((a) => a.startsWith("--repeats="))?.slice(10) ?? "2", 10) || 2;

const { createExternalChatProviderFromEnv } = await import("../src/external-model/resolve-provider.js");
const { getRuntimeKernel } = await import("../src/agent/runtime-kernel.js");
const { FOREGROUND_ROLE_GUIDANCE } = await import("../src/agent/lane-role-guidance.js");
const { buildPersonaStaticBlock, buildPersonaMoodBlock } = await import("../src/agent/persona-core.js");
const { finalizeChatSystemPrompt } = await import("../src/agent/prompt-builder.js");
const { buildLaneCoreTools } = await import("../src/external-model/lane-tool-sets.js");
const { getBuiltinAgentChatTools } = await import("../src/external-model/openai-compatible-tool-loop.js");
const { TASK_DISPATCH_TOOL_DEFINITION } = await import("../src/tools/task-dispatch-tool.js");
const { TASK_CANCEL_TOOL_DEFINITION, TASK_STATUS_TOOL_DEFINITION } = await import("../src/tools/task-plane-tools.js");
const { PERCEPTION_OVERVIEW_TOOL_DEFINITION } = await import("../src/tools/perception-tools.js");
const { ToolRegistry } = await import("../src/tools/tool-registry.js");
const { InfoHubService } = await import("../src/services/info-hub-service.js");
const { UpstreamSearchService } = await import("../src/services/upstream-search-service.js");
const { formatNextRunAtLocal } = await import("../src/tools/calendar-tools.js");
const { enforceReplyStyle } = await import("../src/agent/execution/reply-style-guard.js");
const { TurnFinalizer } = await import("../src/agent/execution/turn-finalizer.js");
const { TurnLifecycle } = await import("../src/agent/turn-lifecycle.js");

// 探针场景：早报订阅（真机翻车原场景，agent_task 长期任务）+ 吃药提醒（简单对照组）。
// tomorrow08 = 明早 08:00 的 nextRunAtLocal，与生产 formatNextRunAtLocal 同源格式。
const tomorrow08 = (() => {
  const d = new Date(Date.now() + 24 * 3600 * 1000);
  d.setHours(8, 0, 0, 0);
  return d.toISOString();
})();
const CASES = [
  { text: "每天早上八点给我一份科技早报", kind: "agent_task" },
  { text: "明天早上8点提醒我吃药", kind: "reminder" },
];

function buildToolContext() {
  const infoHub = new InfoHubService();
  const upstream = new UpstreamSearchService(infoHub);
  const registry = new ToolRegistry() as any;
  // 唯一合成点：calendar 创建固定成功（nextRunAtLocal 走生产同款格式化）
  let seq = 0;
  const createOk = async () => {
    seq += 1;
    return {
      ok: true,
      result: {
        taskId: `probe-task-${seq}`,
        nextRunAt: tomorrow08,
        nextRunAtLocal: formatNextRunAtLocal(tomorrow08, "Asia/Shanghai"),
        recurrence: "daily",
      },
    };
  };
  for (const name of ["reminder.plan", "calendar.create_from_text", "calendar.create_task"]) {
    registry.register(name, createOk);
  }
  registry.register("clock.get_current_time", async () => {
    const now = new Date();
    return { iso: now.toISOString(), timezone: "Asia/Shanghai", local: now.toLocaleString("zh-CN") };
  });
  registry.register("clock.get_user_location", async () => ({
    city: "上海市", latitude: 31.2304, longitude: 121.4737, source: "probe-fixture",
  }));
  registry.register("search_web", async (input: any) =>
    upstream.searchWeb(String(input?.query ?? ""), Math.min(8, Number(input?.limit) || 8)));
  const stub = async (name: string) => ({ ok: false, result: { error: `probe: ${name} 未接执行器` } });
  for (const name of ["calendar.list_tasks", "task.dispatch", "task.status", "task.cancel", "wallet.get_balance", "messages.overview", "surface.show"]) {
    registry.register(name, stub.bind(null, name));
  }
  const calls: Array<{ name: string; ok: boolean }> = [];
  const toolCtx = {
    executeTool: async (name: string, args: Record<string, unknown>) => {
      let r: { ok: boolean; result: Record<string, unknown> };
      try {
        const out = await registry.execute(name, args, { actorId: "confirm-probe" });
        r = { ok: Boolean(out?.ok), result: (out?.result ?? {}) as Record<string, unknown> };
      } catch (err) {
        r = { ok: false, result: { error: err instanceof Error ? err.message : String(err) } };
      }
      calls.push({ name, ok: r.ok });
      return r;
    },
  };
  return { toolCtx, calls };
}

async function main(): Promise<void> {
  const provider = createExternalChatProviderFromEnv();
  if (!provider?.isEnabled()) {
    console.error("[confirm-probe] 外部模型 provider 未启用，无法探针");
    process.exit(1);
  }
  const kernel = getRuntimeKernel();
  const identity = kernel.buildSessionSystem() ?? "";
  const personaStatic = buildPersonaStaticBlock({ userAlias: "王哥", tier: 1 });
  const mood = buildPersonaMoodBlock("casual_wit");
  // 生产组装顺序（assembleSystemPrompt）：baseSystem（含 finalize 后缀）→ 稳定层（人格静态）→ 动态层（mood 沉底随 user 消息）
  const baseSystem = finalizeChatSystemPrompt(identity, { tools: true });
  const systemPrompt = [baseSystem, personaStatic].filter(Boolean).join("\n\n");

  const tools = buildLaneCoreTools("chat", getBuiltinAgentChatTools() as any, [
    TASK_DISPATCH_TOOL_DEFINITION,
    TASK_STATUS_TOOL_DEFINITION,
    TASK_CANCEL_TOOL_DEFINITION,
    PERCEPTION_OVERVIEW_TOOL_DEFINITION,
  ] as any);
  console.log(`[confirm-probe] provider=${provider.id} repeats=${repeats} tools=${tools.length} system=${systemPrompt.length}字`);

  // 生产同款收口：真实 TurnFinalizer（风格闸 → 隔离重写臂），deps 全 null（探针进程无记忆/账本装配）
  const lifecycle = new TurnLifecycle({
    narrativeMemory: null,
    computeQuotaService: null,
    evolutionLoopService: null,
    userPersonalizationService: null,
    agentMemorySyncService: null,
    shortTermMemoryGateway: null,
  } as never);
  const finalizer = new TurnFinalizer({
    provider,
    turnLifecycle: lifecycle,
    shortTermMemoryGateway: null,
    getBrainCenter: () => null,
  });

  const results: Array<{ text: string; tools: string[]; gate: { changed: boolean; violations: string[]; out: string }; shipped: string }> = [];
  for (const c of CASES) {
    for (let i = 0; i < repeats; i += 1) {
      const { toolCtx, calls } = buildToolContext();
      const sessionId = `confirm-probe-${Date.now()}-${results.length}`;
      const userText = `${mood}\n\n${c.text}`;
      let final = "";
      try {
        final = await provider.streamCompletion(
          sessionId,
          { text: userText },
          () => {},
          toolCtx as never,
          {
            toolExposureProfile: "explicit",
            chatToolsBuiltin: tools,
            chatToolsExtra: getBuiltinAgentChatTools() as any,
            toolLoop: { maxRounds: 3 },
            turnIntent: "chat",
            ephemeralTurn: true,
          } as never,
        );
      } catch (err) {
        console.error(`[confirm-probe] 轮失败：${c.text}#${i} → ${err instanceof Error ? err.message : err}`);
      }
      provider.clearSession?.(sessionId);
      const gate = enforceReplyStyle(final, "chat", { confirmationRound: true });
      const reply = await finalizer.finish("confirm-probe", c.text, final, {
        streamedChunks: true,
        modelCallsConsumed: 1,
        planExecuteUsed: false,
        pePlan: null,
        peExhausted: false,
        trajCap: undefined,
        lane: "chat",
        confirmationRound: true,
      });
      const shipped = reply.text.replace(/\[NEXT_UP_START\][\s\S]*$/, "").trim();
      results.push({ text: final, tools: calls.map((x) => `${x.name}${x.ok ? "" : "(fail)"}`), gate: { changed: gate.changed, violations: [...gate.violations], out: gate.text }, shipped });
      console.log(`\n──── ${c.text} #${i} tools=[${calls.map((x) => x.name).join(",") || "无"}] ────`);
      console.log(`[模型原话 ${final.length}字] violations=[${gate.violations.join(",") || "无"}]`);
      console.log(`[最终送达 ${shipped.length}字]\n${shipped || "（空）"}`);
    }
  }

  const brief = results.filter((r) => r.shipped.length <= 80).length;
  const summary = {
    label: "confirm-round-probe",
    repeats,
    turns: results.length,
    briefShipped: brief,
    gateFlagged: results.filter((r) => r.gate.violations.length > 0).length,
    rows: results.map((r) => ({ rawChars: r.text.length, shippedChars: r.shipped.length, tools: r.tools, violations: r.gate.violations })),
  };
  const outDir = join(scriptDir, "results");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `confirm-probe-${Date.now()}.json`);
  writeFileSync(outPath, JSON.stringify({ summary, results }, null, 2), "utf8");
  console.log(`\n[confirm-probe] 送达简短（≤80字）：${brief}/${results.length}；闸定罪：${summary.gateFlagged}/${results.length}；明细 → ${outPath}`);
}

main().catch((err) => {
  console.error("[confirm-probe] 探针异常", err);
  process.exit(1);
});
