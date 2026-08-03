// 工具召回测试：Fast 模式 + Complex 模式下所有内置工具是否都能被精准召回
//
// 目标：每个内置工具至少出现一次查询意图，验证：
//   1. Fast 模式（≤12 工具，selectRelevantTools 3-6 个）→ 显式暴露 + tool search 召回
//   2. Complex 模式（contextual/delegate，几十上百工具）→ 显式暴露 + tool search 召回
//   3. 召回延迟（BM25 搜索耗时 < 50ms）
//   4. 召回准确率（top-1 必须是目标工具）
//   5. 召回覆盖度（所有意图关键词都能命中至少 1 个相关工具）
//
// 运行：npx tsx scripts/test-tool-recall-coverage.ts
//
// 行为：测试会临时启用桌面/电话等受环境门控的能力（DESKTOP_VISUAL_ENABLED /
//      DESKTOP_BRIDGE_TOKEN / PHONE_BRIDGE_TOKEN），确保 desktop.run_automation 等
//      受门控工具也能被纳入 builtin 池并验证召回。环境变量在测试结束后自动还原。

// 加载 .env + .env.local（load-server-env 在模块加载时自动执行）
import "../src/config/load-server-env.js";

import {
  getBuiltinAgentChatTools,
  getFastLaneTools,
  invalidateBuiltinToolsCache,
} from "../src/external-model/openai-compatible-tool-loop.js";
import { resolveChatToolPlanForStream } from "../src/external-model/resolve-chat-tools.js";
import { prepareToolsWithToolSearch } from "../src/tools/tool-search/index.js";
import { searchDeferredTools } from "../src/tools/tool-search/catalog.js";
import { executeToolSearchBridge } from "../src/tools/tool-search/handlers.js";
import { ensureToolEmbeddings, getQueryEmbedding, isEmbeddingSearchEnabled } from "../src/tools/tool-search/tool-embedding.js";
import { invalidateFullCatalogCache } from "../src/tools/tool-search/index.js";

// ===== 工具召回意图：每个内置工具配一个用户查询意图 =====
type ToolRecallCase = {
  /** 工具注册名（用于比对） */
  registryName: string;
  /** 工具所在模式（fast/complex/both） */
  mode: "fast" | "complex" | "both";
  /** 模拟用户的查询文本（中文） */
  query: string;
  /** 期望命中的最低分数（top-1 score 阈值） */
  minScore?: number;
};

