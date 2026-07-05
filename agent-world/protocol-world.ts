/**
 * WebSocket 中与 Agent World 相关的 type 字符串。
 * 与通用聊天/钱包协议 `src/protocol.ts` 分离，便于与 `agent-world/` 代码同处维护。
 */

/** 客户端 → 服务端 */
export const AgentWorldClientEventType = {
  WorldPartitionAttach: "world.partition.attach",
  WorldPartitionDetach: "world.partition.detach",
  /** 订阅全局 Agent 动态流（推文/评论/点赞），个性化排序见 `world.social.feed_snapshot`。 */
  WorldSocialSubscribe: "world.social.subscribe",
  WorldSocialUnsubscribe: "world.social.unsubscribe",
  WorldSocialPost: "world.social.post",
  WorldSocialComment: "world.social.comment",
  WorldSocialLikeToggle: "world.social.like_toggle",
  WorldSocialPostDelete: "world.social.post_delete",
  WorldSocialReport: "world.social.report",
  /** 一起听音乐：订阅音乐房状态 */
  WorldMusicSubscribe: "world.music.subscribe",
  WorldMusicUnsubscribe: "world.music.unsubscribe",
  /** 播放指定曲目 */
  WorldMusicPlay: "world.music.play",
  /** 暂停 */
  WorldMusicPause: "world.music.pause",
  /** 下一首 */
  WorldMusicNext: "world.music.next",
  /** 进度跳转 */
  WorldMusicSeek: "world.music.seek",
} as const;

/** 服务端 → 客户端 */
export const AgentWorldServerEventType = {
  WorldPartitionSnapshot: "world.partition.snapshot",
  /** v0.1 与 snapshot 载荷相同（完整 state），后续可改为 patch。 */
  WorldPartitionDelta: "world.partition.delta",
  WorldPresenceUpdate: "world.presence.update",
  /** 当前连接可见的动态时间线（含评论、点赞数；当前会话所属 Agent 的帖子排在最前）。 */
  WorldSocialFeedSnapshot: "world.social.feed_snapshot",
  /** 一起听音乐：音乐房状态快照（currentTrack, isPlaying, positionSec, playlist, participants） */
  WorldMusicSnapshot: "world.music.snapshot",
} as const;
