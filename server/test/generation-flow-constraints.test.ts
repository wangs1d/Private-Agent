import assert from "node:assert/strict";
import test from "node:test";

import { isDirectFactQuery } from "../src/agent/direct-fact-query.js";
import { AssistantRewriterService } from "../src/services/assistant-rewriter.js";
import { UserPersonalizationService } from "../src/services/user-personalization/user-personalization-service.js";

test("direct fact query detection stays narrow to factual lookups", () => {
  assert.equal(isDirectFactQuery("她现在在哪"), true);
  assert.equal(isDirectFactQuery("今天有没有确切消息"), true);
  assert.equal(isDirectFactQuery("分析一下她最近为什么这么火"), false);
});

test("personalization suppresses follow-up guidance for direct fact queries", async () => {
  const service = new UserPersonalizationService(null, null);
  const actorId = "direct-fact-user";

  (service as any).fallbackState.set(`${actorId}:user_style_profile`, {
    banterLevel: 0.4,
    playfulTolerance: 0.5,
    cuteTolerance: 0.4,
    teasingTolerance: 0.4,
    followUpTolerance: 0.92,
    expressiveTolerance: 0.4,
    careStyle: "gentle",
    motivationStyle: "steady",
    initiativeStyle: "balanced",
    lastUpdatedAt: new Date().toISOString(),
  });

  const slice = await service.getPromptSlice(actorId, "她今天在哪？有没有确切消息");

  assert.equal(slice.toneGuidance?.includes("结论 + 1句依据"), true);
  assert.equal(slice.relationshipGuidance?.includes("不要顺手追加追问"), true);
  assert.equal(slice.relationshipGuidance?.includes("回答完可以顺手追问半句"), false);
});

test("personalization still allows light follow-up on non-factual chat turns", async () => {
  const service = new UserPersonalizationService(null, null);
  const actorId = "chatty-user";

  (service as any).fallbackState.set(`${actorId}:user_style_profile`, {
    banterLevel: 0.4,
    playfulTolerance: 0.5,
    cuteTolerance: 0.4,
    teasingTolerance: 0.4,
    followUpTolerance: 0.92,
    expressiveTolerance: 0.4,
    careStyle: "gentle",
    motivationStyle: "steady",
    initiativeStyle: "balanced",
    lastUpdatedAt: new Date().toISOString(),
  });

  const slice = await service.getPromptSlice(actorId, "最近有点无聊，陪我聊两句");

  assert.equal(slice.relationshipGuidance?.includes("回答完可以顺手追问半句"), true);
});

test("rewriter skips direct fact query turns instead of adding extra flavor", async () => {
  let called = 0;
  const provider = {
    isEnabled() {
      return true;
    },
    async streamCompletion() {
      called += 1;
    },
  };

  const service = new AssistantRewriterService(provider as any);
  const base = "还没有确切消息。昨晚她还在活动现场，所以目前更像还在那边。";
  const output = await service.rewriteIfNeeded("她现在在哪？有没有确切消息", base);

  assert.equal(output, base);
  assert.equal(called, 0);
});