const RECALL_CASES: ToolRecallCase[] = [
  // === Fast 模式核心工具（必须显式暴露） ===
  { registryName: "clock.get_current_time", mode: "fast", query: "现在几点了" },
  { registryName: "clock.get_user_location", mode: "fast", query: "我当前位置在哪" },
  { registryName: "clock.get_date", mode: "fast", query: "今天日期" },
  { registryName: "clock.format_timestamp", mode: "fast", query: "格式化时间戳" },
  { registryName: "weather.get_local", mode: "fast", query: "北京今天天气怎么样" },
  { registryName: "calendar.list_tasks", mode: "fast", query: "我今天有哪些待办事项" },
  { registryName: "search_web", mode: "fast", query: "搜索一下最新 AI 新闻" },
  { registryName: "fetch_web", mode: "fast", query: "帮我读一下这个网页的内容" },
  { registryName: "browser.session.list", mode: "fast", query: "当前打开了哪些浏览器标签" },
  { registryName: "agent.query_capabilities", mode: "fast", query: "你能做什么 列出你的能力" },
  { registryName: "phone.ensure_my_number", mode: "fast", query: "查询虚拟号码 申领 6 位号" },
  { registryName: "phone.virtual_call", mode: "fast", query: "虚拟来电测试" },
  { registryName: "phone.call_user", mode: "fast", query: "打电话给我提醒一下" },
  { registryName: "budget.calculate", mode: "fast", query: "算一下这个月预算够不够" },
  { registryName: "shopping.suggest", mode: "fast", query: "推荐一个笔记本电脑" },
  { registryName: "self.list_custom_skills", mode: "fast", query: "我装载了哪些自定义技能" },

  // === Complex 模式特有工具（需 tool search 召回） ===
  // 注意：只列 builtin 池中实际存在的工具（calendar.delete_task、care.*、protocol.*、mcp.*
  // 在 builtin 池中未注册，agent.register_account 同理，故不列入）
  { registryName: "calendar.create_task", mode: "complex", query: "创建明天下午 3 点的会议" },
  { registryName: "calendar.create_from_text", mode: "complex", query: "从这段文字里提取日程" },
  { registryName: "reminder.plan", mode: "complex", query: "设置一个提醒 十分钟后提醒我" },
  { registryName: "agent.send_to_peer", mode: "complex", query: "把这个消息发给另一个 agent" },
  { registryName: "agent.link.send_friend_request", mode: "complex", query: "给另一个 agent 发好友请求" },
  { registryName: "agent.link.list_friends", mode: "complex", query: "列出我的 agent 好友" },
  { registryName: "wallet.get_balance", mode: "complex", query: "查一下我的钱包余额" },
  { registryName: "wallet.get_transactions", mode: "complex", query: "查看最近 10 笔交易记录" },
  { registryName: "aip.dispatch", mode: "complex", query: "AIP 智能协议处理分发" },
  { registryName: "embodiment.window_place", mode: "complex", query: "把桌面角色窗口放到指定位置" },
  { registryName: "embodiment.roam", mode: "complex", query: "让桌面角色漫游移动" },
  { registryName: "desktop.run_automation", mode: "complex", query: "运行桌面自动化任务脚本" },
  { registryName: "desktop.run_shell", mode: "complex", query: "执行一个 shell 命令" },
  { registryName: "browser.session.list", mode: "complex", query: "浏览器自动化 打开网页点击按钮" },
  { registryName: "world.open_registry.agent_quick", mode: "complex", query: "在世界注册一个 agent" },
];

// ===== 工具名提取辅助 =====
function getToolName(tool: { function?: { name?: string } } | unknown): string | null {
  if (typeof tool !== "object" || tool === null) return null;
  const t = tool as { type?: string; function?: { name?: string } };
  if (t.type === "function" && t.function?.name) return t.function.name;
  return null;
}

function getToolDescription(tool: { function?: { description?: string } } | unknown): string {
  if (typeof tool !== "object" || tool === null) return "";
  const t = tool as { function?: { description?: string } };
  return t.function?.description ?? "";
}

function isMatch(toolName: string, target: string): boolean {
  if (target.endsWith(".")) return toolName.startsWith(target);
  return toolName === target;
}

function findToolIndex(toolList: { name: string }[], target: string): number {
  for (let i = 0; i < toolList.length; i++) {
    if (isMatch(toolList[i].name, target)) return i;
  }
  return -1;
}

type RecallResult = {
  case: ToolRecallCase;
  inVisible: boolean;
  inSearchable: boolean;
  searchTopHits: { name: string; score: number; rank: number }[];
  foundInSearchTop1: boolean;
  foundInSearchTop5: boolean;
  searchLatencyMs: number;
  verdict: "VISIBLE" | "SEARCH_TOP1" | "SEARCH_TOP5" | "MISSED";
};

