import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WorldService } from "../services/world-service.js";

describe("WorldService 落盘 JSON 体积", () => {
  let tmpDir: string;
  let prevWorldFile: string | undefined;
  let prevPretty: string | undefined;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "agent-world-ws-"));
    prevWorldFile = process.env.WORLD_STATE_FILE;
    prevPretty = process.env.WORLD_STATE_JSON_PRETTY;
    process.env.WORLD_STATE_FILE = join(tmpDir, "world-state.json");
  });

  afterEach(async () => {
    if (prevWorldFile === undefined) delete process.env.WORLD_STATE_FILE;
    else process.env.WORLD_STATE_FILE = prevWorldFile;
    if (prevPretty === undefined) delete process.env.WORLD_STATE_JSON_PRETTY;
    else process.env.WORLD_STATE_JSON_PRETTY = prevPretty;
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("默认紧凑序列化（无缩进换行），且可 load 回读", async () => {
    delete process.env.WORLD_STATE_JSON_PRETTY;
    const ws = new WorldService();
    await ws.load();
    ws.getOrCreate("viewer-session-1");
    await ws.flushPersist();
    const raw = await readFile(process.env.WORLD_STATE_FILE!, "utf8");
    expect(raw.startsWith('{"version":2')).toBe(true);
    expect(raw).not.toMatch(/\n {2}"/);

    const ws2 = new WorldService();
    await ws2.load();
    expect(ws2.getExisting("viewer-session-1")?.roomId).toBe("viewer-session-1");
  });

  it("WORLD_STATE_JSON_PRETTY=1 时写入带缩进", async () => {
    process.env.WORLD_STATE_JSON_PRETTY = "1";
    const ws = new WorldService();
    await ws.load();
    ws.getOrCreate("viewer-session-2");
    await ws.flushPersist();
    const raw = await readFile(process.env.WORLD_STATE_FILE!, "utf8");
    expect(raw).toMatch(/\n {2}"/);
    expect(raw.length).toBeGreaterThan(120);

    const compactLen = JSON.stringify(JSON.parse(raw)).length;
    expect(raw.length).toBeGreaterThanOrEqual(compactLen);
  });
});
