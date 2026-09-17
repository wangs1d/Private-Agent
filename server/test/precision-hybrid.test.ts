/**
 * 定向读取精确度优化测试（WP1.1）：覆盖度加权 + 标题/正文分离计分 + 语义混合。
 *
 * 覆盖：
 *  - 词面修复回归：标题/表头小节不得靠标题词反超真证据节（CSV 表头 vs 数据行）
 *  - 语义混合：SemanticHint 注入后，零词面重叠的同义 query 命中目标节
 *  - ObservationPack：注入 mock embedder → 归档异步富集节向量 → recall 融合命中；
 *    无向量时词面兜底；alternatives / lowConfidence 字段
 *  - 防幻觉不变量：无任何候选（词面+语义全零）时正确拒绝（返回 null）
 */
import assert from "node:assert/strict";
import { describe, test, afterEach } from "node:test";

import {
  buildContentMap,
  resolveQueryWindow,
  scoreSectionsDetailed,
  type SemanticHint,
} from "../src/external-model/content-map.js";
import {
  ObservationPack,
  setObservationEmbedder,
  embedObsQuery,
} from "../src/external-model/observation-pack.js";

function makeCsvDoc(): string {
  const rows = ["航班号,出发,到达,状态"];
  for (let i = 1; i <= 600; i++) {
    rows.push(i === 540 ? "MU5137,上海浦东,法兰克福,延误 2 小时" : `CZ${1000 + i},城市${i},城市${(i % 40) + 1},正常`);
  }
  return rows.join("\n");
}

describe("词面精确度修复（覆盖度加权 + 标题/正文分离）", () => {
  test("CSV 表头节不得反超含目标数据的数据行节", () => {
    const doc = makeCsvDoc();
    const map = buildContentMap(doc);
    const ranked = scoreSectionsDetailed(map, doc, "去法兰克福的航班");
    assert.ok(ranked.length > 0);
    assert.equal(ranked[0]!.section.title, "第 401-600 行", "含 MU5137 的行区节应排名第一");
    const win = resolveQueryWindow(map, doc, "去法兰克福的航班", 1200)!;
    assert.ok(doc.slice(win.offset, win.offset + win.chars).includes("MU5137"));
  });

  test("零词面重叠的行号口语查询正确拒绝（回退线性分页兜底）", () => {
    const doc = makeCsvDoc();
    const map = buildContentMap(doc);
    // 生成器中第 540 行已被 MU5137 行替换，"540" 与文档零词面重叠 → 应拒绝而非硬凑窗口
    assert.equal(resolveQueryWindow(map, doc, "540 行什么情况", 1200), null);
  });

  test("markdown 标题节的标题证据仍有效（正文+标题共同命中）", async () => {
    const { buildContentMap: b, resolveQueryWindow: r } = await import("../src/external-model/content-map.js");
    const doc = [
      "# 服务条款",
      "## 退款政策",
      `退款规则：7 天内全额退款。${"退".repeat(600)}`,
      "## 联系方式",
      `客服热线 400-000-0000。${"联".repeat(600)}`,
    ].join("\n");
    const win = r(b(doc), doc, "退款手续费怎么算", 1200)!;
    assert.ok(doc.slice(win.offset, win.offset + win.chars).includes("全额退款"));
  });
});

/** mock 同义词嵌入：概念词典 → 独热向量（演示融合管线；真实语义能力取决于 embedding 端点）。 */
const CONCEPT_DIMS: Array<[string, string[]]> = [
  ["refund", ["退款", "退钱", "退货", "后悔"]],
  ["contact", ["客服", "电话", "热线", "联系"]],
  ["housing-fund", ["公积金", "住房资金", "买房"]],
  ["budget", ["预算", "经费", "花钱", "财务"]],
  ["flight", ["航班", "延误", "法兰克福"]],
];
const DIM_INDEX = new Map(CONCEPT_DIMS.map(([name], i) => [name, i]));
const WORD_TO_DIM = new Map<string, number>();
for (const [name, words] of CONCEPT_DIMS) {
  for (const w of words) WORD_TO_DIM.set(w, DIM_INDEX.get(name)!);
}

function mockEmbed(text: string): Float32Array {
  const vec = new Float32Array(CONCEPT_DIMS.length);
  for (const [word, dim] of WORD_TO_DIM) {
    if (text.includes(word)) vec[dim] = 1;
  }
  return vec;
}

const SEMANTIC_MD_DOC = [
  "# 服务条款",
  "## 退款政策",
  `退款规则：购买后 7 天内可无理由全额退款，超过 7 天收取 10% 手续费。${"退".repeat(1300)}`,
  "## 联系方式",
  `客服热线 400-000-0000。${"联".repeat(1300)}`,
].join("\n");

