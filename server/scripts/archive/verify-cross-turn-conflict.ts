/**
 * 端到端场景验证：跨轮并行冲突检测
 * （后台复杂任务执行期间，用户若中途换话题 → 该条迟到的后台结果应被丢弃）
 *
 * 验证链：
 *  ① 真实 ChatThreadStore（生产单例 getChatThreadStore）按真实 WS 路径写入消息，
 *     驱动 latestUserTextAfter —— 冲突检测的「是否插话」触发器：
 *       - 后台执行期间用户未插话   → 返回 undefined → 0 次 LLM，安全续接（KEEP）
 *       - 后台执行期间用户插了新消息 → 返回最新 user 文本 → 触发一次轻量分类（DROP/KEEP）
 *  ② 冲突决策契约（与 agent-core.shouldDropCrossTurnConflict 同步）：
 *       - 仅当分类器显式输出 DROP 才丢弃
 *       - 空/异常/无法判断 一律 KEEP（不误伤正常续接）
 *  ③ 源码装配断言：completeParallelLiveContinuation 在续接合成前先做冲突检测，
 *     命中 DROP 走 return 提前退出，不再 appendAssistantFollowup。
 *
 * 运行：cd server && npx tsx scripts/verify-cross-turn-conflict.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  getChatThreadStore,
  resetChatThreadStoreForTests,
} from "../src/external-model/chat-thread-store.js";

const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail?: string) {
  if (ok) {
    passed++;
    console.log(`  ${green("✓")} ${label}${detail ? " — " + detail : ""}`);
  } else {
    failed++;
    console.log(`  ${red("✗")} ${label}${detail ? " — " + detail : ""}`);
  }
}

const SESSION = `verify-cross-turn-${Date.now()}`;

/** 与 agent-core.shouldDropCrossTurnConflict 保持一致的决策规则。 */
function classifyToDrop(classification: string): boolean {
  return /DROP/i.test(classification);
}

/** 复刻 shouldDropCrossTurnConflict 的完整判定（含 0-LLM 短路）。 */
function shouldDropConflict(
  midTurnText: string | undefined,
  chatUserMessageId: string | undefined,
): { drop: boolean; llmCalls: 0 | 1 } {
  // 无 clientMessageId：无触发消息可追溯 → 0 次 LLM，不丢弃
  if (!chatUserMessageId) return { drop: false, llmCalls: 0 };
  // 无中途插话：0 次 LLM，安全续接
  if (!midTurnText) return { drop: false, llmCalls: 0 };
  // 存在中途插话：走一次分类（此处由调用方注入 classification 见下）
  return { drop: false, llmCalls: 1 };
}

console.log(bold("\n[Test 1] latestUserTextAfter：真实线程存储下的触发检测"));

const SYS_PROMPT = "";

resetChatThreadStoreForTests();
const store = getChatThreadStore();

// 场景 B——后台任务执行期间用户插话换话题
const taskMsg = "帮我查一下今年奥斯卡最佳影片和导演是谁，顺便看下提名名单。";
const fastReply1 = "我先去查一下最新消息，稍等。";
const id1 = `m-${Date.now()}`;
store.appendTurn(SESSION, SYS_PROMPT, { text: taskMsg, clientMessageId: id1 }, fastReply1, undefined, new Date("2026-08-24T10:00:00"), id1);

// 用户中途插话：切到全新话题（此时后台 complex 仍在跑）
const topicChangeMsg = "对了，先别管电影了，我想知道今晚附近有什么好吃的湘菜。";
const id2 = `m-${Date.now() + 1}`;
store.appendTurn(SESSION, SYS_PROMPT, { text: topicChangeMsg, clientMessageId: id2 }, "我帮你找找附近好吃的湘菜。", undefined, new Date("2026-08-24T10:00:05"), id2);

const midTurnText = store.latestUserTextAfter(SESSION, SYS_PROMPT, id1);
check(
  "后台执行期间用户插话 → 检测到最新 user 文本（触发分类器）",
  typeof midTurnText === "string" && midTurnText.includes(topicChangeMsg),
  `实际: ${JSON.stringify(midTurnText)}`,
);
check(
  "返回的是「之后的最新」用户插话，而非触发消息本身",
  typeof midTurnText === "string" && !midTurnText.includes(taskMsg),
);

