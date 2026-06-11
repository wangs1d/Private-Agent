import { z } from "zod";

import { clientLocationWireSchema } from "../types/client-location.js";

const visionSourceKindSchema = z.enum(["device_camera", "external_stream", "agent_attachment"]);

/** WebSocket `chat.user_message` 可选附带视觉帧（与 {@link sanitizeVisionFramesFromWire} 对齐）。 */
export const visionFrameWireSchema = z.object({
  sourceKind: visionSourceKindSchema,
  sourceId: z.string().max(160).optional(),
  mimeType: z.string().min(3).max(120),
  dataBase64: z.string().min(1),
  capturedAt: z.string().max(64).optional(),
});

/** WebSocket `chat.agent_processing_ui`：与客户端「处理中」气泡/状态同步 */
export const agentProcessingUiSchema = z.object({
  sessionId: z.string().min(1),
  userId: z.string().min(1).optional(),
  active: z.boolean(),
});

/** WebSocket `agent.embodiment.interact` — 球形 Agent 用户交互 */
export const agentEmbodimentInteractSchema = z.object({
  sessionId: z.string().min(1),
  userId: z.string().min(1).optional(),
  action: z.enum(["focus", "wake", "chat"]),
  text: z.string().max(4000).optional(),
  agentAccessMode: z.enum(["sandbox", "full"]).optional(),
});

export const userMessageSchema = z
  .object({
    /** 兼容旧客户端；与 `userId` 同时存在时以 `userId` 为稳定用户标识 */
    sessionId: z.string().min(1),
    /** 稳定用户 id（推荐）；缺省时行为同仅发 `sessionId` */
    userId: z.string().min(1).optional(),
    messageId: z.string().min(1),
    /** 可与 `visionFrames` 二选一：仅有图时允许空串，由服务端补默认提示 */
    text: z.string(),
    timestamp: z.string().min(1),
    visionFrames: z.array(visionFrameWireSchema).max(16).optional(),
    /** 被打断的回复上下文，用于整合到下一次回复中 */
    interruptedContext: z.string().optional(),
    /** 客户端 IP（前端未上报定位时的兜底） */
    clientIp: z.string().optional(),
    /** 前端 GPS / 浏览器定位（优先于 IP） */
    clientLocation: clientLocationWireSchema.optional(),
    /** 默认 `sandbox`；`full` 时允许桌面控制、钱包、自编程等高权限工具 */
    agentAccessMode: z.enum(["sandbox", "full"]).optional(),
  })
  .superRefine((data, ctx) => {
    const hasText = data.text.trim().length > 0;
    const hasVision = (data.visionFrames?.length ?? 0) > 0;
    if (!hasText && !hasVision) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "需要非空 text 或至少一帧 visionFrames",
        path: ["text"],
      });
    }
  });

export const walletRequestSchema = z.object({
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  action: z.enum(["freeze", "debit", "refund", "purchase"]),
  amount: z.number().positive(),
  meta: z.record(z.unknown()).optional(),
});

/** Agent World HTTP/WS 校验：实现位于根目录包 `agent-world/schemas.ts` */
export {
  worldLeisureBodySchema,
  worldMarketContractCreateBodySchema,
  worldMarketContractDeliverBodySchema,
  worldMarketContractRejectBodySchema,
  worldMarketContractsQuerySchema,
  worldMarketContractSessionBodySchema,
  worldPurchaseBodySchema,
  worldRegisterAgentQuickBodySchema,
  worldRegisterChallengeBodySchema,
  worldRegisterVerifyBodySchema,
  worldSessionQuerySchema,
  worldSkillUploadBodySchema,
} from "@private-ai-agent/agent-world";

export const agentInboxQuerySchema = z.object({
  sessionId: z.string().min(1),
  limit: z.coerce.number().int().positive().max(200).optional(),
});

export const agentPairBodySchema = z.object({
  sessionId: z.string().min(1),
  code: z.string().min(1).max(256),
});

