import assert from "node:assert/strict";
import test from "node:test";

import { MorningBriefingService } from "../src/services/morning-briefing-service.js";

// 称呼方向铁律回归（2026-10-02 事故）：简报称呼必须取 factStore「称呼」
// 字段（agent 叫用户，如「王哥」）；记忆 KV user_profile 无称呼行时也绝不
// 回退账号 displayName——那是 agent 的网络名（用户叫 agent）。
test("简报称呼：factStore「称呼」字段是第一事实源", async () => {
  const svc = new MorningBriefingService({
    factStore: {
      getFact: (_actorId: string, field: string) =>
        field === "称呼" ? { field, value: "王哥" } : null,
    },
    agentMemorySyncService: {
      getSnapshot: () => ({
        revision: 1,
        entries: {
          user_profile: "- （待了解：称呼、常用语言、所在地等）",
        },
      }),
    },
  } as never);
  const briefing = await svc.generateBriefing("user@example.com");
  assert.equal(briefing.appellation, "王哥");
});

test("简报称呼：factStore 无记录时兜底读 KV user_profile「称呼」行", async () => {
  const svc = new MorningBriefingService({
    agentMemorySyncService: {
      getSnapshot: () => ({
        revision: 1,
        entries: { user_profile: "- 称呼：老王" },
      }),
    },
  } as never);
  const briefing = await svc.generateBriefing("user@example.com");
  assert.equal(briefing.appellation, "老王");
});

test("简报称呼：两边都取不到 → 省略字段（绝不回退 agent 网络名）", async () => {
  const svc = new MorningBriefingService({
    agentMemorySyncService: {
      getSnapshot: () => ({
        revision: 1,
        entries: { user_profile: "- （待了解：称呼、常用语言、所在地等）" },
      }),
    },
  } as never);
  const briefing = await svc.generateBriefing("user@example.com");
  assert.equal(briefing.appellation, undefined);
});