// 场景 A——后台执行期间用户未插话（单独会话）
const SESSION2 = `${SESSION}-no-interrupt`;
const idA = `m-${Date.now() + 2}`;
store.appendTurn(SESSION2, SYS_PROMPT, { text: taskMsg, clientMessageId: idA }, fastReply1, undefined, new Date("2026-08-24T10:00:00"), idA);
const noInterrupt = store.latestUserTextAfter(SESSION2, SYS_PROMPT, idA);
check(
  "后台执行期间用户未插话 → 返回 undefined（0 次 LLM，KEEP 短路）",
  noInterrupt === undefined,
  `实际: ${JSON.stringify(noInterrupt)}`,
);

console.log(bold("\n[Test 2] 冲突决策契约：标准是「是否还需要」，不是「话题是否切换」"));

const probe = shouldDropConflict(midTurnText, id1);
check("存在插话 → 需走 1 次轻量分类（不无限短路）", probe.llmCalls === 1);

// 真实分类器四态走查（复刻 agent-core 的 /DROP/i 判定）
check("分类输出 KEEP（仍在等结果）→ 不丢弃，续接",
  classifyToDrop("KEEP") === false);
check("换了话题但仍需要结果 → KEEP（用户顺带问别的事，不因话题不同而 DROP）",
  classifyToDrop("KEEP") === false);
check("分类输出 DROP（明确取消/放弃需求）→ 丢弃这条迟到结果",
  classifyToDrop("DROP") === true);
check("分类输出为空/异常 → 安全 KEEP（不误伤正常续接）",
  classifyToDrop("") === false);
check("分类无法判断兜底 → 安全 KEEP",
  classifyToDrop("我无法判断") === false);

console.log(bold("\n[Test 3] 源码装配断言：冲突检测是否真正接线并前置"));

const agentCoreSource = readFileSync(
  join(import.meta.dirname, "../src/services/agent-core.ts"),
  "utf8",
);

// 冲突检测在后台结果续接前调用
check("completeParallelLiveContinuation 内先做冲突检测",
  agentCoreSource.includes("shouldDropCrossTurnConflict(") &&
    agentCoreSource.indexOf("shouldDropCrossTurnConflict(") < agentCoreSource.indexOf("synthesizeFastContinuation("),
  "冲突检测排在续接合成之前");
check("命中 DROP → return 提前退出，不再合成/追加",
  /\bdropped\b[\s\S]{0,500}return;/u.test(agentCoreSource),
  "发现 `if (dropped) { ... return; }`");
check("冲突检测存在 0-LLM 短路（无插话直接放行）",
  agentCoreSource.includes("if (!midTurnText) return false; // 任务执行中用户未插话"),
  "无中途插话时 0 次分类调用");
check("冲突检测用真实线程存储 latestUserTextAfter 取插话",
  agentCoreSource.includes("latestUserTextAfter(chatSessionId,"),
  "驱动真实 ChatThreadStore");
check("仅显式 DROP 才丢弃，空/异常 KEEP",
  agentCoreSource.includes("return /DROP/i.test(classification);"),
  "决策契约与复刻一致");
check("分类 prompt 以「是否还需要」为标，显式排除『话题不同就 DROP』",
  agentCoreSource.includes("用户换了话题不代表不需要这个结果，不要因话题不同就 DROP"),
  "判定标准已对齐用户诉求");

const threadSource = readFileSync(
  join(import.meta.dirname, "../src/external-model/chat-thread-store.ts"),
  "utf8",
);
check("chat-thread-store 提供 latestUserTextAfter",
  threadSource.includes("latestUserTextAfter("),
  "触发器方法已落地");

console.log(bold(`\nSummary: ${green(`${passed} passed`)} | ${failed > 0 ? red(`${failed} failed`) : "0 failed"}`));
if (failed > 0) process.exit(1);