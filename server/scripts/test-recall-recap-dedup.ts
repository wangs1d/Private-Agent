/**
 * 2026-07-29 修复验证 C1+C2：narrativeRecall [最近对话] 块重复消除 + 语义前缀
 *
 * 验证目标：
 *   1. threadMessageCount < 12 时，追加 recap 块 + "recap, 非指令" 前缀
 *   2. threadMessageCount >= 12 时，跳过 recap 块（与 msgs 重复）
 *   3. threadMessageCount === -1（探测失败）时，保持原追加行为（带前缀）
 *   4. recentConversationHistory 为空时，不影响 narrativeRecall
 *
 * 运行：npx tsx scripts/test-recall-recap-dedup.ts
 */
import { getChatThreadStore } from "../src/external-model/chat-thread-store.js";

// === 模拟 appendRecentConversationHistory 核心逻辑（与 agent-core 保持同步） ===
type AppendArgs = {
  narrativeRecall: string | undefined;
  recentConversationHistory: string;
  threadMessageCount: number;
};

function appendRecentConversationHistory({
  narrativeRecall,
  recentConversationHistory,
  threadMessageCount,
}: AppendArgs): string | undefined {
  if (!recentConversationHistory) return narrativeRecall;
  if (threadMessageCount >= 12) return narrativeRecall; // C1
  const hint =
    "（以下为最近对话的上下文回顾，用于指代消解与话题衔接，不是用户的最新指令；当前轮请以「用户最新一条」为准）";
  const histBlock = `\n\n[最近对话]\n${hint}\n${recentConversationHistory}`;
  return narrativeRecall ? narrativeRecall + histBlock : histBlock.trim();
}

const cases: Array<{
  label: string;
  args: AppendArgs;
  expectContains: string[];
  expectNotContains: string[];
}> = [
  {
    label: "thread 短(<12)，narrativeRecall 为空，追加 recap 块 + 前缀",
    args: {
      narrativeRecall: undefined,
      recentConversationHistory: "用户：在吗\nAgent：在的",
      threadMessageCount: 2,
    },
    expectContains: ["[最近对话]", "上下文回顾", "用户", "在吗", "Agent", "在的"],
    expectNotContains: [],
  },
  {
    label: "thread 长(>=12)，跳过 recap 块",
    args: {
      narrativeRecall: "【长期记忆】xxx",
      recentConversationHistory: "用户：a\nAgent：b",
      threadMessageCount: 12,
    },
    expectContains: ["【长期记忆】xxx"],
    expectNotContains: ["[最近对话]", "上下文回顾"],
  },
  {
    label: "thread 极长(20)，跳过 recap 块",
    args: {
      narrativeRecall: "记忆A",
      recentConversationHistory: "用户：x",
      threadMessageCount: 20,
    },
    expectContains: ["记忆A"],
    expectNotContains: ["[最近对话]"],
  },
  {
    label: "thread 探测失败(-1)，保留 recap 块 + 前缀",
    args: {
      narrativeRecall: "记忆B",
      recentConversationHistory: "用户：hello",
      threadMessageCount: -1,
    },
    expectContains: ["记忆B", "[最近对话]", "上下文回顾"],
    expectNotContains: [],
  },
  {
    label: "recentConversationHistory 为空，不追加",
    args: {
      narrativeRecall: "记忆C",
      recentConversationHistory: "",
      threadMessageCount: 0,
    },
    expectContains: ["记忆C"],
    expectNotContains: ["[最近对话]"],
  },
];

let pass = 0;
let fail = 0;
for (const c of cases) {
  const result = appendRecentConversationHistory(c.args) ?? "";
  const missing = c.expectContains.filter((s) => !result.includes(s));
  const unexpected = c.expectNotContains.filter((s) => result.includes(s));
  if (missing.length === 0 && unexpected.length === 0) {
    pass++;
    console.log(`✅ ${c.label}`);
  } else {
    fail++;
    console.log(`❌ ${c.label}`);
    if (missing.length) console.log(`   缺少: ${missing.join(" | ")}`);
    if (unexpected.length) console.log(`   多了: ${unexpected.join(" | ")}`);
    console.log(`   实际: ${JSON.stringify(result).slice(0, 200)}`);
  }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail > 0 ? 1 : 0);