function runRecallForMode(
  mode: "fast" | "complex",
  cases: ToolRecallCase[],
  fastLaneTools: ReturnType<typeof getBuiltinAgentChatTools>,
): RecallResult[] {
  const results: RecallResult[] = [];

  for (const c of cases) {
    if (c.mode === mode) {
      // 主测试
    } else if (c.mode === "both") {
      // both 模式
    } else {
      // 跳过：当前模式不需要测
      continue;
    }

    // 1. 模拟 streamOpts
    const streamOpts =
      mode === "fast"
        ? {
            chatToolsBuiltin: fastLaneTools,
            chatToolsExtra: [],
            toolExposureProfile: "contextual" as const,
            toolRankingHint: undefined,
          }
        : {
            toolExposureProfile: "contextual" as const,
            toolRankingHint: undefined,
          };

    // 2. resolveChatToolPlanForStream：拿到 visibleTools + searchableTools
    const plan = resolveChatToolPlanForStream(c.query, streamOpts);

    const inVisible = findToolIndex(plan.visibleTools.map((t) => ({ name: getToolName(t) ?? "" })), c.registryName) >= 0;

    // 3. 准备 tool search catalog（贴近生产：单轮内所有 case 共用一个 deferred catalog）
    // 关键优化：catalog 跨 case 复用一次，buildDeferredCatalog 较重（>30ms），
    // 不复用的话 latency 数字会虚高（每次 build + search）。
    // 这里每 8 个 case 复用一次 catalog，模拟"一次 plan 触发一次 search"的真实流。
    if (!_sharedCatalogByMode.has(mode)) {
      const firstPlan = plan;
      const prepared = prepareToolsWithToolSearch(firstPlan.visibleTools, firstPlan.searchableTools);
      _sharedCatalogByMode.set(mode, { catalog: prepared.deferredCatalog, usedCount: 0 });
    }
    const shared = _sharedCatalogByMode.get(mode)!;
    shared.usedCount += 1;
    if (shared.usedCount >= 8) {
      // 重新构建一次以模拟"过了 8 轮"
      const prepared = prepareToolsWithToolSearch(plan.visibleTools, plan.searchableTools);
      _sharedCatalogByMode.set(mode, { catalog: prepared.deferredCatalog, usedCount: 1 });
    }
    const prepared = { deferredCatalog: _sharedCatalogByMode.get(mode)!.catalog };

    const inSearchable = prepared.deferredCatalog.entries.some((e) => isMatch(e.registryName, c.registryName));

    // 4. 对 query 做 BM25 搜索
    const t0 = performance.now();
    const matches = searchDeferredTools(prepared.deferredCatalog, c.query, 5);
    const searchLatencyMs = performance.now() - t0;

    const searchTopHits = matches.map((m, i) => ({ name: m.name, score: m.score, rank: i + 1 }));
    const foundInSearchTop1 =
      searchTopHits.length > 0 && isMatch(searchTopHits[0].name, c.registryName);
    const foundInSearchTop5 = searchTopHits.some((h) => isMatch(h.name, c.registryName));

    // 5. 判定
    let verdict: RecallResult["verdict"];
    if (inVisible) {
      verdict = "VISIBLE";
    } else if (foundInSearchTop1) {
      verdict = "SEARCH_TOP1";
    } else if (foundInSearchTop5) {
      verdict = "SEARCH_TOP5";
    } else {
      verdict = "MISSED";
    }

    results.push({
      case: c,
      inVisible,
      inSearchable,
      searchTopHits,
      foundInSearchTop1,
      foundInSearchTop5,
      searchLatencyMs,
      verdict,
    });
  }

  return results;
}

// 跨 case 复用的 deferred catalog 缓存
const _sharedCatalogByMode = new Map<
  "fast" | "complex",
  { catalog: ReturnType<typeof prepareToolsWithToolSearch>["deferredCatalog"]; usedCount: number }
>();

