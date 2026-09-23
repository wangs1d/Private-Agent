/**
 * 购物建议 runtime 链路真机 E2E（除 LLM 决策外的全真实链路）：
 *
 *   真实商品库（data/recommendation）→ 真实 shopping.suggest handler
 *   （life-tools 注册版）→ tool-card-registry builder → AGENT_RESULT_CARD
 *   标记（客户端 agent_result_parser 直接消费的协议）。
 *
 * 用法：cd server && npx tsx scripts/recommendation-runtime-e2e.ts
 */
import { join } from "node:path";

import { createRecommendationCatalog } from "../src/recommendation/index.js";
import { registerLifeTools } from "../src/tools/life-tools.js";
import type { ToolRegistry } from "../src/tools/tool-registry.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import { tryAttachToolResultCard } from "../src/services/tool-card-registry.js";

const registry: ToolRegistry = new ToolRegistry();
const catalog = createRecommendationCatalog(
  join(process.cwd(), "data", "recommendation"),
);

// 可注入的假个性化 LLM（记录收到的画像/数据，返回固定决策 JSON）
let lastUserContext = "";
let lastUserPrompt = "";
let fakeLlmRaw: string | null = null;
const personalization = {
  buildUserContext: async (actorId: string, userRequest?: string) => {
    void userRequest;
    lastUserContext = "用户画像：通勤地铁单程 40 分钟；常用安卓机；偏好实用、对价格敏感";
    return lastUserContext;
  },
  llmComplete: async (_system: string, userText: string) => {
    // 调用时读取：模拟 LLM 可用性在运行期才确定
    if (!fakeLlmRaw) throw new Error("fake llm unavailable");
    lastUserPrompt = userText;
    return fakeLlmRaw;
  },
};

// 可注入的假补图端口（记录收到的 query；置 null 模拟未装配/失败）
let fakeImageSearch: ((query: string, actorId: string) => Promise<string | null>) | null = null;
const webImageSearch = async (query: string, actorId: string) => {
  if (!fakeImageSearch) throw new Error("image search unavailable");
  return fakeImageSearch(query, actorId);
};

registerLifeTools(registry, {} as never, {} as never, {
  catalog,
  personalization,
  webImageSearch,
});

type ToolHandler = (input: Record<string, unknown>) => Promise<unknown>;
// ToolRegistry 无公开枚举 API，这里用与主聊天一致的 execute 通道：
const execute = async (name: string, input: Record<string, unknown>) => {
  const exec = (
    registry as unknown as {
      execute: (
        name: string,
        input: Record<string, unknown>,
        context: unknown,
      ) => Promise<{ ok: boolean; result: Record<string, unknown> }>;
    }
  ).execute.bind(registry);
  return exec(name, input, { sessionId: 'e2e-local_user' });
};

