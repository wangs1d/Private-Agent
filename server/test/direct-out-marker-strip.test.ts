import test from "node:test";
import assert from "node:assert/strict";

/**
 * 非聊天直出出口的协议标记剥离回归（2026-09-28）：
 *  - stripProtocolMarkersForDirectOut：RENDER_HINT/RENDER_AS 声明、NEXT_UP 块
 *    （含残缺）、结构化卡 JSON 块，确定性剥除且不动正常文本；
 *  - sanitizeNarrationText：简报润色稿即使带出 [RENDER_HINT:brief] 也不下发
 *    （2026-09-24 晨报泄漏教训的纵深防御）。
 *
 * 运行：npx tsx --test test/direct-out-marker-strip.test.ts
 */

const { stripProtocolMarkersForDirectOut } = await import("../src/services/reply-envelope.js");
const { sanitizeNarrationText } = await import("../src/services/morning-briefing-service.js");

test("正常文本原样保留（无标记零开销）", () => {
  const text = "今天 09:30 有项目评审，出门记得带伞。";
  assert.equal(stripProtocolMarkersForDirectOut(text), text);
});

test("RENDER_HINT 独占行整行删、行内就地剥、RENDER_AS 声明剥除", () => {
  const input = "[RENDER_HINT:brief]\n早上好 [RENDER_HINT:brief] 今天有两件事。\n[RENDER_AS:fold_list]";
  const out = stripProtocolMarkersForDirectOut(input);
  assert.equal(out, "早上好  今天有两件事。");
  assert.ok(!out.includes("RENDER"));
});

test("NEXT_UP 完整块与残缺块（漏发 END）都剥掉", () => {
  const full = "今天的安排说完了。\n[NEXT_UP_START]\n- 要不要看看天气？\n- 需要我提醒你吗？\n[NEXT_UP_END]";
  assert.equal(stripProtocolMarkersForDirectOut(full), "今天的安排说完了。");
  const malformed = "今天的安排说完了。\n[NEXT_UP_START]\n- 要不要看看天气？";
  assert.equal(stripProtocolMarkersForDirectOut(malformed), "今天的安排说完了。");
});

test("结构化卡 JSON 块整块丢弃（含残缺孤立标记），正文保留", () => {
  const input =
    "空气炸锅降到 300 以内了。\n[AGENT_RESULT_CARD_START]{\"title\":\"比价卡\",\"items\":[\"现价 289\"]}[AGENT_RESULT_CARD_END]\n后续我继续盯。";
  const out = stripProtocolMarkersForDirectOut(input);
  assert.equal(out.replace(/\n{2,}/g, "\n"), "空气炸锅降到 300 以内了。\n后续我继续盯。");
  assert.ok(!out.includes("AGENT_RESULT_CARD"));
  assert.ok(!out.includes("比价卡"));

  // 残缺块（无 END）时保守处理：只删孤立标记，块外正文不误伤
  const orphan = "话术正文 [DATA_BRIEF_START] 残缺开头";
  const out2 = stripProtocolMarkersForDirectOut(orphan);
  assert.equal(out2, "话术正文  残缺开头");
  assert.ok(!out2.includes("DATA_BRIEF"));
});

test("sanitizeNarrationText：简报润色稿带出 RENDER_HINT 也不下发（2026-09-24 事故场景）", () => {
  const leaked = "[RENDER_HINT:brief]\n今天 09:30 项目评审，20:00 健身，出门带伞。";
  const out = sanitizeNarrationText(leaked);
  assert.equal(out, "今天 09:30 项目评审，20:00 健身，出门带伞。");
  assert.ok(!out.includes("RENDER"));

  const withCard =
    "早上好。[AGENT_RESULT_CARD_START]{\"title\":\"日程\"}[AGENT_RESULT_CARD_END]\n两件事：09:30 评审、14:00 牙医。";
  const out2 = sanitizeNarrationText(withCard);
  assert.equal(out2, "早上好。 两件事：09:30 评审、14:00 牙医。");
  assert.ok(!out2.includes("AGENT_RESULT_CARD"));
});
