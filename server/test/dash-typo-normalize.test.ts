/**
 * 错字归一化（normalizeDashTypos）测试：单个破折号「—」冒充量词「一」。
 *
 * 背景：deepseek 系模型中文输出偶发把量词「一」打成「—」
 *（2026-09-12 实测「在成都有—场品牌活动」）。归一化只处理
 * 「汉字 + 单个— + 量词字」窄模式；合法双破折号「——」与其他
 * 连字符场景不得误伤。
 */
import assert from "node:assert/strict";
import test from "node:test";

const { normalizeDashTypos } = await import("../src/utils/text.js");

test("错字归一化：单个「—」+量词字改写为「一」", () => {
  assert.equal(
    normalizeDashTypos("她今天（9月12日）在成都有—场品牌活动"),
    "她今天（9月12日）在成都有一场品牌活动",
  );
  assert.equal(normalizeDashTypos("我看过—遍这个电影"), "我看过一遍这个电影");
  assert.equal(normalizeDashTypos("他有—辆车"), "他有一辆车");
  assert.equal(normalizeDashTypos("等了—个小时"), "等了一个小时");
});

test("错字归一化：合法双破折号与英文连字符不误伤", () => {
  assert.equal(normalizeDashTypos("成都——她今天真美"), "成都——她今天真美");
  assert.equal(normalizeDashTypos("——以下是正文"), "——以下是正文");
  assert.equal(normalizeDashTypos("searching—fast"), "searching—fast");
  assert.equal(normalizeDashTypos("- 列表项"), "- 列表项");
});

test("错字归一化：无破折号文本原样返回", () => {
  assert.equal(normalizeDashTypos("今天有一场活动"), "今天有一场活动");
  assert.equal(normalizeDashTypos(""), "");
});
