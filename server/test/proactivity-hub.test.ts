// ProactivityHub（主动性多元化模块）集成单测：
// 快路径（任务恭喜/待办闭环/过劳干预/问候）、通用 LLM 路径（speak/act/advise 路由）、
// act 黑名单安全门、media.search → media.play 链式填参、频控拦截、LLM 零开销路径、
// 负向决策缓存（重复场景免 LLM）、searchTools top-K 工具选择、LLM 决策蒸馏。
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { ProactivityHub } from "../src/proactivity/proactivity-hub.js";
import { FrequencyGovernor } from "../src/proactivity/frequency-governor.js";
import type { LlmCompleteFn } from "../src/proactivity/initiative-engine.js";
import { resetExemplars } from "../src/proactivity/semantic-trigger-matcher.js";
import { detectConversationProactiveHook } from "../src/proactivity/triggers/conversation-triggers.js";

// 通用 LLM 路径默认关闭（PROACTIVITY_LLM_INITIATIVE 默认 0，对话主动走 fast 规则车道）。
// 本文件专门覆盖该路径，故显式开启；互不串扰的干扰已在 onTick 内按 greeting/快路径先行短路。
process.env.PROACTIVITY_LLM_INITIATIVE = "1";

// 语义范例是模块级状态（决策蒸馏会在线扩充）——每个用例前重置，
// 避免早先用例蒸馏的范例污染后续用例的对话钩子判定
beforeEach(() => resetExemplars());

const ACTOR = "actor-1";

type PublishedSignal = {
  actorId: string;
  kind: string;
  title: string;
  summary: string;
  importance: string;
};

type ToolCall = { tool: string; args: Record<string, unknown> };

function makeDeps(overrides?: {
  llmComplete?: LlmCompleteFn;
  executeTool?: (
    tool: string,
    args: Record<string, unknown>,
    actorId: string,
  ) => Promise<{ ok: boolean; result: Record<string, unknown> }>;
  getLastInteractionAt?: (actorId: string) => number | null;
  getScheduleSnapshot?: (actorId: string) => string | null;
  getProfileText?: (actorId: string) => Promise<string | null>;
  listTools?: () => Array<{ name: string; description: string }>;
  searchTools?: (query: string, limit: number) => Array<{ name: string; description: string }>;
}) {
  const signals: PublishedSignal[] = [];
  const toolCalls: ToolCall[] = [];
  const deps = {
    publishSignal: (s: PublishedSignal) => {
      signals.push(s);
    },
    executeTool:
      overrides?.executeTool ??
      (async (tool: string, args: Record<string, unknown>) => {
        toolCalls.push({ tool, args });
        return { ok: true, result: {} };
      }),
    getLastInteractionAt: overrides?.getLastInteractionAt,
    getScheduleSnapshot: overrides?.getScheduleSnapshot,
    getProfileText: overrides?.getProfileText,
    listTools: overrides?.listTools,
    searchTools: overrides?.searchTools,
    llmComplete: overrides?.llmComplete,
    frequencyGovernor: new FrequencyGovernor({
      ignoreEnv: true,
      disableQuietHours: true,
    }),
  };
  return { deps, signals, toolCalls };
}

const flush = () => new Promise((r) => setTimeout(r, 20));

function atHour(hour: number, minute = 0): Date {
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  return d;
}

// ── 快路径 ─────────────────────────────────────────────

test("快路径：复杂任务完成 → speak 恭喜信号", async () => {
  const { deps, signals } = makeDeps();
  const hub = new ProactivityHub(deps);
  hub.onAgentTaskCompleted(ACTOR, "整理本周周报并生成图表");
  await flush();
  assert.equal(signals.length, 1);
  assert.equal(signals[0].kind, "task_celebration");
  assert.equal(signals[0].actorId, ACTOR);
  assert.ok(signals[0].summary.includes("周报"));
});

