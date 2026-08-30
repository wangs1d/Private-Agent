import assert from "node:assert/strict";
import test from "node:test";

import { humanizeAssistantText } from "../src/services/assistant-humanizer.js";

test("structured replies remove repeated intro clauses while keeping list items", () => {
  const input = [
    "今儿个有意思的事儿还真有几件：",
    "",
    "1. 斯诺克中国公开赛太原开杆了。",
    "2. 年度电影票房突破240亿。",
    "",
    "这几件里有你关心的不？今儿个有意思的事儿还真有几件：",
    "3. 8月可能还有台风登陆。",
  ].join("\n");

  const output = humanizeAssistantText(input);

  assert.equal(output.includes("今儿个有意思的事儿还真有几件"), true);
  assert.equal(output.includes("这几件里有你关心的不？今儿个有意思的事儿还真有几件"), false);
  assert.equal(output.includes("这几件里有你关心的不？"), true);
  assert.equal(output.includes("3. 8月可能还有台风登陆。"), true);
});

test("plain replies drop repeated factual paragraphs and keep at most one follow-up offer", () => {
  const input = [
    "昨天（8月7日）她在北京参加开幕活动。",
    "",
    "今天的话，搜不到她的实时行踪，没有确切消息。不过活动还在继续，她大概率还在那边参加后续活动。",
    "",
    "所以她现在应该还在那边——昨天还在活动上，今天估计还没走，大概率待在那边。",
    "",
    "要我帮你看看今天有没有后续安排不？说不定能蹲到她的行程。",
    "你是想看活动视频，还是想看她现在的动态？我按你说的帮你捞。",
  ].join("\n");

  const output = humanizeAssistantText(input);

  assert.equal(output.includes("所以她现在应该还在那边——昨天还在活动上"), false);
  assert.equal((output.match(/要我帮你|你是想看/g) ?? []).length, 1);
});
