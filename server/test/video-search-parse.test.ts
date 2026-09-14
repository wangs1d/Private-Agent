// Bing 视频页解析回归测试（2026-09-13「搜出来的视频不对」根修）：
//   - 新结构 mc_vtvc_link（href/ourl + mc_vtvc_title + mc_bc_rc + img）必须能解析；
//   - 推广位视频（标题与查询词无 token 交集）必须被相关性门禁剔除；
//   - 旧结构 mmeta 兼容保留；query 为空时门禁关闭。
import assert from "node:assert/strict";
import { test } from "node:test";

import { parseBingVideoResults } from "../src/services/upstream-search-service.js";

/** 新结构结果单元（2026-09 实测：aria-label 在 class 前，href 是播放页直链） */
function vtvcLink(title: string, videoId: string, duration: string): string {
  return `<a aria-label="${title} 来源: douyin.com · 时长: 2 分钟 · 上传人: 某某" data-dc="vtdc_grey" class="mc_vtvc_link mc_vtvc_el" target="_blank" href="https://www.douyin.com/video/${videoId}" h="ID=video,5217.1">
<div class="mc_vtvc_con_rc" ourl="https://www.douyin.com/video/${videoId}">
<div class="mc_vtvc_th b_canvas"><div class="cico"><img height="199" width="354" data-src-hq="https://ts2.mm.bing.net/th/id/OVP.${videoId}?w=354&amp;h=199" src="https://ts2.mm.bing.net/th/id/OVP.${videoId}?w=120" /></div></div>
<div class="mc_vtvc_ban_lo"><div class="mc_bc_rc items">${duration}</div></div>
<div class="mc_vtvc_meta_w"><div class="mc_vtvc_meta"><div class="mc_vtvc_title b_promtxt" title="${title}"><strong>${title}</strong></div></div></div>
</a>`;
}

test("新结构 mc_vtvc_link 解析出标题/播放页/时长/缩略图，推广位被查询词门禁剔除", () => {
  const html = [
    vtvcLink("刘浩存最新采访", "111", "2:18"),
    vtvcLink("左下角直接玩！免费无下载的热门休闲小游戏入口", "222", "0:45"),
  ].join("\n");

  const items = parseBingVideoResults(html, 8, "刘浩存 采访");
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "刘浩存最新采访");
  assert.equal(items[0].pageUrl, "https://www.douyin.com/video/111");
  assert.equal(items[0].duration, "2:18");
  assert.equal(
    items[0].thumbnailUrl,
    "https://ts2.mm.bing.net/th/id/OVP.111?w=354&h=199",
  );
});

test("query 为空时门禁关闭（推广位也保留）", () => {
  const html = [
    vtvcLink("刘浩存最新采访", "111", "2:18"),
    vtvcLink("左下角直接玩！免费小游戏入口", "222", "0:45"),
  ].join("\n");
  assert.equal(parseBingVideoResults(html, 8, "").length, 2);
});

test("新旧结构同 URL 去重，旧结构 mmeta 兼容解析", () => {
  const html = [
    vtvcLink("刘浩存舞台直拍", "111", "3:00"),
    '<div class="mc_vtvc b_canvas" mmeta="{&quot;purl&quot;:&quot;https://www.douyin.com/video/111&quot;,&quot;turl&quot;:&quot;https://turl.bing.com/old.jpg&quot;}"><a aria-label="刘浩存舞台直拍 来源: douyin.com">占位</a></div>',
    '<div class="mc_vtvc b_canvas" mmeta="{&quot;purl&quot;:&quot;https://www.bilibili.com/video/BV1xx&quot;,&quot;turl&quot;:&quot;https://turl.bing.com/bv.jpg&quot;}"><a aria-label="刘浩存 杂谈 来源: bilibili.com">占位2</a></div>',
  ].join("\n");

  const items = parseBingVideoResults(html, 8, "刘浩存");
  const urls = items.map((it) => it.pageUrl);
  assert.equal(urls.length, new Set(urls.map((u) => u.toLowerCase())).size, "同 URL 只保留一条");
  assert.ok(urls.includes("https://www.bilibili.com/video/BV1xx"), "mmeta 旧结构仍可解析");
});

test("门禁不误杀英文标题匹配拉丁 token 的结果", () => {
  const html = vtvcLink("Taylor Swift Eras Tour live", "333", "5:01");
  const items = parseBingVideoResults(html, 8, "Taylor Swift");
  assert.equal(items.length, 1);
  assert.equal(items[0].pageUrl, "https://www.douyin.com/video/333");
});