test("快路径：用户待办闭环 → speak 恭喜信号", async () => {
  const { deps, signals } = makeDeps();
  const hub = new ProactivityHub(deps);
  hub.onUserLoopCompleted(ACTOR, "把简历投出去了");
  await flush();
  assert.equal(signals.length, 1);
  assert.equal(signals[0].kind, "task_celebration");
  assert.ok(signals[0].summary.includes("简历"));
});

test("快路径：过劳信号 → act 三步执行（放音乐+排休息日程）+ speak 告知", async () => {
  const { deps, signals, toolCalls } = makeDeps({
    executeTool: async (tool, args) => {
      toolCalls.push({ tool, args });
      if (tool === "media.search") {
        return {
          ok: true,
          result: {
            tracks: [{ id: "t-01", name: "月光", artist: "某人", durationSec: 180 }],
          },
        };
      }
      return { ok: true, result: {} };
    },
  });
  const hub = new ProactivityHub(deps);
  hub.onRhythmSignal(ACTOR, "body.rhythm.overwork_detected", {
    continuousWorkHours: 3.5,
    lateNightActiveCount: 0,
  });
  await flush();

  assert.equal(signals.length, 1); // act 完成后 speak 告知
  assert.equal(signals[0].kind, "overwork_care");

  const tools = toolCalls.map((c) => c.tool);
  assert.deepEqual(tools, ["media.search", "media.play", "calendar.create_task"]);
  // fromStep 链式填参：media.play 拿到 search 结果第一条曲目
  const play = toolCalls[1].args;
  assert.equal(play.trackId, "t-01");
  assert.equal(play.trackName, "月光");
  assert.equal(play.artist, "某人");
  // 休息日程排到明晚
  assert.equal(toolCalls[2].args.kind, "reminder");
  assert.ok(String(toolCalls[2].args.runAt).length > 10);
});

test("快路径：非 overwork 的节律信号被忽略", async () => {
  const { deps, signals } = makeDeps();
  const hub = new ProactivityHub(deps);
  hub.onRhythmSignal(ACTOR, "body.rhythm.heartbeat", {});
  await flush();
  assert.equal(signals.length, 0);
});

test("快路径：早晨 + 长静默 → greeting 问候（speak）", async () => {
  const morning = atHour(8);
  const lastInteraction = new Date(morning.getTime() - 12 * 60 * 60 * 1000); // 昨晚 20:00，静默恒 12h
  const { deps, signals } = makeDeps({
    getLastInteractionAt: () => lastInteraction.getTime(),
  });
  const hub = new ProactivityHub(deps);
  await hub.onTick(ACTOR, morning);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].kind, "greeting");
});

test("快路径：从未交互 → tick 静默（不冷启动打扰）", async () => {
  const { deps, signals } = makeDeps({ getLastInteractionAt: () => null });
  const hub = new ProactivityHub(deps);
  await hub.onTick(ACTOR, atHour(8));
  assert.equal(signals.length, 0);
});

// ── 通用 LLM 路径 ─────────────────────────────────────

/** 观察已入 feed 的通用路径测试基座（对话轮不命中 care/followup 正则） */
async function tickWithDecision(
  reply: string,
  now: Date = atHour(15),
): Promise<{ hub: ProactivityHub; signals: PublishedSignal[]; toolCalls: ToolCall[]; llmCalls: number }> {
  let llmCalls = 0;
  const llmComplete: LlmCompleteFn = async () => {
    llmCalls += 1;
    return reply;
  };
  const { deps, signals, toolCalls } = makeDeps({ llmComplete });
  const hub = new ProactivityHub(deps);
  hub.observeConversationTurn(ACTOR, "在忙一个新模块的设计"); // 命中 feed，不命中规则正则
  await flush(); // observe 内部 handleConversation 为 null，无路由
  await hub.onTick(ACTOR, now);
  return { hub, signals, toolCalls, llmCalls };
}

test("通用路径：LLM 判定 speak → 发布 LifeSignal", async () => {
  const { signals, llmCalls } = await tickWithDecision(
    JSON.stringify({
      mode: "speak",
      kind: "mood_support",
      importance: "medium",
      rationale: "用户连续专注两小时了，值得一句关怀",
      messageHint: "像朋友一样问一句忙得怎么样，别催进度",
      actions: [],
    }),
  );
  assert.equal(llmCalls, 1);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].kind, "mood_support");
  assert.ok(signals[0].summary.includes("忙得怎么样"));
});

