// 媒体音乐登录音源单测：
// 1) 有网易云 Cookie 会话时解析请求带 Cookie 头（用户会员权益解析 VIP 曲目）；
// 2) 无会话回退匿名（无 Cookie 头），音源登录是增强而非前置条件；
// 3) 登录/匿名双缓存键互不污染（同一曲目两条路径独立缓存）；
// 4) getLoginSourceStatus 如实报告两种状态。
// 注意：resolveTrackPlayUrl 的 LRU 缓存是模块级的，测试用不重复的曲目 ID 隔离。
import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveTrackPlayUrl } from "../src/services/media-music-service.js";
import { MediaMusicService } from "../src/services/media-music-service.js";
import { declareClientCapabilities } from "../src/services/client-capability-registry.js";

function neteaseJson(url: string | null): { ok: boolean; status: number; json: () => Promise<unknown> } {
  if (url == null) throw new Error("缺少 url");
  return {
    ok: true,
    status: 200,
    json: async () => ({
      code: 200,
      data: [{ id: 1, url: url === "null" ? null : `https://audio.example.com/${url}.mp3` }],
    }),
  };
}

function makeFetchSpy(responder: (url: string, init?: RequestInit) => { status: number; json: () => Promise<unknown> }) {
  const calls: Array<{ url: string; cookie?: string }> = [];
  const fetchImpl = (async (url: string | RequestInfo, init?: RequestInit) => {
    const u = String(url);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url: u, cookie: headers.Cookie });
    return responder(u, init);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const cookieStore = (cookies: Array<{ name: string; value: string }> | Error) => ({
  getCookiesForAgent: async (_actorId: string, _site: "netease") => {
    if (cookies instanceof Error) throw cookies;
    return cookies;
  },
});

const wsStub = { trySend: () => true };

test("登录会话：解析请求携带 Cookie 头", async () => {
  const { fetchImpl, calls } = makeFetchSpy((url) => neteaseJson("auth-1"));
  const svc = new MediaMusicService(wsStub, fetchImpl, cookieStore([{ name: "MUSIC_U", value: "token-abc" }]));
  const res = await svc.resolveTrackUrlForActor("user-login", "990001");
  assert.equal(res.ok, true);
  assert.equal(res.source, "netease_login");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cookie, "MUSIC_U=token-abc");
});

test("无会话：回退匿名解析（无 Cookie 头），不视为错误", async () => {
  const { fetchImpl, calls } = makeFetchSpy((url) => neteaseJson("anon-1"));
  const svc = new MediaMusicService(wsStub, fetchImpl, cookieStore(new Error("未导入网易云音乐 Cookie")));
  const res = await svc.resolveTrackUrlForActor("user-anon", "990002");
  assert.equal(res.ok, true);
  assert.equal(res.source, "anonymous");
  assert.equal(calls[0].cookie, undefined);
});

test("双缓存键：登录与匿名的同曲目解析互不命中对方缓存", async () => {
  // 同一曲目：匿名解析出 urlA，登录解析出 urlB——缓存若混用则第二次会命中第一次的错误结果
  const { fetchImpl, calls } = makeFetchSpy((url) => {
    // 用 Cookie 头区分两条路径的返回
    return neteaseJson("anon-2");
  });
  // 匿名（无 cookie 头）
  const anon = await resolveTrackPlayUrl("990003", fetchImpl);
  assert.equal(anon.ok, true);
  assert.match((anon as { url: string }).url, /anon-2/);
  // 登录（带 cookie 头；改返回 auth 结果需要独立 spy，这里仅验证第二次确实发起了真实请求
  // 而不是吃掉匿名的缓存——即 calls 增长）
  const { fetchImpl: fetch2, calls: calls2 } = makeFetchSpy(() => neteaseJson("auth-2"));
  const auth = await resolveTrackPlayUrl("990003", fetch2, { cookieHeader: "MUSIC_U=x" });
  assert.equal(auth.ok, true);
  assert.match((auth as { url: string }).url, /auth-2/);
  assert.equal(calls.length, 1);
  assert.equal(calls2.length, 1);
  // 再各解析一次：都命中各自缓存，不再打上游
  await resolveTrackPlayUrl("990003", fetchImpl);
  await resolveTrackPlayUrl("990003", fetch2, { cookieHeader: "MUSIC_U=x" });
  assert.equal(calls.length, 1);
  assert.equal(calls2.length, 1);
});

test("getLoginSourceStatus：两种状态如实报告", async () => {
  const okFetch = (async () => neteaseJson("s")) as unknown as typeof fetch;
  const loggedIn = new MediaMusicService(wsStub, okFetch, cookieStore([{ name: "MUSIC_U", value: "t" }]));
  const statusIn = await loggedIn.getLoginSourceStatus("u1");
  assert.equal(statusIn.loggedIn, true);
  assert.equal(statusIn.source, "netease_login");

  const loggedOut = new MediaMusicService(wsStub, okFetch, cookieStore(new Error("no session")));
  const statusOut = await loggedOut.getLoginSourceStatus("u1");
  assert.equal(statusOut.loggedIn, false);
  assert.equal(statusOut.source, "anonymous");
  assert.match(statusOut.detail, /匿名音源/);
});

test("play：匿名音源解析失败时提示接入登录音源的可能", async () => {
  // 该曲目无版权：匿名路径失败且 urlError 附带登录音源提示
  const { fetchImpl } = makeFetchSpy(() => neteaseJson("null"));
  const svc = new MediaMusicService(wsStub, fetchImpl, cookieStore(new Error("no session")));
  declareClientCapabilities("user-play-vip", { mediaPlayback: true });
  const res = await svc.play("990004", "user-play-vip", { name: "VIP 曲", artist: "某歌手" });
  assert.equal(res.ok, true); // 事件仍下发（客户端如实展示无法播放）
  assert.equal((res as { urlError?: string }).url, undefined);
  assert.match((res as { urlError: string }).urlError, /匿名音源/);
});