export const agentUnpairBodySchema = z.object({
  sessionId: z.string().min(1),
});

export const agentPairStatusQuerySchema = z.object({
  sessionId: z.string().min(1),
});

/** WebSocket：AIP 投递 */
export const aipDispatchWsSchema = z.object({
  toSessionId: z.string().min(1),
  envelope: z.record(z.unknown()),
  /** 可选：与当前主会话用户消息关联（同 `chat.user_message.messageId`） */
  chatUserMessageId: z.string().min(1).optional(),
});

export const agentAipStateQuerySchema = z.object({
  sessionId: z.string().min(1),
});

function accountActorRefine(data: { userId?: string; sessionId?: string }, ctx: z.RefinementCtx): void {
  const u = data.userId?.trim() ?? "";
  const s = data.sessionId?.trim() ?? "";
  if (!u && !s) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "userId 或 sessionId 至少填一项",
      path: ["userId"],
    });
  }
}

export const accountRegisterBodySchema = z
  .object({
    userId: z.string().optional(),
    sessionId: z.string().optional(),
    displayName: z.string().min(1).max(120),
  })
  .superRefine(accountActorRefine);

export const accountMeQuerySchema = z
  .object({
    userId: z.string().optional(),
    sessionId: z.string().optional(),
  })
  .superRefine(accountActorRefine);

/** 发起邮箱验证码注册 */
export const accountEmailRegisterStartBodySchema = z
  .object({
    userId: z.string().optional(),
    sessionId: z.string().optional(),
    displayName: z.string().min(1).max(120),
  })
  .superRefine(accountActorRefine);

/** 查询占位收件箱（拉取验证码） */
export const accountEmailRegisterPendingQuerySchema = z
  .object({
    userId: z.string().optional(),
    sessionId: z.string().optional(),
  })
  .superRefine(accountActorRefine);

/** 提交验证码完成注册 */
export const accountEmailRegisterVerifyBodySchema = z
  .object({
    userId: z.string().optional(),
    sessionId: z.string().optional(),
    code: z.string().regex(/^\d{6}$/, "须为 6 位数字验证码"),
  })
  .superRefine(accountActorRefine);

/** 邮件网关 Inbound Webhook（真实收信回调） */
export const accountEmailInboundBodySchema = z.object({
  to: z.string().min(1),
  text: z.string().optional(),
  html: z.string().optional(),
  subject: z.string().optional(),
});

export const scheduleTaskCreateBodySchema = z
  .object({
    sessionId: z.string().min(1),
    title: z.string().min(1).max(120),
    description: z.string().min(1).max(2000),
    kind: z.enum(["reminder", "action", "weather_brief", "agent_task"]),
    runAt: z.string().min(1).optional(),
    recurrence: z.enum(["none", "daily", "weekly", "yearly", "cron"]).default("none"),
    timezone: z.string().min(1).optional(),
    cronExpression: z.string().min(1).max(120).optional(),
    webhookToken: z.string().min(1).max(160).optional(),
    reminderMessage: z.string().min(1).max(500).optional(),
    action: z
      .object({
        url: z.string().url(),
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
        headers: z.record(z.string()).optional(),
        body: z.unknown().optional(),
      })
      .optional(),
    agentTask: z
      .object({
        prompt: z.string().min(1).max(4000),
        accessMode: z.enum(["sandbox", "full"]).optional(),
      })
      .optional(),
  })
  .superRefine((data, ctx) => {
    if (!data.runAt && !data.cronExpression) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["runAt"],
        message: "runAt or cronExpression is required",
      });
    }
    if (data.cronExpression && data.recurrence !== "cron") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["recurrence"],
        message: "recurrence must be cron when cronExpression is provided",
      });
    }
    if (data.kind === "reminder" && !data.reminderMessage) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reminderMessage"],
        message: "提醒任务必须提供 reminderMessage",
      });
    }
    if (data.kind === "action" && !data.action?.url) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["action", "url"],
        message: "动作任务必须提供 action.url",
      });
    }
    if (data.kind === "agent_task" && !data.agentTask?.prompt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["agentTask", "prompt"],
        message: "Agent 自动化任务必须提供 agentTask.prompt",
      });
    }
  });

