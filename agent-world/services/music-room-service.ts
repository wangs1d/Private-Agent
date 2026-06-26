import { randomBytes } from "node:crypto";

import type { WsConnectionRegistryLike } from "../host-types.js";
import { AgentWorldServerEventType } from "../protocol-world.js";
import type { WorldService } from "./world-service.js";

/** 占位歌单：SoundHelix 免费样本，后续可替换为真实音乐 API。 */
const PLACEHOLDER_PLAYLIST: MusicTrack[] = [
  {
    id: "track_01",
    title: "Midnight Echoes",
    artist: "SoundHelix",
    url: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3",
    durationSec: 372,
  },
  {
    id: "track_02",
    title: "Neon Drift",
    artist: "SoundHelix",
    url: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3",
    durationSec: 426,
  },
  {
    id: "track_03",
    title: "Ocean Pulse",
    artist: "SoundHelix",
    url: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-3.mp3",
    durationSec: 348,
  },
  {
    id: "track_04",
    title: "Crystal Dreams",
    artist: "SoundHelix",
    url: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-4.mp3",
    durationSec: 402,
  },
  {
    id: "track_05",
    title: "Electric Horizon",
    artist: "SoundHelix",
    url: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-5.mp3",
    durationSec: 390,
  },
];

export type MusicTrack = {
  id: string;
  title: string;
  artist: string;
  url: string;
  durationSec: number;
};

export type MusicRoomSummary = {
  roomId: string;
  createdBy: string;
  participantCount: number;
  isPlaying: boolean;
  currentTrackTitle: string | null;
};

type MusicRoom = {
  id: string;
  createdBy: string;
  participants: Set<string>;
  playlist: MusicTrack[];
  currentTrackIndex: number;
  isPlaying: boolean;
  positionSec: number;
  /** 最后一次状态更新的时间戳（用于客户端推算当前播放进度）。 */
  lastUpdatedAt: number;
};

function newRoomId(): string {
  return `mr_${randomBytes(6).toString("hex")}`;
}

export class MusicRoomService {
  private readonly rooms = new Map<string, MusicRoom>();
  /** roomId → 订阅该房间快照的 sessionId 集合。 */
  private readonly watchers = new Map<string, Set<string>>();
  private wsRegistry: WsConnectionRegistryLike | null = null;

  constructor(private readonly worldService: WorldService) {}

  /** 绑定 WebSocket 注册表后，状态变更会向在线会话推送 `world.music.snapshot`。 */
  attachWebSocketRegistry(registry: WsConnectionRegistryLike): void {
    this.wsRegistry = registry;
  }

  /** 获取占位歌单（供外部展示与后续替换）。 */
  getPlaylist(): MusicTrack[] {
    return PLACEHOLDER_PLAYLIST;
  }

  listRooms(): MusicRoomSummary[] {
    return [...this.rooms.values()].map((r) => this.summarize(r));
  }

  /** 创建音乐房。 */
  createRoom(sessionId: string): { ok: true; room: MusicRoomSummary } | { ok: false; reason: string } {
    this.worldService.enterGameCenterScene(sessionId, "music_room");
    const id = newRoomId();
    const room: MusicRoom = {
      id,
      createdBy: sessionId,
      participants: new Set([sessionId]),
      playlist: [...PLACEHOLDER_PLAYLIST],
      currentTrackIndex: 0,
      isPlaying: false,
      positionSec: 0,
      lastUpdatedAt: Date.now(),
    };
    this.rooms.set(id, room);
    return { ok: true, room: this.summarize(room) };
  }

  /** 加入音乐房。 */
  joinRoom(
    roomId: string,
    sessionId: string,
  ): { ok: true; snapshot: Record<string, unknown> } | { ok: false; reason: string } {
    const room = this.rooms.get(roomId);
    if (!room) return { ok: false, reason: "音乐房不存在" };
    this.worldService.enterGameCenterScene(sessionId, "music_room");
    room.participants.add(sessionId);
    room.lastUpdatedAt = Date.now();
    this.notifyRoom(roomId);
    return { ok: true, snapshot: this.buildSnapshot(room, sessionId) };
  }

  /** 离开音乐房。 */
  leaveRoom(roomId: string, sessionId: string): { ok: true } | { ok: false; reason: string } {
    const room = this.rooms.get(roomId);
    if (!room) return { ok: false, reason: "音乐房不存在" };
    room.participants.delete(sessionId);
    this.watchers.get(roomId)?.delete(sessionId);
    // 所有参与者离开后清理房间
    if (room.participants.size === 0) {
      this.watchers.delete(roomId);
      this.rooms.delete(roomId);
    } else {
      room.lastUpdatedAt = Date.now();
      this.notifyRoom(roomId);
    }
    return { ok: true };
  }

