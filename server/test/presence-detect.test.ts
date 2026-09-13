import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  detectPersonAtDesk,
  parsePresenceVerdict,
} from "../src/routes/http/presence-detect.js";

describe("parsePresenceVerdict：视觉模型输出解析", () => {
  test("标准 JSON / 围栏 JSON / 裸布尔 / 字符串布尔", () => {
    assert.equal(parsePresenceVerdict('{"present": true}'), true);
    assert.equal(parsePresenceVerdict('{"present": false}'), false);
    assert.equal(parsePresenceVerdict('```json\n{"present": true}\n```'), true);
    assert.equal(parsePresenceVerdict('前置说明 {"present":false} 后缀'), false);
    assert.equal(parsePresenceVerdict("true"), true);
    assert.equal(parsePresenceVerdict("false"), false);
    assert.equal(parsePresenceVerdict('{"present": "true"}'), true);
  });

  test("无法解析 → null", () => {
    assert.equal(parsePresenceVerdict(""), null);
    assert.equal(parsePresenceVerdict("画面中似乎有人"), null);
    assert.equal(parsePresenceVerdict('{"ok": 1}'), null);
  });
});

describe("detectPersonAtDesk：在座判定", () => {
  test("视觉模型判在座 → ok:true present:true", async () => {
    const verdict = await detectPersonAtDesk(
      { imageBase64: "aGVsbG8=", mimeType: "image/jpeg" },
      async () => '{"present": true}',
    );
    assert.deepEqual(verdict, { ok: true, present: true });
  });

  test("视觉模型判无人 → ok:true present:false", async () => {
    const verdict = await detectPersonAtDesk(
      { imageBase64: "aGVsbG8=" },
      async () => '{"present": false}',
    );
    assert.deepEqual(verdict, { ok: true, present: false });
  });

  test("输出无法解析 → ok:false unparsable_verdict（客户端失败放行）", async () => {
    const verdict = await detectPersonAtDesk(
      { imageBase64: "aGVsbG8=" },
      async () => "看不清楚",
    );
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, "unparsable_verdict");
  });

  test("VLM 调用异常 → ok:false vlm_error（不抛异常）", async () => {
    const verdict = await detectPersonAtDesk(
      { imageBase64: "aGVsbG8=" },
      async () => {
        throw new Error("boom");
      },
    );
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason ?? "", /^vlm_error:boom$/);
  });

  test("缺图 / 图片过大 → ok:false 参数校验", async () => {
    assert.deepEqual(await detectPersonAtDesk({ imageBase64: "" }), {
      ok: false,
      reason: "imageBase64 required",
    });
    const big = await detectPersonAtDesk(
      { imageBase64: "A".repeat(6_000_000) },
      async () => '{"present": true}',
    );
    assert.equal(big.ok, false);
    assert.equal(big.reason, "image too large");
  });
});
