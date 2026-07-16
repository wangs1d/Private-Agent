/**
 * 探测目标网站 HTML 结构，提取新闻列表
 */
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

interface Probe {
  name: string;
  url: string;
  encoding?: string; // GBK 网站需要
}

const probes: Probe[] = [
  // 环球网
  { name: "环球网国际", url: "https://world.huanqiu.com/" },
  { name: "环球网国内", url: "https://china.huanqiu.com/" },
  { name: "环球网财经", url: "https://finance.huanqiu.com/" },
  // 央视网
  { name: "央视网新闻", url: "https://news.cctv.com/" },
  { name: "央视网国际", url: "https://news.cctv.com/world/" },
  { name: "央视网国内", url: "https://news.cctv.com/china/" },
  // 参考消息
  { name: "参考消息首页", url: "https://www.cankaoxiaoxi.com/" },
  // 联合早报
  { name: "联合早报中国", url: "https://www.zaobao.com.sg/news/china" },
  { name: "联合早报国际", url: "https://www.zaobao.com.sg/news/world" },
  // 中国网
  { name: "中国网国际", url: "http://www.china.com.cn/international/" },
  // 澎湃新闻
  { name: "澎湃新闻首页", url: "https://www.thepaper.cn/" },
];

async function probe(p: Probe) {
  try {
    const r = await fetch(p.url, {
      headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml" },
      signal: AbortSignal.timeout(12000),
    });
    const buf = await r.arrayBuffer();
    const text = new TextDecoder("utf-8", { fatal: false }).decode(buf);
    // 提取所有 <a> 标签，看是否包含新闻标题
    const links = [...text.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>([^<]{8,80})<\/a>/gi)];
    const newsLinks = links
      .map(m => ({ href: m[1], text: m[2].trim() }))
      .filter(l => l.text.length >= 10 && !/^(首页|登录|注册|更多|关于|联系|广告|服务)/.test(l.text))
      .filter(l => /\.(html|shtml|htm)$/.test(l.href) || /\/\d{4}-\d{2}\/\d+/.test(l.href) || /news|article|detail/i.test(l.href));
    console.log(`✓ ${p.name} (${r.status}, ${text.length}字节, ${newsLinks.length}条新闻链接)`);
    newsLinks.slice(0, 3).forEach(l => {
      console.log(`   - ${l.text.slice(0, 50)} → ${l.href.slice(0, 80)}`);
    });
    if (newsLinks.length === 0) {
      console.log(`   前 500 字: ${text.slice(0, 500).replace(/\s+/g, " ")}`);
    }
  } catch (e: any) {
    console.log(`✗ ${p.name}: ${e.message}`);
  }
}

async function main() {
  console.log("=== 探测目标网站 HTML 结构 ===\n");
  for (const p of probes) {
    await probe(p);
    console.log("");
  }
}

main().catch(console.error);