export const scheduleTaskUpdateBodySchema = z.object({
  title: z.string().min(1).max(120).optional(),
  description: z.string().min(1).max(2000).optional(),
  runAt: z.string().min(1).optional(),
  recurrence: z.enum(["none", "daily", "weekly", "yearly", "cron"]).optional(),
  timezone: z.string().min(1).optional(),
  cronExpression: z.string().min(1).max(120).nullable().optional(),
  webhookToken: z.string().min(1).max(160).nullable().optional(),
  reminderMessage: z.string().min(1).max(500).optional(),
  action: z
    .object({
      url: z.string().url(),
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
      headers: z.record(z.string()).optional(),
      body: z.unknown().optional(),
    })
    .optional(),
  agentTask: z
    .object({
      prompt: z.string().min(1).max(4000),
      accessMode: z.enum(["sandbox", "full"]).optional(),
    })
    .optional(),
  status: z.enum(["active", "paused", "cancelled"]).optional(),
});

export const scheduleTaskListQuerySchema = z.object({
  sessionId: z.string().min(1),
  from: z.string().optional(),
  to: z.string().optional(),
});

export const scheduleTaskRunsQuerySchema = z.object({
  taskId: z.string().uuid(),
  limit: z.coerce.number().int().positive().max(200).optional(),
});

export const weatherCurrentQuerySchema = z.object({
  latitude: z.coerce.number().gte(-90).lte(90),
  longitude: z.coerce.number().gte(-180).lte(180),
  timezone: z.string().min(1).optional(),
  label: z.string().max(120).optional(),
});

export const weatherPrefsGetQuerySchema = z.object({
  sessionId: z.string().min(1),
});

export const weatherPrefsPutBodySchema = z.object({
  sessionId: z.string().min(1),
  latitude: z.number().gte(-90).lte(90),
  longitude: z.number().gte(-180).lte(180),
  label: z.string().max(120).optional(),
  timezone: z.string().min(1).optional(),
  morningReminderEnabled: z.boolean().optional(),
  /** 开启每日简报且尚无任务时必填：首次触发的 ISO 时间（须为未来） */
  morningFirstRunAt: z.string().optional(),
});

/** 将已创建的 weather_brief 日程任务 id 写入天气偏好（需已保存过经纬度） */
export const weatherLinkTaskBodySchema = z.object({
  sessionId: z.string().min(1),
  taskId: z.string().uuid(),
});

export const chatScheduleDraftBodySchema = z.object({
  sessionId: z.string().min(1),
  text: z.string().min(1).max(4000),
});

/** 复制消息：客户端把要复制的纯文本一起带上，服务端做审计/回执（实际剪贴板由前端写入） */
export const chatMessageCopyBodySchema = z.object({
  sessionId: z.string().min(1),
  userId: z.string().optional(),
  messageId: z.string().min(1).max(160),
  text: z.string().min(0).max(20000),
});

/** 编辑消息：替换 user 消息的文本并触发 Agent 重答 */
export const chatMessageEditBodySchema = z.object({
  sessionId: z.string().min(1),
  userId: z.string().optional(),
  messageId: z.string().min(1).max(160),
  newText: z.string().min(1).max(20000),
  /** 透传到 Agent 上下文；可携带 `agentAccessMode`、`clientLocation` 等 */
  agentAccessMode: z.enum(["sandbox", "full"]).optional(),
});

/** 技能库：列出当前 Actor 可见的 Skill（含已禁用项） */
export const chatSkillsQuerySchema = z.object({
  sessionId: z.string().optional(),
  userId: z.string().optional(),
});