describe("语义混合打分（P1）", () => {
  afterEach(() => setObservationEmbedder(null));

  test("零词面重叠的同义 query：注入语义向量后命中目标节", () => {
    const doc = SEMANTIC_MD_DOC;
    const map = buildContentMap(doc);
    const query = "后悔了怎么办"; // 与原文零词面重叠；mock 语义 → refund 概念
    // 无语义：词面全零 → 正确拒绝
    assert.equal(resolveQueryWindow(map, doc, query, 1200), null);
    // 有语义：命中退款节
    const semantic: SemanticHint = {
      queryVector: mockEmbed(query),
      sectionVectors: map.sections.map((s) => mockEmbed(`${s.title} ${doc.slice(s.offset, s.offset + 512)}`)),
    };
    const win = resolveQueryWindow(map, doc, query, 1200, semantic)!;
    assert.ok(win, "语义命中应出窗");
    assert.ok(doc.slice(win.offset, win.offset + win.chars).includes("退款"), "窗口应落在退款节");
    assert.ok(win.matchedTitles.some((t) => t.includes("退款")));
  });

  test("词面与语义冲突时融合权重生效：强词面证据不被弱语义带偏", () => {
    const doc = SEMANTIC_MD_DOC;
    const map = buildContentMap(doc);
    const query = "退款手续费"; // 词面强命中退款节
    const sectionVectors = map.sections.map((s) => mockEmbed(`${s.title} ${doc.slice(s.offset, s.offset + 512)}`));
    // 语义故意指向联系方式节（模拟噪音语义）——不传 weight，走自适应：
    // 词面有证据（matched 3/4 ≥ 1/3）→ 语义降级为仲裁，直接证据优先
    const semantic: SemanticHint = {
      queryVector: mockEmbed("客服热线联系"),
      sectionVectors,
    };
    const win = resolveQueryWindow(map, doc, query, 1200, semantic)!;
    const slice = doc.slice(win.offset, win.offset + win.chars);
    assert.ok(slice.includes("退款"), "词面强证据应主导（自适应权重下语义单侧噪音无法压制直接证据）");
  });

  test("alternatives 提供次优候选；lowConfidence 在零证据时置位", () => {
    const doc = SEMANTIC_MD_DOC;
    const map = buildContentMap(doc);
    const win = resolveQueryWindow(map, doc, "退款手续费", 120)!;
    assert.ok(Array.isArray(win.alternatives), "应带次优候选");
    const weak = resolveQueryWindow(map, doc, "完全不相关词组表", 120);
    assert.equal(weak, null, "零命中仍正确拒绝");
  });
});

describe("ObservationPack 向量富集（P1）", () => {
  afterEach(() => setObservationEmbedder(null));

  test("注入 mock embedder：归档后台富集 → recall 带 queryVector 命中同义节", async () => {
    setObservationEmbedder(async (texts) => texts.map((t) => mockEmbed(t)));
    const pack = new ObservationPack();
    const obs = pack.archive("fetch_web", "call_1", SEMANTIC_MD_DOC);
    assert.ok(obs);
    // 等待异步富集完成
    for (let i = 0; i < 20 && !obs!.sectionVectors; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(obs!.sectionVectors, "节向量应已富集");

    const queryVector = await embedObsQuery("后悔了怎么办");
    assert.ok(queryVector, "mock embedder 应产出 query 向量");
    const hit = pack.recall({ id: "obs_1", query: "后悔了怎么办", limit: 1200, queryVector });
    assert.ok(hit.ok);
    assert.ok(hit.result.text.includes("退款"), "语义融合后窗口应落在退款节");
    assert.ok(hit.result.matched!.some((t) => t.includes("退款")));
  });

  test("无向量（未注入 embedder）时词面打分兜底，行为与优化前一致", async () => {
    setObservationEmbedder(null);
    const pack = new ObservationPack();
    pack.archive("fetch_web", "call_1", SEMANTIC_MD_DOC);
    const hit = pack.recall({ id: "obs_1", query: "退款手续费", limit: 1200 });
    assert.ok(hit.ok);
    assert.ok(hit.result.text.includes("退款"));
    assert.equal(hit.result.lowConfidence, undefined);
  });

  test("query 向量与节向量缺任一侧时不抛错（词面兜底）", async () => {
    setObservationEmbedder(async (texts) => texts.map((t) => mockEmbed(t)));
    const pack = new ObservationPack();
    pack.archive("fetch_web", "call_1", SEMANTIC_MD_DOC);
    // 未等富集完成即 recall（sectionVectors 尚缺）→ 词面路径
    const hit = pack.recall({ id: "obs_1", query: "退款手续费", limit: 1200 });
    assert.ok(hit.ok);
  });
});
