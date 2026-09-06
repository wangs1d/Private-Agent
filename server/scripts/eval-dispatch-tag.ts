/**
 * [dispatch:] 派发标签协议真机抽样（2026-09-06）。
 *
 * 这是前后台架构的第一环：前台 Flash 模型必须在回复文本里产出**格式合法**的
 * [dispatch:...] 标签。格式失败 = 派发意图丢失，只有回复恰好含"承诺话术"时
 * 才有诚实闸兜底——"我帮你看看"类表述 + 标签失败 = 任务静默丢失。
 *
 * 本脚本用真实 provider（createExternalChatProviderFromEnv）按前台人格
 * （FOREGROUND_ROLE_GUIDANCE 原文，经 systemPromptOverride 注入，与线上一致）
 * 抽样一批应答/办事消息，统计：
 *   - 派发命中率：该办事的消息是否真的带合法标签；
 *   - 格式合法率：parseDispatchTags 能否解析（JSON 体/纯文本体两种形态）；
 *   - 误派发率：纯聊天消息是否错误带标签；
 *   - 流式剥离正确性：DispatchTagStreamFilter 后用户可见文本零标签残留；
 *   - 首字延迟（TTFT）参考。
 *
 * 用法：
 *   npx tsx scripts/eval-dispatch-tag.ts                # 默认用例集抽样
 *   npx tsx scripts/eval-dispatch-tag.ts --times 3      # 每条消息抽 3 次
 *   npx tsx scripts/eval-dispatch-tag.ts --case 2       # 只跑第 2 条
 *
 * 未配置模型密钥时优雅退出（exit 0，打印 SKIP），方便挂进 CI 冒烟。
 */
import { loadServerEnv } from "../src/config/load-server-env.js";

loadServerEnv();

if (!process.env.OPENAI_API_KEY && !process.env.MOONSHOT_API_KEY && !process.env.ANTHROPIC_API_KEY) {
  console.log("SKIP: 未配置模型密钥（OPENAI_API_KEY / MOONSHOT_API_KEY），跳过真机抽样。");
  process.exit(0);
}

import { performance } from "node:perf_hooks";
import { createExternalChatProviderFromEnv } from "../src/external-model/index.js";
import { FOREGROUND_ROLE_GUIDANCE } from "../src/services/agent-core.js";
import { DispatchTagStreamFilter, parseDispatchTags, stripDispatchTags } from "../src/agent/dispatch-tag.js";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}
const TIMES = Math.max(1, Number(arg("times", "2")));
const ONLY_CASE = process.argv.includes("--case") ? Number(arg("case", "-1")) : null;

type SampleCase = {
  text: string;
  /** 期望：dispatch=应派发（≥1 个合法标签）；chat=纯对话（零标签） */
  expect: "dispatch" | "chat";
};

const CASES: SampleCase[] = [
  { text: "帮我查一下比特币现在什么价", expect: "dispatch" },
  { text: "明天早上九点提醒我开会", expect: "dispatch" },
  { text: "找几张猫的照片给我看看", expect: "dispatch" },
  { text: "看看我现在在哪个城市", expect: "dispatch" },
  { text: "搜一下今天有什么热搜", expect: "dispatch" },
  { text: "在吗", expect: "chat" },
  { text: "你觉得养猫好还是养狗好", expect: "chat" },
  { text: "今天累瘫了", expect: "chat" },
  { text: "哈哈哈哈笑死我了", expect: "chat" },
];

type RunResult = {
  caseIdx: number;
  text: string;
  expect: "dispatch" | "chat";
  full: string;
  visible: string;
  tags: number;
  malformedTag: boolean;
  visibleResidue: boolean;
  emptyAck: boolean;
  ttftMs: number;
  totalMs: number;
};

