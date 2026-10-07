/**
 * 路由专用模型解析（route-chat-provider）行为测试。
 *
 * 契约：
 * - `LLM_ROUTE_PROVIDER` 显式 pin 优先；pin 的密钥缺失 → 回退 auto 链；
 * - auto 链：openai → moonshot-kimi → minimax（无思考链快模型优先，M 系最后）；
 * - 链上全部未配置 或 显式 none → 跟随主 provider（保底可用 / 向后兼容）。
 */
import assert from "node:assert/strict";
import test from "node:test";

const { resolveRouteChatProvider } = await import(
  "../src/external-model/route-chat-provider.js"
);

const ENV_KEYS = [
  "LLM_ROUTE_PROVIDER",
  "OPENAI_API_KEY",
  "MOONSHOT_API_KEY",
  "MINIMAX_API_KEY",
] as const;

/** 在受控 env 沙箱内执行断言（用后恢复，避免污染其他测试）。 */
function withEnv(env: Partial<Record<(typeof ENV_KEYS)[number], string>>, fn: () => void): void {
  const saved = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
  try {
    for (const k of ENV_KEYS) {
      if (env[k] === undefined) delete process.env[k];
      else process.env[k] = env[k];
    }
    fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** 主 provider 替身：只用于验证「回退主 provider」的引用同一性。 */
function fakeMain() {
  return { id: "fake-main", isEnabled: () => true } as never;
}

test("auto 链：openai 可用则路由固定用 openai（即使主模型是 minimax）", () => {
  withEnv({ OPENAI_API_KEY: "sk-test", MINIMAX_API_KEY: "k" }, () => {
    const main = fakeMain();
    const resolved = resolveRouteChatProvider(main);
    assert.equal((resolved as { id: string } | null)?.id, "openai");
    assert.notEqual(resolved, main);
  });
});

test("auto 链：无 openai 时依次回退 kimi", () => {
  withEnv({ MOONSHOT_API_KEY: "k", MINIMAX_API_KEY: "k" }, () => {
    const resolved = resolveRouteChatProvider(fakeMain());
    assert.equal((resolved as { id: string } | null)?.id, "moonshot-kimi");
  });
});

test("auto 链：全部未配置 → 回退主 provider（保底可用）", () => {
  withEnv({}, () => {
    const main = fakeMain();
    const resolved = resolveRouteChatProvider(main);
    assert.equal(resolved, main);
  });
});

test("显式 pin 优先于 auto 链", () => {
  withEnv(
    { LLM_ROUTE_PROVIDER: "minimax", OPENAI_API_KEY: "sk-test", MINIMAX_API_KEY: "k" },
    () => {
      const resolved = resolveRouteChatProvider(fakeMain());
      assert.equal((resolved as { id: string } | null)?.id, "minimax");
    },
  );
});

test("显式 pin 别名（kimi）可用", () => {
  withEnv({ LLM_ROUTE_PROVIDER: "kimi", MOONSHOT_API_KEY: "k" }, () => {
    const resolved = resolveRouteChatProvider(fakeMain());
    assert.equal((resolved as { id: string } | null)?.id, "moonshot-kimi");
  });
});

test("显式 pin 密钥缺失 → 回退 auto 链", () => {
  withEnv({ LLM_ROUTE_PROVIDER: "kimi", OPENAI_API_KEY: "sk-test" }, () => {
    const resolved = resolveRouteChatProvider(fakeMain());
    assert.equal((resolved as { id: string } | null)?.id, "openai");
  });
});

test("显式 none → 跟随主 provider（向后兼容旧行为）", () => {
  withEnv({ LLM_ROUTE_PROVIDER: "none", OPENAI_API_KEY: "sk-test" }, () => {
    const main = fakeMain();
    const resolved = resolveRouteChatProvider(main);
    assert.equal(resolved, main);
  });
});