test("通用路径：LLM 判定 act → 静默执行工具 + speak 告知", async () => {
  const { signals, toolCalls } = await tickWithDecision(
    JSON.stringify({
      mode: "act",
      kind: "schedule_care",
      importance: "high",
      rationale: "用户连轴转，提前排好休息日程",
      messageHint: "做完顺口提一句",
      actions: [{ tool: "calendar.create_task", args: { kind: "reminder", title: "休息" } }],
    }),
  );
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].tool, "calendar.create_task");
  assert.equal(signals.length, 1); // act 后轻量告知
  assert.ok(signals[0].title.includes("顺手做了点事"));
});

test("通用路径：act 黑名单安全门 → 危险工具永不自动执行", async () => {
  const { signals, toolCalls } = await tickWithDecision(
    JSON.stringify({
      mode: "act",
      kind: "cleanup",
      importance: "high",
      rationale: "想帮忙清理文件",
      messageHint: "打算清理旧文件",
      actions: [
        { tool: "file.delete", args: { path: "/tmp/old" } },
        { tool: "media.play", args: { trackId: "t" } },
        { tool: "system.shutdown", args: {} },
      ],
    }),
  );
  const tools = toolCalls.map((c) => c.tool);
  assert.deepEqual(tools, ["media.play"]); // delete/shutdown 被安全门拦截，仅安全工具放行
  assert.equal(signals.length, 1); // speak 告知仍发布（内部说明哪些被拦）
});

test("通用路径：LLM 判定 advise → speak 主动投递（不入队）", async () => {
  const { signals } = await tickWithDecision(
    JSON.stringify({
      mode: "advise",
      kind: "info_prep",
      importance: "low",
      rationale: "发现用户连续三天查同一个话题",
      messageHint: "下次聊到时自然带出相关资料",
      actions: [],
    }),
  );
  // 架构调整后 advise 不再入队注入 prompt（原 AdviceStore 队列已废弃），
  // 改由与 speak 一致的主动对话投递。
  assert.equal(signals.length, 1);
  assert.equal(signals[0].kind, "info_prep");
  assert.ok(signals[0].summary.includes("资料"));
});

test("通用路径：LLM 判定 none → 全静默", async () => {
  const { signals, toolCalls } = await tickWithDecision(
    JSON.stringify({
      mode: "none",
      kind: "general",
      importance: "low",
      rationale: "观察平淡",
      messageHint: "",
      actions: [],
    }),
  );
  assert.equal(signals.length, 0);
  assert.equal(toolCalls.length, 0);
});

test("零开销：无新观察的 tick 不调 LLM", async () => {
  let llmCalls = 0;
  const llmComplete: LlmCompleteFn = async () => {
    llmCalls += 1;
    return JSON.stringify({ mode: "none", kind: "general", importance: "low", rationale: "", messageHint: "", actions: [] });
  };
  const { deps, signals } = makeDeps({ llmComplete });
  const hub = new ProactivityHub(deps);
  hub.observeConversationTurn(ACTOR, "在忙一个新模块的设计");
  await hub.onTick(ACTOR, atHour(15)); // 第一次：消费观察，调 LLM（返回 none）
  assert.equal(llmCalls, 1);
  assert.equal(signals.length, 0);

  await hub.onTick(ACTOR, atHour(15, 30)); // 第二次：无新观察
  assert.equal(llmCalls, 1); // LLM 未被再次调用
});

test("LLM 未注入：通用路径静默禁用（只走快路径）", async () => {
  const { deps, signals } = makeDeps();
  const hub = new ProactivityHub(deps);
  hub.observeConversationTurn(ACTOR, "在忙一个新模块的设计");
  await hub.onTick(ACTOR, atHour(15));
  assert.equal(signals.length, 0); // 无 greeting 条件、无规则命中 → 静默
});

