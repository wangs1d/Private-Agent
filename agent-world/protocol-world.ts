/**
 * WebSocket 中与 Agent World（斗地主等）相关的 type 字符串。
 * 与通用聊天/钱包协议 `src/protocol.ts` 分离，便于与 `agent-world/` 代码同处维护。
 */

/** 客户端 → 服务端 */
export const AgentWorldClientEventType = {
  WorldPartitionAttach: "world.partition.attach",
  WorldPartitionDetach: "world.partition.detach",
  WorldDoudizhuSubscribe: "world.doudizhu.subscribe",
  WorldDoudizhuUnsubscribe: "world.doudizhu.unsubscribe",
  WorldDoudizhuSubscribeLobby: "world.doudizhu.subscribe_lobby",
  WorldDoudizhuUnsubscribeLobby: "world.doudizhu.unsubscribe_lobby",
  WorldZhajinhuaSubscribe: "world.zhajinhua.subscribe",
  WorldZhajinhuaUnsubscribe: "world.zhajinhua.unsubscribe",
  WorldZhajinhuaSubscribeLobby: "world.zhajinhua.subscribe_lobby",
  WorldZhajinhuaUnsubscribeLobby: "world.zhajinhua.unsubscribe_lobby",
  WorldGomokuSubscribe: "world.gomoku.subscribe",
  WorldGomokuUnsubscribe: "world.gomoku.unsubscribe",
  WorldGomokuSubscribeLobby: "world.gomoku.subscribe_lobby",
  WorldGomokuUnsubscribeLobby: "world.gomoku.unsubscribe_lobby",
  /** 订阅全局 Agent 动态流（推文/评论/点赞），个性化排序见 `world.social.feed_snapshot`。 */
  WorldSocialSubscribe: "world.social.subscribe",
  WorldSocialUnsubscribe: "world.social.unsubscribe",
  WorldSocialPost: "world.social.post",
  WorldSocialComment: "world.social.comment",
  WorldSocialLikeToggle: "world.social.like_toggle",
  WorldSocialPostDelete: "world.social.post_delete",
  WorldSocialReport: "world.social.report",
} as const;

/** 服务端 → 客户端 */
export const AgentWorldServerEventType = {
  WorldPartitionSnapshot: "world.partition.snapshot",
  /** v0.1 与 snapshot 载荷相同（完整 state），后续可改为 patch。 */
  WorldPartitionDelta: "world.partition.delta",
  WorldPresenceUpdate: "world.presence.update",
  WorldDoudizhuSnapshot: "world.doudizhu.snapshot",
  WorldDoudizhuLobbySnapshot: "world.doudizhu.lobby_snapshot",
  WorldZhajinhuaSnapshot: "world.zhajinhua.snapshot",
  WorldZhajinhuaLobbySnapshot: "world.zhajinhua.lobby_snapshot",
  WorldGomokuSnapshot: "world.gomoku.snapshot",
  WorldGomokuLobbySnapshot: "world.gomoku.lobby_snapshot",
  /** Agent 在五子棋对局中的口语化旁白（嘲讽、吐槽、求饶等） */
  WorldGomokuBanter: "world.gomoku.banter",
  /** 当前连接可见的动态时间线（含评论、点赞数；当前会话所属 Agent 的帖子排在最前）。 */
  WorldSocialFeedSnapshot: "world.social.feed_snapshot",
} as const;
