/**
 * slang-lexicon 语料管线（2026-10-06 方案 D 后补，手动触发）：
 *
 *   抖音热榜（官方公开接口，无登录态）+ web 搜索热梗盘点页
 *     → LLM 按「管家+熟人」人设过滤打分（拒低俗/圈层黑话/纯事件热点/将过气）
 *     → 入库 data/slang-lexicon.json（词条+例句+来源+入库日期）
 *     → 同时对存量 active 词条做过气判定（明显过气才降级 retired，渲染层不再出）
 *
 * 注入层零改动：chat-voice-baseline 的语气词行读 active 词条，词条换了语癖就换了。
 *
 * 用法：
 *   npx tsx scripts/refresh-slang-lexicon.ts            # dry-run，只打印建议
 *   npx tsx scripts/refresh-slang-lexicon.ts --apply    # 真写库（先备份原文件）
 *   npx tsx scripts/refresh-slang-lexicon.ts --apply --limit=3
 */
import "dotenv/config";
import { loadServerEnv } from "../src/config/load-server-env.js";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

loadServerEnv();

const APPLY = process.argv.includes("--apply");
const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const NEW_LIMIT = Number.parseInt(limitArg?.slice(8) ?? "4", 10) || 4;

const LEXICON_PATH =
  process.env.SLANG_LEXICON_PATH ?? join(process.cwd(), "data", "slang-lexicon.json");

type SlangEntry = { term: string; tier: "active" | "retired"; note: string; example: string; addedAt?: string; source?: string };
type SlangLexicon = { meta: { note: string; updatedAt: string; nextReview: string }; entries: SlangEntry[] };
type LlmVerdict = { new: Array<{ term: string; note: string; example: string; source: string }>; retire: Array<{ term: string; reason: string }> };

// ── 1. 采集：抖音热榜直连 + web 盘点页 ─────────────────────────────