// ── 频控 ─────────────────────────────────────────────

test("频控：同 kind 冷却期内二次触发被拦", async () => {
  const { deps, signals } = makeDeps();
  const hub = new ProactivityHub(deps);
  hub.onAgentTaskCompleted(ACTOR, "任务一");
  await flush();
  hub.onAgentTaskCompleted(ACTOR, "任务二"); // task_celebration 30min 冷却
  await flush();
  assert.equal(signals.length, 1);
});

test("频控：每日预算耗尽后全部拦截", async () => {
  const signals: PublishedSignal[] = [];
  const hub = new ProactivityHub({
    publishSignal: (s) => signals.push(s),
    executeTool: async () => ({ ok: true, result: {} }),
    frequencyGovernor: new FrequencyGovernor({
      ignoreEnv: true,
      disableQuietHours: true,
      dailyBudget: 1,
    }),
  });
  hub.onAgentTaskCompleted(ACTOR, "任务一");
  await flush();
  assert.equal(signals.length, 1);
  hub.onUserLoopCompleted(ACTOR, "待办一"); // 不同 kind，但预算已尽
  await flush();
  assert.equal(signals.length, 1);
});

// ── 感知流 ─────────────────────────────────────────────

test("感知流：日程快照变化才推观察（去重）", async () => {
  let llmCalls = 0;
  const llmComplete: LlmCompleteFn = async () => {
    llmCalls += 1;
    return JSON.stringify({ mode: "none", kind: "general", importance: "low", rationale: "", messageHint: "", actions: [] });
  };
  let snapshot = "SCH|range=today|count=1\n- 20:00|单次|休息提醒";
  const { deps } = makeDeps({ llmComplete, getScheduleSnapshot: () => snapshot });
  const hub = new ProactivityHub(deps);
  hub.observeConversationTurn(ACTOR, "在忙一个新模块的设计");
  await hub.onTick(ACTOR, atHour(15)); // 第一次：日程观察入 feed，连同对话观察一起消费
  assert.equal(llmCalls, 1);

  // 日程没变：第二次 tick 无新观察（对话无、日程去重）→ 不调 LLM
  await hub.onTick(ACTOR, atHour(15, 30));
  assert.equal(llmCalls, 1);

  // 日程变了 → 新观察 → 调 LLM
  snapshot = "SCH|range=today|count=2\n- 20:00|单次|休息提醒\n- 21:00|单次|喝水";
  await hub.onTick(ACTOR, atHour(16));
  assert.equal(llmCalls, 2);
});

test("对话观察文本截断到 120 字符", async () => {
  const { deps } = makeDeps();
  const hub = new ProactivityHub(deps);
  const longText = "a".repeat(500);
  hub.observeConversationTurn(ACTOR, longText);
  // recent 最后一条是 noteUserActivity 推的 user_activity，过滤取 conversation_turn
  const obs = hub
    .getFeed()
    .recent(ACTOR, 5)
    .filter((o) => o.type === "conversation_turn");
  assert.equal(obs.length, 1);
  // content = "用户说：" + 前 120 字符
  assert.equal(obs[0].content.length, "用户说：".length + 120);
  assert.equal(obs[0].content, `用户说：${"a".repeat(120)}`);
});

// ── 省 token 件：决策缓存 / 工具选择 / 决策蒸馏 ─────

const NONE_REPLY = JSON.stringify({
  mode: "none",
  kind: "general",
  importance: "low",
  rationale: "观察平淡",
  messageHint: "",
  actions: [],
});

