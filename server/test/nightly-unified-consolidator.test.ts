import test from "node:test";
import assert from "node:assert/strict";

import { resolveNightlyMode } from "../src/services/nightly-unified-consolidator.js";

test("resolveNightlyMode：默认 shadow（旧管路照常 + 单遍巩固器只记对比报告）", () => {
  const saved = process.env.AGENT_MEMORY_NIGHTLY_MODE;
  try {
    delete process.env.AGENT_MEMORY_NIGHTLY_MODE;
    assert.equal(resolveNightlyMode(), "shadow");
  } finally {
    if (saved === undefined) delete process.env.AGENT_MEMORY_NIGHTLY_MODE;
    else process.env.AGENT_MEMORY_NIGHTLY_MODE = saved;
  }
});

test("resolveNightlyMode：合法值原样返回，非法值回退 shadow", () => {
  const saved = process.env.AGENT_MEMORY_NIGHTLY_MODE;
  try {
    for (const mode of ["legacy", "shadow", "unified"] as const) {
      process.env.AGENT_MEMORY_NIGHTLY_MODE = mode;
      assert.equal(resolveNightlyMode(), mode);
    }
    process.env.AGENT_MEMORY_NIGHTLY_MODE = "bogus";
    assert.equal(resolveNightlyMode(), "shadow");
  } finally {
    if (saved === undefined) delete process.env.AGENT_MEMORY_NIGHTLY_MODE;
    else process.env.AGENT_MEMORY_NIGHTLY_MODE = saved;
  }
});
