/**
 * 多引擎搜索相关性闸门（searchWebMultiEngine / primaryRelevanceRatio）测试。
 *
 * 背景（2026-09-12 实测）：必应中国 RSS 对多词中文 query（「刘浩存 泰国」）
 * 只按首字匹配，返回「刘姓起源」类垃圾且条数凑满 limit——旧逻辑提前返回垃圾，
 * 百度/搜狗的真实结果（「刘浩存泰国归来」）永远没机会出场。修复后：主路相关性
 * <50% 时必须放行兜底引擎，且相关条目置顶/垃圾剔除。
 */
import assert from "node:assert/strict";
import test from "node:test";

const {
  primaryRelevanceRatio,
} = await import("../src/services/domestic-web-providers.js");

type Item = { title: string; snippet?: string; url?: string; source?: string; publishedAt?: string };

function items(specs: Array<[string, string]>): Item[] {
  return specs.map(([title, snippet]) => ({ title, snippet, url: `https://example.com/${encodeURIComponent(title)}` }));
}

test("相关性闸门：必应「刘姓」垃圾对人物 query 判 0% 相关", () => {
  const garbage = items([
    ["扒一扒刘姓起源和刘姓祖先的故事", "全国刘姓人口6460万"],
    ["刘（汉语汉字）_百度百科", "「刘」字的字源"],
    ["刘姓（中国姓氏）_百度百科", "刘姓，最早一支刘姓源自尧的后裔刘累"],
    ["刘的意思,刘的解释,刘的拼音", "刘的拼音是liú"],
  ]);
  assert.equal(primaryRelevanceRatio(garbage as never, "刘浩存 泰国"), 0);
});

test("相关性闸门：真实结果对同一 query 判高相关", () => {
  const real = items([
    ["刘浩存泰国归来！亮相直播，公主造型状态满分", "刘浩存结束泰国行程回国"],
    ["刘浩存 更新 泰国 plog，暮色蓝调照治愈感满满", "刘浩存在泰国拍摄的度假照"],
  ]);
  const ratio = primaryRelevanceRatio(real as never, "刘浩存 泰国");
  assert.ok(ratio !== null && ratio >= 0.5, `应 ≥0.5，实际 ${ratio}`);
});

test("相关性闸门：普通天气 query 的常规结果不被误杀", () => {
  const weather = items([
    ["上海天气预报_一周天气", "上海明天多云转晴"],
    ["上海市_百度百科", "上海，简称沪"],
  ]);
  const ratio = primaryRelevanceRatio(weather as never, "上海 明天 天气");
  assert.ok(ratio !== null && ratio > 0, `应 >0，实际 ${ratio}`);
});

test("相关性闸门：纯符号 query 返回 null（不过滤，保持原行为）", () => {
  assert.equal(primaryRelevanceRatio(items([["x", "y"]]) as never, "!!! ???"), null);
  assert.equal(primaryRelevanceRatio([] as never, "刘浩存"), 0);
});
