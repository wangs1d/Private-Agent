import { ServerEventType } from "../protocol.js";
import type { AgentMediaPlayPayload } from "../protocol.js";
import type { ClientPushPort } from "../ports/client-push-port.js";
import { clientSupportsMediaPlayback } from "./client-capability-registry.js";

/**
 * 媒体音乐播放服务。
 *
 * 职责：
 *   - {@link searchTracks}：调网易云开放搜索 API（无需鉴权），返回曲目列表
 *   - {@link play} / {@link pause} / {@link resume} / {@link stop}：
 *     通过 {@link ClientPushPort.trySend} 推 `agent.media.*` 事件给客户端
 *   - {@link getNowPlaying}：查询内存 Map<actorId, NowPlayingState>
 *
 * 设计要点：
 *   - 播放状态仅存内存（Map<actorId, state>），进程重启后清空。媒体播放本身是短时态，
 *     不需要持久化；客户端断线重连后可调 media.now_playing 重新拉取。
 *   - 播放 URL 由服务端统一解析（{@link resolveTrackUrl}，调网易云 song/enhance/player/url
 *     公开接口），随 `agent.media.play` 事件一并下发——历史上服务端只发 trackId、指望
 *     客户端自己拉流，但客户端从未实现这一步，导致信令发了却永远不出声。
 *     URL 解析失败（无版权/超时）时事件仍下发（带 urlError），客户端能如实展示
 *     "无法播放"而不是黑屏假死；media.play 工具返回值同步如实告知模型。
 *   - 服务端默认不代理音频流（版权与带宽考量）；但提供 /api/media/stream-proxy
 *     （routes/http/media.ts）作客户端直连失败时的兜底，且仅按 trackId 解析后转发，
 *     不做任意 URL 开放代理。
 *   - 与 {@link VoiceCapabilityService} 区别：voice.* 是 Agent 自身合成语音播报给用户，
 *     media.* 是控制客户端播放第三方音乐流。
 */

/** 单首曲目元数据（搜索结果 / 播放载荷共用）。 */
export interface MediaTrack {
  id: string;
  name: string;
  artist: string;
  album: string;
  durationSec: number;
  /** 可选播放 URL（网易云搜索 API 通常不直接返回，预留字段）。 */
  url?: string;
}

/** 当前播放状态（内存存储）。 */
export interface MediaNowPlayingState {
  trackId: string;
  trackName?: string;
  artist?: string;
  album?: string;
  durationSec?: number;
  url?: string;
  paused: boolean;
  /** play 调用的 epoch ms（客户端可据此估算播放进度）。 */
  startedAt: number;
  /** 若当前处于暂停，记录暂停时间。 */
  pausedAt?: number;
}

/** play() 第三参数的可选曲目元数据（用于客户端 UI 显示）。 */
export interface MediaTrackInfo {
  name?: string;
  artist?: string;
  album?: string;
  durationSec?: number;
  url?: string;
}

const NETEASE_SEARCH_ENDPOINT = "https://music.163.com/api/search/get";
const NETEASE_SONG_URL_ENDPOINT = "https://music.163.com/api/song/enhance/player/url";

/** 播放 URL 解析结果（resolveTrackPlayUrl 的返回）。 */
export type TrackUrlResolution =
  | { ok: true; url: string }
  | { ok: false; error: string };

/** URL 缓存条目：url=null 表示"该曲目无版权/不可播"的负缓存（同样防重复打接口）。 */
interface TrackUrlCacheEntry {
  url: string | null;
  cachedAt: number;
}

/**
 * 播放 URL 的进程内 LRU 缓存：最多 200 条，TTL 30 分钟。
 *
 * 为什么缓存：同一首歌短时间内反复 play/pause/resume 很常见，而网易云接口对
 * 高频请求不友好；负缓存（url=null）同样缓存，避免对无版权曲目反复打接口。
 */
const TRACK_URL_CACHE_MAX = 200;
const TRACK_URL_CACHE_TTL_MS = 30 * 60_000;
const trackUrlCache = new Map<string, TrackUrlCacheEntry>();

/** 取缓存并按 LRU 语义刷新热度（Map 迭代序 = 插入序，重插即提到最新）。 */
function getCachedTrackUrl(trackId: string): TrackUrlCacheEntry | undefined {
  const entry = trackUrlCache.get(trackId);
  if (!entry) return undefined;
  if (Date.now() - entry.cachedAt > TRACK_URL_CACHE_TTL_MS) {
    trackUrlCache.delete(trackId);
    return undefined;
  }
  trackUrlCache.delete(trackId);
  trackUrlCache.set(trackId, entry);
  return entry;
}