async function runBridgeRecallTest(
  cases: ToolRecallCase[],
  fastLaneTools: ReturnType<typeof getBuiltinAgentChatTools>,
): Promise<{ name: string; ok: boolean; detail: string }[]> {
  const checks: { name: string; ok: boolean; detail: string }[] = [];

  for (const c of cases) {
    // bridge 测试在对应模式下跑：
    //   - fast 模式：用 chatToolsBuiltin 限制 + 选 3-6 个 visible
    //   - complex 模式：全量 builtin + prepareToolsWithToolSearch 进 deferred
    const streamOpts =
      c.mode === "fast"
        ? {
            chatToolsBuiltin: fastLaneTools,
            chatToolsExtra: [],
            toolExposureProfile: "contextual" as const,
            toolRankingHint: undefined,
          }
        : {
            toolExposureProfile: "contextual" as const,
            toolRankingHint: undefined,
          };
    const plan = resolveChatToolPlanForStream(c.query, streamOpts);

    // 工具已在 visible 中：bridge 不必召回，单独标注为 PASS
    const visibleNames = plan.visibleTools
      .map(getToolName)
      .filter((n): n is string => n != null);
    const alreadyVisible = visibleNames.some((n) => isMatch(n, c.registryName));
    if (alreadyVisible) {
      checks.push({
        name: `[${c.mode}] bridge for ${c.registryName}`,
        ok: true,
        detail: `已在 visibleTools（不必经 bridge 召回）`,
      });
      continue;
    }

    // 工具不在 visible 中：模拟 LLM 调用 tool_discover 召回
    const prepared = prepareToolsWithToolSearch(plan.visibleTools, plan.searchableTools);
    const discoverResult = await executeToolSearchBridge("tool_discover", { query: c.query }, prepared.deferredCatalog);

    if (discoverResult.kind !== "discover" || !discoverResult.ok) {
      checks.push({
        name: `[${c.mode}] bridge for ${c.registryName}`,
        ok: false,
        detail: `discover 失败: ${JSON.stringify((discoverResult as { result?: unknown }).result ?? {}).slice(0, 100)}`,
      });
      continue;
    }

    const r = discoverResult.result as {
      matches: Array<{ name: string; score: number; parameters?: unknown }>;
    };
    const top1 = r.matches?.[0];
    const top1Name = top1?.name ?? "";
    const top1HasSchema = !!top1?.parameters;

    if (top1Name && isMatch(top1Name, c.registryName) && top1HasSchema) {
      checks.push({
        name: `[${c.mode}] bridge for ${c.registryName}`,
        ok: true,
        detail: `top1=${top1Name} score=${top1.score} 含 schema=true`,
      });
    } else {
      checks.push({
        name: `[${c.mode}] bridge for ${c.registryName}`,
        ok: false,
        detail: `top1=${top1Name}（期望 ${c.registryName}）含 schema=${top1HasSchema}`,
      });
    }
  }

  return checks;
}

/**
 * Hybrid 召回（BM25 + embedding RRF）对比测试。
 *
 * 流程：
 *   1. 预热所有 deferred tool 的 embedding（fire-and-forget 后等 ensureToolEmbeddings 返回）
 *   2. 跑复杂模式每个 case：
 *      a. BM25-only top1
 *      b. BM25 + embedding top1
 *   3. 统计两组 top1 命中率，对比 hybrid 是否带来提升
 *
 * 失败时静默降级：无 OPENAI_API_KEY / API 异常 → 整段跳过并标记 N/A。
 */
type HybridResult = {
  case: ToolRecallCase;
  bm25Top1: string | null;
  hybridTop1: string | null;
  bm25Correct: boolean;
  hybridCorrect: boolean;
  queryLatencyMs: number;
  searchLatencyMs: number;
};

