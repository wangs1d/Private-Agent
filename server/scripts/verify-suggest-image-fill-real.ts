/**
 * shopping.suggest 缺图补图「全真实链路」验证（2026-09-23 补图链路配套）。
 *
 * 与 recommendation-runtime-e2e.ts 场景6 的差别：补图端口不再是假件，
 * 而是与 bootstrap 完全同源的真实装配——
 *   真实 UpstreamSearchService（真实搜索 API/Bing 兜底 + 真实 PNG 转存）
 *   → 真实 shopping.suggest handler → 真实 tool-card-registry 出卡
 *   → 校验 sides[].image 可经 HTTP 拉到 image/png。
 *
 * 用法：cd server && npx tsx scripts/verify-suggest-image-fill-real.ts
 */
import "dotenv/config";
import { join } from "node:path";

import { loadServerEnv } from "../src/config/load-server-env.js";

loadServerEnv();

import { createRecommendationCatalog } from "../src/recommendation/index.js";
import { InfoHubService } from "../src/services/info-hub-service.js";
import { ImageGenerationService } from "../src/services/image-generation-service.js";
import { UpstreamSearchService } from "../src/services/upstream-search-service.js";
import { tryAttachToolResultCard } from "../src/services/tool-card-registry.js";
import { registerLifeTools } from "../src/tools/life-tools.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";

const registry = new ToolRegistry();
const infoHubService = new InfoHubService();
const upstreamSearchService = new UpstreamSearchService(infoHubService);
// 与 bootstrap 同源：图片转存落 data/images，静态路由 /agent/images 可拉
upstreamSearchService.setImageStorageService(new ImageGenerationService());

const actorId = `verify-img-${Date.now()}`;
registerLifeTools(registry, {} as never, {} as never, {
  catalog: createRecommendationCatalog(join(process.cwd(), "data", "recommendation")),
  webImageSearch: async (query, actor) => {
    const res = await upstreamSearchService.searchImages(query, 1, actor);
    return res.items[0]?.mediaUrl ?? null;
  },
});

const exec = (
  registry as unknown as {
    execute: (
      name: string,
      input: Record<string, unknown>,
      context: unknown,
    ) => Promise<{ ok: boolean; result: Record<string, unknown> }>;
  }
).execute.bind(registry);

let failed = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "  ✓" : "  ✗"} ${name}${cond ? "" : `：${detail}`}`);
  if (!cond) failed += 1;
};

console.log("[verify] 真实网搜补图（手表 + 显示器，种子库均无一手图）");
const t0 = Date.now();
const res = await exec("shopping.suggest", { item: "智能手表 显示器" }, { sessionId: actorId });
const rec = res.result.recommendation as
  | { candidates: Array<{ productId: string; brand: string; name: string; image?: string }> }
  | undefined;
check("工具执行成功", res.ok === true && Boolean(rec));
const candidates = rec?.candidates ?? [];
check("候选 ≥2", candidates.length >= 2, `实际 ${candidates.length}`);
console.log(`  耗时 ${Date.now() - t0}ms（含真实网搜 + PNG 转存）`);

for (const c of candidates) {
  check(
    `${c.productId} 补上图（/agent/images/）`,
    typeof c.image === "string" && c.image.startsWith("/agent/images/"),
    `实际：${c.image}`,
  );
  if (typeof c.image === "string" && c.image.startsWith("/agent/images/")) {
    const res2 = await fetch(`http://127.0.0.1:3000${c.image}`).catch(() => null);
    const ok2 = res2?.status === 200 && res2?.headers.get("content-type")?.includes("image/png");
    check(`${c.productId} 图片 HTTP 可拉（200 image/png）`, Boolean(ok2), res2 ? `HTTP ${res2.status}` : "fetch 失败（需 server 运行）");
  }
}

const text = tryAttachToolResultCard("前导正文", "shopping.suggest", res.result);
check("出卡标记", text?.includes("[AGENT_RESULT_CARD_START]") === true);
const payload = JSON.parse(
  text!.split("[AGENT_RESULT_CARD_START]\n")[1]!.split("\n[AGENT_RESULT_CARD_END]")[0]!,
) as { cardType: string; sides: Array<{ side: string; label: string; image?: string }> };
check("cardType=product_compare", payload.cardType === "product_compare");
check(
  "分侧全部带图",
  payload.sides.length >= 2 && payload.sides.every((s) => Boolean(s.image)),
);
console.log(`  sides: ${payload.sides.map((s) => `${s.side}=${s.label} img=${s.image ?? "无"}`).join("\n         ")}`);

console.log(failed === 0 ? "\n全部通过 ✓" : `\n${failed} 项失败 ✗`);
process.exit(failed === 0 ? 0 : 1);
