import test from "node:test";
import assert from "node:assert/strict";

import { sanitizeVisionFramesFromWire } from "../src/vision/sanitize-vision-frames.js";

const tinyPngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("sanitizeVisionFramesFromWire accepts tiny png", () => {
  const out = sanitizeVisionFramesFromWire([
    {
      sourceKind: "device_camera",
      mimeType: "image/png",
      dataBase64: tinyPngBase64,
    },
  ]);
  assert.ok(out);
  assert.equal(out?.length, 1);
  assert.equal(out?.[0]?.mimeType, "image/png");
  assert.equal(out?.[0]?.sourceKind, "device_camera");
});

test("sanitizeVisionFramesFromWire rejects bad mime", () => {
  assert.throws(() =>
    sanitizeVisionFramesFromWire([
      {
        sourceKind: "device_camera",
        mimeType: "image/gif",
        dataBase64: tinyPngBase64,
      },
    ]),
  );
});
