import assert from "node:assert/strict";
import test from "node:test";

import {
  extractReminderSubject,
  formatReminderMessage,
} from "../src/services/schedule-intent-service.js";

/** 用户对助手的称呼（小弟/老哥等）不是提醒事项：不得混入 shortTitle 与到点文案。 */
test("extractReminderSubject strips trailing vocative appended after the subject", () => {
  assert.equal(extractReminderSubject("五分钟后提醒我睡觉 小弟"), "睡觉");
  assert.equal(extractReminderSubject("五分钟后提醒我睡觉 老铁呀"), "睡觉");
  assert.equal(extractReminderSubject("10分钟后提醒我喝水 老板"), "喝水");
});

test("extractReminderSubject strips leading vocative before the time expression", () => {
  assert.equal(extractReminderSubject("小弟，五分钟后提醒我睡觉"), "睡觉");
  assert.equal(extractReminderSubject("老哥 帮我明天9点提醒我开会"), "明天9点提醒我开会");
});

test("extractReminderSubject keeps vocative that is a sentence object (no separator)", () => {
  assert.equal(extractReminderSubject("明天9点提醒我打电话给大哥"), "打电话给大哥");
  assert.equal(extractReminderSubject("下午3点提醒我问老板要签字"), "问老板要签字");
});

test("reminder copy for vocative-suffixed request stays clean", () => {
  const subject = extractReminderSubject("五分钟后提醒我睡觉 小弟");
  assert.equal(subject, "睡觉");
  assert.equal(formatReminderMessage(subject), "该睡觉啦");
});

test("extractReminderSubject still handles plain reminders without vocatives", () => {
  assert.equal(extractReminderSubject("半小时后提醒我睡觉"), "睡觉");
  assert.equal(extractReminderSubject("2分钟后提醒吃药"), "吃药");
  assert.equal(extractReminderSubject("一分钟后提醒上厕所"), "上厕所");
});