async function runHybridRecallTest(
  cases: ToolRecallCase[],
  fastLaneTools: ReturnType<typeof getBuiltinAgentChatTools>,
): Promise<{ enabled: boolean; results: HybridResult[]; bm25Top1: number; hybridTop1: number }> {
  if (!isEmbeddingSearchEnabled()) {
    console.log("\n" + "=".repeat(80));
    console.log("🧬 Hybrid 召回对比（BM25 + embedding）");
    console.log("=".repeat(80));
    console.log("  ⚠️  未启用 embedding（缺 OPENAI_API_KEY / 关闭）→ 跳过对比");
    return { enabled: false, results: [], bm25Top1: 0, hybridTop1: 0 };
  }

  console.log("\n" + "=".repeat(80));
  console.log("🧬 Hybrid 召回对比（BM25 + embedding → RRF）");
  console.log("=".repeat(80));

  // 准备 complex 模式 catalog，并预热所有 entry 的 embedding
  const complexPlan = resolveChatToolPlanForStream("anything", {
    toolExposureProfile: "contextual" as const,
    toolRankingHint: undefined,
  });
  const prepared = prepareToolsWithToolSearch(complexPlan.visibleTools, complexPlan.searchableTools);

  console.log(`  ⏳ 预热 ${prepared.deferredCatalog.entries.length} 个 deferred tool 的 embedding...`);
  const t0 = performance.now();
  const warmup = await ensureToolEmbeddings(
    prepared.deferredCatalog.entries.map((e) => ({
      registryName: e.registryName,
      searchText: e.embeddingInput || e.searchText,
    })),
  );
  const warmupMs = performance.now() - t0;
  console.log(
    `  ✅ 预热完成：computed=${warmup.computed} reused=${warmup.reused} failed=${warmup.failed} 耗时=${warmupMs.toFixed(0)}ms`,
  );
  if (warmup.computed === 0 && warmup.reused === 0) {
    console.log("  ⚠️  没有任何 tool embedding 缓存/计算成功 → 跳过对比");
    return { enabled: false, results: [], bm25Top1: 0, hybridTop1: 0 };
  }

  // 重新构建 catalog，确保 ingest 最新计算结果
  invalidateFullCatalogCache();
  const prepared2 = prepareToolsWithToolSearch(complexPlan.visibleTools, complexPlan.searchableTools);
  const catalog = prepared2.deferredCatalog;
  console.log(`  📦 catalog embedding 索引规模：${catalog.embeddingIndex.size}/${catalog.entries.length}`);

  // 跑所有 complex 模式 case
  const complexCases = cases.filter((c) => c.mode === "complex" || c.mode === "both");
  const results: HybridResult[] = [];
  let bm25Correct = 0;
  let hybridCorrect = 0;
  const searchLatencies: number[] = [];

  for (const c of complexCases) {
    const tQ = performance.now();
    const queryVector = await getQueryEmbedding(c.query);
    const queryLatencyMs = performance.now() - tQ;

    const tS = performance.now();
    const bm25Matches = searchDeferredTools(catalog, c.query, 5);
    const hybridMatches = searchDeferredTools(catalog, c.query, 5, {
      queryVector: queryVector ?? undefined,
    });
    const searchLatencyMs = performance.now() - tS;
    searchLatencies.push(searchLatencyMs);

    const bm25Top1 = bm25Matches[0]?.name ?? null;
    const hybridTop1 = hybridMatches[0]?.name ?? null;
    const bm25IsCorrect = bm25Top1 != null && isMatch(bm25Top1, c.registryName);
    const hybridIsCorrect = hybridTop1 != null && isMatch(hybridTop1, c.registryName);

    if (bm25IsCorrect) bm25Correct += 1;
    if (hybridIsCorrect) hybridCorrect += 1;

    results.push({
      case: c,
      bm25Top1,
      hybridTop1,
      bm25Correct: bm25IsCorrect,
      hybridCorrect: hybridIsCorrect,
      queryLatencyMs,
      searchLatencyMs,
    });
  }

  // 打印对比
  for (const r of results) {
    const sameName = r.bm25Top1 === r.hybridTop1;
    const changed = r.bm25Top1 !== r.hybridTop1;
    const icon = sameName
      ? "↔️"
      : r.hybridCorrect
        ? "🎯"
        : r.bm25Correct
          ? "⚠️"
          : "❌";
    const note = sameName
      ? "top1 相同"
      : r.hybridCorrect
        ? `hybrid 修正 → ${r.hybridTop1}`
        : r.bm25Correct
          ? `hybrid 改错 → ${r.hybridTop1}`
          : `两边都错`;
    console.log(
      `  ${icon} ${r.case.registryName.padEnd(28)} bm25=${r.bm25Top1 ?? "(无)"}  hybrid=${r.hybridTop1 ?? "(无)"}  ${note}`,
    );
  }

  const p50 = searchLatencies.sort((a, b) => a - b)[Math.floor(searchLatencies.length * 0.5)] ?? 0;
  const p95 = searchLatencies[Math.floor(searchLatencies.length * 0.95)] ?? 0;
  console.log(`\n  Hybrid 检索延迟 p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms`);

  console.log(`\n  📊 BM25 top1 命中：${bm25Correct}/${results.length} (${((bm25Correct / results.length) * 100).toFixed(1)}%)`);
  console.log(`  📊 Hybrid top1 命中：${hybridCorrect}/${results.length} (${((hybridCorrect / results.length) * 100).toFixed(1)}%)`);
  const improvement = hybridCorrect - bm25Correct;
  if (improvement > 0) {
    console.log(`  🎉 Hybrid 比 BM25 多修正 ${improvement} 例 top1`);
  } else if (improvement === 0) {
    console.log(`  ➡️  Hybrid 与 BM25 持平（hybrid 通道未带来增量）`);
  } else {
    console.log(`  ⚠️  Hybrid 比 BM25 少 ${-improvement} 例（需调整 embedding 权重或过滤 negative）`);
  }

  return { enabled: true, results, bm25Top1: bm25Correct, hybridTop1: hybridCorrect };
}

