/**
 * 语感 A/B 真链探针（2026-10-06 活人感治理 E 验收，参照 probe-confirm-round.ts 骨架）。
 *
 * 同一生产同源 system prompt（kernel 薄身份 + finalize 后缀 + 【人格·静态】 +
 * FOREGROUND_ROLE_GUIDANCE + mood），仅切换两个治理变量做前后对比：
 *  - before 臂：无【语感基准】few-shot、无 slang 语气词行、默认采样（旧地基形态）
 *  - after   臂：【语感基准】8 组轮换示例 + slang 语气词行 + chatLaneSampling
 *    （temperature 0.85 + frequency_penalty 0.4，即治理后 chat 车道形态）
 *
 * 验收（方案 E）：after 臂闲聊像人话、梗适量（一轮最多一个）；正事轮（提醒）
 * 零梗（人格块铁律）；20 题语感集留档 results/。
 *
 * 用法：npx tsx scripts/probe-voice-ab.ts [--repeats=1] [--cases=核心20]
 */
import "dotenv/config";
import { loadServerEnv } from "../src/config/load-server-env.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

loadServerEnv();

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repeats = Number.parseInt(process.argv.find((a) => a.startsWith("--repeats="))?.slice(10) ?? "1", 10) || 1;
// 定点回归：--arm=after|both（缺省 both）、--tags=tag1,tag2（只跑指定题）、
// --seed=xxx（语感基准轮换种子）、--custom=p1|p2（临时题，不进冻结语感集）
const armArg = (process.argv.find((a) => a.startsWith("--arm="))?.slice(6) ?? "both") as "both" | "after" | "before";
const tagsArg = process.argv.find((a) => a.startsWith("--tags="))?.slice(7) ?? "";
const tagFilter = new Set(tagsArg.split(",").map((t) => t.trim()).filter(Boolean));
const seedArg = process.argv.find((a) => a.startsWith("--seed="))?.slice(7) ?? "";
const customArg = process.argv.find((a) => a.startsWith("--custom="))?.slice(9) ?? "";

const { createExternalChatProviderFromEnv } = await import("../src/external-model/resolve-provider.js");
const { getRuntimeKernel } = await import("../src/agent/runtime-kernel.js");
const { FOREGROUND_ROLE_GUIDANCE } = await import("../src/agent/lane-role-guidance.js");
const { buildPersonaStaticBlock, buildPersonaMoodBlock, resolvePersonaMood } = await import("../src/agent/persona-core.js");
const { buildVoiceBaselineBlock } = await import("../src/agent/chat-voice-baseline.js");
const { finalizeChatSystemPrompt } = await import("../src/agent/prompt-builder.js");
const { buildLaneCoreTools } = await import("../src/external-model/lane-tool-sets.js");
const { getBuiltinAgentChatTools } = await import("../src/external-model/openai-compatible-tool-loop.js");
const { TASK_DISPATCH_TOOL_DEFINITION } = await import("../src/tools/task-dispatch-tool.js");
const { TASK_CANCEL_TOOL_DEFINITION, TASK_STATUS_TOOL_DEFINITION } = await import("../src/tools/task-plane-tools.js");
const { PERCEPTION_OVERVIEW_TOOL_DEFINITION } = await import("../src/tools/perception-tools.js");
const { ToolRegistry } = await import("../src/tools/tool-registry.js");
const { InfoHubService } = await import("../src/services/info-hub-service.js");
const { UpstreamSearchService } = await import("../src/services/upstream-search-service.js");

// ── 20 题语感集（方案 E 留档；每版本同集回归，防悄悄回退）──
type Case = { tag: string; text: string; expect: string };
const CASES: Case[] = [
  { tag: "称呼", text: "以后叫我王哥", expect: "顺着接住称呼，像熟人" },
  { tag: "闲聊", text: "周末好无聊", expect: "接话茬给方向，不说教" },
  { tag: "疲惫", text: "今天加班到现在才吃上饭", expect: "先关心吃饭，短" },
  { tag: "吐槽", text: "游戏输了一晚上", expect: "接梗损一句，不上价值" },
  { tag: "情绪", text: "感觉最近啥都不顺", expect: "先接情绪再给角度" },
  { tag: "好奇", text: "哈哈哈你看这个截图", expect: "要图，口吻起哄" },
  { tag: "求助", text: "你说我这项目还有戏吗", expect: "有立场，反问卡点" },
  { tag: "深夜", text: "好困但是不想睡", expect: "损一句带收尾" },
  { tag: "惊吓", text: "刚才吓死我了", expect: "先问人没事吧" },
  { tag: "天气", text: "今天天气真好", expect: "带行动建议，不平铺" },
  { tag: "周一", text: "又是周一", expect: "一句共苦，不灌鸡汤" },
  { tag: "搞笑", text: "刚看到一个特别好笑的视频", expect: "要看，口气松" },
  { tag: "想家", text: "有点想家了", expect: "落在具体动作上" },
  { tag: "考试", text: "明天要考试好紧张", expect: "接住紧张，给一句实用的" },
  { tag: "戒烟", text: "我终于把烟戒了", expect: "捧场 + 给替代方案" },
  { tag: "存钱", text: "最近存不下钱", expect: "给一个抓手，不开课" },
  { tag: "放假", text: "好想放假", expect: "短共情 + 盘计划" },
  { tag: "鸽子", text: "我朋友放我鸽子", expect: "站用户这边，损事不损人" },
  { tag: "正事·零梗", text: "明天早上8点提醒我吃药", expect: "当场办妥一两句确认，零梗零玩笑" },
  { tag: "梗诱导·克制", text: "来点网络热梗听听", expect: "可给一两个，不堆梗不报菜名" },
];