function setCachedTrackUrl(trackId: string, url: string | null): void {
  trackUrlCache.delete(trackId);
  trackUrlCache.set(trackId, { url, cachedAt: Date.now() });
  while (trackUrlCache.size > TRACK_URL_CACHE_MAX) {
    const oldest = trackUrlCache.keys().next().value;
    if (oldest === undefined) break;
    trackUrlCache.delete(oldest);
  }
}

/**
 * 按曲目 ID 解析可播放 URL（独立导出，供 /api/media/stream-proxy 路由复用，
 * 与 MediaMusicService 共享同一份 LRU 缓存）。
 *
 * 调网易云公开接口（无需鉴权）：
 *   GET https://music.163.com/api/song/enhance/player/url?ids=[<id>]&br=320000
 *
 * 返回 `data[0].url`：null 表示无版权 / 仅 VIP / 地区限制——这是上游的如实结论，
 * 必须透传为失败，绝不能编造一个 URL 假装可以播。
 *
 * @param fetchImpl 可注入 fetch（测试 mock 用）；默认全局 fetch。
 */
export async function resolveTrackPlayUrl(
  trackId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TrackUrlResolution> {
  const id = String(trackId ?? "").trim();
  if (!/^\d+$/.test(id)) {
    return { ok: false, error: `trackId 无效（应为纯数字网易云曲目 ID）：${id}` };
  }

  const cached = getCachedTrackUrl(id);
  if (cached) {
    return cached.url
      ? { ok: true, url: cached.url }
      : { ok: false, error: "该曲目无可播放 URL（无版权/仅 VIP/地区限制）" };
  }

  const url = `${NETEASE_SONG_URL_ENDPOINT}?ids=[${id}]&br=320000`;
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; PrivateAgent/1.0)",
        Accept: "application/json",
        Referer: "https://music.163.com",
      },
      // 10s 超时：媒体播放是交互场景，超过 10s 用户早已认为失败
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      return { ok: false, error: `网易云播放地址请求失败：HTTP ${res.status} ${res.statusText}` };
    }
    const data = (await res.json()) as {
      code?: number;
      data?: Array<{ id?: number; url?: string | null; code?: number; type?: string }>;
    };
    const item = data.data?.[0];
    const playUrl = typeof item?.url === "string" ? item.url.trim() : "";
    if (!playUrl) {
      // 负缓存：无版权结论短期不会变，缓存住避免反复打接口
      setCachedTrackUrl(id, null);
      return { ok: false, error: "该曲目无可播放 URL（无版权/仅 VIP/地区限制）" };
    }
    setCachedTrackUrl(id, playUrl);
    return { ok: true, url: playUrl };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // 超时/网络错误不缓存：可能瞬时抖动，下次重试
    return { ok: false, error: `网易云播放地址解析失败：${msg}` };
  }
}

/** play() 成功分支的返回（url/urlError 如实透出，供工具返回值向模型告知）。 */
export type MediaPlayOkResult = {
  ok: true;
  pushed: boolean;
  /** 解析成功的可播放 URL（trackInfo 直接给 url 时原样透传）。 */
  url?: string;
  /** URL 解析失败原因；存在时客户端大概率无法真正出声。 */
  urlError?: string;
};

export class MediaMusicService {
  /** actorId → 当前播放状态。 */
  private readonly states = new Map<string, MediaNowPlayingState>();

