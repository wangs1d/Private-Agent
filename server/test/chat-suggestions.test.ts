import assert from "node:assert/strict";
import test from "node:test";

import {
  configureChatSuggestionUsageSource,
  getChatSuggestions,
  type SuggestionUsageObservation,
} from "../src/services/chat-suggestions-service.js";

/** 与能力就绪注册表相关的 env 组：设置后 12 条推荐池全部就绪 */
const ALL_READY_ENV: Record<string, string> = {
  SEARCH_API_KEY: "test-key",
  OPENAI_API_KEY: "test-key",
  LUCKIN_MCP_TOKEN: "test-token",
  MEITUAN_AI_HUB_TOKEN: "test-token",
  MEITUAN_AI_HUB_SKILL_ID: "test-skill",
  DIDI_MCP_KEY: "test-key",
  HA_BASE_URL: "http://ha.test",
  HA_TOKEN: "test-token",
  JUHE_TRAIN_KEY: "test-key",
  VARIFLIGHT_APP_ID: "test-id",
  VARIFLIGHT_APP_SECRET: "test-secret",
};

function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** 固定「现在」，观察相对它生成 */
const NOW = new Date("2026-09-24T12:00:00");

function daysAgo(n: number, hour = 10): number {
  return new Date(NOW.getTime() - n * 86_400_000).setHours(hour, 0, 0, 0);
}

function obs(tool: string, at: number, actorId = "u1"): SuggestionUsageObservation {
  return { actorId, tool, at };
}

test("早报推荐项标签为「早报」（非「主动提醒」），文案为订阅早报", () => {
  withEnv({ ...ALL_READY_ENV }, () => {
    const seen: string[] = [];
    for (let i = 0; i < 80; i += 1) {
      const { suggestions } = getChatSuggestions(NOW);
      for (const s of suggestions) {
        if (s.id === "morning-brief") {
          assert.equal(s.tag, "早报");
          assert.equal(s.prompt, "每天早上八点给我一份早报");
          seen.push(s.tag);
        }
      }
    }
    assert.ok(seen.length > 0, "80 次抽样中早报（核心组）应至少出现一次");
  });
});

test("无使用数据：完全回退默认行为（5 条、核心保底 ≥3、全为介绍版文案）", () => {
  withEnv({ ...ALL_READY_ENV }, () => {
    for (let i = 0; i < 40; i += 1) {
      const { suggestions } = getChatSuggestions(NOW);
      assert.equal(suggestions.length, 5);
      const coreCount = suggestions.filter((s) =>
        ["weather-today", "schedule-create", "web-research", "shopping-compare", "memory-save", "morning-brief"].includes(s.id),
      ).length;
      assert.ok(coreCount >= 3, `核心组应 ≥3，实际 ${coreCount}`);
      for (const s of suggestions) {
        assert.equal(s.personalized, false);
      }
    }
  });
});

test("使用习惯个性化：近 14 天 ≥2 天用过的能力保底在场并出回访版文案", () => {
  withEnv({ ...ALL_READY_ENV }, () => {
    configureChatSuggestionUsageSource(null);
    // search_web 在 3 个不同天出现（跨 actor 也聚合），web_search 能力应稳定在场
    const usage: SuggestionUsageObservation[] = [
      obs("search_web", daysAgo(1)),
      obs("search_web", daysAgo(2, 15), "u2"),
      obs("search_web", daysAgo(9)),
      obs("weather.get_local", daysAgo(1, 8)),
      obs("weather.get_local", daysAgo(3, 8)),
    ];
    configureChatSuggestionUsageSource(() => usage);
    try {
      for (let i = 0; i < 40; i += 1) {
        const { suggestions } = getChatSuggestions(NOW);
        const search = suggestions.find((s) => s.id === "web-research");
        assert.ok(search, "在用能力（搜索）应保底在场");
        assert.equal(search.personalized, true);
        assert.equal(search.prompt, "帮我查查这周有什么新动态，挑重点讲给我");
        const personalizedCount = suggestions.filter((s) => s.personalized).length;
        assert.ok(personalizedCount <= 2, `个性化保底位应 ≤2，实际 ${personalizedCount}`);
        const coreCount = suggestions.filter((s) =>
          ["weather-today", "schedule-create", "web-research", "shopping-compare", "memory-save", "morning-brief"].includes(s.id),
        ).length;
        assert.ok(coreCount >= 3, "个性化在场不得挤掉核心保底");
      }
    } finally {
      configureChatSuggestionUsageSource(null);
    }
  });
});

test("窗口外与单天使用不触发个性化", () => {
  withEnv({ ...ALL_READY_ENV }, () => {
    // 20 天前的使用超出 14 天窗口；luckin 仅 1 天 → 均不算「在用」
    const usage: SuggestionUsageObservation[] = [
      obs("search_web", daysAgo(20)),
      obs("search_web", daysAgo(25)),
      obs("luckin_order", daysAgo(1)),
    ];
    configureChatSuggestionUsageSource(() => usage);
    try {
      for (let i = 0; i < 40; i += 1) {
        const { suggestions } = getChatSuggestions(NOW);
        for (const s of suggestions) {
          assert.equal(s.personalized, false);
          if (s.id === "luckin-order") {
            assert.equal(s.prompt, "帮我点一杯冰美式，到店自取");
          }
        }
      }
    } finally {
      configureChatSuggestionUsageSource(null);
    }
  });
});

test("推荐项结构：capabilityId / experimental 透传不回归", () => {
  withEnv({ ...ALL_READY_ENV, LUCKIN_MCP_TOKEN: undefined }, () => {
    // 删除 LUCKIN_MCP_TOKEN 后 luckin_coffee 未就绪，任何抽样不得出现点咖啡项
    for (let i = 0; i < 40; i += 1) {
      const { suggestions } = getChatSuggestions(NOW);
      assert.ok(!suggestions.some((s) => s.id === "luckin-order"), "未就绪能力不得入推荐");
      for (const s of suggestions) {
        assert.equal(typeof s.tag, "string");
        assert.ok(s.prompt.length > 0);
        assert.equal(typeof s.experimental, "boolean");
      }
    }
  });
});