test("决策缓存：同观察窗口重复判 none → 第二次跳过 LLM（省 token）", async () => {
  let llmCalls = 0;
  const llmComplete: LlmCompleteFn = async () => {
    llmCalls += 1;
    return NONE_REPLY;
  };
  const { deps } = makeDeps({
    llmComplete,
    // 固定交互时刻贴近 tick 时刻：静默 < 10h，问候快路径不介入
    getLastInteractionAt: () => atHour(14).getTime(),
  });
  const hub = new ProactivityHub(deps);
  hub.observeConversationTurn(ACTOR, "在忙一个新模块的设计");
  await hub.onTick(ACTOR, atHour(15)); // 第一次：调 LLM → none → 记入负向缓存
  assert.equal(llmCalls, 1);

  // 完全相同的观察再来一轮（对话内容与来源均相同 → 指纹相同）→ 缓存命中跳过
  hub.observeConversationTurn(ACTOR, "在忙一个新模块的设计");
  await hub.onTick(ACTOR, atHour(15, 30));
  assert.equal(llmCalls, 1);

  // 不同观察（指纹不同）→ 重新调 LLM
  hub.observeConversationTurn(ACTOR, "换了话题，在整理这周的会议纪要");
  await hub.onTick(ACTOR, atHour(16));
  assert.equal(llmCalls, 2);
});

test("searchTools 注入：prompt 只含核心保底 + top-K 相关工具（全量不进 prompt）", async () => {
  const prompts: string[] = [];
  const llmComplete: LlmCompleteFn = async (prompt) => {
    prompts.push(prompt);
    return NONE_REPLY;
  };
  // 10 个核心工具（media./calendar.）+ 20 个杂项；searchTools 只回 3 个相关杂项
  const all = [
    ...["media.search", "media.play", "media.pause", "media.next", "media.volume"].map((name) => ({
      name,
      description: `${name} 工具`,
    })),
    ...["calendar.create_task", "calendar.list", "calendar.update", "calendar.delete_task", "calendar.query"].map(
      (name) => ({ name, description: `${name} 工具` }),
    ),
    ...Array.from({ length: 20 }, (_, i) => ({
      name: `misc.tool_${i}`,
      description: `杂项工具 ${i}`,
    })),
  ];
  const { deps } = makeDeps({
    llmComplete,
    getLastInteractionAt: () => atHour(14).getTime(),
    listTools: () => all,
    searchTools: (query, limit) => {
      assert.ok(query.length > 0); // 查询由观察内容拼出
      return all.filter((t) => t.name.startsWith("misc.")).slice(0, Math.min(3, limit));
    },
  });
  const hub = new ProactivityHub(deps);
  hub.observeConversationTurn(ACTOR, "在忙一个新模块的设计");
  await hub.onTick(ACTOR, atHour(15));

  const prompt = prompts[0];
  const toolNames = all.map((t) => t.name).filter((n) => prompt.includes(`- ${n}：`));
  // 核心 10 + 相关 3 = 13；未相关的 misc.tool_3+ 不进 prompt（token 压缩生效）
  assert.equal(toolNames.length, 13);
  assert.ok(prompt.includes("- media.search："));
  assert.ok(prompt.includes("- misc.tool_0："));
  assert.ok(!prompt.includes("- misc.tool_3："));
});

test("决策蒸馏：LLM 对话主动决策（care 类 kind）→ 原话固化为快路径范例", async () => {
  resetExemplars();
  const text = "这周连着开了好几个通宵会"; // 正则无「通宵」、种子范例无重叠 → 学习前不命中
  assert.equal(detectConversationProactiveHook(text), null);

  const llmComplete: LlmCompleteFn = async () =>
    JSON.stringify({
      mode: "speak",
      kind: "mood_support", // 匹配 care 蒸馏正则
      importance: "medium",
      rationale: "用户连轴转了一整周",
      messageHint: "心疼一句，劝他别硬扛",
      actions: [],
    });
  const { deps, signals } = makeDeps({
    llmComplete,
    getLastInteractionAt: () => atHour(14).getTime(),
  });
  const hub = new ProactivityHub(deps);
  hub.observeConversationTurn(ACTOR, text);
  await hub.onTick(ACTOR, atHour(15));
  assert.equal(signals.length, 1); // LLM speak 决策发布信号

  // 蒸馏生效：同样的话此后走零 LLM 快路径语义层命中
  const hook = detectConversationProactiveHook(text);
  assert.ok(hook);
  assert.equal(hook.kind, "care");
  assert.equal(hook.importance, "medium");
});