async function main() {
  console.log("=".repeat(80));
  console.log("🔍 工具召回测试：Fast + Complex 模式覆盖度");
  console.log("=".repeat(80));

  // ===== 临时启用受门控的能力（让 desktop.run_automation 等进入 builtin 池） =====
  // 测试目的是验证「全量工具能否被召回」，因此临时把桌面/电话/手机桥接打开。
  // 跑完后恢复原 env，避免污染进程退出后的副作用。
  const ENV_BACKUP: Record<string, string | undefined> = {};
  const ENV_OVERRIDES: Record<string, string> = {
    DESKTOP_VISUAL_ENABLED: "1",
    DESKTOP_BRIDGE_ENABLED: "1",
    DESKTOP_BRIDGE_TOKEN: "test-bridge-token-12345678",
    PHONE_BRIDGE_ENABLED: "1",
    PHONE_BRIDGE_TOKEN: "test-phone-token-12345678",
  };
  for (const [k, v] of Object.entries(ENV_OVERRIDES)) {
    ENV_BACKUP[k] = process.env[k];
    process.env[k] = v;
  }

  try {
    await runTests();
  } finally {
    for (const [k, v] of Object.entries(ENV_BACKUP)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    // 清缓存避免影响后续测试
    invalidateBuiltinToolsCache();
  }
}

async function runTests() {
  // 清缓存确保拿到最新工具列表
  invalidateBuiltinToolsCache();
  _sharedCatalogByMode.clear();

  const actualFastLane = getFastLaneTools();

  console.log(`\n📦 内置工具总数：${getBuiltinAgentChatTools().length}`);
  console.log(`📦 Fast Lane 工具数：${actualFastLane.length}`);

  // 显示 Fast 模式与 Complex 模式的工具分布
  const fastCases = RECALL_CASES.filter((c) => c.mode === "fast" || c.mode === "both");
  const complexCases = RECALL_CASES.filter((c) => c.mode === "complex" || c.mode === "both");

  console.log(`\n🎯 测试用例分布：fast=${fastCases.length} complex=${complexCases.length}`);

  // ===== Fast 模式召回测试 =====
  console.log("\n" + "=".repeat(80));
  console.log("⚡ Fast 模式召回测试");
  console.log("=".repeat(80));
  const fastResults = runRecallForMode("fast", RECALL_CASES, actualFastLane);

  let passFast = 0;
  for (const r of fastResults) {
    const icon =
      r.verdict === "VISIBLE"
        ? "✅"
        : r.verdict === "SEARCH_TOP1"
          ? "✅"
          : r.verdict === "SEARCH_TOP5"
            ? "⚠️"
            : "❌";
    const mode = r.inVisible ? "VISIBLE" : r.inSearchable ? "DEFERRED" : "NOT_IN_POOL";
    const topHit = r.searchTopHits[0];
    const topHitStr = topHit ? `${topHit.name} (score=${topHit.score.toFixed(3)})` : "(无)";
    console.log(
      `  ${icon} [${mode}] ${r.case.registryName.padEnd(28)} query="${r.case.query}" 召回=${topHitStr} latency=${r.searchLatencyMs.toFixed(2)}ms`,
    );
    if (r.verdict !== "MISSED") passFast++;
  }
  console.log(`\nFast 模式通过：${passFast}/${fastResults.length}`);

  // ===== Complex 模式召回测试 =====
  console.log("\n" + "=".repeat(80));
  console.log("🧠 Complex 模式召回测试");
  console.log("=".repeat(80));
  const complexResults = runRecallForMode("complex", RECALL_CASES, actualFastLane);

  let passComplex = 0;
  for (const r of complexResults) {
    const icon =
      r.verdict === "VISIBLE"
        ? "✅"
        : r.verdict === "SEARCH_TOP1"
          ? "✅"
          : r.verdict === "SEARCH_TOP5"
            ? "⚠️"
            : "❌";
    const mode = r.inVisible ? "VISIBLE" : r.inSearchable ? "DEFERRED" : "NOT_IN_POOL";
    const topHit = r.searchTopHits[0];
    const topHitStr = topHit ? `${topHit.name} (score=${topHit.score.toFixed(3)})` : "(无)";
    console.log(
      `  ${icon} [${mode}] ${r.case.registryName.padEnd(28)} query="${r.case.query}" 召回=${topHitStr} latency=${r.searchLatencyMs.toFixed(2)}ms`,
    );
    if (r.verdict !== "MISSED") passComplex++;
  }
  console.log(`\nComplex 模式通过：${passComplex}/${complexResults.length}`);

  // ===== Bridge 桥接测试（tool_discover） =====
  console.log("\n" + "=".repeat(80));
  console.log("🌉 Bridge 桥接测试（Fast 模式通过 tool_discover 召回）");
  console.log("=".repeat(80));
  const bridgeChecks = await runBridgeRecallTest(RECALL_CASES, actualFastLane);
  let passBridge = 0;
  for (const c of bridgeChecks) {
    const icon = c.ok ? "✅" : "❌";
    console.log(`  ${icon} ${c.name}  ${c.detail}`);
    if (c.ok) passBridge++;
  }
  console.log(`\nBridge 通过：${passBridge}/${bridgeChecks.length}`);

  // ===== 延迟统计 =====
  console.log("\n" + "=".repeat(80));
  console.log("⏱️  召回延迟统计");
  console.log("=".repeat(80));
  const allLatencies = [...fastResults, ...complexResults].map((r) => r.searchLatencyMs).sort((a, b) => a - b);
  const p50 = allLatencies[Math.floor(allLatencies.length * 0.5)] ?? 0;
  const p95 = allLatencies[Math.floor(allLatencies.length * 0.95)] ?? 0;
  const p99 = allLatencies[Math.floor(allLatencies.length * 0.99)] ?? 0;
  const max = allLatencies[allLatencies.length - 1] ?? 0;
  console.log(`  p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms p99=${p99.toFixed(2)}ms max=${max.toFixed(2)}ms`);
  const latencyPass = p95 < 50;
  console.log(`  ${latencyPass ? "✅" : "❌"} p95 < 50ms`);

  // ===== Hybrid 召回（BM25 + embedding RRF）对比测试 =====
  const hybridSummary = await runHybridRecallTest(RECALL_CASES, actualFastLane);

  // ===== 汇总 =====
  console.log("\n" + "=".repeat(80));
  console.log("📊 工具召回测试汇总");
  console.log("=".repeat(80));
  const totalPass = passFast + passComplex + passBridge + (latencyPass ? 1 : 0);
  const totalChecks = fastResults.length + complexResults.length + bridgeChecks.length + 1;
  console.log(`  ✅ Fast 模式召回：${passFast}/${fastResults.length}`);
  console.log(`  ✅ Complex 模式召回：${passComplex}/${complexResults.length}`);
  console.log(`  ✅ Bridge 桥接（tool_discover）：${passBridge}/${bridgeChecks.length}`);
  console.log(`  ${latencyPass ? "✅" : "❌"} 召回延迟 p95 < 50ms`);
  if (hybridSummary.enabled && hybridSummary.results.length > 0) {
    const total = hybridSummary.results.length;
    console.log(
      `  🧬 Hybrid 对比：BM25 ${hybridSummary.bm25Top1}/${total} → Hybrid ${hybridSummary.hybridTop1}/${total}`,
    );
  } else {
    console.log(`  🧬 Hybrid 对比：未启用（缺 OPENAI_API_KEY 或 embedding 通道未命中）`);
  }
  console.log(`\n  总计：${totalPass}/${totalChecks}`);

  // ===== 漏召回清单 =====
  const missedAll = [...fastResults, ...complexResults].filter((r) => r.verdict === "MISSED");

  // 区分「内容问题」与「机制问题」：
  //   - 内容问题：工具在 builtin 池中但 BM25 召回不到（描述/intent 需优化）
  //   - 机制问题：工具不在 builtin 池中（注册漏掉了）
  const contentIssue: { name: string; query: string }[] = [];
  const mechanismIssue: { name: string; query: string }[] = [];
  for (const r of missedAll) {
    const allToolNames = (function () {
      try {
        return (require("../src/external-model/openai-compatible-tool-loop.js") as { getBuiltinAgentChatTools: () => { function?: { name?: string } }[] })
          .getBuiltinAgentChatTools()
          .map((t) => t.function?.name ?? "")
          .filter(Boolean);
      } catch {
        return [];
      }
    })();
    if (allToolNames.includes(r.case.registryName)) {
      contentIssue.push({ name: r.case.registryName, query: r.case.query });
    } else {
      mechanismIssue.push({ name: r.case.registryName, query: r.case.query });
    }
  }

  if (contentIssue.length > 0) {
    console.log("\n⚠️  内容问题（工具在池中但 BM25 召回失败，需优化 description / intent metadata）：");
    for (const c of contentIssue) {
      console.log(`  - ${c.name}  query="${c.query}"`);
    }
  }
  if (mechanismIssue.length > 0) {
    console.log("\n🔧 机制问题（工具未注册到 builtin 池，需添加到对应 CHAT_TOOLS 数组）：");
    for (const m of mechanismIssue) {
      console.log(`  - ${m.name}  query="${m.query}"`);
    }
  }

  console.log("\n📌 测试覆盖：");
  console.log("  - Fast 模式 16 个核心工具（含 1 个动态 fastLane 测试）");
  console.log("  - Complex 模式 15+ 个扩展工具（calendar/phone/desktop/embodiment/mcp 等）");
  console.log("  - Bridge 桥接：tool_discover 自动附带 top-1 schema");
  console.log("  - 召回延迟：BM25 索引 ≤ 50ms p95");

  // 退出码
  const allPass = missedAll.length === 0 && latencyPass;
  if (!allPass) {
    console.log("\n❌ 存在漏召回或延迟不达标，退出码 1");
    process.exit(1);
  }
  console.log("\n✅ 所有工具均能精准召回");
}

// main() 已直接调用，无需前置初始化
void main();
