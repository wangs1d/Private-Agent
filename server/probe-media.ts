import { UpstreamSearchService } from "./src/services/upstream-search-service.js";
import { InfoHubService } from "./src/services/info-hub-service.js";

const svc = new UpstreamSearchService(new InfoHubService());
const t0 = Date.now();
const imgs = await svc.searchImages("马尔代夫 水屋", 4, "probe");
console.log("IMAGES provider=", imgs.provider, "items=", imgs.items.length, "ms=", Date.now()-t0);
console.log("notes:", imgs.notes);
for (const it of imgs.items.slice(0,3)) console.log(" -", it.title?.slice(0,30), "| thumb:", (it.thumbnailUrl||"").slice(0,80), "| media:", (it.mediaUrl||"").slice(0,80));
const tv0 = Date.now();
const vids = await svc.searchVideos("马尔代夫 旅行 vlog", 6);
console.log("VIDEOS provider=", vids.provider, "items=", vids.items.length, "ms=", Date.now()-tv0);
console.log("notes:", vids.notes);
for (const it of vids.items.slice(0,3)) console.log(" -", it.title?.slice(0,30), "| page:", (it.pageUrl||"").slice(0,70), "| thumb:", (it.thumbnailUrl||"").slice(0,60));
