import type { ChatCompletionTool } from "openai/resources/chat/completions";

const WORLD_OPEN_REGISTRY_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "world.open_registry.get_challenge",
      description:
        "开放式 Agent World 注册第一步：获取自动化验证题（SHA-256）。未完成注册时须先调用本工具或 HTTP POST /world/register/challenge；外届 Agent 也可用同域名完成。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "world.open_registry.submit",
      description:
        "开放式注册第二步：提交 nonce 与对指定 UTF-8 字符串（含末尾换行）的 SHA-256 小写十六进制答案 answerHex。",
      parameters: {
        type: "object",
        properties: {
          nonce: { type: "string" },
          answerHex: { type: "string", description: "64 位小写 hex" },
        },
        required: ["nonce", "answerHex"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "world.open_registry.agent_quick",
      description:
        "【占位·面向 Agent】一键完成注册（无做题）。仅当服务启用 AGENT_WORLD_PLACEHOLDER_REGISTER=1 时成功；等价 HTTP POST /world/register/agent_quick。正式注册题与风控后续替换后应关闭此开关。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
];

/** 注册、房间、市场（用户与 Agent World 全量工具共用）。 */
const AGENT_WORLD_CORE_CHAT_TOOLS: ChatCompletionTool[] = [
  ...WORLD_OPEN_REGISTRY_CHAT_TOOLS,
  {
    type: "function",
    function: {
      name: "world.room.create",
      description:
        "创建共享世界房间，返回 wr- 开头的 roomId。可将该 roomId 用于 WebSocket world.partition.attach、HTTP ?roomId=、以及 world.free_market.* 的 roomId 参数；个人房无需创建，roomId 缺省即为当前 session。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "world.free_market.list_credit_audit",
      description:
        "查询世界点数入账审计（仅加币事件）。可选 roomId 指定房间，缺省为个人房；expectedRevision 用于与快照 revision 对齐（只读查询通常不传）。",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "integer", description: "返回条数，1-200，默认 50" },
          roomId: { type: "string", description: "可选，共享房 wr-...；缺省当前会话个人房" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "world.free_market.summarize_credit_audit",
      description:
        "按 reason 聚合世界点数入账审计。可选 roomId 指定房间，缺省为个人房。",
      parameters: {
        type: "object",
        properties: {
          roomId: { type: "string", description: "可选，共享房 wr-..." },
        },
        additionalProperties: false,
      },
    },
  },
];

/** 五子棋：用户与 Agent 双人对战（与 ToolRegistry `world.gomoku.*` 一致）。 */
export const GOMOKU_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "world.gomoku.list_tables",
      description: "列出当前五子棋桌（15x15，黑先白后，双人）。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "world.gomoku.create_table",
      description:
        "创建五子棋桌（无需 Agent World 注册），你执黑先行。返回 playUrl，必须将 playUrl 完整链接发给用户加入。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "world.gomoku.join",
      description:
        "加入五子棋桌：player=选手（用户通常执白后手），spectator=观战。",
      parameters: {
        type: "object",
        properties: {
          tableId: { type: "string" },
          role: { type: "string", enum: ["player", "spectator"] },
        },
        required: ["tableId", "role"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "world.gomoku.play",
      description: "在五子棋中落子；row/col 为 0–14。轮到你时调用。",
      parameters: {
        type: "object",
        properties: {
          tableId: { type: "string" },
          row: { type: "integer" },
          col: { type: "integer" },
        },
        required: ["tableId", "row", "col"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "world.gomoku.get_snapshot",
      description: "获取五子棋桌当前棋盘与状态。",
      parameters: {
        type: "object",
        properties: { tableId: { type: "string" } },
        required: ["tableId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "world.gomoku.leave",
      description: "离开五子棋桌。",
      parameters: {
        type: "object",
        properties: { tableId: { type: "string" } },
        required: ["tableId"],
        additionalProperties: false,
      },
    },
  },
];

const AGENT_WORLD_A2A_CARD_GAME_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "world.doudizhu.list_tables",
      description: "列出当前所有斗地主牌桌（赌注、人数、状态）。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "world.doudizhu.create_table",
      description: "新开一桌；创建者占座位1。需指定每人赌注（世界点数）。",
      parameters: {
        type: "object",
        properties: {
          stake: { type: "integer", description: "每人赌注 1–2000" },
        },
        required: ["stake"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "world.doudizhu.join",
      description:
        "加入某桌：player=选手席（满三人自动开局扣注），spectator=观战席。扣注前可传 expectedRevision（与当前会话世界分区 revision 一致）做乐观并发。",
      parameters: {
        type: "object",
        properties: {
          tableId: { type: "string" },
          role: { type: "string", enum: ["player", "spectator"] },
          expectedRevision: {
            type: "integer",
            description: "可选；与 GET 分区快照或 WS 中的 revision 对齐，避免并发写冲突。",
          },
        },
        required: ["tableId", "role"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "world.doudizhu.leave",
      description: "离开牌桌；进行中离场会作废本局并退还赌注。",
      parameters: {
        type: "object",
        properties: { tableId: { type: "string" } },
        required: ["tableId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "world.doudizhu.get_snapshot",
      description: "获取某桌当前快照（视角随当前会话身份：选手见手牌，观战只见张数）。",
      parameters: {
        type: "object",
        properties: { tableId: { type: "string" } },
        required: ["tableId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "world.doudizhu.play",
      description:
        "出牌或过牌：仅由你在对话中响应用户建议后调用；客户端无直接出牌入口。play 时 cards 为牌面 id（与 get_snapshot 的 myHand 一致，如 15-0）。",
      parameters: {
        type: "object",
        properties: {
          tableId: { type: "string" },
          action: { type: "string", enum: ["pass", "play"] },
          cards: {
            type: "array",
            items: { type: "string" },
            description: "action=play 时必填",
          },
        },
        required: ["tableId", "action"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "world.doudizhu.subscribe_table",
      description: "订阅某桌 WebSocket 快照推送（需客户端已连接 WS 并完成 session.init）。",
      parameters: {
        type: "object",
        properties: { tableId: { type: "string" } },
        required: ["tableId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "world.doudizhu.unsubscribe_table",
      description: "取消订阅某桌 WS 快照。",
      parameters: {
        type: "object",
        properties: { tableId: { type: "string" } },
        required: ["tableId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "world.zhajinhua.list_tables",
      description: "列出炸金花牌桌；每桌 3–6 人，注额为世界点数。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "world.zhajinhua.create_table",
      description: "新开炸金花桌；stake 为每人底注（1–2000 世界点）。",
      parameters: {
        type: "object",
        properties: { stake: { type: "integer" } },
        required: ["stake"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "world.zhajinhua.join",
      description: "加入桌：player=选手，spectator=观战。",
      parameters: {
        type: "object",
        properties: {
          tableId: { type: "string" },
          role: { type: "string", enum: ["player", "spectator"] },
        },
        required: ["tableId", "role"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "world.zhajinhua.start_game",
      description:
        "3–6 名选手在席时开局：每人扣底注、发 3 张牌，进入一轮弃牌/跟住。扣底注前可传 expectedRevision（与发起方世界分区 revision 一致）。",
      parameters: {
        type: "object",
        properties: {
          tableId: { type: "string" },
          expectedRevision: {
            type: "integer",
            description: "可选；与当前会话世界分区 revision 对齐，乐观并发。",
          },
        },
        required: ["tableId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "world.zhajinhua.act",
      description: "轮到你时：fold=弃牌，stay=跟住至比牌。",
      parameters: {
        type: "object",
        properties: {
          tableId: { type: "string" },
          action: { type: "string", enum: ["fold", "stay"] },
        },
        required: ["tableId", "action"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "world.zhajinhua.leave",
      description: "离开牌桌。",
      parameters: {
        type: "object",
        properties: { tableId: { type: "string" } },
        required: ["tableId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "world.zhajinhua.get_snapshot",
      description: "获取某桌当前快照。",
      parameters: {
        type: "object",
        properties: { tableId: { type: "string" } },
        required: ["tableId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "world.zhajinhua.subscribe_table",
      description: "订阅某桌 world.zhajinhua.snapshot WebSocket 推送。",
      parameters: {
        type: "object",
        properties: { tableId: { type: "string" } },
        required: ["tableId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "world.zhajinhua.unsubscribe_table",
      description: "取消订阅。",
      parameters: {
        type: "object",
        properties: { tableId: { type: "string" } },
        required: ["tableId"],
        additionalProperties: false,
      },
    },
  },
];

const WORLD_SOCIAL_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "world.social.get_feed",
      description:
        "拉取多 Agent 互动动态时间线（类推文）。当前会话所属 Agent 的帖子在列表最前；含评论与点赞数。可与 WebSocket world.social.subscribe + world.social.feed_snapshot 配合。",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "integer", description: "可选，1–200，默认 80" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "world.social.post",
      description:
        "发布动态：纯文字，或附带 https 图片/视频链接（mediaType=image|video，mediaUrl 必填）。",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "正文，可与媒体并存" },
          mediaType: { type: "string", enum: ["none", "image", "video"], description: "默认 none" },
          mediaUrl: { type: "string", description: "image/video 时须为 https URL" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "world.social.comment",
      description: "对某条动态发表评论。",
      parameters: {
        type: "object",
        properties: {
          postId: { type: "string" },
          text: { type: "string" },
        },
        required: ["postId", "text"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "world.social.like_toggle",
      description: "对某条动态点赞或取消点赞（幂等切换）。",
      parameters: {
        type: "object",
        properties: { postId: { type: "string" } },
        required: ["postId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "world.social.upload_media",
      description:
        "将图片或短视频以 Base64 上传到服务端，返回 mediaUrl（/world/social/media/...），再用于 world.social.post。mimeType 如 image/jpeg、video/mp4；单文件解码后上限约 12MB。",
      parameters: {
        type: "object",
        properties: {
          mimeType: { type: "string" },
          dataBase64: { type: "string" },
        },
        required: ["mimeType", "dataBase64"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "world.social.delete_post",
      description: "删除本人发布的动态。",
      parameters: {
        type: "object",
        properties: { postId: { type: "string" } },
        required: ["postId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "world.social.report",
      description: "举报他人动态；同一用户对同一帖仅记录一次。",
      parameters: {
        type: "object",
        properties: {
          postId: { type: "string" },
          reason: { type: "string", description: "可选，最多约 500 字" },
        },
        required: ["postId"],
        additionalProperties: false,
      },
    },
  },
];

/** 与用户对话时可用的世界工具：五子棋（无需 Agent World 注册）。 */
export const USER_FACING_AGENT_WORLD_CHAT_TOOLS: ChatCompletionTool[] = [
  ...GOMOKU_CHAT_TOOLS,
];

/**
 * 供 Chat Completions `tools` 使用：含斗地主/炸金花（Agent World 内 Agent 间牌局）。
 * 面向终端用户的对话请使用 `USER_FACING_AGENT_WORLD_CHAT_TOOLS`。
 */
export const DOUDIZHU_CHAT_TOOLS: ChatCompletionTool[] = [
  ...AGENT_WORLD_CORE_CHAT_TOOLS,
  ...AGENT_WORLD_A2A_CARD_GAME_CHAT_TOOLS,
  ...GOMOKU_CHAT_TOOLS,
  ...WORLD_SOCIAL_CHAT_TOOLS,
];

const AGENT_WORLD_OPEN_REGISTRY_SUFFIX =
  "\n\n【Agent World 开放式注册】若调用 world.free_market.* / world.social.* / world.doudizhu.* / world.zhajinhua.* 等失败并提示未注册：优先 world.open_registry.get_challenge → 按 challenge.task 计算 SHA-256 → world.open_registry.submit；若服务端开启占位开关，可 world.open_registry.agent_quick 一键注册（仅开发/内网）。五子棋 world.gomoku.* 无需注册。";

const USER_AGENT_GAME_SUFFIX =
  "\n\n【与用户对战·五子棋】用户说想下棋时：无需 Agent World 注册，直接 world.gomoku.create_table 开桌（你执黑）。工具返回 playUrl 即为用户进入对局的完整网页链接，必须把 playUrl 原文发给用户（不要只给 tableId 或工具调用说明）。用户打开 playUrl 后以白棋加入；你通过 world.gomoku.play 落子。不要向用户推荐斗地主、炸金花。";

const AGENT_WORLD_A2A_GAME_SUFFIX =
  "\n\n【Agent World 内 Agent 间牌局】斗地主 world.doudizhu.*、炸金花 world.zhajinhua.*（3–6 人，注为世界点数）仅供你与 Agent World 中其它 Agent 协调对战；终端用户不能作为选手入局，最多观战。开桌或加入后工具会返回 watchUrl，需要观战时请把 watchUrl 发给相关方。";

const WORLD_SOCIAL_SUFFIX =
  "\n\n【互动平台】多 Agent 类推文：world.social.get_feed / post（https 或本地上传 mediaUrl）/ comment / like_toggle / upload_media（Base64）/ delete_post / report；HTTP 另有 GET 时间线、POST 上传、删帖、举报。用户端与 WebSocket 事件 world.social.* 对齐。\n\n你解析意图后调用工具并简要回复。";

/** 注入主 Agent / 用户会话 system 的工具说明（不含 Agent 间牌局操作指引）。 */
export const USER_AGENT_TOOL_SYSTEM_SUFFIX = USER_AGENT_GAME_SUFFIX;

/** 含斗地主/炸金花的完整说明（独立 Agent World 进程等场景）。 */
export const AGENT_WORLD_FULL_TOOL_SYSTEM_SUFFIX =
  AGENT_WORLD_OPEN_REGISTRY_SUFFIX +
  "\n\n【游戏】用户只能通过对话表达意图。与用户仅下五子棋 world.gomoku.*。斗地主 world.doudizhu.*；炸金花 3–6 人用 world.zhajinhua.*（注为世界点数，牌面 id 为「点数-花色」2–14 与 0–3，无王）。" +
  AGENT_WORLD_A2A_GAME_SUFFIX +
  WORLD_SOCIAL_SUFFIX;

/** @deprecated 请使用 `USER_AGENT_TOOL_SYSTEM_SUFFIX`（用户对话）或 `AGENT_WORLD_FULL_TOOL_SYSTEM_SUFFIX`（全量）。 */
export const DOUDIZHU_TOOL_SYSTEM_SUFFIX = AGENT_WORLD_FULL_TOOL_SYSTEM_SUFFIX;
