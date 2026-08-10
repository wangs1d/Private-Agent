// 工具搜索优化基准：速度 + 召回率（优化前/后通用）
//
// 运行：npx tsx scripts/bench-tool-search-opt.ts
//
// 输出 JSON 汇总（最后一行）+ 人类可读表格：
//   channel         = bm25 / hybrid / bridge
//   latency         = avg / p50 / p95
//   top1Rate        = 命中目标工具 top-1 的比例
//   top5Rate        = 命中目标工具 top-5 的比例

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
import {
  ensureToolEmbeddings,
  getQueryEmbedding,
  isEmbeddingSearchEnabled,
} from "../src/tools/tool-search/tool-embedding.js";
import { invalidateFullCatalogCache } from "../src/tools/tool-search/index.js";

type RecallCase = { registryName: string; query: string };

const RECALL_CASES: RecallCase[] = [
  { registryName: "clock.get_current_time", query: "现在几点了" },
  { registryName: "clock.get_user_location", query: "我当前位置在哪" },
  { registryName: "clock.get_date", query: "今天日期" },
  { registryName: "clock.format_timestamp", query: "格式化时间戳" },
  { registryName: "weather.get_local", query: "北京今天天气怎么样" },
  { registryName: "calendar.list_tasks", query: "我今天有哪些待办事项" },
  { registryName: "search_web", query: "搜索一下最新 AI 新闻" },
  { registryName: "fetch_web", query: "帮我读一下这个网页的内容" },
  { registryName: "browser.session.list", query: "当前打开了哪些浏览器标签" },
  { registryName: "agent.query_capabilities", query: "你能做什么 列出你的能力" },
  { registryName: "phone.ensure_my_number", query: "查询虚拟号码 申领 6 位号" },
  { registryName: "phone.virtual_call", query: "虚拟来电测试" },
  { registryName: "phone.call_user", query: "打电话给我提醒一下" },
  { registryName: "budget.calculate", query: "算一下这个月预算够不够" },
  { registryName: "shopping.suggest", query: "推荐一个笔记本电脑" },
  { registryName: "self.list_custom_skills", query: "我装载了哪些自定义技能" },
  { registryName: "calendar.create_task", query: "创建明天下午 3 点的会议" },
  { registryName: "calendar.create_from_text", query: "从这段文字里提取日程" },
  { registryName: "reminder.plan", query: "设置一个提醒 十分钟后提醒我" },
  { registryName: "agent.send_to_peer", query: "把这个消息发给另一个 agent" },
  { registryName: "agent.link.send_friend_request", query: "给另一个 agent 发好友请求" },
  { registryName: "agent.link.list_friends", query: "列出我的 agent 好友" },
  { registryName: "wallet.get_balance", query: "查一下我的钱包余额" },
  { registryName: "wallet.get_transactions", query: "查看最近 10 笔交易记录" },
  { registryName: "aip.dispatch", query: "AIP 智能协议处理分发" },
  { registryName: "embodiment.window_place", query: "把桌面角色窗口放到指定位置" },
  { registryName: "embodiment.roam", query: "让桌面角色漫游移动" },
  { registryName: "desktop.run_automation", query: "运行桌面自动化任务脚本" },
  { registryName: "desktop.run_shell", query: "执行一个 shell 命令" },
  { registryName: "world.open_registry.agent_quick", query: "在世界注册一个 agent" },
];

function isMatch(toolName: string, target: string): boolean {
  if (target.endsWith(".")) return toolName.startsWith(target);
  return toolName === target;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx] ?? 0;
}

