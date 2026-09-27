import fs from "node:fs";
import path from "node:path";
const BASE = "http://127.0.0.1:3000";
// 全目录扫描凑到 16 张非重复
const root = path.join("data", "images");
const existing = JSON.parse(fs.readFileSync("data-tmp-demo-ids.json", "utf8"));
const index = JSON.parse(fs.readFileSync(path.join("data", "pictures", "index.json"), "utf8"));
const have = new Set(Object.keys(index.assets));
let added = existing.length;
for (const dir of fs.readdirSync(root)) {
  if (added >= 16) break;
  const sub = path.join(root, dir);
  if (!fs.statSync(sub).isDirectory()) continue;
  for (const f of fs.readdirSync(sub).filter(f => f.endsWith(".png"))) {
    if (added >= 16) break;
    try {
      const buf = fs.readFileSync(path.join(sub, f));
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(buf)]), `salon-${added}.png`);
      const res = await fetch(`${BASE}/picture/assets`, { method: "POST", body: form });
      const j = await res.json();
      if (j.ok && !j.deduplicated) { existing.push(j.photo.id); added++; }
    } catch {}
  }
}
fs.writeFileSync("data-tmp-demo-ids.json", JSON.stringify(existing));
console.log("总演示照片:", added);
