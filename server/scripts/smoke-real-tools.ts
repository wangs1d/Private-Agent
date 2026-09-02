/**
 * 真实链路冒烟测试（手动运行，产生真实 API 调用与真实搜索请求）：
 *
 *   npx tsx scripts/smoke-real-tools.ts
 *
 * 验证目标（2026-09-02 意图路由架构 + 工具真实调用）：
 *   ① 真实 LLM 意图分类：一批代表性消息经 routeTurnByLlm（真实 provider）→
 *      输出意图标签 + 车道，核对 fast/complex 是否被正确命中；
 *   ② 真实搜索工具：registry.execute("search_web") 走真实 AnySearch 链路返回结果；
 *   ③ 真实图片工具：registry.execute("search_images") 返回真实照片；
 *   ④ 其他工具：registry.execute("clock.get_current_time") 正确返回；
 *   ⑤ 真实端到端 tool-loop：真实 LLM + 真实工具执行器——搜索类请求是否
 *      「真的去调用了工具并基于结果作答」（文字搜索 + 照片各跑一轮）。
 */
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(here, "../../.env") });
dotenv.config({ path: path.join(here, "../.env"), override: true });
dotenv.config({ path: path.join(here, "../.env.local"), override: true });

const { ToolRegistry } = await import("../src/tools/tool-registry.js");
const { registerWebTools } = await import("../src/tools/web-tools.js");
const { registerClockTools } = await import("../src/tools/clock-tools.js");
const { InfoHubService } = await import("../src/services/info-hub-service.js");
const { UpstreamSearchService } = await import("../src/services/upstream-search-service.js");
const { createExternalChatProviderFromEnv } = await import(
  "../src/external-model/resolve-provider.js"
);
const { routeTurnByLlm } = await import("../src/agent/llm-task-router.js");
const { streamCompletionWithTools, getFastLaneTools } = await import(
  "../src/external-model/openai-compatible-tool-loop.js"
);
const OpenAI = (await import("openai")).default;

const registry = new ToolRegistry();
const infoHub = new InfoHubService();
const upstreamSearch = new UpstreamSearchService(infoHub);
registerWebTools(registry, infoHub, upstreamSearch);
registerClockTools(registry);

const section = (title: string) =>
  console.log(`\n════════════════════ ${title} ════════════════════`);

/* ── ① 真实 LLM 意图分类 ── */
async function smokeIntentRouting() {
  section("① 真实 LLM 意图分类（routeTurnByLlm × 真实 provider）");
  const provider = createExternalChatProviderFromEnv();
  if (!provider) {
    console.log("⚠ 未配置外部模型 provider（OPENAI_API_KEY?），跳过");
    return;
  }
  const cases: Array<{ text: string; expectLane: "fast" | "complex" }> = [
    { text: "在吗", expectLane: "fast" },
    { text: "你好呀，今天有点累", expectLane: "fast" },
    // 新架构：realtime_lookup 按路由表走 fast（fast 已携搜索工具 + strict 出口仲裁兜底）
    { text: "刘浩存最近的消息", expectLane: "fast" },
    { text: "帮我搜索景甜的照片", expectLane: "fast" },
    { text: "帮我找几张景甜最近的活动中照片", expectLane: "fast" },
    { text: "明天早上八点提醒我开会", expectLane: "complex" },
    { text: "在电脑上帮我打开微信给张三发个消息", expectLane: "complex" },
    { text: "量子纠缠到底是什么原理", expectLane: "fast" },
  ];
  let hit = 0;
  for (const { text, expectLane } of cases) {
    const d = await routeTurnByLlm(provider, "smoke-intent", text);
    const ok = d.mode === expectLane;
    if (ok) hit += 1;
    console.log(
      `${ok ? "✔" : "✖"} [${d.mode}${ok ? "" : `≠期望${expectLane}`}] intent=${d.intent}@${d.confidence?.toFixed(2)} | ${text} | ${d.reasons[0] ?? ""}`,
    );
  }
  console.log(`── 意图路由命中 ${hit}/${cases.length}`);
}