function buildToolContext() {
  const infoHub = new InfoHubService();
  const upstream = new UpstreamSearchService(infoHub);
  const registry = new ToolRegistry() as any;
  const stub = async (name: string) => ({ ok: false, result: { error: `probe: ${name} 未接执行器` } });
  for (const name of [
    "reminder.plan", "calendar.create_from_text", "calendar.create_task",
    "clock.get_current_time", "clock.get_user_location", "search_web", "search_images",
    "calendar.list_tasks", "task.dispatch", "task.status", "task.cancel",
  ]) {
    registry.register(name, stub.bind(null, name));
  }
  const calls: Array<{ name: string; ok: boolean }> = [];
  const toolCtx = {
    executeTool: async (name: string, args: Record<string, unknown>) => {
      let r: { ok: boolean; result: Record<string, unknown> };
      try {
        const out = await registry.execute(name, args, { actorId: "voice-probe" });
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

type Row = { arm: string; tag: string; user: string; reply: string; tools: string[]; chars: number };

async function runArm(
  provider: any,
  arm: "before" | "after",
  seed: string,
): Promise<Row[]> {
  const kernel = getRuntimeKernel();
  const identity = kernel.buildSessionSystem() ?? "";
  const personaStatic = buildPersonaStaticBlock({ userAlias: undefined, tier: 2 });
  const mood = buildPersonaMoodBlock(
    resolvePersonaMood({ tier: 2, isTaskPlane: false }),
  );
  const baseSystem = finalizeChatSystemPrompt(identity, { tools: true });
  const parts = [baseSystem, personaStatic];
  // after 臂才注入【语感基准】（含 slang 语气词行，读 data/slang-lexicon.json）
  if (arm === "after") {
    const voice = buildVoiceBaselineBlock(seed);
    if (voice) parts.push(voice);
  }
  const systemPrompt = parts.filter(Boolean).join("\n\n");

  const tools = buildLaneCoreTools("chat", getBuiltinAgentChatTools() as any, [
    TASK_DISPATCH_TOOL_DEFINITION,
    TASK_STATUS_TOOL_DEFINITION,
    TASK_CANCEL_TOOL_DEFINITION,
    PERCEPTION_OVERVIEW_TOOL_DEFINITION,
  ] as any);

  const rows: Row[] = [];
  const customCases: Case[] = customArg
    .split("|")
    .map((t, i) => ({ tag: `自定义#${i + 1}`, text: t.trim(), expect: "临时题" }))
    .filter((c) => c.text);
  const cases = [
    ...(customCases.length > 0 ? customCases : CASES.filter((c) => tagFilter.size === 0 || tagFilter.has(c.tag))),
  ];
  for (const c of cases) {
    for (let i = 0; i < repeats; i += 1) {
      const { toolCtx, calls } = buildToolContext();
      const sessionId = `voice-probe-${arm}-${Date.now()}-${rows.length}`;
      const isTaskish = c.tag.startsWith("正事");
      const userText = `${isTaskish ? "【人格·状态：严肃】\n零调侃，直接办，先结果后过程。" : mood}\n\n${c.text}`;
      let reply = "";
      try {
        reply = await provider.streamCompletion(
          sessionId,
          { text: userText },
          () => {},
          toolCtx as never,
          {
            toolExposureProfile: "explicit",
            chatToolsBuiltin: tools,
            chatToolsExtra: getBuiltinAgentChatTools() as any,
            toolLoop: { maxRounds: 2 },
            turnIntent: "chat",
            // after 臂才带 chat 车道采样放开（与生产 agent-core 同源置位）
            ...(arm === "after" ? { chatLaneSampling: true } : {}),
          } as never,
        );
      } catch (err) {
        console.error(`[voice-probe] ${arm} ${c.tag}#${i} 失败：${err instanceof Error ? err.message : err}`);
      }
      provider.clearSession?.(sessionId);
      const toolsUsed = calls.map((x) => x.name).join(",");
      rows.push({ arm, tag: c.tag, user: c.text, reply: reply.trim(), tools: toolsUsed ? [toolsUsed] : [], chars: reply.trim().length });
      console.log(`\n──── [${arm}] ${c.tag} ────`);
      console.log(`用户：${c.text}`);
      console.log(`agent：${reply.trim() || "（空）"}`);
    }
  }
  return rows;
}

async function main(): Promise<void> {
  const provider = createExternalChatProviderFromEnv();
  if (!provider?.isEnabled()) {
    console.error("[voice-probe] 外部模型 provider 未启用，无法探针");
    process.exit(1);
  }
  console.log(`[voice-probe] provider=${provider.id} repeats=${repeats} cases=${CASES.length} arms=${armArg}${seedArg ? ` seed=${seedArg}` : ""}`);
  const seed = seedArg || `voice-probe-seed`; // 固定 seed：两臂取同一批示例，对比只剩治理变量
  const runArms: Array<"before" | "after"> = armArg === "both" ? ["before", "after"] : [armArg];
  const allRows: Array<{ arm: string; rows: Row[] }> = [];
  for (const arm of runArms) {
    allRows.push({ arm, rows: await runArm(provider, arm, seed) });
  }
  const before = allRows.find((r) => r.arm === "before")?.rows ?? [];
  const after = allRows.find((r) => r.arm === "after")?.rows ?? [];

  const outDir = join(scriptDir, "results");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `voice-ab-${Date.now()}.json`);
  writeFileSync(outPath, JSON.stringify({ seed, cases: CASES, before, after }, null, 2), "utf8");
  console.log(`\n[voice-probe] 完成 before=${before.length} after=${after.length} 轮；明细 → ${outPath}`);
}

main().catch((err) => {
  console.error("[voice-probe] 探针异常", err);
  process.exit(1);
});
