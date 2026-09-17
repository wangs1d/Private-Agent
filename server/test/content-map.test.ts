/**
 * ContentMap + obs_recall 定向读取测试（WP1，2026-09-17）。
 *
 * 借鉴 codebase-memory-mcp「结构索引+定向读取」：
 *  - buildContentMap：markdown/json/csv/code/text 五种 kind 的确定性抽取，
 *    offset 与原文坐标严格一致（切片回读可验证）
 *  - scoreSections / resolveQueryWindow：关键词命中目标节（BM25-lite）
 *  - renderOutline：结构目录渲染有界
 *  - ObservationPack 集成：归档自动建 map；mode="outline"；query 定向跳转；
 *    无 query 时旧分页行为不变；旧格式条目（无 map）安全回退
 *  - 防幻觉约束：确定性抽取（无 LLM）；outline 带导航声明
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

// ---------- buildContentMap ----------

describe("buildContentMap kind 识别与节抽取", () => {
  test("markdown：标题切节，offset 精确（切片回读验证）", async () => {
    const { buildContentMap } = await import("../src/external-model/content-map.js");
    const doc = [
      "引言段：这篇文章讨论价格政策与售后条款。",
      "## 价格政策",
      "全文价格：基础版 99 元/月，专业版 299 元/月。退款需在 7 天内申请。",
      "## 售后条款",
      "售后：一年质保，人为损坏不在范围内。",
      "### 退款细则",
      "退款细则：7 天无理由，15 天内收取 10% 手续费。",
    ].join("\n");
    const map = buildContentMap(doc);
    assert.equal(map.kind, "markdown");
    assert.ok(map.sections.length >= 3);
    // 每节的 offset 回读必须得到标题行原文（坐标严格一致）
    for (const s of map.sections) {
      const sliceAt = doc.slice(s.offset, s.offset + s.chars);
      if (s.title !== "(开头)") {
        assert.ok(
          sliceAt.includes(s.title.split(" ")[0]!),
          `节 ${s.title} 的 offset 应落在对应标题处`,
        );
      }
    }
    // 全覆盖：节区间拼起来应覆盖全文
    assert.equal(map.sections[0]!.offset, 0);
    const last = map.sections[map.sections.length - 1]!;
    assert.equal(last.offset + last.chars, doc.length);
  });

  test("json：键名定位为节，offset 可回读到键名", async () => {
    const { buildContentMap } = await import("../src/external-model/content-map.js");
    const obj = {
      query: "上海房价",
      summary: "简".repeat(300),
      items: Array.from({ length: 20 }, (_, i) => ({ title: `t${i}`, body: "x".repeat(200) })),
      disclaimer: "免".repeat(250),
    };
    const text = JSON.stringify(obj);
    const map = buildContentMap(text);
    assert.equal(map.kind, "json");
    assert.ok(map.sections.some((s) => s.title === "query"));
    assert.ok(map.sections.some((s) => s.title === "items"));
    for (const s of map.sections) {
      if (s.title === "(开头)") continue;
      assert.equal(
        text.slice(s.offset, s.offset + s.title.length + 2).includes(s.title),
        true,
        `键 ${s.title} 的 offset 应落在键名字面量处`,
      );
    }
  });

  test("csv：表头节 + 行区间节", async () => {
    const { buildContentMap } = await import("../src/external-model/content-map.js");
    const rows = ["订单ID,金额,状态", ...Array.from({ length: 500 }, (_, i) => `A${i},${i * 3},已支付`)];
    const text = rows.join("\n");
    const map = buildContentMap(text);
    assert.equal(map.kind, "csv");
    assert.ok(map.sections[0]!.title.includes("表头"));
    assert.ok(map.sections.length >= 3, "500 行应切成 ≥3 个行区间节");
    assert.ok(map.sections.some((s) => s.title.includes("第 1-200 行")));
  });

  test("code：函数/类签名切节", async () => {
    const { buildContentMap } = await import("../src/external-model/content-map.js");
    const text = [
      "// 模块注释",
      "export function computePrice(base: number): number {",
      "  return base * 1.1;",
      "}",
      "",
      "export class PriceService {",
      "  refresh() {}",
      "}",
    ].join("\n");
    const map = buildContentMap(text);
    assert.equal(map.kind, "code");
    assert.ok(map.sections.some((s) => s.title.includes("computePrice")));
    assert.ok(map.sections.some((s) => s.title.includes("PriceService")));
  });

  test("text：空行分段；短文本返回空节；超限回退均匀分块", async () => {
    const { buildContentMap } = await import("../src/external-model/content-map.js");
    // 短文本：无节
    assert.equal(buildContentMap("太短").sections.length, 0);
    // 长文本多段落
    const paras = Array.from({ length: 30 }, (_, i) => `第${i}段：${"内容".repeat(150)}`);
    const text = paras.join("\n\n");
    const map = buildContentMap(text);
    assert.equal(map.kind, "text");
    assert.ok(map.sections.length >= 3);
    assert.equal(map.sections[0]!.offset, 0);
    // 巨量节回退：120 上限（用无空行长文本触发 text 分块的节超限场景较难，
    // 直接验证 uniformChunks 兜底后节数有界即可——json 大量键场景）
    const bigJson = JSON.stringify(
      Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`k${i}`, "v".repeat(50)])),
    );
    const bigMap = buildContentMap(bigJson);
    assert.ok(bigMap.sections.length <= 120, "节数应有界（≤120）");
  });
});

// ---------- scoreSections / resolveQueryWindow ----------

describe("query 定向跳转打分", () => {
  const makeDoc = (): string => {
    const parts: string[] = ["产品说明文档。"];
    parts.push("## 价格政策");
    parts.push(`价格：基础版 99 元/月，专业版 299 元/月。${"价".repeat(500)}`);
    parts.push("## 售后条款");
    parts.push(`售后：一年质保，人为损坏不在范围内。${"售".repeat(500)}`);
    parts.push("## 退款细则");
    parts.push(`退款：7 天无理由，15 天内收取 10% 手续费。${"退".repeat(500)}`);
    return parts.join("\n");
  };

  test("中文 query 命中目标节（退款）而非其他节", async () => {
    const { buildContentMap, resolveQueryWindow } = await import(
      "../src/external-model/content-map.js"
    );
    const doc = makeDoc();
    const map = buildContentMap(doc);
    const win = resolveQueryWindow(map, doc, "退款手续费怎么收", 500);
    assert.ok(win, "应命中窗口");
    assert.ok(win!.matchedTitles.some((t) => t.includes("退款")), "应命中退款节");
    const slice = doc.slice(win!.offset, win!.offset + win!.chars);
    assert.ok(slice.includes("10% 手续费"), "窗口应包含退款细则原文");
    assert.ok(!slice.includes("人为损坏"), "窗口不应把无关节全带进来");
  });

  test("英文 query 与无命中 query", async () => {
    const { buildContentMap, resolveQueryWindow, scoreSections } = await import(
      "../src/external-model/content-map.js"
    );
    const doc = [
      "notes",
      "## Pricing",
      `Basic costs 99 yuan per month. ${"p".repeat(400)}`,
      "## Support",
      `Warranty lasts one year. ${"s".repeat(400)}`,
    ].join("\n");
    const map = buildContentMap(doc);
    const win = resolveQueryWindow(map, doc, "pricing cost", 300);
    assert.ok(win);
    assert.ok(win!.matchedTitles.some((t) => t.toLowerCase().includes("pricing")));
    // 无命中 → null（调用方回退线性分页）
    assert.equal(resolveQueryWindow(map, doc, "完全不相关的词组", 300), null);
    assert.deepEqual(scoreSections(map, doc, ""), []);
  });
});

// ---------- renderOutline ----------

describe("renderOutline", () => {
  test("目录渲染有界且带导航声明", async () => {
    const { buildContentMap, renderOutline } = await import("../src/external-model/content-map.js");
    const doc = [
      "# 主标题",
      "## 价格政策",
      "价".repeat(300),
      "## 售后条款",
      "售".repeat(300),
    ].join("\n");
    const outline = renderOutline(buildContentMap(doc));
    assert.match(outline, /markdown/);
    assert.match(outline, /仅供导航/);
    assert.match(outline, /价格政策/);
    assert.match(outline, /售后条款/);
  });
});

// ---------- ObservationPack 集成 ----------

describe("ObservationPack WP1 集成", () => {
  test("归档自动建 map；mode=outline 返回结构目录（无正文）", async () => {
    const { ObservationPack } = await import("../src/external-model/observation-pack.js");
    const pack = new ObservationPack();
    const doc = [
      "文档引言。",
      "## 价格政策",
      `价格内容。${"价".repeat(2500)}`,
      "## 售后条款",
      `售后内容。${"售".repeat(2500)}`,
    ].join("\n");
    pack.archive("fetch_web", "call_1", doc);
    const outline = pack.recall({ id: "obs_1", mode: "outline" });
    assert.ok(outline.ok);
    assert.equal(outline.result.text, "", "outline 模式不返回正文");
    assert.equal(outline.result.kind, "markdown");
    assert.match(outline.result.outline!, /价格政策/);
    assert.match(outline.result.outline!, /仅供导航/);
  });

  test("query 定向读取：一次命中目标节窗口，matched 带节标题", async () => {
    const { ObservationPack } = await import("../src/external-model/observation-pack.js");
    const pack = new ObservationPack();
    const doc = [
      "文档引言。",
      "## 价格政策",
      `基础版 99 元/月。${"价".repeat(2500)}`,
      "## 退款细则",
      `7 天无理由退款，15 天内收 10% 手续费。${"退".repeat(2500)}`,
      "## 售后条款",
      `一年质保。${"售".repeat(2500)}`,
    ].join("\n");
    pack.archive("fetch_web", "call_1", doc);
    const hit = pack.recall({ id: "obs_1", query: "退款手续费", limit: 1200 });
    assert.ok(hit.ok);
    assert.ok(hit.result.matched!.some((t) => t.includes("退款")), "应命中退款节");
    assert.ok(hit.result.text.includes("10% 手续费"), "窗口应包含目标原文");
    assert.ok(hit.result.returnedChars <= 1200 + 3000, "窗口大小受节边界与 limit 约束");
    assert.notEqual(hit.result.nextOffset, 0, "窗口后仍有内容时给出续读偏移");
  });

  test("默认参数行为不变：无 query 时线性分页结果与旧版一致", async () => {
    const { ObservationPack } = await import("../src/external-model/observation-pack.js");
    const pack = new ObservationPack();
    const text = "abcdefghij".repeat(500);
    pack.archive("t", "call", text);
    const page = pack.recall({ id: "obs_1" });
    assert.ok(page.ok);
    assert.equal(page.result.offset, 0);
    assert.equal(page.result.returnedChars, 4000);
    assert.equal(page.result.text, text.slice(0, 4000));
    assert.equal(page.result.nextOffset, 4000);
    assert.equal(page.result.matched, undefined, "无 query 不应带 matched 字段");
    // 显式 offset 也走旧逻辑
    const page1 = pack.recall({ id: "obs_1", offset: 4000 });
    assert.ok(page1.ok);
    assert.equal(page1.result.text, text.slice(4000));
  });

  test("旧格式条目（无 map）安全回退：query 走线性分页，outline 报可恢复错误", async () => {
    const { ObservationPack } = await import("../src/external-model/observation-pack.js");
    const pack = new ObservationPack();
    const big = "z".repeat(2500);
    const obs = pack.archive("t", "call", big);
    assert.ok(obs);
    // 模拟旧条目：抹掉 map
    delete obs!.map;
    const fallback = pack.recall({ id: "obs_1", query: "任何词" });
    assert.ok(fallback.ok, "无 map 时 query 应回退线性分页而非报错");
    assert.equal(fallback.result.text, big.slice(0, 4000));
    assert.equal(fallback.result.matched, undefined);
    const noOutline = pack.recall({ id: "obs_1", mode: "outline" });
    assert.equal(noOutline.ok, false);
    assert.match(noOutline.error, /offset\/limit/);
  });

  test("读回提示：带 map 时给出 outline/query 定向读法", async () => {
    const { ObservationPack, buildObservationRecallHint } = await import(
      "../src/external-model/observation-pack.js"
    );
    const pack = new ObservationPack();
    const obs = pack.archive("fetch_web", "call", [
      "## 价格",
      "价".repeat(2500),
      "## 售后",
      "售".repeat(2500),
    ].join("\n"));
    assert.ok(obs);
    const hint = buildObservationRecallHint(obs!);
    assert.match(hint, /mode="outline"/);
    assert.match(hint, /query="关键词"/);
    assert.match(hint, /不要重新执行原工具/);
  });
});