async function runOnce(
  provider: NonNullable<ReturnType<typeof createExternalChatProviderFromEnv>>,
  sessionId: string,
  text: string,
): Promise<RunResult> {
  let full = "";
  let visible = "";
  const filter = new DispatchTagStreamFilter();
  let ttftMs = -1;
  const t0 = performance.now();
  const raw = await provider.streamCompletion(
    sessionId,
    { text },
    (delta) => {
      if (!delta) return;
      if (ttftMs < 0) ttftMs = performance.now() - t0;
      full += delta;
      visible += filter.feed(delta);
    },
    undefined,
    {
      systemPromptOverride: FOREGROUND_ROLE_GUIDANCE,
      ephemeralTurn: true,
      maxOutputTokens: 512,
    },
  );
  const tail = filter.flush();
  if (tail) visible += tail;
  const finalText = (raw ?? full).trim();
  const tags = parseDispatchTags(finalText);
  const malformedTag =
    /\[dispatch:(?![^{]*\{)[^\]]*\]/.test(finalText) || // [dispatch:xxx] 未闭合/无体
    (/\[dispatch:/.test(finalText) && tags.length === 0);
  const totalMs = performance.now() - t0;
  return {
    caseIdx: -1,
    text,
    expect: "chat",
    full: finalText,
    visible: visible.trim(),
    tags: tags.length,
    malformedTag,
    visibleResidue: /\[dispatch:/.test(visible),
    emptyAck: stripDispatchTags(finalText).trim().length === 0,
    ttftMs: ttftMs < 0 ? totalMs : ttftMs,
    totalMs,
  };
}

async function main(): Promise<void> {
  const provider = createExternalChatProviderFromEnv();
  if (!provider?.isEnabled()) {
    console.log("SKIP: provider 未启用（缺少模型密钥或 base URL），跳过真机抽样。");
    return;
  }
  console.log(`=== [dispatch:] 标签协议真机抽样（provider=${provider.id}，每例 ${TIMES} 次）===\n`);

  const results: RunResult[] = [];
  for (let ci = 0; ci < CASES.length; ci++) {
    if (ONLY_CASE != null && ci !== ONLY_CASE) continue;
    const c = CASES[ci]!;
    for (let t = 0; t < TIMES; t++) {
      const r = await runOnce(provider, `eval-dispatch-${ci}-${t}-${Date.now()}`, c.text);
      r.caseIdx = ci;
      r.expect = c.expect;
      results.push(r);
      const flag =
        (c.expect === "dispatch" && r.tags > 0) || (c.expect === "chat" && r.tags === 0) ? "✓" : "✗";
      console.log(
        `${flag} [${ci}] ${c.text}  → tags=${r.tags} malformed=${r.malformedTag} residue=${r.visibleResidue} emptyAck=${r.emptyAck} ttft=${r.ttftMs.toFixed(0)}ms`,
      );
      if (flag === "✗" || r.malformedTag) {
        console.log(`   原文: ${r.full.slice(0, 160).replace(/\n/g, "\\n")}`);
      }
    }
  }

  if (results.length === 0) return;
  const dispatchCases = results.filter((r) => r.expect === "dispatch");
  const chatCases = results.filter((r) => r.expect === "chat");
  const hit = dispatchCases.filter((r) => r.tags > 0).length;
  const falsePositives = chatCases.filter((r) => r.tags > 0).length;
  const malformed = results.filter((r) => r.malformedTag).length;
  const residue = results.filter((r) => r.visibleResidue).length;
  const emptyAck = dispatchCases.filter((r) => r.emptyAck).length;
  const ttfts = results.map((r) => r.ttftMs).sort((a, b) => a - b);

  console.log("\n=== 汇总 ===");
  console.log(`派发命中率 : ${hit}/${dispatchCases.length}（${((hit / dispatchCases.length) * 100).toFixed(0)}%）——该办事的消息带合法标签`);
  console.log(`误派发率   : ${falsePositives}/${chatCases.length}（纯聊天错误带标签）`);
  console.log(`格式失败   : ${malformed}/${results.length}（[dispatch: 语法坏/未闭合）`);
  console.log(`流式残留   : ${residue}/${results.length}（用户可见文本带标签=流式剥离 bug）`);
  console.log(`空 ack     : ${emptyAck}/${dispatchCases.length}（派发了但没对用户说话）`);
  console.log(`TTFT 中位  : ${ttfts[Math.floor(ttfts.length / 2)]?.toFixed(0)}ms`);

  console.log("\n判定基线（前后台架构上线建议值）：");
  console.log(`  派发命中率 ≥ 90% | 误派发率 ≤ 10% | 格式失败 ≤ 5% | 流式残留 = 0`);
  const pass =
    hit / dispatchCases.length >= 0.9 &&
    falsePositives / Math.max(1, chatCases.length) <= 0.1 &&
    malformed / results.length <= 0.05 &&
    residue === 0;
  console.log(pass ? "\nPASS" : "\nNEEDS-ATTENTION（超出基线，优先看格式失败的原文样本）");
  if (!pass) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
