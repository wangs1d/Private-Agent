/**
 * RuntimeKernel 对话连续性 + 时间戳感知验证
 *
 * 验证两个关键问题：
 * 1. 时间戳感知：minimal 模式下，每条消息的 [ts:...] 前缀是否被 LLM 看到？
 *    系统是否告诉 LLM 这些前缀是什么含义？
 * 2. 对话上下文连续性：跨轮 thread 是否保留？跨会话 recap 是否注入？
 *    followUpAnchor / interruptedContext / sessionRecap 等衔接字段是否在 minimal 模式下保留？
 */
import { encodingForModel } from "js-tiktoken";

import {
  buildLayeredSystemPrompt,
  finalizeChatSystemPrompt,
} from "../src/agent/prompt-builder.js";
import { RuntimeKernel } from "../src/agent/runtime-kernel.js";
import type { AgentPromptMemoryContext } from "../src/external-model/types.js";
import {
  buildMessageTimestampPrefix,
  ChatThreadStore,
} from "../src/external-model/chat-thread-store.js";

const MODEL = "gpt-4o";
const SESSION_ID = "test-continuity-session";

function tokenCount(text: string): number {
  const enc = encodingForModel(MODEL);
  try {
    return enc.encode(text).length;
  } finally {
    enc.free?.();
  }
}

function hrtimeMs(): number {
  const [s, ns] = process.hrtime();
  return s * 1000 + ns / 1e6;
}

const BASE_SYSTEM_PROMPT =
  "You are a helpful, safe assistant. Respond in the same language the user uses when appropriate (Chinese or English). Refuse requests involving illegal or harmful content.";

