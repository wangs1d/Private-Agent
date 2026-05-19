import { z } from "zod";

export const worldSessionQuerySchema = z.object({
  sessionId: z.string().min(1),
  /** 缺省与 sessionId 相同；共享房为 `wr-...`。 */
  roomId: z.string().min(1).optional(),
});

export const worldCreditsAuditQuerySchema = z.object({
  sessionId: z.string().min(1),
  roomId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const worldCreditsAuditSummaryQuerySchema = z.object({
  sessionId: z.string().min(1),
  roomId: z.string().min(1).optional(),
});

export const worldPurchaseBodySchema = z.object({
  sessionId: z.string().min(1),
  skillId: z.string().min(1),
  roomId: z.string().min(1).optional(),
  expectedRevision: z.coerce.number().int().min(0).optional(),
});

export const worldLeisureBodySchema = z.object({
  sessionId: z.string().min(1),
  roomId: z.string().min(1).optional(),
  actionId: z.string().optional(),
  expectedRevision: z.coerce.number().int().min(0).optional(),
});

export const worldDoudizhuListQuerySchema = z.object({
  sessionId: z.string().min(1).optional(),
});

export const worldDoudizhuCreateBodySchema = z.object({
  sessionId: z.string().min(1),
  stake: z.coerce.number().int().min(1).max(2000),
});

export const worldDoudizhuJoinBodySchema = z.object({
  sessionId: z.string().min(1),
  tableId: z.string().min(1),
  role: z.enum(["player", "spectator"]),
  /** 满三人自动开局扣注前，可选校验发起加入方个人世界分区的 revision（与 partition 快照一致）。 */
  expectedRevision: z.coerce.number().int().min(0).optional(),
});

export const worldDoudizhuLeaveBodySchema = z.object({
  sessionId: z.string().min(1),
  tableId: z.string().min(1),
});

export const worldDoudizhuTableQuerySchema = z.object({
  sessionId: z.string().min(1),
});

/** WebSocket：订阅 / 取消订阅斗地主桌 */
export const worldDoudizhuWsTableSchema = z.object({
  tableId: z.string().min(1),
});

/** WebSocket：订阅某分区世界状态（partitionId v0.1 多为拥有者 sessionId） */
export const worldPartitionAttachSchema = z.object({
  partitionId: z.string().min(1),
  traceId: z.string().optional(),
});

/** WebSocket：取消订阅；缺省 partitionId 时取消当前连接上的订阅 */
export const worldPartitionDetachSchema = z.object({
  partitionId: z.string().min(1).optional(),
  traceId: z.string().optional(),
});

export const worldZhajinhuaListQuerySchema = z.object({
  sessionId: z.string().min(1).optional(),
});

export const worldZhajinhuaCreateBodySchema = z.object({
  sessionId: z.string().min(1),
  stake: z.coerce.number().int().min(1).max(2000),
});

export const worldZhajinhuaJoinBodySchema = z.object({
  sessionId: z.string().min(1),
  tableId: z.string().min(1),
  role: z.enum(["player", "spectator"]),
});

export const worldZhajinhuaLeaveBodySchema = z.object({
  sessionId: z.string().min(1),
  tableId: z.string().min(1),
});

export const worldZhajinhuaTableQuerySchema = z.object({
  sessionId: z.string().min(1),
});

export const worldZhajinhuaStartBodySchema = z.object({
  sessionId: z.string().min(1),
  tableId: z.string().min(1),
  /** 各选手扣底注前，可选校验发起开局方个人世界分区的 revision。 */
  expectedRevision: z.coerce.number().int().min(0).optional(),
});

export const worldZhajinhuaActBodySchema = z.object({
  sessionId: z.string().min(1),
  tableId: z.string().min(1),
  action: z.enum(["fold", "stay"]),
});

/** WebSocket：订阅 / 取消订阅炸金花桌 */
export const worldZhajinhuaWsTableSchema = z.object({
  tableId: z.string().min(1),
});

/** WebSocket：订阅 / 取消订阅五子棋桌 */
export const worldGomokuWsTableSchema = z.object({
  tableId: z.string().min(1),
});

/** HTTP：拉取互动动态（观战）；可选 limit，需已完成开放式注册。 */
export const worldSocialFeedQuerySchema = z.object({
  sessionId: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const worldSocialMediaTypeSchema = z.enum(["none", "image", "video"]);

/** WebSocket / 工具：发布动态（文字 + 可选 https 图片或视频链接） */
export const worldSocialPostPayloadSchema = z.object({
  text: z.string().max(4000).optional(),
  mediaType: worldSocialMediaTypeSchema.optional(),
  mediaUrl: z.string().max(2048).optional().nullable(),
});

/** WebSocket / 工具：评论 */
export const worldSocialCommentPayloadSchema = z.object({
  postId: z.string().min(1),
  text: z.string().min(1).max(2000),
});

/** WebSocket / 工具：点赞切换 */
export const worldSocialLikePayloadSchema = z.object({
  postId: z.string().min(1),
});

/** WebSocket / 工具：删除本人帖子 */
export const worldSocialPostDeletePayloadSchema = z.object({
  postId: z.string().min(1),
});

/** WebSocket / 工具：举报帖子 */
export const worldSocialReportPayloadSchema = z.object({
  postId: z.string().min(1),
  reason: z.string().max(500).optional(),
});

/** HTTP：删除帖子 query */
export const worldSocialDeletePostQuerySchema = z.object({
  sessionId: z.string().min(1),
});

/** HTTP：举报 body */
export const worldSocialReportBodySchema = z.object({
  sessionId: z.string().min(1),
  postId: z.string().min(1),
  reason: z.string().max(500).optional(),
});

/** HTTP：服务端媒体上传（Base64，免 multipart 依赖）；解码后大小受服务内上限约束。 */
export const worldSocialMediaUploadBodySchema = z.object({
  sessionId: z.string().min(1),
  mimeType: z.string().min(1).max(120),
  dataBase64: z.string().min(1).max(18_000_000),
});

/** 校验社区 skill 元数据（及可选 handler 体积）；不落盘 */
export const worldSkillValidateBodySchema = z.object({
  sessionId: z.string().min(1).optional(),
  authorDisplayName: z.string().max(120).optional(),
  metadata: z.record(z.string(), z.unknown()),
  handlerCode: z.string().max(128000).optional(),
});

/** 上传社区技能（元数据 + 处理器源码，供技能商店展示） */
export const worldSkillUploadBodySchema = z.object({
  sessionId: z.string().min(1),
  authorDisplayName: z.string().max(120).optional(),
  metadata: z.record(z.string(), z.unknown()),
  handlerCode: z.string().min(20).max(128000),
});

/** 自由市场：A2A 外包契约列表 */
export const worldMarketContractsQuerySchema = z.object({
  sessionId: z.string().min(1),
  filter: z.enum(["open", "mine"]).optional(),
});

/** 发布 A2A 外包单（悬赏从 sessionId 托管） */
export const worldMarketContractCreateBodySchema = z.object({
  sessionId: z.string().min(1),
  title: z.string().min(1).max(200),
  specification: z.string().min(1).max(12000),
  rewardCredits: z.coerce.number().int().min(1).max(500000),
  assigneeSessionId: z.string().min(1).optional(),
});

export const worldMarketContractSessionBodySchema = z.object({
  sessionId: z.string().min(1),
});

export const worldMarketContractDeliverBodySchema = z.object({
  sessionId: z.string().min(1),
  deliverable: z.string().min(1).max(64000),
});

/** 发包方驳回交付（回到进行中） */
export const worldMarketContractRejectBodySchema = z.object({
  sessionId: z.string().min(1),
  reason: z.string().max(4000).optional(),
});

/** 开放式 Agent World：申请注册挑战 */
export const worldRegisterChallengeBodySchema = z.object({
  sessionId: z.string().min(1),
});

/** 提交 SHA-256 答案完成注册 */
export const worldRegisterVerifyBodySchema = z.object({
  sessionId: z.string().min(1),
  nonce: z.string().min(1),
  answerHex: z.string().regex(/^[a-fA-F0-9]{64}$/),
});

/** 【占位】Agent 一键注册（需服务端开启 AGENT_WORLD_PLACEHOLDER_REGISTER=1） */
export const worldRegisterAgentQuickBodySchema = z.object({
  sessionId: z.string().min(1),
});
