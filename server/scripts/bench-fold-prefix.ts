/**
 * B2 前后对比测量：旧折叠逻辑（git HEAD：合并折叠、每次重写）vs 新逻辑
 * （逐链冻结、append-only）对多波任务 replan 请求的「前缀可缓存长度」影响。
 *
 * 前缀可缓存长度 = 相邻两次 LLM 请求 messages 的最长公共前缀（JSON 字节计）
 * ——这是 DeepSeek/OpenAI prefix cache 能命中多少 token 的直接上限；
 * 未命中部分每波全价重付。
 */
import { foldOldWaveToolChains } from "../src/external-model/openai-compatible-tool-loop.js";

/* ---------- 旧逻辑复刻（git HEAD 版 openai-compatible-tool-loop.ts） ---------- */
const OLD_DIGEST = 160;
function oldTruncate(raw: string, maxChars: number): string {
  if (raw.length <= maxChars) return raw;
  const cut = raw.slice(0, maxChars);
  const urlMatch = cut.match(/https?:\/\/\S*$/);
  if (urlMatch && urlMatch[0].length >= 10) {
    const tail = raw.slice(maxChars).match(/^[^\s"',)}\]]*/);
    if (tail && tail[0].length > 0) return cut + tail[0] + "…";
  }
  return cut + "…";
}
function foldOldLogic(msgs: any[]): any[] {
  const isTool = (m: any) => m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0;
  const starts: number[] = [];
  for (let i = 0; i < msgs.length; i++) if (isTool(msgs[i])) starts.push(i);
  if (starts.length <= 1) return msgs;
  const keepFrom = starts[starts.length - 1];
  const out: any[] = [];
  let folded: string[] = [];
  const flush = () => {
    if (folded.length === 0) return;
    out.push({ role: "user", content: "【历史工具结果摘要（早于当前规划轮，供参考）】\n" + folded.join("") });
    folded = [];
  };
  let i = 0;
  while (i < msgs.length) {
    const m = msgs[i];
    if (!isTool(m)) { out.push(m); i += 1; continue; }
    const chain = [m];
    let j = i + 1;
    while (j < msgs.length && msgs[j].role === "tool") { chain.push(msgs[j]); j += 1; }
    if (i >= keepFrom) { flush(); out.push(...chain); }
    else {
      const names = (m.tool_calls ?? []).map((c: any) => c.function?.name ?? "?").join("/");
      for (const tm of chain.slice(1)) {
        const raw = typeof tm.content === "string" ? tm.content : JSON.stringify(tm.content ?? "");
        folded.push(`- ${names}[结果]: ${oldTruncate(raw, OLD_DIGEST)}`);
      }
    }
    i = j;
  }
  flush();
  return out;
}

/* ---------- 构造真实规模的 5 波任务历史 ---------- */
const base: any[] = [
  { role: "system", content: "You are a helpful assistant. ".repeat(60) },
  { role: "user", content: "帮我调研最近新能源车市场行情，对比热门车型，再看看上海政策。" },
  { role: "assistant", content: "好的，我分几步查：大盘行情、热门车型、深度报告、上海政策，最后汇总。" },
];
const mk = (id: string, name: string, args: string, body: string) => ([
  { role: "assistant", content: "", tool_calls: [{ id, type: "function", function: { name, arguments: args } }] },
  { role: "tool", tool_call_id: id, content: body },
]);
const noise = "snippet: 新能源汽车市场八月销量同比增长…";
const chains = [
  mk("c1", "search_web", '{"query":"新能源车 8月销量"}',
    JSON.stringify({ results: Array.from({ length: 6 }, (_, i) => ({ title: `结果${i}`, snippet: noise.repeat(15).slice(0, 300 + i * 100), url: `https://example.com/news/${i}` })) })),
  mk("c2", "fetch_web", '{"url":"https://example.com/deep-report"}', "深度报告正文。".repeat(260)),
  mk("c3", "search_web", '{"query":"上海 新能源 补贴政策"}',
    JSON.stringify({ results: Array.from({ length: 4 }, (_, i) => ({ title: `政策${i}`, snippet: noise.repeat(12).slice(0, 250), url: `https://gov.example/${i}` })) })),
  mk("c4", "deep_search", '{"query":"新能源车 横评 对比"}', "横评正文数据。".repeat(200)),
  mk("c5", "fetch_web", '{"url":"https://gov.example/policy-detail"}', "政策细则正文。".repeat(180)),
];

const bytes = (msgs: any[]) => JSON.stringify(msgs).length;
function commonPrefixBytes(a: any[], b: any[]): number {
  let total = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const sa = JSON.stringify(a[i]);
    const sb = JSON.stringify(b[i]);
    if (sa !== sb) break;
    total += sa.length;
  }
  return total;
}

/* ---------- 自校验：折叠必须真的生效 ---------- */
const sanity = foldOldWaveToolChains([...base, ...chains[0], ...chains[1]]);
if (sanity.length !== base.length + 1 + chains[1].length) {
  throw new Error(`自校验失败：3 条消息预期 ${base.length + 1 + chains[1].length} 条，实际 ${sanity.length} 条`);
}

console.log(`多波任务 replan：每行 = 本波请求 vs 上一波请求 的前缀缓存命中情况\n`);
let totals: Record<string, { miss: number; req: number }> = {};
for (const [label, fold] of [["旧(合并折叠,每次重写)", foldOldLogic], ["新(逐链冻结,append-only)", (m: any[]) => foldOldWaveToolChains(m)]] as const) {
  console.log(`[${label}]`);
  let prev = fold([...base, ...chains[0]]);
  let missSum = 0, reqSum = 0;
  for (let w = 1; w < chains.length; w++) {
    const cur = fold([...base, ...chains.slice(0, w + 1).flat()]);
    const req = bytes(cur);
    const hit = commonPrefixBytes(cur, prev);
    const miss = req - hit;
    missSum += miss; reqSum += req;
    console.log(`  wave${w + 1}: 请求 ${(req / 1024).toFixed(1)} KB ｜ 可命中前缀 ${(hit / 1024).toFixed(1)} KB (${((hit / req) * 100).toFixed(0)}%) ｜ 全价重付 ${(miss / 1024).toFixed(1)} KB`);
    prev = cur;
  }
  totals[label] = { miss: missSum, req: reqSum };
  console.log(`  合计: ${chains.length - 1} 次 replan 请求 ${((reqSum) / 1024).toFixed(1)} KB，其中全价重付 ${(missSum / 1024).toFixed(1)} KB\n`);
}
const oldT = totals["旧(合并折叠,每次重写)"];
const newT = totals["新(逐链冻结,append-only)"];
console.log(`==> replan 阶段全价重付字节：旧 ${(oldT.miss / 1024).toFixed(1)} KB → 新 ${(newT.miss / 1024).toFixed(1)} KB（降低 ${(((oldT.miss - newT.miss) / oldT.miss) * 100).toFixed(0)}%）`);
