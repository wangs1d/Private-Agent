import fs from "node:fs";
import path from "node:path";
const BASE = "http://127.0.0.1:3000";
const dir = path.join("data", "images", "dbg-img-1787372472878");
const files = fs.readdirSync(dir).filter(f => f.endsWith(".png")).slice(0, 18);
const ids = [];
for (const f of files) {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(fs.readFileSync(path.join(dir, f)))]), f);
  const res = await fetch(`${BASE}/picture/assets`, { method: "POST", body: form });
  const j = await res.json();
  if (j.ok && !j.deduplicated) ids.push(j.photo.id);
}
fs.writeFileSync("data-tmp-demo-ids.json", JSON.stringify(ids));
console.log("演示照片:", ids.length, "张");
