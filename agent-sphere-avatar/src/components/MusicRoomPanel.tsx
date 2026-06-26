interface MusicRoomTrack {
  id: string;
  title: string;
  artist: string;
  url: string;
  durationSec: number;
}

interface MusicRoomSnapshot {
  roomId: string;
  currentTrack: MusicRoomTrack | null;
  isPlaying: boolean;
  positionSec: number;
  lastUpdatedAt: number;
  participants: string[];
  playlist: Array<{ id: string; title: string; artist: string }>;
  currentTrackIndex: number;
}

interface MusicRoomPanelProps {
  open: boolean;
  snapshot: MusicRoomSnapshot | null;
  onPlay: () => void;
  onPause: () => void;
  onNext: () => void;
  onClose: () => void;
}

function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** 一起听：迷你音乐播放器浮层 */
export function MusicRoomPanel({ open, snapshot, onPlay, onPause, onNext, onClose }: MusicRoomPanelProps) {
  if (!open || !snapshot) return null;

  const track = snapshot.currentTrack;
  const duration = track?.durationSec ?? 0;
  const position = Math.max(0, Math.min(snapshot.positionSec, duration || snapshot.positionSec));
  const progress = duration > 0 ? Math.min(100, (position / duration) * 100) : 0;

  return (
    <div className="music-room-panel" role="dialog" aria-label="一起听音乐房间">
      <div className="music-room-panel__header">
        <div className="music-room-panel__title">
          <span className="music-room-panel__title-icon">🎵</span>
          <span>一起听</span>
          <span className="music-room-panel__room-id">#{snapshot.roomId.slice(-6)}</span>
        </div>
        <button
          type="button"
          className="music-room-panel__close"
          onClick={onClose}
          aria-label="关闭"
        >
          ×
        </button>
      </div>

      <div className="music-room-panel__track">
        <div className="music-room-panel__track-icon">{snapshot.isPlaying ? "🎶" : "🎵"}</div>
        <div className="music-room-panel__track-info">
          <div className="music-room-panel__track-title">
            {track ? track.title : "暂无曲目"}
          </div>
          <div className="music-room-panel__track-artist">
            {track ? track.artist : "—"}
          </div>
        </div>
      </div>

      <div className="music-room-panel__progress">
        <div className="music-room-panel__progress-bar">
          <div className="music-room-panel__progress-fill" style={{ width: `${progress}%` }} />
        </div>
        <div className="music-room-panel__progress-time">
          <span>{formatTime(position)}</span>
          <span>{formatTime(duration)}</span>
        </div>
      </div>

      <div className="music-room-panel__controls">
        <button
          type="button"
          className="music-room-panel__btn"
          onClick={snapshot.isPlaying ? onPause : onPlay}
          disabled={!track}
          aria-label={snapshot.isPlaying ? "暂停" : "播放"}
        >
          {snapshot.isPlaying ? "⏸" : "▶"}
        </button>
        <button
          type="button"
          className="music-room-panel__btn"
          onClick={onNext}
          disabled={!track}
          aria-label="下一首"
        >
          ⏭
        </button>
      </div>

      {snapshot.participants.length > 0 && (
        <div className="music-room-panel__participants">
          <span className="music-room-panel__participants-count">
            {snapshot.participants.length} 人在听
          </span>
          <ul className="music-room-panel__participants-list">
            {snapshot.participants.map((p, i) => (
              <li key={`${p}-${i}`} className="music-room-panel__participant">
                <span className="music-room-panel__participant-dot" />
                {p}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
