import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { shouldRecallLongTerm } from "../src/agent/recall-gate.js";
import {
  shouldInjectMemorySummary,
  isWindowDeixisShortCircuit,
} from "../src/agent/memory-signal.js";
import { DailyJournalService } from "../src/services/daily-journal-service.js";
import { ShortTermMemoryGatewayService } from "../src/services/short-term-memory-gateway.js";
import { isNoiseLogLine } from "../src/services/nightly-memory-task-service.js";

// ===== recall-gate：长期记忆白名单门控 =====

test("explicit memory cues trigger recall", () => {
  assert.equal(shouldRecallLongTerm({ text: "还记得我上次说的那个项目吗" }).trigger, true);
  assert.equal(shouldRecallLongTerm({ text: "上次聊天我们聊到哪了" }).trigger, true);
  assert.equal(shouldRecallLongTerm({ text: "记住我不吃香菜" }).trigger, true);
});

test("personal fact statements trigger recall", () => {
  assert.equal(shouldRecallLongTerm({ text: "我叫李雷，在杭州工作" }).trigger, true);
});

test("new session opening triggers recall", () => {
  assert.equal(shouldRecallLongTerm({ text: "在吗", threadMessageCount: 0 }).trigger, true);
  assert.equal(shouldRecallLongTerm({ text: "在吗", threadMessageCount: 1 }).trigger, true);
});

test("second turn in session does NOT trigger new_session recall (串台根治)", () => {
  // 首轮问答完成后 thread 已有 2 条消息；任务追问（如"你确定？"）不得再命中
  // new_session 把跨会话记忆/关系记忆灌进任务轮。
  assert.equal(shouldRecallLongTerm({ text: "你确定？", threadMessageCount: 2, ambiguousFollowUp: true }).trigger, false);
  assert.equal(shouldRecallLongTerm({ text: "再帮我看看", threadMessageCount: 3 }).trigger, false);
});

test("ordinary mid-session turns do NOT trigger recall (白天只写不捞)", () => {
  assert.equal(shouldRecallLongTerm({ text: "今天天气怎么样", threadMessageCount: 10 }).trigger, false);
  assert.equal(shouldRecallLongTerm({ text: "帮我看看这段代码有什么问题", threadMessageCount: 6 }).trigger, false);
  assert.equal(shouldRecallLongTerm({ text: "哈哈这个有意思", threadMessageCount: 4 }).trigger, false);
});

test("empty text never triggers", () => {
  assert.equal(shouldRecallLongTerm({ text: "   " }).trigger, false);
});

test("anaphora escalation: ambiguous follow-up in long session triggers, short session does not", () => {
  // 短会话：LLM 从最近轮次即可消解，不需要长期检索
  assert.equal(
    shouldRecallLongTerm({ text: "那个方案后来怎么样了", threadMessageCount: 8, ambiguousFollowUp: true }).trigger,
    false,
  );
  // 长会话（早期轮次已截出窗口）：指代可能指向窗口外，升级检索
  const escalated = shouldRecallLongTerm({ text: "那个方案后来怎么样了", threadMessageCount: 30, ambiguousFollowUp: true });
  assert.equal(escalated.trigger, true);
  assert.equal(escalated.reason, "anaphora_escalation");
  // 非指代轮次即使会话再长也不触发
  assert.equal(
    shouldRecallLongTerm({ text: "今天天气怎么样", threadMessageCount: 30, ambiguousFollowUp: false }).trigger,
    false,
  );
});

// ===== 窗口内指代短路：根治"之前/刚才"双关词误触长期检索导致的串台 =====

test("window-deixis short-circuit: pure in-window references do NOT trigger recall", () => {
  // 窗口内指代（thread/STM 可消解）→ 不触发长期检索
  assert.equal(shouldRecallLongTerm({ text: "我刚才说的那个文件呢", threadMessageCount: 12 }).trigger, false);
  assert.equal(shouldRecallLongTerm({ text: "之前那个方案后来怎么样了", threadMessageCount: 12 }).trigger, false);
  assert.equal(shouldRecallLongTerm({ text: "前面说的那家店叫什么", threadMessageCount: 12 }).trigger, false);
  // 记忆摘要注入同样被抑制（"之前"双关词不再把旧会话摘要带进来）
  assert.equal(shouldInjectMemorySummary("我之前说的那个文件呢"), false);
  assert.equal(isWindowDeixisShortCircuit("我刚才说的那个文件呢"), true);
});

test("cross-session escalation: historical verbs/dates bypass short-circuit", () => {
  // 带"说过/聊过/上次/昨天"等跨会话线索 → 放行长期检索
  assert.equal(shouldRecallLongTerm({ text: "我之前跟你说过的那个方案", threadMessageCount: 12 }).trigger, true);
  assert.equal(shouldRecallLongTerm({ text: "我们之前聊过的那家餐厅", threadMessageCount: 12 }).trigger, true);
  assert.equal(shouldRecallLongTerm({ text: "昨天我们聊到了哪", threadMessageCount: 12 }).trigger, true);
  assert.equal(shouldRecallLongTerm({ text: "记得我刚才说的那个文件吗", threadMessageCount: 12 }).trigger, true);
  assert.equal(isWindowDeixisShortCircuit("我们之前聊过的那家餐厅"), false);
});

test("explicit memory command is never short-circuited", () => {
  assert.equal(shouldRecallLongTerm({ text: "记住我刚才说的，周末去见客户", threadMessageCount: 12 }).trigger, true);
  assert.equal(isWindowDeixisShortCircuit("记住我刚才说的约会安排"), false);
});

// ===== 固化噪音过滤：闲聊语气行不进入长期记忆 =====

