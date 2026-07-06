import type { ToolHandler, ToolContext } from "../../tool-registry.js";
import { resolveActorId } from "../../../agent/actor-id.js";
import type { MediaMusicService } from "../../../services/media-music-service.js";

/**
 * media.* 工具 handler 工厂集合。
 *
 * 失败统一返回 `{ ok: false, error, retryable? }`；
 * 成功返回 `{ ok: true, ..., summary }`（summary 供 LLM 直接转述给用户）。
 */

/** media.search：搜索歌曲 / 艺术家 / 专辑。 */
export function createMediaSearchHandler(mediaMusicService: MediaMusicService): ToolHandler {
  return async (input) => {
    const query = String(input.query ?? "").trim();
    if (!query) {
      return { ok: false, error: "缺少 query（搜索关键词）" };
    }
    const limit =
      input.limit != null ? Math.max(1, Math.min(20, Number(input.limit))) : undefined;

    const result = await mediaMusicService.searchTracks(query, limit);
    if (!result.ok) {
      return { ok: false, error: result.error, retryable: true };
    }

    const preview = result.tracks
      .slice(0, 3)
      .map((t) => `${t.name} - ${t.artist}`)
      .join(" / ");

    return {
      ok: true,
      tracks: result.tracks,
      summary: `找到 ${result.tracks.length} 首曲目${preview ? `：${preview}` : ""}`,
    };
  };
}

/** media.play：让用户客户端播放指定曲目。 */
export function createMediaPlayHandler(mediaMusicService: MediaMusicService): ToolHandler {
  return async (input, context: ToolContext) => {
    const trackId = String(input.trackId ?? "").trim();
    if (!trackId) {
      return { ok: false, error: "缺少 trackId（请先调 media.search 获取）" };
    }
    const actorId = resolveActorId(context);

    // 可选元数据，用于客户端 UI 显示
    const trackInfo: {
      name?: string;
      artist?: string;
      album?: string;
      durationSec?: number;
      url?: string;
    } = {};
    if (input.trackName != null) trackInfo.name = String(input.trackName);
    if (input.artist != null) trackInfo.artist = String(input.artist);
    if (input.album != null) trackInfo.album = String(input.album);
    if (input.durationSec != null) {
      trackInfo.durationSec = Math.max(0, Math.floor(Number(input.durationSec)));
    }
    if (input.url != null) trackInfo.url = String(input.url);

    const result = await mediaMusicService.play(trackId, actorId, trackInfo);
    if (!result.ok) {
      return { ok: false, error: result.error, retryable: true };
    }

    const display = trackInfo.name
      ? `${trackInfo.name}${trackInfo.artist ? " - " + trackInfo.artist : ""}`
      : `track#${trackId}`;

    return {
      ok: true,
      pushed: result.pushed,
      trackId,
      summary: result.pushed
        ? `已下发播放指令到用户客户端：${display}。客户端会自动播放。`
        : `已记录播放状态，但用户当前离线（未连接 WebSocket），上线后可重发。`,
    };
  };
}

/** media.pause：暂停客户端播放。 */
export function createMediaPauseHandler(mediaMusicService: MediaMusicService): ToolHandler {
  return async (_input, context: ToolContext) => {
    const actorId = resolveActorId(context);
    const result = mediaMusicService.pause(actorId);
    if (!result.ok) {
      return { ok: false, error: result.error };
    }
    return {
      ok: true,
      pushed: result.pushed,
      summary: result.pushed
        ? "已下发暂停指令到用户客户端。"
        : "暂停已记录，但用户当前离线。",
    };
  };
}

/** media.resume：恢复已暂停的播放。 */
export function createMediaResumeHandler(mediaMusicService: MediaMusicService): ToolHandler {
  return async (_input, context: ToolContext) => {
    const actorId = resolveActorId(context);
    const result = mediaMusicService.resume(actorId);
    if (!result.ok) {
      return { ok: false, error: result.error };
    }
    return {
      ok: true,
      pushed: result.pushed,
      summary: result.pushed
        ? "已下发恢复播放指令到用户客户端。"
        : "恢复已记录，但用户当前离线。",
    };
  };
}

/** media.stop：停止播放并清空状态。 */
export function createMediaStopHandler(mediaMusicService: MediaMusicService): ToolHandler {
  return async (_input, context: ToolContext) => {
    const actorId = resolveActorId(context);
    const result = mediaMusicService.stop(actorId);
    if (!result.ok) {
      return { ok: false, error: result.error };
    }
    return {
      ok: true,
      pushed: result.pushed,
      summary: result.pushed
        ? "已下发停止指令到用户客户端，并清空播放状态。"
        : "已清空播放状态（用户离线）。",
    };
  };
}

/** media.now_playing：查询当前正在播放的曲目。 */
export function createMediaNowPlayingHandler(mediaMusicService: MediaMusicService): ToolHandler {
  return async (_input, context: ToolContext) => {
    const actorId = resolveActorId(context);
    const state = mediaMusicService.getNowPlaying(actorId);
    if (!state) {
      return {
        ok: true,
        playing: false,
        summary: "当前没有正在播放的曲目。",
      };
    }
    return {
      ok: true,
      playing: !state.paused,
      paused: state.paused,
      track: {
        id: state.trackId,
        name: state.trackName,
        artist: state.artist,
        album: state.album,
        durationSec: state.durationSec,
        url: state.url,
      },
      startedAt: state.startedAt,
      pausedAt: state.pausedAt,
      summary: state.paused
        ? `已暂停：${state.trackName ?? state.trackId} - ${state.artist ?? "未知"}`
        : `正在播放：${state.trackName ?? state.trackId} - ${state.artist ?? "未知"}`,
    };
  };
}
