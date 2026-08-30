import fs from "node:fs";

const url = `https://cn.bing.com/videos/search?q=${encodeURIComponent("马尔代夫 旅行 vlog")}`;
const res = await fetch(url, {
  headers: {
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    "accept-language": "zh-CN,zh;q=0.9",
  },
});
console.log("status:", res.status);
const html = await res.text();
console.log("len:", html.length);
fs.writeFileSync("probe-videos.html", html);
const counts: Record<string, number> = {
  mc_vtvc: (html.match(/mc_vtvc/g) || []).length,
  vrhmc: (html.match(/vrhmc/g) || []).length,
  mJson: (html.match(/\bm='?\{/g) || []).length,
  dataEpi: (html.match(/data-epi/g) || []).length,
  dgU: (html.match(/dg_u/g) || []).length,
};
console.log(counts);