async function main(): Promise<void> {
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
    invalidateBuiltinToolsCache();

    const plan = resolveChatToolPlanForStream("bench", {
      toolExposureProfile: "contextual",
      toolRankingHint: undefined,
    });
    const prepared = prepareToolsWithToolSearch(plan.visibleTools, plan.searchableTools);
    const catalog = prepared.deferredCatalog;

    console.log(`内置工具数=${getBuiltinAgentChatTools().length} 延迟目录=${catalog.entries.length} 类别=${catalog.categories.size}`);

    // 预热 embedding（hybrid 通道需要；失败则跳过 hybrid）
    // 快速探测：5s 内无法拿到 1 个 embedding → 直接判定本环境不可用，跳过预热
    const embeddingEnabled = isEmbeddingSearchEnabled();
    let hybridReady = false;
    if (embeddingEnabled) {
      const probe = await probeEmbedding();
      if (!probe) {
        console.log("embedding API 探测失败（网络/Key）→ hybrid 通道跳过");
      } else {
        const warm = await ensureToolEmbeddings(
          catalog.entries.map((e) => ({
            registryName: e.registryName,
            searchText: e.embeddingInput || e.searchText,
          })),
        );
        console.log(`embedding 预热 computed=${warm.computed} reused=${warm.reused} failed=${warm.failed}`);
        invalidateFullCatalogCache();
        const prepared2 = prepareToolsWithToolSearch(plan.visibleTools, plan.searchableTools);
        hybridReady =
          prepared2.deferredCatalog.embeddingIndex.size >
          prepared2.deferredCatalog.entries.length * 0.5;
        if (hybridReady) {
          Object.assign(catalog, prepared2.deferredCatalog);
        } else {
          console.log("embedding 索引不足 50% → hybrid 通道跳过");
        }
      }
    }

    // 只测「目标工具在延迟目录中」的用例（可见核心工具无法被 search 召回，统计无意义）
    const deferredNames = new Set(catalog.entries.map((e) => e.registryName));
    const cases = RECALL_CASES.filter((c) =>
      [...deferredNames].some((n) => isMatch(n, c.registryName)),
    );
    const skipped = RECALL_CASES.length - cases.length;
    console.log(`用例数=${cases.length}（可见工具跳过 ${skipped}）`);
    const bm25Lat: number[] = [];
    const hybridLat: number[] = [];
    const bridgeLat: number[] = [];
    let bm25Top1 = 0;
    let bm25Top5 = 0;
    let hybridTop1 = 0;
    let hybridTop5 = 0;
    let bridgeTop1 = 0;
    let bridgeTop5 = 0;
    let bridgeOk = 0;
    const total = cases.length;

    for (const c of cases) {
      // BM25 通道
      const t1 = performance.now();
      const bm25Hits = searchDeployedToolsExec(catalog, c.query);
      const bm25Ms = performance.now() - t1;
      bm25Lat.push(bm25Ms);
      if (bm25Hits[0] && isMatch(bm25Hits[0].name, c.registryName)) bm25Top1++;
      if (bm25Hits.slice(0, 5).some((h) => isMatch(h.name, c.registryName))) bm25Top5++;

      // Hybrid 通道
      if (hybridReady) {
        const qv = await getQueryEmbedding(c.query);
        const t2 = performance.now();
        const hybridHits = searchDeployedToolsExec(catalog, c.query, {
          queryVector: qv ?? undefined,
        });
        const hybridMs = performance.now() - t2;
        hybridLat.push(hybridMs);
        if (hybridHits[0] && isMatch(hybridHits[0].name, c.registryName)) hybridTop1++;
        if (hybridHits.slice(0, 5).some((h) => isMatch(h.name, c.registryName))) hybridTop5++;
      }

      // Bridge 通道（真实生产路径：adaptive）
      const t3 = performance.now();
      const discover = await executeToolSearchBridge(
        "tool_discover",
        { query: c.query },
        catalog,
      );
      const bridgeMs = performance.now() - t3;
      bridgeLat.push(bridgeMs);
      if (discover.kind === "discover" && discover.ok) {
        bridgeOk++;
        const matches = (discover.result as { matches?: Array<{ name: string }> }).matches ?? [];
        if (matches[0] && isMatch(matches[0].name, c.registryName)) bridgeTop1++;
        if (matches.slice(0, 5).some((h) => isMatch(h.name, c.registryName))) bridgeTop5++;
      }
    }

    const summary = {
      total,
      embeddingEnabled,
      hybridReady,
      bm25: {
        avg: avg(bm25Lat),
        p50: percentile([...bm25Lat].sort((a, b) => a - b), 0.5),
        p95: percentile([...bm25Lat].sort((a, b) => a - b), 0.95),
        top1Rate: round3(bm25Top1 / total),
        top5Rate: round3(bm25Top5 / total),
      },
      hybrid: hybridReady
        ? {
            avg: avg(hybridLat),
            p50: percentile([...hybridLat].sort((a, b) => a - b), 0.5),
            p95: percentile([...hybridLat].sort((a, b) => a - b), 0.95),
            top1Rate: round3(hybridTop1 / total),
            top5Rate: round3(hybridTop5 / total),
          }
        : null,
      bridge: {
        avg: avg(bridgeLat),
        p50: percentile([...bridgeLat].sort((a, b) => a - b), 0.5),
        p95: percentile([...bridgeLat].sort((a, b) => a - b), 0.95),
        top1Rate: round3(bridgeTop1 / total),
        top5Rate: round3(bridgeTop5 / total),
        okRate: round3(bridgeOk / total),
      },
    };

    // 人类可读输出
    console.log("\n===== 基准结果 =====");
    console.log(`用例数=${total}  embedding=${embeddingEnabled ? "on" : "off"} hybrid=${hybridReady ? "ready" : "n/a"}`);
    const line = (name: string, s: { avg: number; p50: number; p95: number; top1Rate: number; top5Rate: number } | null) => {
      if (!s) return;
      console.log(
        `  ${name.padEnd(8)} avg=${s.avg.toFixed(2).padStart(7)}ms p50=${s.p50.toFixed(2).padStart(7)}ms p95=${s.p95.toFixed(2).padStart(7)}ms  top1=${(s.top1Rate * 100).toFixed(1).padStart(5)}%  top5=${(s.top5Rate * 100).toFixed(1).padStart(5)}%`,
      );
    };
    line("bm25", summary.bm25);
    line("hybrid", summary.hybrid);
    line("bridge", summary.bridge);

    console.log("\n===== JSON =====");
    console.log(JSON.stringify(summary));
  } finally {
    for (const [k, v] of Object.entries(ENV_BACKUP)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    invalidateBuiltinToolsCache();
  }
}

// 真实调用封装
function searchDeployedToolsExec(
  catalog: Parameters<typeof searchDeferredTools>[0],
  query: string,
  opts?: Parameters<typeof searchDeferredTools>[3],
) {
  return searchDeferredTools(catalog, query, 5, opts);
}

/** 快速探测 embedding API 可用性（5s 超时，不抛错） */
async function probeEmbedding(): Promise<boolean> {
  try {
    const key =
      process.env.AGENT_TOOL_SEARCH_EMBEDDING_API_KEY?.trim() ||
      process.env.OPENAI_API_KEY?.trim() ||
      process.env.AGENT_EMBEDDING_API_KEY?.trim();
    if (!key) return false;
    const base =
      process.env.OPENAI_EMBEDDINGS_URL?.replace(/\/$/, "") ??
      "https://api.openai.com/v1/embeddings";
    const r = await fetch(base, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "text-embedding-3-small", input: "probe" }),
      signal: AbortSignal.timeout(5_000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

function avg(arr: number[]): number {
  return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

void main();