test("noise consolidation filter keeps substance, drops chit-chat", () => {
  // 高信号行恒保留
  assert.equal(isNoiseLogLine("fact", "我在做智能家居项目"), false);
  assert.equal(isNoiseLogLine("prefer", "我喜欢喝冰美式"), false);
  assert.equal(isNoiseLogLine("commit", "我明天帮你查一下"), false);
  // 闲聊/语气填充行过滤
  assert.equal(isNoiseLogLine("U", "哈哈哈哈"), true);
  assert.equal(isNoiseLogLine("A", "好的。"), true);
  assert.equal(isNoiseLogLine("U", "嗯嗯"), true);
  assert.equal(isNoiseLogLine("U", "晚安"), true);
  assert.equal(isNoiseLogLine("U", "谢谢你"), true);
  // 实义陈述保留
  assert.equal(isNoiseLogLine("U", "帮我看看这段代码的报错"), false);
  assert.equal(isNoiseLogLine("A", "我已帮你查了小米SU7的交付数据"), false);
});

// ===== daily-journal：当日写入 + 词法检索 + 固化标记 =====

function createJournal(): DailyJournalService {
  const dir = mkdtempSync(join(tmpdir(), "journal-"));
  return new DailyJournalService(dir);
}

test("appendTurn writes simplified lines and searchToday finds them", async () => {
  const journal = createJournal();
  const actorId = "user-a";
  journal.appendTurn(actorId, "session1234567890", "我们聊聊小米SU7的销量数据吧", "好的，我帮你查了小米SU7上月交付数据。");
  await new Promise((r) => setTimeout(r, 50)); // 等写入链 flush

  const hits = await journal.searchToday(actorId, "小米SU7 交付");
  assert.ok(hits.length > 0, "应能命中今天写入的对话行");
  assert.ok(hits.some((h) => h.text.includes("小米")), "命中行应含检索词");
});

test("searchToday returns empty when no journal exists", async () => {
  const journal = createJournal();
  const hits = await journal.searchToday("nobody", "随便查点什么");
  assert.deepEqual(hits, []);
});

test("preference/fact extraction lines are journaled", async () => {
  const journal = createJournal();
  const actorId = "user-b";
  journal.appendTurn(actorId, "sess-1", "我喜欢喝冰美式。我在做智能家居项目。", "知道了。");
  await new Promise((r) => setTimeout(r, 50));

  const preferHits = await journal.searchToday(actorId, "喜欢 冰美式");
  assert.ok(preferHits.length > 0, "偏好句应被提取为 prefer 行");
  const factHits = await journal.searchToday(actorId, "智能家居 项目");
  assert.ok(factHits.length > 0, "事实句应被提取为 fact 行");
});

test("consolidation flow: getUnconsolidated → markConsolidated → empty", async () => {
  const journal = createJournal();
  const actorId = "user-c";
  journal.appendTurn(actorId, "sess-1", "今天聊了记忆架构重构", "已记录。");
  await new Promise((r) => setTimeout(r, 50));

  const before = await journal.getUnconsolidatedLines(actorId);
  assert.equal(before.length, 1, "应有 1 个未固化日期");
  assert.ok(before[0]!.lines.length > 0, "日志行应非空");

  await journal.markConsolidated(actorId, [before[0]!.dateKey]);
  const after = await journal.getUnconsolidatedLines(actorId);
  assert.equal(after.length, 0, "固化后不应再有未处理日志");
});

test("appendTurn dedups identical turn within window (防多路径双写)", async () => {
  const journal = createJournal();
  const actorId = "user-idem";
  // 同一轮（同 session + 同首句）连续两次落盘：标准主答 / complex 后台 / parallel 续接可能多路径调同一次，
  // 幂等防抖窗口内应只写一次，避免当日检索/固化被重复行污染
  journal.appendTurn(actorId, "sess-idem-1", "今天聊了记忆架构", "已记录。");
  journal.appendTurn(actorId, "sess-idem-1", "今天聊了记忆架构", "已记录。");
  await new Promise((r) => setTimeout(r, 80));

  const hits = await journal.searchToday(actorId, "记忆架构");
  assert.equal(hits.length, 1, "同一轮重复写应只落一行");
});

test("searchRange covers recent days window (跨天检索)", async () => {
  const journal = createJournal();
  const actorId = "user-range";
  journal.appendTurn(actorId, "sess-range-1", "记得把项目部署到服务器", "好的，已记下。");
  await new Promise((r) => setTimeout(r, 80));

  const hits = await journal.searchRange(actorId, "部署 服务器", 3);
  assert.ok(hits.length > 0, "近 3 天窗口应能命中今天写入的行");
});

test("markConsolidated is idempotent", async () => {
  const journal = createJournal();
  const actorId = "user-d";
  journal.appendTurn(actorId, "sess-1", "写一行", "回一行");
  await new Promise((r) => setTimeout(r, 50));

  const before = await journal.getUnconsolidatedLines(actorId);
  const dateKey = before[0]!.dateKey;
  await journal.markConsolidated(actorId, [dateKey]);
  await journal.markConsolidated(actorId, [dateKey]);
  const after = await journal.getUnconsolidatedLines(actorId);
  assert.equal(after.length, 0);
});

// ===== STM gateway：buildRecallQuery 已删除的回归保护 =====

test("ShortTermMemoryGatewayService no longer exposes buildRecallQuery", () => {
  const dir = mkdtempSync(join(tmpdir(), "stm-gate-"));
  const service = new ShortTermMemoryGatewayService(join(dir, "stack.json"));
  assert.equal(
    typeof (service as unknown as Record<string, unknown>).buildRecallQuery,
    "undefined",
    "buildRecallQuery 拼接链应已彻底移除",
  );
});
