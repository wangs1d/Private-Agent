/** 诊断：cn.bing.com/videos/search 服务端直抓的 HTML 里到底有什么 */
const q = process.argv[2] ?? "泰勒丝 演唱会";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const url = `https://cn.bing.com/videos/search?q=${encodeURIComponent(q)}`;
const res = await fetch(url, {
  headers: { "user-agent": UA, accept: "text/html", "accept-language": "zh-CN,zh;q=0.9" },
  redirect: "follow",
});
console.log(`HTTP ${res.status}  finalURL=${res.url}`);
const html = await res.text();
console.log(`html length=${html.length}`);
console.log(`mc_vtvc 出现次数: ${(html.match(/class="mc_vtvc/g) ?? []).length}`);
console.log(`mmeta= 出现次数: ${(html.match(/\smmeta="/g) ?? []).length}`);
console.log(`vrhdata 出现次数: ${(html.match(/class="vrhdata"/g) ?? []).length}`);
console.log(`<a href 出现次数: ${(html.match(/<a\b[^>]*href=/g) ?? []).length}`);
// dump mmeta 里的 purl/murl
const mmetaRe = /class="mc_vtvc[^"]*"[^>]*\smmeta="([^"]*)"/g;
let m; let i = 0;
while ((m = mmetaRe.exec(html)) && i < 6) {
  i += 1;
  try {
    const data = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
    console.log(`mmeta#${i}: purl=${String(data.purl ?? "").slice(0, 80)} murl=${String(data.murl ?? "").slice(0, 80)}`);
  } catch (e) { console.log(`mmeta#${i}: 解析失败 ${e.message}`); }
}
// 页面标题（看是不是被重定向到验证页/首页）
const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
console.log(`页面 title: ${t ? t[1].slice(0, 100) : "(无)"}`);
// 找"推荐/热门"模块特征
for (const kw of ["热门", "推荐", "趋势", "trending", "Related", "相关视频"]) {
  const n = html.split(kw).length - 1;
  if (n > 0) console.log(`特征词「${kw}」出现 ${n} 次`);
}
