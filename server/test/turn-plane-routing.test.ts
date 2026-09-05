/**
 * 双面路由（2026-09-05）黄金用例回归。
 *
 * 目标：真实对话中「需要工具的轮次必须落任务面（有工具可用）」，
 * 「纯对话轮次必须落对话面（零工具、零预算、不多花一步）」。
 * 用例全部来自线上真实事故句与高频句式。
 *
 * 根源化契约：
 *   - 路由层没有任何话题关键词（价格/天气/新闻词表已删除）；
 *   - L0 只认锚定全文的寒暄——带诉求的句子（无论多短）都进 L1 语义分类；
 *   - 正确性由「L1 语义分类 + 出口自检兜底」共同保证，不靠词表预判。
 */
import assert from "node:assert/strict";
import test from "node:test";

const { routeTurnByLlm } = await import("../src/agent/llm-task-router.js");
const { isHighPrecisionChatText } = await import("../src/agent/task-router.js");

function fakeProvider(intent: string, confidence = 0.9) {
  const calls = { count: 0 };
  const provider = {
    isEnabled: () => true,
    streamCompletion: async () => {
      calls.count += 1;
      return JSON.stringify({ intent, confidence });
    },
  };
  return { provider: provider as never, calls };
}

/* ---------------- 对话面：纯对话不多花一步 ---------------- */

test("对话面：寒暄/闲聊 → chat 平面零工具零预算，L0 短路零 LLM 成本", async () => {
  for (const text of ["在吗", "哈哈笑死我了", "好的收到", "晚安"]) {
    const { provider, calls } = fakeProvider("chat");
    const d = await routeTurnByLlm(provider, `sess-chat-${text}`, text);
    assert.equal(d.plane, "chat", `${text} 应落对话面，实际 ${d.plane}（${d.reasons.join(",")}）`);
    assert.equal(d.capabilities.length, 0, `${text} 对话面不得携带能力束`);
    assert.equal(d.budget, 0, `${text} 对话面预算必须为 0`);
    assert.equal(d.tier, "fast");
  }
});

test("对话面：L0 短路命中时零 LLM 调用（不花路由 token）", async () => {
  const { provider, calls } = fakeProvider("chat");
  await routeTurnByLlm(provider, "sess-l0-cost", "在吗");
  assert.equal(calls.count, 0);
});

/* ---------------- 任务面：需要工具的轮次必须落任务面 ---------------- */

const TASK_CASES: Array<{
  text: string;
  intent: string;
  why: string;
  minBudget?: number;
}> = [
  { text: "帮我订明天上午去上海的机票", intent: "action_write", why: "写操作（订票）必须真实执行" },
  { text: "明天早上八点提醒我开会", intent: "action_write", why: "写日程/提醒必须真实写入" },
  { text: "把电脑上这批照片整理到新建文件夹", intent: "multi_step_task", why: "多步桌面操作" },
  { text: "帮我搜索一下景甜最近的照片", intent: "media_retrieval", why: "媒体检索必须真搜", minBudget: 2 },
  { text: "今天天气怎么样？要带伞吗", intent: "realtime_lookup", why: "天气查询必须调天气工具（对话面零工具）" },
  { text: "刘浩存最近有什么新消息", intent: "realtime_lookup", why: "实时信息必须现查（线上事故句）" },
  { text: "现在比特币多少钱一个", intent: "realtime_lookup", why: "行情必须现查" },
  { text: "在电脑上帮我打开微信给张总发个消息", intent: "multi_step_task", why: "桌面自动化" },
];

test("任务面：L1 语义分类把工具轮映射到任务面且带正预算", async () => {
  for (const tc of TASK_CASES) {
    const { provider } = fakeProvider(tc.intent);
    const d = await routeTurnByLlm(provider, `sess-task-${tc.text}`, tc.text);
    assert.equal(
      d.plane,
      "task",
      `「${tc.text}」应落任务面（${tc.why}），实际 ${d.plane}（${d.reasons.join(",")}）`,
    );
    assert.ok(
      d.budget >= (tc.minBudget ?? 1),
      `「${tc.text}」预算应 ≥${tc.minBudget ?? 1}，实际 ${d.budget}`,
    );
    assert.ok(d.capabilities.length > 0, `「${tc.text}」任务面必须声明能力束`);
  }
});

test("根源保证：带诉求的短句不被闲聊短路吞掉，全部进入 L1 语义分类", async () => {
  // 这些句子曾是词表夹缝/长度兜底的受害者——现在无论词表是否存在，
  // L0 锚定匹配保证它们必然到达语义分类器（正确的工具需求由 L1 判定）。
  for (const text of ["以太坊现在什么价位", "刘浩存最近的动态", "明天会下雨吗"]) {
    assert.equal(
      isHighPrecisionChatText(text),
      false,
      `「${text}」不得被闲聊短路吞掉`,
    );
    const { provider, calls } = fakeProvider("realtime_lookup");
    await routeTurnByLlm(provider, `sess-l1-reach-${text}`, text);
    assert.equal(calls.count, 1, `「${text}」应到达 L1 语义分类`);
  }
});

/* ---------------- 保守降级：语义判定不可用时不静默失败 ---------------- */

test("降级安全：语义分类不可用时，非寒暄句保守落任务面（有工具可兜底）", async () => {
  const broken = {
    isEnabled: () => true,
    streamCompletion: async () => {
      throw new Error("provider down");
    },
  } as never;
  for (const text of ["刘浩存最近的消息", "帮我看看这个月花了多少钱", "明天带伞吗"]) {
    const d = await routeTurnByLlm(broken, `sess-fallback-${text}`, text);
    assert.equal(
      d.plane,
      "task",
      `「${text}」语义不可用时应保守落任务面（错放任务面只是慢，错放对话面=静默失败）`,
    );
  }
});

/* ---------------- 路由 token 效率契约 ---------------- */

test("路由效率：词法判定与 L1 每轮各至多一次（不重复计费）", async () => {
  const { provider, calls } = fakeProvider("realtime_lookup");
  const d = await routeTurnByLlm(provider, "sess-cost", "今天比特币行情怎么样");
  assert.equal(calls.count, 1, "L1 分类恰好调用一次");
  assert.equal(d.plane, "task");
  // 同输入命中缓存：第二次路由零 LLM 调用
  const d2 = await routeTurnByLlm(provider, "sess-cost", "今天比特币行情怎么样");
  assert.equal(calls.count, 1, "缓存命中不得重复调用 LLM");
  assert.equal(d2.plane, "task");
});

test("任务面档位：单点查询用 Flash 档，写操作/多步才上 Pro 档（省 token）", async () => {
  const realtime = await routeTurnByLlm(
    fakeProvider("realtime_lookup").provider,
    "sess-tier-1",
    "今天金价多少",
  );
  assert.equal(realtime.tier, "fast", "单点查询应使用 Flash 档");

  const write = await routeTurnByLlm(
    fakeProvider("action_write").provider,
    "sess-tier-2",
    "明天早上八点提醒我开会",
  );
  assert.equal(write.tier, "complex", "写操作应使用 Pro 档");
});