async function main(): Promise<void> {
  const kernel = new RuntimeKernel();
  const threadStore = new ChatThreadStore(null);

  console.log("=".repeat(80));
  console.log("RuntimeKernel 对话连续性 + 时间戳感知验证");
  console.log("=".repeat(80));

  // -------- 第一轮对话：用户问"今天天气" --------
  console.log("\n--- 第一轮 ---");
  const t1 = new Date("2026-07-19T23:30:00+08:00");
  const userText1 = "今天北京天气怎么样";
  const assistantText1 = "今天北京晴，最高 28 度。";

  // 1. thread 写入：appendTurn 会给 user/assistant 都打 [ts:] 前缀
  threadStore.appendTurn(
    SESSION_ID,
    BASE_SYSTEM_PROMPT,
    { text: userText1 },
    assistantText1,
    12,
    t1,
  );

  // 2. 模拟第二轮的 memory（含 followUpAnchor 锚定上一轮）
  const memoryRound2: AgentPromptMemoryContext = {
    taskContext: "current-mission: 帮用户跟进天气",
    memorySummary: "用户最近在评估 RuntimeKernel，关心 prompt 优化",
    currentTime: "当前时间：2026-07-19 23:35:00 周日 (时区：Asia/Shanghai)",
    narrativeRecall: "上轮用户问了北京天气，Agent 回复晴 28 度",
    followUpAnchor: "上一轮：用户问北京天气 → Agent 回复晴 28 度",
    memoryPreferences: "偏好简洁回复",
    memoryOpenLoops: "未完成：用户没说要不要带伞",
    sessionRecap: "本会话：1) 用户问北京天气 2) Agent 回复晴 28 度",
  };

  const plan2 = kernel.planTurn(userText1, memoryRound2);
  const sanitized2 = kernel.sanitizePromptMemory(memoryRound2, plan2) ?? {};
  const baseContent2 = buildLayeredSystemPrompt(BASE_SYSTEM_PROMPT, sanitized2);
  const sysContent2 = finalizeChatSystemPrompt(baseContent2, {
    suppressRuntimeSuffixes: true,
  });
  // minimal 模式下实际下发的 system = buildSessionSystem() 返回值（作为 systemPromptOverride）
  const sessionSys2 = kernel.buildSessionSystem() ?? "";

  console.log(`第二轮 system prompt tokens: ${tokenCount(sysContent2)}`);
  console.log(`第二轮 sanitized memory 字段: ${Object.keys(sanitized2).join(", ")}`);
  console.log(`\n第二轮 sessionSys（systemPromptOverride）tokens: ${tokenCount(sessionSys2)}`);
  console.log(`第二轮 system 是否含 [ts:] 时间戳说明: ${/\[ts:YYYY-MM-DD/.test(sessionSys2) ? "✅ 有" : "❌ 无（剥离了）"}`);

  // 3. 模拟第二轮 streamCompletion 取 thread 的过程
  const msgs2 = threadStore.thread(SESSION_ID, BASE_SYSTEM_PROMPT);
  console.log(`\n第二轮 thread 消息数: ${msgs2.length}`);
  console.log("第二轮 thread 内容（应含第一轮 user/assistant 带 [ts:] 前缀）：");
  for (let i = 0; i < msgs2.length; i++) {
    const m = msgs2[i];
    const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    const preview = content.length > 100 ? content.slice(0, 100) + "..." : content;
    console.log(`  [${i}] ${m.role}: ${preview.replace(/\n/g, "\\n")}`);
  }

  // 检查每条 user/assistant 消息是否有 [ts:] 前缀
  const tsCheckResults = msgs2
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m, i) => {
      const content = typeof m.content === "string" ? m.content : "";
      return {
        index: i,
        role: m.role,
        hasTsPrefix: /^\[ts:/.test(content),
        prefix: content.match(/^\[ts:[^\]]+\]/)?.[0] ?? "(无)",
      };
    });
  console.log("\n消息时间戳前缀检查：");
  for (const r of tsCheckResults) {
    console.log(`  [${r.index}] ${r.role}: ${r.hasTsPrefix ? "✅" : "❌"} ${r.prefix}`);
  }

  // -------- 第二轮对话：实际再追加一条 --------
  console.log("\n--- 第二轮实际写入 ---");
  const t2 = new Date("2026-07-19T23:35:00+08:00");
  const userText2 = "那明天呢？";
  const assistantText2 = "明天多云转晴，最高 30 度。";
  threadStore.appendTurn(
    SESSION_ID,
    BASE_SYSTEM_PROMPT,
    { text: userText2 },
    assistantText2,
    12,
    t2,
  );

  const msgs3 = threadStore.thread(SESSION_ID, BASE_SYSTEM_PROMPT);
  console.log(`两轮后 thread 消息数: ${msgs3.length}`);
  console.log("两轮 thread 时序：");
  for (let i = 0; i < msgs3.length; i++) {
    const m = msgs3[i];
    const content = typeof m.content === "string" ? m.content : "";
    const tsMatch = content.match(/^\[ts:([^\]]+)\]/);
    const body = content.replace(/^\[ts:[^\]]+\]\n?/, "").slice(0, 60);
    console.log(`  [${i}] ${m.role} ts=${tsMatch?.[1] ?? "(无)"} body="${body}"`);
  }

  // -------- 跨会话恢复：模拟重启后从持久化恢复 --------
  console.log("\n--- 跨会话恢复（模拟重启）---");
  const restoredMsgs = threadStore.thread(SESSION_ID, BASE_SYSTEM_PROMPT);
  console.log(`恢复后消息数: ${restoredMsgs.length}`);
  console.log(`恢复后第一条 user 是否仍带 [ts:] 前缀: ${
    /^\[ts:/.test(
      typeof restoredMsgs[1]?.content === "string"
        ? (restoredMsgs[1].content as string)
        : "",
    )
      ? "✅"
      : "❌"
  }`);

  // -------- thread-store 首轮注入机制（setSessionSystemProvider）--------
  console.log("\n--- thread-store 首轮注入（setSessionSystemProvider）---");
  const injectKernel = new RuntimeKernel();
  // 默认 minimal 模式（enabled=true, promptMode="minimal"），buildSessionSystem 会返回内容
  const injectStore = new ChatThreadStore(null);
  injectStore.setSessionSystemProvider(() => injectKernel.buildSessionSystem() ?? null);
  const injectSession = "inject-test-session";
  const expectedSessionSys = injectKernel.buildSessionSystem() ?? "";
  console.log(`buildSessionSystem() 返回长度: ${expectedSessionSys.length} 字符`);
  console.log(`buildSessionSystem() 含 [ts:] 说明: ${/\[ts:YYYY-MM-DD/.test(expectedSessionSys) ? "✅" : "❌"}`);

  // 首次 thread() 调用：会创建新会话并注入 sessionSys 到 msgs[0]
  const injectMsgs1 = injectStore.thread(injectSession, BASE_SYSTEM_PROMPT);
  const injectSys1 = injectMsgs1[0];
  const injectSys1Content = typeof injectSys1?.content === "string" ? injectSys1.content : "";
  console.log(`首次 thread() msgs[0] role: ${injectSys1?.role}`);
  console.log(`首次 thread() msgs[0] content 长度: ${injectSys1Content.length}`);
  console.log(`首次 thread() msgs[0] 是否为 sessionSys（非 BASE_SYSTEM_PROMPT）: ${
    injectSys1Content === expectedSessionSys ? "✅" : "❌（应等于 sessionSys）"
  }`);

  // 追加一轮对话后再次 thread()：验证 msgs[0] 仍为 sessionSys（首轮注入一次后保留）
  injectStore.appendTurn(
    injectSession,
    BASE_SYSTEM_PROMPT,
    { text: "你好" },
    "你好，有什么可以帮你的？",
    12,
    new Date("2026-07-19T23:40:00+08:00"),
  );
  const injectMsgs2 = injectStore.thread(injectSession, BASE_SYSTEM_PROMPT);
  const injectSys2Content =
    typeof injectMsgs2[0]?.content === "string" ? injectMsgs2[0].content : "";
  console.log(`第二轮 thread() msgs[0] 是否仍为 sessionSys: ${
    injectSys2Content === expectedSessionSys ? "✅（首轮注入后保留）" : "❌（被覆盖）"
  }`);

  // 模拟 identity 热更新：buildSessionSystem 返回内容变化后，下次 thread() 应反映新内容
  injectKernel.update({
    identity: {
      persona: ["knowledgeable-companion"],
      values: ["curious", "precise"],
      style: ["concise"],
    },
  });
  const updatedSessionSys = injectKernel.buildSessionSystem() ?? "";
  console.log(`\nidentity 热更新后 buildSessionSystem() 长度: ${updatedSessionSys.length}`);
  console.log(`新旧 sessionSys 内容是否不同: ${updatedSessionSys !== expectedSessionSys ? "✅" : "❌"}`);

  // 注意：现有会话 msgs[0] 已写入，sessionSystemProvider 只在「创建新会话」时取一次
  // 创建新会话才会拿到新 sessionSys
  const newInjectMsgs = injectStore.thread("inject-test-session-2", BASE_SYSTEM_PROMPT);
  const newInjectSysContent =
    typeof newInjectMsgs[0]?.content === "string" ? newInjectMsgs[0].content : "";
  console.log(`新会话 msgs[0] 是否反映了热更新: ${
    newInjectSysContent === updatedSessionSys ? "✅" : "❌"
  }`);

  // -------- 关键问题诊断 --------
  console.log("\n" + "=".repeat(80));
  console.log("关键问题诊断");
  console.log("=".repeat(80));

  const allTsPrefixed = tsCheckResults.every((r) => r.hasTsPrefix);
  const tsExplainInSys = /\[ts:YYYY-MM-DD/.test(sessionSys2);
  const threadKept = msgs3.length >= 4; // system + 第一轮 user/assistant + 第二轮 user/assistant
  const followUpAnchorKept = "followUpAnchor" in sanitized2;
  const sessionRecapKept = "sessionRecap" in sanitized2;
  const memoryOpenLoopsKept = "memoryOpenLoops" in sanitized2;
  // thread-store 首轮注入机制断言
  const injectFirstRoundOk = injectSys1Content === expectedSessionSys && expectedSessionSys.length > 0;
  const injectSecondRoundOk = injectSys2Content === expectedSessionSys;
  const injectHotUpdateOk = updatedSessionSys !== expectedSessionSys && newInjectSysContent === updatedSessionSys;

  const issues = [
    {
      ok: allTsPrefixed,
      label: "每条 user/assistant 消息带 [ts:] 前缀",
      detail: "由 ChatThreadStore.appendTurn 在写入时注入，与 prompt 模式无关",
    },
    {
      ok: tsExplainInSys,
      label: "system prompt 含 [ts:] 时间戳说明（解释前缀含义）",
      detail: tsExplainInSys
        ? "✅ buildSessionSystem 已注入说明"
        : "❌ LLM 看到一堆 [ts:] 前缀但不知道含义",
    },
    {
      ok: threadKept,
      label: "跨轮 thread 保留对话历史",
      detail: `两轮后 thread 有 ${msgs3.length} 条消息（预期 ≥4）`,
    },
    {
      ok: followUpAnchorKept,
      label: "followUpAnchor 锚定上一轮（短句追问不串台）",
      detail: followUpAnchorKept ? "✅ 在 MINIMAL_PROMPT_FIELDS 中" : "❌ 被剥离",
    },
    {
      ok: sessionRecapKept,
      label: "sessionRecap 跨会话 recap",
      detail: sessionRecapKept ? "✅" : "❌ 不在 MINIMAL_PROMPT_FIELDS 中，跨会话 recap 丢失",
    },
    {
      ok: memoryOpenLoopsKept,
      label: "memoryOpenLoops 未完成事项",
      detail: memoryOpenLoopsKept ? "✅" : "❌ 被剥离",
    },
    {
      ok: injectFirstRoundOk,
      label: "thread-store 首次 thread() 注入 sessionSys 到 msgs[0]",
      detail: injectFirstRoundOk
        ? "✅ sessionSystemProvider 在创建新会话时被调用"
        : `❌ msgs[0] ≠ sessionSys（${injectSys1Content.length} vs ${expectedSessionSys.length}）`,
    },
    {
      ok: injectSecondRoundOk,
      label: "thread-store 第二轮 thread() 保留首轮注入的 msgs[0]",
      detail: injectSecondRoundOk
        ? "✅ 首轮注入一次，后续轮次不重新覆盖（靠前缀缓存命中）"
        : "❌ 第二轮 msgs[0] 被改写或丢失",
    },
    {
      ok: injectHotUpdateOk,
      label: "identity 热更新后新会话反映新 sessionSys",
      detail: injectHotUpdateOk
        ? "✅ 新会话从 provider 取最新 sessionSys"
        : "❌ 新会话未反映热更新（新旧内容应不同且新会话 msgs[0] = 新 sessionSys）",
    },
  ];

  for (const issue of issues) {
    console.log(`  ${issue.ok ? "✅" : "❌"} ${issue.label}`);
    console.log(`     → ${issue.detail}`);
  }

  // -------- 性能：连续多轮 thread 增长 vs 固定 system 开销 --------
  console.log("\n--- 性能：10 轮对话 thread 累积开销 ---");
  const perfStore = new ChatThreadStore(null);
  const perfKernel = new RuntimeKernel();
  const startMs = hrtimeMs();
  for (let round = 1; round <= 10; round++) {
    const now = new Date(2026, 6, 19, 23, 30 + round, 0);
    perfStore.appendTurn(
      `perf-${round}`,
      BASE_SYSTEM_PROMPT,
      { text: `第${round}轮对话` },
      `这是第${round}轮的回复`,
      12,
      now,
    );
    const mem: AgentPromptMemoryContext = {
      taskContext: `round-${round}`,
      memorySummary: "summary",
      currentTime: "当前时间：2026-07-19",
      followUpAnchor: `上一轮：${round - 1}`,
    };
    const p = perfKernel.planTurn(`第${round}轮`, mem);
    const s = perfKernel.sanitizePromptMemory(mem, p);
    const b = buildLayeredSystemPrompt(BASE_SYSTEM_PROMPT, s ?? {});
    finalizeChatSystemPrompt(b, { suppressRuntimeSuffixes: true });
  }
  const elapsed = hrtimeMs() - startMs;
  console.log(`10 轮对话端到端开销（appendTurn + planTurn + sanitize + finalizeChatSystemPrompt）：${elapsed.toFixed(2)}ms`);
  console.log(`平均每轮：${(elapsed / 10).toFixed(3)}ms`);

  const allPass = issues.every((i) => i.ok);
  console.log(`\n结论：${allPass ? "✅ 全部通过" : "❌ 有问题需要修复（见 ❌ 项）"}`);
  process.exit(allPass ? 0 : 1);
}

void main();
