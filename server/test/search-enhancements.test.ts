import assert from "node:assert/strict";
import test from "node:test";

import {
  buildIntentAwareQueryVariants,
  classifySearchIntent,
  prependRecencyQueryVariants,
  shouldBoostQueryRecency,
} from "../src/services/search-enhancements.js";

test("latest and research queries get broader suggested limits", () => {
  assert.equal(classifySearchIntent("今天A股最新消息").suggestedLimit, 16);
  assert.equal(classifySearchIntent("帮我调研一下刘浩存的作品和经历").suggestedLimit, 14);
});

test("recency variants are prepended before base variants", () => {
  const variants = prependRecencyQueryVariants(["刘浩存", "刘浩存 动态"], "刘浩存最近动态");

  assert.equal(variants[0]?.includes("年"), true);
  assert.equal(variants[1]?.includes("最新"), true);
  assert.equal(variants.includes("刘浩存"), true);
});

test("timeless definition queries do not get forced recency variants", () => {
  assert.equal(shouldBoostQueryRecency("OpenAI 是什么"), false);
  assert.deepEqual(
    prependRecencyQueryVariants(["OpenAI 是什么"], "OpenAI 是什么"),
    ["OpenAI 是什么"],
  );
});

test("intent-aware variants expand compare queries with multiple entities", () => {
  const intent = classifySearchIntent("iPhone 17 和 iPhone 16 对比");
  const variants = buildIntentAwareQueryVariants("iPhone 17 和 iPhone 16 对比", intent, 8);

  assert.equal(variants.some((value) => value.includes("iPhone 17 iPhone 16 对比")), true);
  assert.equal(variants.some((value) => value.includes("vs")), true);
});