/** 技能库：切换启用状态（社区技能需已拥有） */
export const chatSkillEnabledBodySchema = z.object({
  skillName: z.string().min(1),
  enabled: z.boolean(),
  sessionId: z.string().optional(),
  userId: z.string().optional(),
});

export const infoSearchQuerySchema = z.object({
  q: z.string().min(1),
  limit: z.coerce.number().int().positive().max(20).optional(),
});

export const infoNewsQuerySchema = z.object({
  topic: z.string().min(1),
  limit: z.coerce.number().int().positive().max(20).optional(),
});

export const infoReadBodySchema = z.object({
  url: z.string().url(),
});

export const infoTrackCreateBodySchema = z.object({
  sessionId: z.string().min(1),
  name: z.string().min(1).max(120),
  keywords: z.array(z.string().min(1)).min(1),
  runAt: z.string().optional(),
  recurrence: z.enum(["none", "daily", "weekly", "yearly"]).optional(),
});

export const infoTrackListQuerySchema = z.object({
  sessionId: z.string().min(1),
});

export const infoTrackRunBodySchema = z
  .object({
    topicId: z.string().uuid().optional(),
    sessionId: z.string().min(1).optional(),
    name: z.string().optional(),
    mode: z.enum(["topic", "keywords"]).optional(),
    keywords: z.array(z.string()).optional(),
  })
  .refine((v) => Boolean(v.topicId) || Boolean(v.keywords?.length), {
    message: "topicId 或 keywords 至少提供一个",
  });

export const phoneMeQuerySchema = z.object({
  sessionId: z.string().min(1),
  userId: z.string().min(1).optional(),
});

export const wechatClawStatusQuerySchema = z
  .object({
    userId: z.string().optional(),
    sessionId: z.string().optional(),
  })
  .superRefine(accountActorRefine);

export const wechatClawActorBodySchema = z
  .object({
    userId: z.string().optional(),
    sessionId: z.string().optional(),
  })
  .superRefine(accountActorRefine);

export const wechatClawLoginStartBodySchema = z
  .object({
    userId: z.string().optional(),
    sessionId: z.string().optional(),
    force: z.boolean().optional(),
  })
  .superRefine(accountActorRefine);

export const wechatClawLoginWaitBodySchema = z
  .object({
    userId: z.string().optional(),
    sessionId: z.string().optional(),
    /** 客户端已持有当前二维码时设为 true，避免重复上传巨型 data URL */
    qrKnown: z.boolean().optional(),
    currentQrDataUrl: z.string().max(2_000_000).optional(),
    timeoutMs: z.number().int().min(3000).max(90_000).optional(),
  })
  .superRefine(accountActorRefine);

/** OpenClaw 消息桥：微信入站 → 主服务 AgentCore */
export const wechatClawBridgeChatBodySchema = z.object({
  text: z.string().max(16_000),
  userId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  weixinSenderId: z.string().max(256).optional(),
  channel: z.string().max(64).optional(),
  accountId: z.string().max(128).optional(),
  messageId: z.string().max(128).optional(),
});

const browserSessionSiteIdSchema = z.enum(["ctrip", "taobao", "jd", "qunar", "fliggy"]);

const browserSessionCookieSchema = z.object({
  name: z.string().min(1).max(512),
  value: z.string().max(16_384),
  domain: z.string().max(256).optional(),
  path: z.string().max(256).optional(),
  expires: z.number().optional(),
  httpOnly: z.boolean().optional(),
  secure: z.boolean().optional(),
  sameSite: z.string().max(16).optional(),
});

export const browserSessionStatusQuerySchema = z
  .object({
    userId: z.string().optional(),
    sessionId: z.string().optional(),
  })
  .superRefine(accountActorRefine);

