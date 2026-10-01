/**
 * 封面库 v1 平铺形状兼容读取（独立文件：store 是单例，v1 环境必须独占进程级设置）。
 * 存量 data/travel-media/destination-covers.json（v1 平铺形状）升级后不丢数据。
 */

import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

const v1Dir = mkdtempSync(join(tmpdir(), "dest-cover-v1-test-"));
process.env.TRAVEL_MEDIA_STORE_DIR = v1Dir;
writeFileSync(
  join(v1Dir, "destination-covers.json"),
  JSON.stringify({
    杭州: { url: "https://x/westlake.jpg", source: "wikipedia-lead", ts: Date.now() },
  }),
  "utf-8",
);

const { destinationCoverStore } = await import(
  "../src/skills/travel-planning/travel-destination-cover-store.js"
);

after(() => {
  rmSync(v1Dir, { recursive: true, force: true });
});

describe("destinationCoverStore v1 兼容", () => {
  it("v1 平铺形状读取：存量目的地封面不丢", () => {
    assert.equal(destinationCoverStore.get("杭州")?.url, "https://x/westlake.jpg");
  });
});
