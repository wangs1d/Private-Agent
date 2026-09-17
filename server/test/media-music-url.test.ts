import assert from "node:assert/strict";
import test from "node:test";

import {
  MediaMusicService,
  resolveTrackPlayUrl,
} from "../src/services/media-music-service.js";
import {
  clearClientCapabilities,
  declareClientCapabilities,
} from "../src/services/client-capability-registry.js";
import { createMediaPlayHandler } from "../src/tools/capability-modules/media-music/handlers.js";

/**
 * media.play 播放 URL 解析（服务端闭环补全）回归：
 *   - 服务端按 trackId 调网易云 song/enhance/player/url 解析可播放 URL 并随事件下发
 *   - 无版权（url=null）必须如实失败，事件带 urlError，工具返回值同步告知
 *   - 上游超时/网络错误不阻断事件下发，但如实带 urlError
 *
 * fetch 全部 mock：本测试不产生真实网络请求。
 */

/** 构造网易云 enhance/player/url 的 mock fetch。记录调用次数供缓存断言。 */
function createFakeFetch(options: {
  url: string | null;
  status?: number;
  reject?: Error;
  latencyMs?: number;
}) {
  let calls = 0;
  const impl = async (_input: unknown, _init?: unknown): Promise<Response> => {
    calls += 1;
    if (options.reject) throw options.reject;
    if (options.latencyMs) {
      await new Promise((r) => setTimeout(r, options.latencyMs));
    }
    if (options.status && options.status !== 200) {
      return new Response(JSON.stringify({ code: options.status }), {
        status: options.status,
      });
    }
    return new Response(
      JSON.stringify({
        code: 200,
        data: [
          options.url === null
            ? { id: 1, url: null, code: 404, fee: 1 }
            : { id: 1, url: options.url, br: 320000, type: "mp3", code: 200 },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  return { impl: impl as unknown as typeof fetch, calls: () => calls };
}

/** 带记录器的服务实例（推送到 WS 的原始帧全量留存在 sent 里）。 */
function createServiceWithRecorder(fetchImpl: typeof fetch) {
  const sent: string[] = [];
  const service = new MediaMusicService(
    {
      trySend: (_actorId: string, data: string) => {
        sent.push(data);
        return true;
      },
      isOnline: () => true,
    },
    fetchImpl,
  );
  return { service, sent };
}

test("resolveTrackUrl parses play URL from NetEase enhance/player/url", async () => {
  const fetchMock = createFakeFetch({ url: "http://m7.music.net.cn/amusic.mp3" });
  const service = new MediaMusicService({ trySend: () => true, isOnline: () => true }, fetchMock.impl);

  const resolved = await service.resolveTrackUrl("9901");
  assert.equal(resolved.ok, true);
  if (resolved.ok) {
    assert.equal(resolved.url, "http://m7.music.net.cn/amusic.mp3");
  }
  assert.equal(fetchMock.calls(), 1);
});

test("resolveTrackUrl reports honestly when track has no copyright (url=null)", async () => {
  // 注意：负缓存生效（200 条/30min），用独立 trackId 避免与其他用例串扰
  const fetchMock = createFakeFetch({ url: null });
  const service = new MediaMusicService({ trySend: () => true, isOnline: () => true }, fetchMock.impl);

  const resolved = await service.resolveTrackUrl("9902");
  assert.equal(resolved.ok, false);
  if (!resolved.ok) {
    assert.match(resolved.error, /无可播放/);
  }
});

test("resolveTrackUrl fails honestly on upstream timeout and does not cache the failure", async () => {
  const fetchMock = createFakeFetch({
    url: "http://m7.music.net.cn/late.mp3",
    reject: new Error("The operation was aborted due to timeout"),
  });
  const service = new MediaMusicService({ trySend: () => true, isOnline: () => true }, fetchMock.impl);

  const first = await service.resolveTrackUrl("9903");
  assert.equal(first.ok, false);
  if (!first.ok) {
    assert.match(first.error, /解析失败/);
    assert.match(first.error, /aborted/);
  }

  // 超时不缓存：第二次应重新打上游（这次成功）
  const retryMock = createFakeFetch({ url: "http://m7.music.net.cn/retry-ok.mp3" });
  const service2 = new MediaMusicService(
    { trySend: () => true, isOnline: () => true },
    retryMock.impl,
  );
  const second = await service2.resolveTrackUrl("9903");
  assert.equal(second.ok, true);
  assert.equal(retryMock.calls(), 1);
});

test("successful URL resolution is LRU-cached (no refetch on repeat)", async () => {
  const fetchMock = createFakeFetch({ url: "http://m7.music.net.cn/cached.mp3" });
  const service = new MediaMusicService({ trySend: () => true, isOnline: () => true }, fetchMock.impl);

  await service.resolveTrackUrl("9904");
  await service.resolveTrackUrl("9904");
  await service.resolveTrackUrl("9904");
  assert.equal(fetchMock.calls(), 1, "重复解析应命中缓存，不得反复打上游");
});

test("media.play event carries url + durationMs, and urlError when resolution fails", async () => {
  const actorId = `media-url-on-${Date.now()}`;
  declareClientCapabilities(actorId, { mediaPlayback: true });
  try {
    // 有 URL：payload 带 url + durationMs，无 urlError
    const okFetch = createFakeFetch({ url: "http://m7.music.net.cn/play.mp3" });
    const ok = createServiceWithRecorder(okFetch.impl);
    const okResult = await ok.service.play("9905", actorId, { name: "晴天", durationSec: 269 });
    assert.equal(okResult.ok, true);
    assert.ok(!("urlError" in okResult) || !okResult.urlError);
    assert.equal(ok.sent.length, 1);
    const okEvent = JSON.parse(ok.sent[0] ?? "{}") as { payload: Record<string, unknown> };
    assert.equal(okEvent.payload.url, "http://m7.music.net.cn/play.mp3");
    assert.equal(okEvent.payload.durationMs, 269_000);
    assert.equal(okEvent.payload.trackId, "9905");
    assert.equal(okEvent.payload.title, "晴天");
    assert.equal(okEvent.payload.urlError, undefined);

    // 无版权：事件仍下发（客户端要能展示"无法播放"），但带 urlError
    const noCopyFetch = createFakeFetch({ url: null });
    const noCopy = createServiceWithRecorder(noCopyFetch.impl);
    const noCopyResult = await noCopy.service.play("9906", actorId, { name: "VIP 专属" });
    assert.equal(noCopyResult.ok, true, "URL 解析失败不阻断信令下发");
    assert.equal(noCopy.sent.length, 1);
    const noCopyEvent = JSON.parse(noCopy.sent[0] ?? "{}") as { payload: Record<string, unknown> };
    assert.equal(noCopyEvent.payload.url, null);
    assert.match(String(noCopyEvent.payload.urlError), /无可播放/);
  } finally {
    clearClientCapabilities(actorId);
  }
});

test("media.play tool result honestly reports urlError to the model", async () => {
  const actorId = `media-url-handler-${Date.now()}`;
  declareClientCapabilities(actorId, { mediaPlayback: true });
  try {
    const fetchMock = createFakeFetch({ url: null });
    const { service } = createServiceWithRecorder(fetchMock.impl);
    const handler = createMediaPlayHandler(service);

    const result = (await handler(
      { trackId: "9907", trackName: "付费单曲" },
      { sessionId: actorId },
    )) as { ok: boolean; urlError?: string; summary?: string };

    assert.equal(result.ok, true, "信令已送达，工具不算失败");
    assert.match(result.urlError ?? "", /无可播放/);
    assert.match(result.summary ?? "", /URL 解析失败/);
    assert.match(result.summary ?? "", /不可播放/);
  } finally {
    clearClientCapabilities(actorId);
  }
});

test("module-level resolveTrackPlayUrl validates trackId format", async () => {
  const bad = await resolveTrackPlayUrl("not-a-number");
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.match(bad.error, /trackId 无效/);
  }
});