  /** 播放指定曲目（trackId 可选，缺省为当前曲目）。 */
  play(
    roomId: string,
    sessionId: string,
    trackId?: string,
  ): { ok: true; snapshot: Record<string, unknown> } | { ok: false; reason: string } {
    const room = this.rooms.get(roomId);
    if (!room) return { ok: false, reason: "音乐房不存在" };
    if (!room.participants.has(sessionId)) return { ok: false, reason: "你不在该音乐房中" };

    if (trackId) {
      const idx = room.playlist.findIndex((t) => t.id === trackId);
      if (idx < 0) return { ok: false, reason: "曲目不存在" };
      room.currentTrackIndex = idx;
      room.positionSec = 0;
    }
    room.isPlaying = true;
    room.lastUpdatedAt = Date.now();
    this.notifyRoom(roomId);
    return { ok: true, snapshot: this.buildSnapshot(room, sessionId) };
  }

  /** 暂停播放。 */
  pause(roomId: string, sessionId: string): { ok: true; snapshot: Record<string, unknown> } | { ok: false; reason: string } {
    const room = this.rooms.get(roomId);
    if (!room) return { ok: false, reason: "音乐房不存在" };
    if (!room.participants.has(sessionId)) return { ok: false, reason: "你不在该音乐房中" };

    room.isPlaying = false;
    room.lastUpdatedAt = Date.now();
    this.notifyRoom(roomId);
    return { ok: true, snapshot: this.buildSnapshot(room, sessionId) };
  }

  /** 下一首。 */
  next(roomId: string, sessionId: string): { ok: true; snapshot: Record<string, unknown> } | { ok: false; reason: string } {
    const room = this.rooms.get(roomId);
    if (!room) return { ok: false, reason: "音乐房不存在" };
    if (!room.participants.has(sessionId)) return { ok: false, reason: "你不在该音乐房中" };

    room.currentTrackIndex = (room.currentTrackIndex + 1) % room.playlist.length;
    room.positionSec = 0;
    room.lastUpdatedAt = Date.now();
    this.notifyRoom(roomId);
    return { ok: true, snapshot: this.buildSnapshot(room, sessionId) };
  }

  /** 进度跳转。 */
  seek(
    roomId: string,
    sessionId: string,
    positionSec: number,
  ): { ok: true; snapshot: Record<string, unknown> } | { ok: false; reason: string } {
    const room = this.rooms.get(roomId);
    if (!room) return { ok: false, reason: "音乐房不存在" };
    if (!room.participants.has(sessionId)) return { ok: false, reason: "你不在该音乐房中" };

    const track = room.playlist[room.currentTrackIndex];
    const clamped = Math.max(0, Math.min(positionSec, track?.durationSec ?? 0));
    room.positionSec = clamped;
    room.lastUpdatedAt = Date.now();
    this.notifyRoom(roomId);
    return { ok: true, snapshot: this.buildSnapshot(room, sessionId) };
  }

  /** 获取音乐房快照。 */
  getSnapshot(roomId: string, sessionId: string): { ok: true; snapshot: Record<string, unknown> } | { ok: false; reason: string } {
    const room = this.rooms.get(roomId);
    if (!room) return { ok: false, reason: "音乐房不存在" };
    return { ok: true, snapshot: this.buildSnapshot(room, sessionId) };
  }

  /** 订阅音乐房 WS 推送。 */
  watchRoom(roomId: string, sessionId: string): { ok: true } | { ok: false; reason: string } {
    if (!this.rooms.has(roomId)) return { ok: false, reason: "音乐房不存在" };
    let set = this.watchers.get(roomId);
    if (!set) {
      set = new Set();
      this.watchers.set(roomId, set);
    }
    set.add(sessionId);
    this.sendSnapshotToSession(roomId, sessionId);
    return { ok: true };
  }

  unwatchRoom(roomId: string, sessionId: string): void {
    this.watchers.get(roomId)?.delete(sessionId);
  }

  private summarize(room: MusicRoom): MusicRoomSummary {
    const track = room.playlist[room.currentTrackIndex];
    return {
      roomId: room.id,
      createdBy: room.createdBy,
      participantCount: room.participants.size,
      isPlaying: room.isPlaying,
      currentTrackTitle: track?.title ?? null,
    };
  }

  private notifyRoom(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    const recipients = new Set<string>();
    for (const s of room.participants) recipients.add(s);
    const w = this.watchers.get(roomId);
    if (w) for (const s of w) recipients.add(s);
    for (const sid of recipients) {
      this.sendSnapshotToSession(roomId, sid);
    }
  }

  private sendSnapshotToSession(roomId: string, sessionId: string): void {
    if (!this.wsRegistry) return;
    const room = this.rooms.get(roomId);
    if (!room) return;
    const snapshot = this.buildSnapshot(room, sessionId);
    this.wsRegistry.trySend(
      sessionId,
      JSON.stringify({
        type: AgentWorldServerEventType.WorldMusicSnapshot,
        payload: { roomId, snapshot },
      }),
    );
  }

  private buildSnapshot(room: MusicRoom, viewerSessionId: string): Record<string, unknown> {
    const track = room.playlist[room.currentTrackIndex] ?? null;
    return {
      roomId: room.id,
      createdBy: room.createdBy,
      participants: [...room.participants],
      playlist: room.playlist,
      currentTrackIndex: room.currentTrackIndex,
      currentTrack: track,
      isPlaying: room.isPlaying,
      positionSec: room.positionSec,
      lastUpdatedAt: room.lastUpdatedAt,
      isParticipant: room.participants.has(viewerSessionId),
    };
  }
}