export const browserSessionImportBodySchema = z
  .object({
    userId: z.string().optional(),
    sessionId: z.string().optional(),
    siteId: browserSessionSiteIdSchema,
    cookies: z.array(browserSessionCookieSchema).min(1).max(500),
    /** 导入时是否立即授权 Agent；默认 false，建议单独调用 consent */
    agentAllowed: z.boolean().optional(),
  })
  .superRefine(accountActorRefine);

export const browserSessionConsentBodySchema = z
  .object({
    userId: z.string().optional(),
    sessionId: z.string().optional(),
    siteId: browserSessionSiteIdSchema,
    agentAllowed: z.boolean(),
  })
  .superRefine(accountActorRefine);

export const browserSessionRevokeBodySchema = z
  .object({
    userId: z.string().optional(),
    sessionId: z.string().optional(),
    siteId: browserSessionSiteIdSchema,
  })
  .superRefine(accountActorRefine);

export const browserSessionActorBodySchema = z
  .object({
    userId: z.string().optional(),
    sessionId: z.string().optional(),
  })
  .superRefine(accountActorRefine);

export const companionSessionQuerySchema = z.object({
  sessionId: z.string().min(1),
});

export const companionProfileUpdateBodySchema = z.object({
  sessionId: z.string().min(1),
  preferredTone: z.enum(["warm", "balanced", "formal", "humor"]).optional(),
  greetingEnabled: z.boolean().optional(),
  dailyGreetingHourLocal: z.number().int().min(0).max(23).optional(),
  timezone: z.string().min(1).optional(),
  likes: z.array(z.string().min(1).max(80)).max(50).optional(),
  dislikes: z.array(z.string().min(1).max(80)).max(50).optional(),
});

export const companionOnboardingBodySchema = z.object({
  sessionId: z.string().min(1),
  focusModes: z.array(z.enum(["shopping", "planning", "companion"])).min(1).max(3),
  budgetMin: z.number().nonnegative().optional(),
  budgetMax: z.number().nonnegative().optional(),
  shoppingPlatforms: z.array(z.string().min(1).max(60)).max(10).optional(),
  billReminders: z
    .array(
      z.object({
        billName: z.string().min(1).max(80),
        dueDate: z.string().min(1),
        daysBefore: z.number().int().min(0).max(30).default(3),
      }),
    )
    .max(20)
    .optional(),
});

export const companionPriceWatchBodySchema = z.object({
  sessionId: z.string().min(1),
  item: z.string().min(1).max(120),
  currentPrice: z.number().positive(),
  targetPrice: z.number().positive(),
  currency: z.string().min(1).max(10).default("USD"),
});

export const companionBillReminderBodySchema = z.object({
  sessionId: z.string().min(1),
  billName: z.string().min(1).max(80),
  dueDate: z.string().min(1),
  daysBefore: z.number().int().min(0).max(30).default(3),
  amount: z.number().positive().optional(),
});

export const companionShoppingPlanBodySchema = z.object({
  sessionId: z.string().min(1),
  item: z.string().min(1).max(120),
  budget: z.number().positive(),
  runAt: z.string().min(1),
  timezone: z.string().min(1).optional(),
  note: z.string().max(500).optional(),
});

export const companionBehaviorSignalUpdateBodySchema = z.object({
  sessionId: z.string().min(1),
  shoppingInterest: z.number().int().min(0).max(1000).optional(),
  planningInterest: z.number().int().min(0).max(1000).optional(),
  companionNeed: z.number().int().min(0).max(1000).optional(),
  privacyConcern: z.number().int().min(0).max(1000).optional(),
});

export const companionContactFeedbackBodySchema = z.object({
  sessionId: z.string().min(1),
  channel: z.enum(["websocket", "voice", "phone_call"]),
  responded: z.boolean(),
  responseTimeMs: z.number().int().min(0).max(86_400_000).optional(),
  feedback: z.enum(["positive", "negative", "neutral"]).optional(),
  quietHours: z.boolean().optional(),
});
