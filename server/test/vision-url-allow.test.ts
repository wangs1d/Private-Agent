import test from "node:test";
import assert from "node:assert/strict";

import { assertVisionPullUrlAllowed } from "../src/vision/url-allow.js";

test("assertVisionPullUrlAllowed blocks localhost", () => {
  assert.throws(() => assertVisionPullUrlAllowed(new URL("http://localhost/snap.jpg")));
});

test("assertVisionPullUrlAllowed allows host when env allowlist matches", () => {
  const prev = process.env.AGENT_VISION_HTTP_PULL_ALLOW_HOSTS;
  process.env.AGENT_VISION_HTTP_PULL_ALLOW_HOSTS = "127.0.0.1";
  try {
    assert.doesNotThrow(() => assertVisionPullUrlAllowed(new URL("http://127.0.0.1/cam.jpg")));
  } finally {
    process.env.AGENT_VISION_HTTP_PULL_ALLOW_HOSTS = prev;
  }
});
