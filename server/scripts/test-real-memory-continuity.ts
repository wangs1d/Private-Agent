/**
 * 真实记忆连续性测试
 *
 * 复现用户真实场景:
 *   12:27  "盯一下"            ← 用户第一句话
 *   12:55  (Agent 主动讲市场)    ← 主动消息(模拟)
 *   13:01  "给我打个电话"
 *   13:57  "你知道我今天问了你些啥吗 第一句话是什么"
 *
 * 验证:
 *   1. 12:27 "盯一下" 还在 thread 吗?
 *   2. trimByDayBoundary 后,被压成 recap 还是完整保留?
 *   3. 如果被压成 recap,recap 内容包含"盯一下"吗?
 *   4. LLM 拿到的 thread 数组(msgs[])实际包含几条 user 消息?
 *
 * 运行: cd server && npx tsx scripts/test-real-memory-continuity.ts
 */
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { ChatThreadStore } from "../src/external-model/chat-thread-store.js";

const BASE_SYSTEM_PROMPT = "你是小夜灯,Agent 身份。";
const SESSION_ID = "test-real-continuity";

interface Pair {
  time: string; // HH:MM
  user: string;
  assistant: string;
}

const pairs: Pair[] = [
  // === 昨天(前天)的对话 — 真实第一句话应该是这条,但被按天切分压成 recap ===
  { time: "07-29 14:00", user: "今天有什么重要会议?", assistant: "看下你的日历,15:00 有产品评审" },
  { time: "07-29 14:30", user: "帮我准备下会议纪要模板", assistant: "好的,模板已生成" },
  { time: "07-29 18:00", user: "晚饭吃啥?", assistant: "附近有家湘菜不错" },
  { time: "07-29 22:00", user: "今天辛苦了", assistant: "你也是,早点休息" },
  // === 今天 — "盯一下"是 thread 里保留的第一句,但不是用户真实第一句 ===
  { time: "12:27", user: "盯一下", assistant: "好,盯什么?" },
  { time: "12:31", user: "美联储利率决议", assistant: "收到,9:3 投票维持 3.50-3.75% 不变" },
  { time: "12:40", user: "为什么 9:3 不是全员一致?", assistant: "内部 3 票反对,说明鹰派比想象中猛" },
  { time: "12:50", user: "为什么看美联储脸色", assistant: "两件事撞一块了,直接砸盘..." },
  { time: "13:00", user: "给我打个电话", assistant: "抱歉,我暂时没有打电话的能力" },
  { time: "13:57", user: "你知道我今天问了你些啥吗 第一句话是什么", assistant: "暂未回答" },
];

function todayAt(time: string): Date {
  // 支持 "HH:MM"(今天) 和 "MM-DD HH:MM"(跨天) 两种格式
  const m = time.match(/^(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/);
  if (m) {
    const [, mo, d, h, mi] = m;
    return new Date(2026, parseInt(mo, 10) - 1, parseInt(d, 10), parseInt(h, 10), parseInt(mi, 10), 0);
  }
  const [h, mi] = time.split(":").map((s) => parseInt(s, 10));
  const d = new Date();
  d.setHours(h, mi, 0, 0);
  return d;
}

function dumpThread(label: string, msgs: ChatCompletionMessageParam[]): void {
  console.log(`\n  [${label}] 共 ${msgs.length} 条:`);
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role === "system") {
      console.log(`    [${i}] system: "${(m.content as string).slice(0, 30)}..."`);
      continue;
    }
    const ts = (m.content as string).match(/^\[ts:([^\]]+)\]/);
    const tsStr = ts ? ts[1] : "?";
    const cleanText = (m.content as string).replace(/^\[ts:[^\]]+\]\n?/, "").trim();
    console.log(`    [${i}] ${m.role.padEnd(9)} (${tsStr}): "${cleanText.slice(0, 50)}"`);
  }
}

function main(): void {
  console.log("=".repeat(80));
  console.log("真实记忆连续性测试 (复现用户真实对话节奏)");
  console.log("=".repeat(80));

  const store = new ChatThreadStore(null);

  // 1. 写入全部成对 turns,每对带时间戳(模拟实际 appendTurn)
  console.log("\n--- 写入全部对话 turns ---");
  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i];
    const at = todayAt(p.time);
    store.appendTurn(
      SESSION_ID,
      BASE_SYSTEM_PROMPT,
      { text: p.user },
      p.assistant,
      24, // maxThreadMessages
      at,
    );
    console.log(`  ${p.time} U:"${p.user.slice(0, 30)}" → A:"${p.assistant.slice(0, 30)}"`);
  }

  // 2. 拿 thread 看看实际保留了什么
  const thread = store.thread(SESSION_ID, BASE_SYSTEM_PROMPT);

  // 3. 关键断言
  console.log("\n" + "=".repeat(80));
  console.log("关键断言 (trim 前)");
  console.log("=".repeat(80));
  dumpThread("trim 前", thread);

  const allText = thread.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");

  const hasFirstUserMsg = allText.includes("盯一下");
  const hasFirstAssistantMsg = allText.includes("好,盯什么");
  const userMsgCount = thread.filter((m) => m.role === "user").length;
  const assistantMsgCount = thread.filter((m) => m.role === "assistant").length;
  const hasRecap = thread.some((m) => typeof m.content === "string" && /session-recap|recap/i.test(m.content));

  console.log(`  ${hasFirstUserMsg ? "✅" : "❌"} 第一句话"盯一下"在 thread 中`);
  console.log(`  ${hasFirstAssistantMsg ? "✅" : "❌"} 第一轮 assistant"好,盯什么"在 thread 中`);
  console.log(`  user 消息条数: ${userMsgCount}`);
  console.log(`  assistant 消息条数: ${assistantMsgCount}`);
  console.log(`  ${hasRecap ? "⚠️  YES(有 recap 摘要)" : "✅  NO(全部原样保留)"}`);

  // 4. 如果有 recap,展开 recap 内容
  if (hasRecap) {
    const recapMsg = thread.find(
      (m) => typeof m.content === "string" && /session-recap|recap/i.test(m.content),
    );
    if (recapMsg && typeof recapMsg.content === "string") {
      console.log(`\n  recap 内容预览:\n    "${recapMsg.content.slice(0, 500)}..."`);
    }
  }

  // 5. 模拟 streamCompletion 路径(再调一次 trimThread,验证 provider 调用前后是否一致)
  console.log("\n" + "=".repeat(80));
  console.log("模拟 streamCompletion 路径 (再 trim 一次)");
  console.log("=".repeat(80));
  store.trimThread(thread);
  dumpThread("trim 后 (LLM 实际看到的)", thread);

  // 6. 总结
  console.log("\n" + "=".repeat(80));
  console.log("总结");
  console.log("=".repeat(80));
  if (hasFirstUserMsg && !hasRecap) {
    console.log("  ✅ thread 完整保留全部对话,记忆连续性 OK");
  } else if (hasRecap && hasFirstUserMsg) {
    console.log("  ⚠️  thread 走 recap 路径:旧消息压成摘要,摘要内含'盯一下'");
    console.log("     → 视觉上'还在',但 LLM 只能看摘要而不是原文细节");
  } else if (!hasFirstUserMsg) {
    console.log("  ❌ 第一句话已被切除!LLM 看不到'盯一下'原文");
    console.log("     → 用户问'第一句话是什么'时,LLM 必须靠其他来源(记忆系统/猜)回答");
  }

  process.exit(hasFirstUserMsg ? 0 : 2);
}

void main();