let failed = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}${detail ? `：${detail}` : ""}`);
  }
}

// ── 场景 1：口红对比（多关键词） ──
console.log("\n[场景1] 「MAC Chili 和 Dior 720 二选一，黄皮」");
const r1raw = (await execute("shopping.suggest", {
  item: "MAC Chili Dior 720",
})) as { ok: boolean; result: { recommendation?: { candidates: unknown[]; compare?: { rows: unknown[] } } } };
check("无个性化 LLM 时降级商品库文案", typeof r1raw.result.recommendation === "object");
check("工具执行成功", r1raw.ok === true);
const r1 = r1raw.result;
check("候选 2 款（真实对比）", r1.recommendation?.candidates?.length === 2);
check("附转置对比表", (r1.recommendation?.compare?.rows?.length ?? 0) > 0);

const text1 = tryAttachToolResultCard(
  "（前导正文）两款都符合你的需求，对比如下。",
  "shopping.suggest",
  r1 as unknown as Record<string, unknown>,
);
check("产出 AGENT_RESULT_CARD 标记", text1?.includes("[AGENT_RESULT_CARD_START]") === true);
const payload1 = JSON.parse(
  text1!.split("[AGENT_RESULT_CARD_START]\n")[1]!.split("\n[AGENT_RESULT_CARD_END]")[0]!,
) as { cardType: string; sides: Array<{ image?: string }>; videos: unknown[] };
check("cardType=product_compare", payload1.cardType === "product_compare");
check("分侧带图（试色/上妆图）", payload1.sides.length >= 2 && payload1.sides.every((s) => Boolean(s.image)));
check("视频入口非空", payload1.videos.length > 0);
console.log(`  sides: ${payload1.sides.map((s) => `${s.side}=${s.label}`).join(" | ")}`);
console.log(`  images: ${payload1.sides.map((s) => s.image).join(" , ")}`);

// ── 场景 2：单品 + 预算过滤 ──
console.log("\n[场景2] 「预算 2000 内降噪耳机」");
const r2raw = (await execute("shopping.suggest", {
  item: "降噪耳机",
  budget: 2000,
})) as { ok: boolean; result: { recommendation?: { candidates: Array<{ priceLabel: string }> } } };
check("工具执行成功", r2raw.ok === true);
const r2 = r2raw.result;
check("命中降噪耳机（XM5，预算内）", r2.recommendation?.candidates?.length === 1);
check("价格为 XM5 区间", r2.recommendation?.candidates?.[0]?.priceLabel.includes("1899") === true);

const text2 = tryAttachToolResultCard(
  "按你的预算筛了一遍。",
  "shopping.suggest",
  r2 as unknown as Record<string, unknown>,
);
const payload2 = JSON.parse(
  text2!.split("[AGENT_RESULT_CARD_START]\n")[1]!.split("\n[AGENT_RESULT_CARD_END]")[0]!,
) as { cardType: string };
check("单候选也上卡", payload2.cardType === "product_compare");

// ── 场景 3：未命中 → 如实降级 ──
console.log("\n[场景3] 「推荐个无人机」（库里没有）");
const r3raw = (await execute("shopping.suggest", { item: "无人机" })) as {
  ok: boolean;
  result: { recommendation?: unknown; suggestion?: string };
};
check("工具 ok 且不编造", r3raw.ok === true && r3raw.result.recommendation === undefined);
const r3 = r3raw.result;
check("降级话术明确", (r3.suggestion ?? "").includes("没有匹配商品"));
check("未命中不上卡", tryAttachToolResultCard("库里没有", "shopping.suggest", r3 as unknown as Record<string, unknown>) === null);

// ── 场景 4：媒体端点可用（商品图 HTTP 200 需常驻实例，这里只验文件在盘） ──
const { existsSync } = await import("node:fs");
check(
  "试色图文件在盘（media 目录）",
  existsSync(join(process.cwd(), "data", "recommendation", "media", "lip-redbrick.jpg")),
);

// ── 场景 4：有个性化 LLM → 每轮实时决策（重排 + 改写话术 + 画像注入） ──
console.log("\n[场景4] 个性化实时决策（注入画像 + 假 LLM 决策）");
fakeLlmRaw = JSON.stringify({
  summary: "两支都显白，通勤日常选 Chili 更实用",
  candidates: [
    {
      productId: "p-lip-chili",
      reasons: ["黄皮通勤显白不挑皮，日常办公室压得住", "哑光质地开会补妆一次就够"],
      cautions: ["你常说的唇部干燥问题，务必先打底"],
    },
    {
      productId: "p-lip-dior720",
      reasons: ["约会/正式场合的温柔挂，和你常用的妆容路线互补"],
      cautions: ["持色一般，午餐后需要补"],
    },
  ],
});
const r4raw = (await execute("shopping.suggest", {
  item: "MAC Chili Dior 720",
  userRequest: "这两支二选一，我日常上班为主，黄皮",
})) as {
  ok: boolean;
  result: {
    summary: string;
    personalized?: boolean;
    recommendation?: { candidates: Array<{ productId: string; reasons: string[] }> };
  };
};
const r4 = r4raw.result;
check("个性化被标记为已应用", r4.personalized === true);
check(
  "画像进入决策输入",
  lastUserContext.includes("通勤地铁"),
);
check(
  "用户原话进入决策输入",
  lastUserPrompt.includes("日常上班") && lastUserPrompt.includes("通勤地铁"),
);
check("候选被实时重排", r4.recommendation?.candidates?.[0]?.productId === "p-lip-chili");
check(
  "话术为当轮改写（非商品库模板）",
  (r4.recommendation?.candidates?.[0]?.reasons?.[0] ?? "").includes("黄皮通勤"),
);
check("summary 为 LLM 实时结论", r4.summary.includes("通勤"));

// ── 场景 5：LLM 输出非法 → 确定性兜底 ──
console.log("\n[场景5] 个性化 LLM 输出非法 → 降级");
fakeLlmRaw = "这不是 JSON";
const r5raw = (await execute("shopping.suggest", { item: "MAC Chili Dior 720" })) as {
  ok: boolean;
  result: { personalized?: boolean; recommendation?: { candidates: unknown[] } };
};
check("非法输出被拒", r5raw.result.personalized === false);
check("降级回商品库文案（候选仍在）", (r5raw.result.recommendation?.candidates?.length ?? 0) >= 2);

// ── 场景 6：缺图候选网搜补图（种子库无一手图的商品 → 卡片默认带图） ──
console.log("\n[场景6] 缺图候选网搜补图（手表 + 显示器，库里均无一手图）");
const searchedQueries: string[] = [];
fakeImageSearch = async (query) => {
  searchedQueries.push(query);
  return `/agent/images/e2e-local_user/${searchedQueries.length}.png`;
};
const r6raw = (await execute("shopping.suggest", {
  item: "智能手表 显示器",
})) as {
  ok: boolean;
  result: { recommendation?: { candidates: Array<{ productId: string; image?: string }> } };
};
check("工具执行成功", r6raw.ok === true);
const r6 = r6raw.result;
check("候选 ≥2（两款无图商品）", (r6.recommendation?.candidates?.length ?? 0) >= 2);
check(
  "缺图候选全部补上图（本地 PNG 相对路径）",
  r6.recommendation?.candidates?.every((c) => c.image?.startsWith("/agent/images/") === true) ===
    true,
);
check(
  "补图 query 为「品牌 + 品名」",
  searchedQueries.length === r6.recommendation?.candidates?.length &&
    searchedQueries.every((q) => q.length > 0),
);
const text6 = tryAttachToolResultCard("给你挑了两款。", "shopping.suggest", r6 as unknown as Record<string, unknown>);
const payload6 = JSON.parse(
  text6!.split("[AGENT_RESULT_CARD_START]\n")[1]!.split("\n[AGENT_RESULT_CARD_END]")[0]!,
) as { cardType: string; sides: Array<{ side: string; label: string; image?: string }> };
check("cardType=product_compare", payload6.cardType === "product_compare");
check(
  "分侧默认带图（网搜补图生效）",
  payload6.sides.length >= 2 && payload6.sides.every((s) => Boolean(s.image)),
);
console.log(`  sides: ${payload6.sides.map((s) => `${s.side}=${s.label}`).join(" | ")}`);
console.log(`  补图 query: ${searchedQueries.join(" , ")}`);
// 缓存生效：同品再查一轮不再触发网搜
await execute("shopping.suggest", { item: "智能手表 显示器" });
check("补图缓存生效（二次调用零网搜）", searchedQueries.length === r6.recommendation?.candidates?.length);
fakeImageSearch = null;

console.log(failed === 0 ? "\n全部通过 ✓" : `\n${failed} 项失败 ✗`);
process.exit(failed === 0 ? 0 : 1);
