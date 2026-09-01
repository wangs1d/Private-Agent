import { ServerEventType } from "../protocol.js";
import type { ClientPushPort } from "../ports/client-push-port.js";

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
 *   - 实际音频流由客户端拉取（网易云搜索 API 不直接返回可播放 URL，客户端可按 trackId
 *     自行调 v1/song/url 或 song/detail 拉流）。
 *   - 服务端只做"控制信令"下发，不代理音频流，避免版权与带宽问题。
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

export class MediaMusicService {
  /** actorId → 当前播放状态。 */
  private readonly states = new Map<string, MediaNowPlayingState>();

  constructor(private readonly wsRegistry: ClientPushPort) {}

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
   * 播放指定曲目：更新内存播放状态 + 推 `agent.media.play` WS 事件给客户端。
   *
   * @param trackId 曲目 ID（来自 media.search）
   * @param actorId 用户标识
   * @param trackInfo 可选曲目元数据（用于客户端 UI 显示；未提供时仅推 trackId）
   *
   * @returns 成功返回 `{ ok: true, pushed }`；失败返回 `{ ok: false, error }`。
   *          pushed=false 表示用户当前离线（未连接 WebSocket），状态已记录但事件未送达。
   */
  async play(
    trackId: string,
    actorId: string,
    trackInfo?: MediaTrackInfo,
  ): Promise<{ ok: true; pushed: boolean } | { ok: false; error: string }> {
    if (!trackId) return { ok: false, error: "trackId 不能为空" };
    if (!actorId) return { ok: false, error: "actorId 不能为空" };

    const now = Date.now();
    const state: MediaNowPlayingState = {
      trackId,
      trackName: trackInfo?.name,
      artist: trackInfo?.artist,
      album: trackInfo?.album,
      durationSec: trackInfo?.durationSec,
      url: trackInfo?.url,
      paused: false,
      startedAt: now,
    };
    this.states.set(actorId, state);

    const pushed = this.wsRegistry.trySend(
      actorId,
      JSON.stringify({
        type: ServerEventType.AgentMediaPlay,
        payload: {
          actorId,
          track: {
            id: trackId,
            name: trackInfo?.name ?? null,
            artist: trackInfo?.artist ?? null,
            album: trackInfo?.album ?? null,
            durationSec: trackInfo?.durationSec ?? null,
            url: trackInfo?.url ?? null,
          },
          timestamp: new Date(now).toISOString(),
        },
      }),
    );

    return { ok: true, pushed };
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
