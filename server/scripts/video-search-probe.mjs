/**
 * 视频搜索链路一次性探针：直调 UpstreamSearchService.searchVideos，
 * 打印 provider/notes/每条结果的标题、播放页、缩略图，用于诊断「搜出来的视频不对」。
 * 用法: node scripts/video-search-probe.mjs "查询词1" "查询词2" ...
 */
import { config } from "dotenv";
config({ path: new URL("../.env", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1") });
config({ path: new URL("../.env.local", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), override: true });

const { UpstreamSearchService } = await import("../dist/services/upstream-search-service.js").catch(() => ({}))
  ?? { UpstreamSearchService: null };
const queries = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ["刘浩存 视频", "泰勒丝 演唱会 视频"];

const svc = new UpstreamSearchService({
  async search(q, limit) {
    const { searchViaSearchApi } = await import("../dist/services/search-api-provider.js");
    const items = await searchViaSearchApi(q, limit ?? 8).catch(() => []);
    return (items ?? []).map((it) => ({
      title: String(it.title ?? ""),
      url: String(it.url ?? it.pageUrl ?? ""),
      snippet: String(it.snippet ?? ""),
      source: String(it.source ?? "search-api"),
    }));
  },
});

for (const q of queries) {
  const t0 = Date.now();
  try {
    const r = await svc.searchVideos(q, 8);
    console.log(`\n【${q}】 provider=${r.provider} ${(Date.now() - t0)}ms 条数=${r.items.length}`);
    console.log(`  notes: ${r.notes.join(" | ")}`);
    for (const it of r.items) {
      console.log(`  - ${String(it.title).slice(0, 50)}`);
      console.log(`      page: ${it.pageUrl}`);
      console.log(`      thumb: ${it.thumbnailUrl ? String(it.thumbnailUrl).slice(0, 90) : "(无)"}`);
      console.log(`      src=${it.source} dur=${it.duration ?? "-"} media=${it.mediaUrl ? "y" : "n"}`);
    }
  } catch (e) {
    console.log(`【${q}】 失败: ${e?.stack || e}`);
  }
}