async function collectCandidates(): Promise<{ douyinWords: string[]; reviewChunks: string[] }> {
  const { InfoHubService } = await import("../src/services/info-hub-service.js");
  const { UpstreamSearchService } = await import("../src/services/upstream-search-service.js");
  const upstream = new UpstreamSearchService(new InfoHubService());

  // 抖音官方热榜（服务内已带可用请求头的 fetchText 直连）
  let douyinWords: string[] = [];
  try {
    const hot = await upstream.fetchDouyinHotSearch(40);
    douyinWords = hot.map((it) => it.title.replace(/^#/, "").trim()).filter(Boolean);
  } catch {
    /* 热榜失败不阻塞，盘点页是兜底 */
  }

  const queries = ["抖音热梗盘点 流行语", "最近抖音火的话 热梗"];
  const reviewChunks: string[] = [];
  for (const q of queries) {
    try {
      const r = await upstream.searchWeb(q, 8);
      const text = (r?.items ?? [])
        .map((it) => `「${it.title ?? ""}」${it.snippet ?? ""}`.trim())
        .filter((t) => t.length > 4)
        .join("\n");
      if (text) reviewChunks.push(`【检索：${q}】\n${text.slice(0, 2400)}`);
    } catch {
      /* 单路检索失败不阻塞 */
    }
  }
  return { douyinWords, reviewChunks };
}

// ── 2. LLM 过滤打分 ────────────────────────────────────────────────

function buildJudgePrompt(current: SlangEntry[], douyinWords: string[], reviewChunks: string[]): string {
  const lines = [
    "你在给一个「私人管家兼熟人朋友」人设的 AI 维护网络用语语癖包。语癖的要求：",
    "- 只收泛用型口语词/句式（微信聊天能自然用的），贴「管家+熟人」人设",
    "- 拒绝：低俗、圈层黑话（饭圈/缩写/抽象话）、纯事件热点（具体新闻/人物/作品名）、明显已过气的",
    "- 例句必须是微信语感的一句家常话，15 字左右，不解释词义",
    "",
    `现有 active 词条：${current.filter((e) => e.tier === "active").map((e) => e.term).join("、") || "（无）"}`,
    "",
    "候选材料一（抖音热榜实时话题词，多为事件词，只有其中像口语梗的才值得收）：",
    douyinWords.slice(0, 40).map((w) => `- ${w}`).join("\n") || "（获取失败）",
  ];
  if (reviewChunks.length > 0) {
    lines.push("", "候选材料二（热梗盘点页检索摘要）：", ...reviewChunks.map((c) => c.slice(0, 2000)));
  }
  lines.push(
    "",
    "任务：",
    `1) 从候选里挑最多 ${NEW_LIMIT} 个新词条（宁缺毋滥，没有合适的就给空数组；不与现有重复）`,
    "2) 逐个判定现有 active 词条是否已经过气/变味——只有明确过气才进 retire，拿不准的不动",
    "",
    "只输出 JSON，不要任何解释：",
    '{"new":[{"term":"词条","note":"什么场合用","example":"微信语感例句","source":"douyin-hot|review"}],"retire":[{"term":"旧词条","reason":"一句话"}]}',
  );
  return lines.join("\n");
}

/** 从 LLM 输出里提取 JSON：优先首个括号平衡的完整对象；截断则按未闭合栈补齐修复。 */
function extractJson(raw: string): string | null {
  const start = raw.indexOf("{");
  if (start < 0) return null;
  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{" || ch === "[") stack.push(ch === "{" ? "}" : "]");
    else if (ch === "}" || ch === "]") stack.pop();
    if (!inStr && stack.length === 0) {
      const candidate = raw.slice(start, i + 1);
      try {
        JSON.parse(candidate);
        return candidate;
      } catch {
        /* 该平衡段不是合法 JSON（可能含未转义引号），继续扫 */
      }
    }
  }
  let repaired = raw.slice(start);
  if (inStr) repaired += '"';
  while (stack.length > 0) repaired += stack.pop();
  try {
    JSON.parse(repaired);
    return repaired;
  } catch {
    return null;
  }
}

async function judgeWithLlm(prompt: string): Promise<LlmVerdict | null> {
  const { createExternalChatProviderFromEnv } = await import("../src/external-model/resolve-provider.js");
  const provider = createExternalChatProviderFromEnv();
  if (!provider?.isEnabled()) {
    console.error("[slang-refresh] 外部模型 provider 未启用，无法跑 LLM 过滤");
    return null;
  }
  // 上游偶发空回/截断：最多重试 2 次（每次换 sessionId 避开同前缀缓存）
  let lastRaw = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const sessionId = `slang-refresh-${Date.now()}-${attempt}`;
    let raw = "";
    await provider.streamCompletion(
      sessionId,
      { text: prompt },
      (delta: string) => { raw += delta; },
      undefined,
      // maxOutputTokens 显式放宽：默认上限会把 JSON 截断在半截
      { ephemeralTurn: true, disableThinking: true, maxThreadMessages: 0, maxOutputTokens: 1024 } as never,
    );
    provider.clearSession?.(sessionId);
    lastRaw = raw;
    const verdict = parseVerdict(raw);
    if (verdict) return verdict;
    console.warn(`[slang-refresh] 第 ${attempt} 次 LLM 输出不可用（${raw.length} 字符），重试…`);
  }
  console.error("[slang-refresh] LLM 原始输出：", lastRaw.slice(0, 600));
  return null;
}

function parseVerdict(raw: string): LlmVerdict | null {
  const jsonText = extractJson(raw);
  if (!jsonText) return null;
  try {
    const parsed = JSON.parse(jsonText) as LlmVerdict;
    return {
      new: Array.isArray(parsed.new) ? parsed.new.filter((x) => x?.term && x?.example && x?.note) : [],
      retire: Array.isArray(parsed.retire) ? parsed.retire.filter((x) => x?.term) : [],
    };
  } catch (err) {
    console.error("[slang-refresh] LLM 原始输出（JSON 解析失败）：", jsonText.slice(0, 800), "→", err instanceof Error ? err.message : err);
    return null;
  }
}

// ── 3. 合并写库 ────────────────────────────────────────────────────

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function plusDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  const lex: SlangLexicon = existsSync(LEXICON_PATH)
    ? (JSON.parse(readFileSync(LEXICON_PATH, "utf8")) as SlangLexicon)
    : { meta: { note: "", updatedAt: today(), nextReview: plusDays(14) }, entries: [] };

  console.log("[slang-refresh] 采集候选：抖音热榜 + web 盘点页…");
  const { douyinWords, reviewChunks } = await collectCandidates();
  console.log(`  抖音热榜词：${douyinWords.length} 条；盘点摘要：${reviewChunks.length} 路`);
  if (douyinWords.length === 0 && reviewChunks.length === 0) {
    console.error("[slang-refresh] 两路候选全空（网络/接口不可用），不写库");
    process.exit(1);
  }

  console.log("[slang-refresh] LLM 过滤打分…");
  const verdict = await judgeWithLlm(buildJudgePrompt(lex.entries ?? [], douyinWords, reviewChunks));
  if (!verdict) {
    console.error("[slang-refresh] LLM 输出解析失败，不写库");
    process.exit(1);
  }

  const retireSet = new Map(verdict.retire.map((r) => [r.term, r.reason]));
  const existingTerms = new Set((lex.entries ?? []).map((e) => e.term));
  const fresh = verdict.new
    .filter((n) => !existingTerms.has(n.term))
    .slice(0, NEW_LIMIT)
    .map<SlangEntry>((n) => ({
      term: n.term.trim(),
      tier: "active",
      note: n.note.trim(),
      example: n.example.trim(),
      addedAt: today(),
      source: n.source === "douyin-hot" ? "douyin-hot" : "review",
    }));

  console.log("\n══ 刷新建议 ══");
  console.log(`新增 ${fresh.length} 条：`);
  for (const f of fresh) console.log(`  + ${f.term}（${f.note}｜例：${f.example}｜源：${f.source}）`);
  console.log(`降级 ${retireSet.size} 条：`);
  for (const [term, reason] of retireSet) console.log(`  - ${term}：${reason}`);

  if (!APPLY) {
    console.log("\n[dry-run] 未写库。确认无误后加 --apply 落库。");
    return;
  }

  const backupPath = LEXICON_PATH.replace(/\.json$/, `.backup-${today()}.json`);
  if (existsSync(LEXICON_PATH)) copyFileSync(LEXICON_PATH, backupPath);
  const activeCount = (lex.entries ?? []).filter((e) => e.tier === "active" && !retireSet.has(e.term)).length + fresh.length;
  const merged: SlangLexicon = {
    meta: {
      note: `网络用语语癖包。来源：语料管线（抖音热榜+web盘点 → LLM 过滤）；首批 10 条人工。铁律在人格块：一轮最多一个梗、合适才用、正事零梗。active 上限 16，当前 ${activeCount}。`,
      updatedAt: today(),
      nextReview: plusDays(14),
    },
    entries: [
      ...(lex.entries ?? []).map<SlangEntry>((e) =>
        retireSet.has(e.term) ? { ...e, tier: "retired" } : e,
      ),
      ...fresh,
    ],
  };
  writeFileSync(LEXICON_PATH, JSON.stringify(merged, null, 2), "utf8");
  console.log(`\n[apply] 已写库 → ${LEXICON_PATH}（备份：${backupPath}）。渲染层 60s 缓存到期后自动生效。`);
}

main().catch((err) => {
  console.error("[slang-refresh] 管线异常", err);
  process.exit(1);
});
