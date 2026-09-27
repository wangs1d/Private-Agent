import fs from "node:fs";
import path from "node:path";
const BASE = "http://127.0.0.1:3000";

// 1) 上传 5 张真实图（取证后恢复）
const dir = path.join("data", "images", "dbg-img-1787372472878");
const files = fs.readdirSync(dir).filter(f => f.endsWith(".png")).slice(0, 5);
const ids = [];
for (const f of files) {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(fs.readFileSync(path.join(dir, f)))]), f);
  const res = await fetch(`${BASE}/picture/assets`, { method: "POST", body: form });
  const j = await res.json();
  if (j.ok && !j.deduplicated) ids.push(j.photo.id);
}
console.log("[1] 上传:", ids.length, "张");

// 2) random（recentDays=0 才纳入刚入库的）
const rand = await (await fetch(`${BASE}/picture/assets/random?count=3&recentDays=0`)).json();
console.log("[2] random: pool=", rand.pool, "抽到", rand.photos.length, "张, caption示例:", rand.photos[0]?.caption?.slice(0, 20) ?? "(无)");

// 3) batch-tag 收藏 2 张 → 再抽应排除
const favIds = ids.slice(0, 2);
await fetch(`${BASE}/picture/assets/batch-tag`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: favIds, tag: "收藏" }) });
const rand2 = await (await fetch(`${BASE}/picture/assets/random?count=10&recentDays=0`)).json();
console.log("[3] 收藏2张后 pool=", rand2.pool, "(应为 3)");

// 4) batch-delete 3 张 → 回收站
const delIds = ids.slice(2);
const del = await (await fetch(`${BASE}/picture/assets/batch-delete`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: delIds }) })).json();
console.log("[4] batch-delete: removed=", del.removed, "trash=", del.trashIds.filter(Boolean).length, "freed=", del.freedBytes, "bytes");

// 5) 回收站列表 + 预览
const trash = await (await fetch(`${BASE}/picture/trash`)).json();
console.log("[5] trash:", trash.items.length, "项, ttl:", trash.ttlDays, "天");
if (trash.items[0]) {
  const pv = await fetch(`${BASE}${trash.items[0].previewUrl}`);
  console.log("    preview:", pv.status, pv.headers.get("content-type"));
}

// 6) 恢复全部 + 去收藏 → 图库还原
const allTrash = trash.items.map(i => i.trashId);
const restore = await (await fetch(`${BASE}/picture/trash/restore`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: allTrash }) })).json();
console.log("[6] restore:", restore.restored, "张");
await fetch(`${BASE}/picture/assets/batch-tag`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: favIds, tag: "收藏", remove: true }) });
const final = await (await fetch(`${BASE}/picture/assets?page=1&pageSize=1`)).json();
console.log("[7] 图库最终 total:", final.total, "(应=上传数", ids.length, ")");

// 7) 清理上传的取证照片（恢复原空库）
for (const id of ids) await fetch(`${BASE}/picture/assets/${id}`, { method: "DELETE" });
const done = await (await fetch(`${BASE}/picture/assets?page=1&pageSize=1`)).json();
console.log("[8] 清理后 total:", done.total);