  /** 可注入 fetch（测试 mock）；默认全局 fetch。 */
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly wsRegistry: ClientPushPort,
    fetchImpl?: typeof fetch,
  ) {
    this.fetchImpl = fetchImpl ?? fetch;
  }

  /**
   * 按曲目 ID 解析可播放 URL（带 LRU 缓存）。
   *
   * @returns 成功返回 `{ ok: true, url }`；无版权/接口失败返回 `{ ok: false, error }`。
   */
  async resolveTrackUrl(trackId: string): Promise<TrackUrlResolution> {
    return resolveTrackPlayUrl(trackId, this.fetchImpl);
  }

  /**
   * 搜索曲目。
   *
   * 调用网易云公开搜索 API（无需鉴权）：
   *   GET https://music.163.com/api/search/get?s=<query>&type=1&offset=0&limit=<limit>
   *
   * type=1 表示单曲；返回 songs 数组含 id / name / artists / album / duration(ms)。
   *
   * @returns 成功返回 `{ ok: true, tracks }`；失败返回 `{ ok: false, error }`。
   */
  async searchTracks(
    query: string,
    limit = 10,
  ): Promise<{ ok: true; tracks: MediaTrack[] } | { ok: false; error: string }> {
    const q = query.trim();
    if (!q) return { ok: false, error: "搜索关键词不能为空" };

    const safeLimit = Math.max(1, Math.min(20, Math.floor(limit || 10)));
    const url = `${NETEASE_SEARCH_ENDPOINT}?s=${encodeURIComponent(q)}&type=1&offset=0&limit=${safeLimit}`;

    try {
      const res = await fetch(url, {
        method: "GET",
        headers: {
          // 网易云 API 对 UA 敏感，加常见浏览器 UA 兜底
          "User-Agent": "Mozilla/5.0 (compatible; PrivateAgent/1.0)",
          Accept: "application/json",
        },
      });
      if (!res.ok) {
        return { ok: false, error: `网易云搜索请求失败：HTTP ${res.status} ${res.statusText}` };
      }
      const data = (await res.json()) as {
        code?: number;
        result?: {
          songCount?: number;
          songs?: Array<{
            id: number;
            name: string;
            artists?: Array<{ id: number; name: string }>;
            artist?: { id: number; name: string };
            album?: { id: number; name: string };
            duration?: number;
          }>;
        };
      };

      if (data.code !== 200 || !data.result?.songs) {
        return { ok: false, error: `网易云搜索返回异常：code=${data.code ?? "unknown"}` };
      }

      const tracks: MediaTrack[] = data.result.songs.map((s) => {
        const artists = s.artists ?? (s.artist ? [s.artist] : []);
        const artistName = artists.map((a) => a.name).join(" / ") || "未知艺术家";
        return {
          id: String(s.id),
          name: s.name,
          artist: artistName,
          album: s.album?.name ?? "未知专辑",
          durationSec: s.duration ? Math.round(s.duration / 1000) : 0,
        };
      });

      return { ok: true, tracks };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: `网易云搜索调用异常：${msg}` };
    }
  }

  /**
   * 播放指定曲目：解析播放 URL → 更新内存播放状态 → 推 `agent.media.play` WS 事件。
   *
   * URL 解析失败（无版权/超时）不阻断事件下发：事件仍带 `urlError` 推出，客户端
   * 可如实展示"无法播放"；工具返回值同步带 `urlError`，让模型如实告知用户，
   * 而不是宣称"已经在放了"。
   *
   * @param trackId 曲目 ID（来自 media.search）
   * @param actorId 用户标识
   * @param trackInfo 可选曲目元数据（含外部直接给的 url 时跳过服务端解析）
   *
   * @returns 成功返回 `{ ok: true, pushed, url?, urlError? }`；失败返回 `{ ok: false, error }`。
   *          pushed=false 表示用户当前离线（未连接 WebSocket），状态已记录但事件未送达。
   */
  async play(
    trackId: string,
    actorId: string,
    trackInfo?: MediaTrackInfo,
  ): Promise<MediaPlayOkResult | { ok: false; error: string }> {
    if (!trackId) return { ok: false, error: "trackId 不能为空" };
    if (!actorId) return { ok: false, error: "actorId 不能为空" };
    // 能力门控（2026-09-12 诚实化）：客户端未声明 mediaPlayback 时不会消费
    // agent.media.play 事件——历史上 push「成功」后模型向用户宣称「歌已经放上了」，
    // 实际什么都没响。此处如实失败，让模型改走 desktop.open 等真实可达路径。
    if (!clientSupportsMediaPlayback(actorId)) {
      return {
        ok: false,
        error:
          "当前客户端未声明媒体播放能力（session.init capabilities.mediaPlayback），" +
          "下发播放指令不会真正出声。可改用 desktop.open 打开音乐应用播放，" +
          "或先在客户端接入媒体播放能力后再试。",
      };
    }

    // 播放 URL 解析：调用方（media.play 工具）通常拿不到可播放 URL（搜索接口不返回），
    // 服务端按 trackId 解析；调用方显式给 url 时直接采用（省一次上游请求）。
    let playUrl: string | null = null;
    let urlError: string | undefined;
    if (trackInfo?.url) {
      playUrl = trackInfo.url;
    } else {
      const resolved = await this.resolveTrackUrl(trackId);
      if (resolved.ok) {
        playUrl = resolved.url;
      } else {
        urlError = resolved.error;
      }
    }

    const now = Date.now();
    const state: MediaNowPlayingState = {
      trackId,
      trackName: trackInfo?.name,
      artist: trackInfo?.artist,
      album: trackInfo?.album,
      durationSec: trackInfo?.durationSec,
      url: playUrl ?? undefined,
      paused: false,
      startedAt: now,
    };
    this.states.set(actorId, state);

    // 事件 payload：扁平结构（trackId/title/artist/url/durationMs），与
    // packages/agent-protocol events.ts 的 AgentMediaPlayPayload 契约一致。
    const pushed = this.wsRegistry.trySend(
      actorId,
      JSON.stringify({
        type: ServerEventType.AgentMediaPlay,
        payload: {
          actorId,
          trackId,
          title: trackInfo?.name ?? null,
          artist: trackInfo?.artist ?? null,
          album: trackInfo?.album ?? null,
          url: playUrl,
          durationMs:
            trackInfo?.durationSec != null && trackInfo.durationSec > 0
              ? Math.round(trackInfo.durationSec * 1000)
              : null,
          ...(urlError ? { urlError } : {}),
          timestamp: new Date(now).toISOString(),
        } satisfies AgentMediaPlayPayload,
      }),
    );

    return playUrl
      ? { ok: true, pushed, url: playUrl }
      : { ok: true, pushed, urlError: urlError ?? "播放 URL 解析失败" };
  }

  /**
   * 暂停：推 `agent.media.pause` 事件，更新内存状态为 paused=true。
   *
   * @returns 失败（无播放 / 已暂停）返回 `{ ok: false, error }`。
   */
  pause(actorId: string): { ok: true; pushed: boolean } | { ok: false; error: string } {
    const state = this.states.get(actorId);
    if (!state) return { ok: false, error: "当前没有正在播放的曲目" };
    if (state.paused) return { ok: false, error: "当前已处于暂停状态" };

    state.paused = true;
    state.pausedAt = Date.now();

    const pushed = this.wsRegistry.trySend(
      actorId,
      JSON.stringify({
        type: ServerEventType.AgentMediaPause,
        payload: { actorId, trackId: state.trackId, timestamp: new Date().toISOString() },
      }),
    );
    return { ok: true, pushed };
  }

  /**
   * 恢复：推 `agent.media.resume` 事件，更新内存状态为 paused=false。
   *
   * @returns 失败（无播放 / 未暂停）返回 `{ ok: false, error }`。
   */
  resume(actorId: string): { ok: true; pushed: boolean } | { ok: false; error: string } {
    const state = this.states.get(actorId);
    if (!state) return { ok: false, error: "当前没有正在播放的曲目" };
    if (!state.paused) return { ok: false, error: "当前未处于暂停状态" };

    state.paused = false;
    state.pausedAt = undefined;

    const pushed = this.wsRegistry.trySend(
      actorId,
      JSON.stringify({
        type: ServerEventType.AgentMediaResume,
        payload: { actorId, trackId: state.trackId, timestamp: new Date().toISOString() },
      }),
    );
    return { ok: true, pushed };
  }

  /**
   * 停止：推 `agent.media.stop` 事件，从内存中清除该 actor 的播放状态。
   *
   * 与 {@link pause} 区别：pause 保留状态可 resume，stop 完全清空。
   */
  stop(actorId: string): { ok: true; pushed: boolean } | { ok: false; error: string } {
    const state = this.states.get(actorId);
    if (!state) return { ok: false, error: "当前没有正在播放的曲目" };

    const pushed = this.wsRegistry.trySend(
      actorId,
      JSON.stringify({
        type: ServerEventType.AgentMediaStop,
        payload: { actorId, trackId: state.trackId, timestamp: new Date().toISOString() },
      }),
    );
    this.states.delete(actorId);
    return { ok: true, pushed };
  }

  /** 查询当前播放状态（无播放时返回 null）。 */
  getNowPlaying(actorId: string): MediaNowPlayingState | null {
    return this.states.get(actorId) ?? null;
  }
}
