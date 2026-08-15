/**
 * 2026-08-06 验证：Fast 主答 + Complex 后台结果回传去重
 * （消除"agent 回复里整段一模一样出现两次"的重复 bug）
 *
 * 设计（参照 GPT Live）：
 *  - fast 是主回答轨道（已流式推给前端）；
 *  - complex 只做后台，结果不回推原文，句级去重后回传 fast 无缝衔接。
 *
 * 验证目标：
 *   1. stripSentencesAlreadySaid 句级去重：整段重复→空；部分重复→只留新句
 *   2. 升级路径源码断言：complex 输出被缓冲，不再把 opts?.onAssistantDelta 直接
 *      交给 orchestrateTask 流式推前端
 *   3. fast 续接合成：流式防线丢弃与 fast 已说重复的句子，气泡内无重复句
 *   4. schedule supplement 路径已接入去重（源码断言）
 *
 * 运行：npx tsx scripts/test-fast-complex-handoff.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  chunkText,
  normalizeSentence,
  sentenceSet,
  splitSentences,
  stripSentencesAlreadySaid,
} from "../src/utils/text.js";

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

console.log(bold("\n[Test 1] stripSentencesAlreadySaid 句级去重"));

// 场景 A：complex 结果与 fast 回复一模一样 → 全部剔除，返回空（不再追加任何内容）
const fastA = "今年奥斯卡最佳影片是《阿诺拉》。它横扫了最佳导演与最佳女主角。";
const complexA = "今年奥斯卡最佳影片是《阿诺拉》。它横扫了最佳导演与最佳女主角。";
const dedupA = stripSentencesAlreadySaid(fastA, complexA);
check("整段一模一样 → 全部剔除返回空",
  dedupA === "",
  `实际: ${JSON.stringify(dedupA)}`);

// 场景 B：complex 先复述 fast 已说句子，再补充新信息 → 只留新句
const fastB = "今年奥斯卡最佳影片是《阿诺拉》。";
const complexB = "今年奥斯卡最佳影片是《阿诺拉》。它横扫了最佳导演与最佳女主角两项大奖。";
const dedupB = stripSentencesAlreadySaid(fastB, complexB);
check("部分重复 → 只保留新句子",
  dedupB === "它横扫了最佳导演与最佳女主角两项大奖。",
  `实际: ${JSON.stringify(dedupB)}`);

// 场景 C：无重复 → 原样返回
const fastC = "我这边先确认一下，稍等。";
const complexC = "查到了：2026 年奥斯卡最佳影片是《阿诺拉》。";
const dedupC = stripSentencesAlreadySaid(fastC, complexC);
check("无重复 → 原样返回",
  dedupC === complexC,
  `实际: ${JSON.stringify(dedupC)}`);

// 场景 D：fast 为空 → 原样返回（兜底）
const dedupD = stripSentencesAlreadySaid("", complexC);
check("fast 为空 → 原样返回",
  dedupD === complexC);

// 场景 E：标点/空白差异不应误判（"我帮你查一下。" vs "我来帮你查一下。"）
const dedupE = stripSentencesAlreadySaid("我帮你查一下。", "我来帮你查一下。");
check("相近但不同的句子不应被误删",
  dedupE === "我来帮你查一下。",
  `实际: ${JSON.stringify(dedupE)}`);

console.log(bold("\n[Test 2] 升级路径源码断言（complex 后台缓冲，不回推原文）"));

const agentCoreSource = readFileSync(join(import.meta.dirname, "../src/services/agent-core.ts"), "utf8");

// 升级块中 orchestrateTask 的第 4 个参数必须是缓冲闭包，而不是 opts?.onAssistantDelta
const upgradeBlock = agentCoreSource.slice(
  agentCoreSource.indexOf("fast 回复命中"),
  agentCoreSource.indexOf("后台 complex 补充失败") + 40,
);
check("升级块不再把 opts?.onAssistantDelta 直接传给 orchestrateTask",
  !upgradeBlock.includes("onAssistantDelta") || !/orchestrateTask\([\s\S]{0,200}opts\?\.onAssistantDelta/u.test(upgradeBlock),
  "orchestrateTask 改用缓冲闭包收集 complex 输出");

check("存在 synthesizeFastContinuation（complex 结果回传 fast）",
  agentCoreSource.includes("synthesizeFastContinuation"),
  "Fast 无缝衔接方法已接入升级块");

check("synthesizeFastContinuation 内部有句级去重调用",
  agentCoreSource.includes("stripSentencesAlreadySaid(fastReply, result)"),
  "先确定性强去重再交给 fast");

console.log(bold("\n[Test 3] fast 续接合成：流式防线丢弃与 fast 已说重复的句子"));

// 复现 synthesizeFastContinuation 的流式防线（与 agent-core 保持同步）：
// 按句检查，与 fast 已说内容重复的句子直接丢弃。
function streamContinuationWithGuard(fastReply: string, rawContinuation: string): string {
  const said = sentenceSet(fastReply);
  let pending = "";
  const forwarded: string[] = [];
  for (const delta of chunkText(rawContinuation, 3)) {
    pending += delta;
    const parts = pending.split(/(?<=[。！？!?；;])/u);
    pending = parts.pop() ?? "";
    for (const s of parts) {
      const t = s.trim();
      if (!t) continue;
      if (!said.has(normalizeSentence(t))) forwarded.push(s);
    }
  }
  if (pending.trim() && !said.has(normalizeSentence(pending.trim()))) {
    forwarded.push(pending);
  }
  return forwarded.join("").trim();
}

// 场景 F：模型在续接时把 fast 已说句子又复读了一遍 + 新增一句
const fastF = "今年的最佳影片我印象是《阿诺拉》，不过我不太确定，建议查一下最新信息。";
const rawContinuationF =
  "今年的最佳影片我印象是《阿诺拉》，不过我不太确定，建议查一下最新信息。" +
  "刚确认了，2026 年奥斯卡最佳影片就是《阿诺拉》。";
const guardedF = streamContinuationWithGuard(fastF, rawContinuationF);
const saidF = sentenceSet(fastF);
const continuationFaultF = splitSentences(guardedF);
const dupInContinuation = continuationFaultF.filter((s) => saidF.has(normalizeSentence(s)));
check("流式防线剔除复读句，只留新句",
  guardedF === "刚确认了，2026 年奥斯卡最佳影片就是《阿诺拉》。",
  `实际: ${JSON.stringify(guardedF)}`);
check("续接部分不再出现 fast 已说句子的重复",
  dupInContinuation.length === 0,
  `重复句: ${JSON.stringify(dupInContinuation)}`);

// 场景 G：续接输出全部是复读 → 防线吞掉全部 → 回退用已去重的 freshPart
const fastG = "今天天气不错，适合出门。";
const rawContinuationG = "今天天气不错，适合出门。";
const guardedG = streamContinuationWithGuard(fastG, rawContinuationG);
const freshPartG = stripSentencesAlreadySaid(fastG, "今天天气不错，适合出门。");
check("全部复读 → 防线吞掉全部（回退 freshPart 也为空，保持 fast 回复）",
  guardedG === "" && freshPartG === "",
  `guarded=${JSON.stringify(guardedG)} freshPart=${JSON.stringify(freshPartG)}`);

console.log(bold("\n[Test 4] schedule supplement 路径已接入去重"));

const chatUserMessageSource = readFileSync(
  join(import.meta.dirname, "../src/ws/handlers/chat-user-message.ts"),
  "utf8",
);
check("supplement 使用 stripSentencesAlreadySaid 去重",
  chatUserMessageSource.includes("stripSentencesAlreadySaid(reply.text, supplement)"),
  "避免工具结果拼接与 LLM 已说内容重叠");

console.log(bold(`\nSummary: ${green(`${passed} passed`)} | ${failed > 0 ? red(`${failed} failed`) : "0 failed"}`));
if (failed > 0) process.exit(1);