/* ── ②③④ 真实工具直调 ── */
async function smokeDirectTools() {
  section("②③④ 真实工具直调（registry.execute → 真实 AnySearch / 图片链路 / 时钟）");
  const ctx = { sessionId: "smoke-real-tools" };

  const web = await registry.execute("search_web", { query: "刘浩存 最新消息", limit: 5 }, ctx);
  const webItems = ((web.result as Record<string, unknown>)?.items ?? []) as Array<Record<string, unknown>>;
  console.log(
    `search_web ok=${web.ok} 条数=${webItems.length}` +
      (webItems[0]
        ? ` 首条: ${String(webItems[0].title).slice(0, 50)} | ${String(webItems[0].url).slice(0, 60)}`
        : ""),
  );

  const imgs = await registry.execute("search_images", { query: "景甜", limit: 4 }, ctx);
  const imgItems = ((imgs.result as Record<string, unknown>)?.items ?? []) as Array<Record<string, unknown>>;
  console.log(
    `search_images ok=${imgs.ok} 条数=${imgItems.length}` +
      (imgItems[0]
        ? ` 首张: ${String(imgItems[0].mediaUrl ?? imgItems[0].thumbnailUrl ?? "").slice(0, 70)}`
        : ""),
  );

  const clock = await registry.execute("clock.get_current_time", {}, ctx);
  console.log(
    `clock.get_current_time ok=${clock.ok} 结果=${JSON.stringify(clock.result).slice(0, 120)}`,
  );

  return { webOk: web.ok && webItems.length > 0, imgOk: imgs.ok && imgItems.length > 0, clockOk: clock.ok };
}

/* ── ⑤ 真实端到端 tool-loop（真实 LLM + 真实工具执行器）── */
async function smokeE2E(userText: string, expectTool: string) {
  console.log(`\n── 端到端: "${userText}" （期望真实调用 ${expectTool}）`);
  const executed: Array<{ name: string; ok: boolean }> = [];
  const ctx = {
    executeTool: async (name: string, args: Record<string, unknown>) => {
      const r = await registry.execute(name, args, { sessionId: "smoke-e2e" });
      executed.push({ name, ok: r.ok });
      return r;
    },
  };
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const model = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
  const out = await streamCompletionWithTools(
    client,
    model,
    [
      {
        role: "system",
        content:
          "你用户的私人助理。涉及时事/近况/新闻必须先调 search_web 拿真实结果再回答；找照片调 search_images。基于真实工具结果回答，注明信息日期。",
      },
      { role: "user", content: userText },
    ],
    () => {},
    ctx,
    {
      tools: getFastLaneTools(),
      maxRounds: 2,
      extraBody: { fastProfile: true },
      audit: { sessionId: "smoke-e2e" },
    },
  );
  const called = executed.some((e) => e.name === expectTool && e.ok);
  console.log(
    `工具执行: ${JSON.stringify(executed)} | ${called ? "✔" : "✖"} 期望工具 ${expectTool} 已真实调用`,
  );
  console.log(`回答摘要: ${out.replace(/\s+/g, " ").slice(0, 160)}`);
  return called;
}

/* ── 主流程 ── */
const results: Record<string, boolean> = {};
results.intent = true;
try {
  await smokeIntentRouting();
} catch (e) {
  results.intent = false;
  console.error("意图分类冒烟失败:", e);
}
try {
  const direct = await smokeDirectTools();
  Object.assign(results, direct);
} catch (e) {
  results.webOk = false;
  results.imgOk = false;
  results.clockOk = false;
  console.error("工具直调冒烟失败:", e);
}
try {
  results.e2eSearch = await smokeE2E("帮我查一下刘浩存最近有什么新闻", "search_web");
  results.e2eImages = await smokeE2E("帮我找几张景甜的照片", "search_images");
} catch (e) {
  results.e2eSearch = false;
  results.e2eImages = false;
  console.error("端到端冒烟失败:", e);
}

section("冒烟结论");
for (const [k, v] of Object.entries(results)) {
  console.log(`${v ? "✔" : "✖"} ${k}`);
}
if (Object.values(results).some((v) => !v)) process.exitCode = 1;
