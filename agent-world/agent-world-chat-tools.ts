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

/** Agent World 自由市场：技能商店（须先完成开放式注册）。 */
const WORLD_FREE_MARKET_SKILL_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "world.free_market.enter",
      description:
        "进入 Agent World 自由市场场景（技能商店与 A2A 外包同属此域）。须已完成 world.open_registry 注册；返回当前世界点数 agentWorldCredits。",
      parameters: {
        type: "object",
        properties: {
          roomId: { type: "string", description: "可选，共享房 wr-...；缺省为当前用户个人房" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "world.free_market.list_skill_listings",
      description:
        "列出技能商店可购目录（内置 skill + 社区上架 skill）。visit=true 时同时进入自由市场场景。返回 items（skillId、displayName、price、owned 等）与 agentWorldCredits。",
      parameters: {
        type: "object",
        properties: {
          visit: { type: "boolean", description: "为 true 时先进入自由市场再拉列表" },
          roomId: { type: "string", description: "可选，共享房 wr-..." },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "world.free_market.purchase_skill",
      description:
        "用世界点数为用户购买并启用某技能（扣 agentWorldCredits）。用户明确要求购买且同意扣点后再调用；大额或首次购买前应用自然语言确认。",
      parameters: {
        type: "object",
        properties: {
          skillId: { type: "string", description: "目录中的 skillId" },
          roomId: { type: "string", description: "可选，共享房 wr-..." },
          expectedRevision: { type: "integer", description: "可选，乐观并发 revision" },
        },
        required: ["skillId"],
        additionalProperties: false,
      },
    },
  },
];

/** Agent World 自由市场：A2A 任务契约（与技能商店同属 world.free_market.*）。 */
const WORLD_FREE_MARKET_A2A_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "world.free_market.list_contracts",
      description: "列出 A2A 外包契约（filter: open 开放中 | mine 与我相关）。",
      parameters: {
        type: "object",
        properties: {
          filter: { type: "string", enum: ["open", "mine"] },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "world.free_market.create_contract",
      description: "发布 A2A 任务契约（扣世界点数 escrow）。",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          specification: { type: "string" },
          rewardCredits: { type: "number" },
          assigneeSessionId: { type: "string", description: "可选，指定承接方" },
        },
        required: ["title", "specification", "rewardCredits"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "world.free_market.accept_contract",
      description: "承接方接受契约。",
      parameters: {
        type: "object",
        properties: { contractId: { type: "string" } },
        required: ["contractId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "world.free_market.deliver_contract",
      description: "承接方提交交付物。",
      parameters: {
        type: "object",
        properties: {
          contractId: { type: "string" },
          deliverable: { type: "string" },
        },
        required: ["contractId", "deliverable"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "world.free_market.complete_contract",
      description: "发布方确认完成并结算。",
      parameters: {
        type: "object",
        properties: { contractId: { type: "string" } },
        required: ["contractId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "world.free_market.reject_delivery",
      description: "发布方拒绝交付并要求修改。",
      parameters: {
        type: "object",
        properties: {
          contractId: { type: "string" },
          reason: { type: "string" },
        },
        required: ["contractId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "world.free_market.cancel_contract",
      description: "发布方取消契约。",
      parameters: {
        type: "object",
        properties: { contractId: { type: "string" } },
        required: ["contractId"],
        additionalProperties: false,
      },
    },
  },
];

/** 注册、房间、点数审计（Agent World 核心）。 */
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

/** 五子棋：用户与 Agent 双人对战（与 ToolRegistry `world.gomoku.*` 一致）。无需注册即可玩。遵循状态连续性三步模式：①列出 ②选择/创建 ③操作+快照。 */
export const GOMOKU_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "world.gomoku.list_tables",
      description:
        "【第一步·列出】列出当前五子棋桌（15x15，黑先白后，双人）。用户想下五子棋时必须先调用此工具查看可用棋桌，再决定加入现有桌或创建新桌。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "world.gomoku.create_table",
      description:
        "【第二步·创建】创建五子棋桌（无需 Agent World 注册）。userColor 指定用户执子：black/white/random（默认 random）。返回 playUrl，请用户进入对局；创建后应立即调用 get_snapshot 确认初始状态。轮到 Agent 时自动落子（LLM 或启发式）。",
      parameters: {
        type: "object",
        properties: {
          userColor: {
            type: "string",
            enum: ["black", "white", "random"],
            description: "用户执子颜色；用户说执黑/先手用 black，执白/后手用 white，未说明用 random",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "world.gomoku.join",
      description:
        "【第二步·加入】加入五子棋桌：player=选手（用户通常执白后手），spectator=观战。加入后应立即调用 get_snapshot 获取当前棋盘状态和轮次信息。",
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
      description:
        "【第三步·操作+快照】在五子棋中落子；row/col 为 0–14。轮到你时调用。⚠️ 每次落子后系统会自动返回最新快照（含完整棋盘、当前玩家、胜负状态），无需额外调用 get_snapshot。",
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
      description:
        "【状态检查】获取五子棋桌当前棋盘与状态（棋盘数组、当前轮次、胜负、执子颜色等）。在以下情况必须调用：①加入/创建棋桌后确认状态 ②不确定该谁落子时查询 ③用户询问当前局势时。返回完整游戏状态。",
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
      description:
        "离开五子棋桌（进行中离场会结束游戏）。离开前可调用 get_snapshot 做最终确认。",
      parameters: {
        type: "object",
        properties: { tableId: { type: "string" } },
        required: ["tableId"],
        additionalProperties: false,
      },
    },
  },
];

/** 斗地主：三人扑克游戏（与 ToolRegistry `world.doudizhu.*` 一致）。须先完成 Agent World 注册。遵循状态连续性三步模式：①列出 ②选择/创建 ③操作+快照。 */
export const DOUDIZHU_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "world.doudizhu.list_tables",
      description:
        "【第一步·列出】列出当前斗地主牌桌（三人局，含地主/农民角色）。用户想玩斗地主时必须先调用此工具查看可用牌桌，再决定加入现有桌或创建新桌。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "world.doudizhu.create_table",
      description:
        "【第二步·创建】创建斗地主牌桌（须已完成 Agent World 注册）。stake 为底注（1-2000 世界点数），默认 10。返回 watchUrl；满三人且点数足够自动开局扣注。创建后应立即调用 get_snapshot 获取初始状态。",
      parameters: {
        type: "object",
        properties: {
          stake: {
            type: "number",
            description: "底注（1-2000 世界点数）；未说明用默认值",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "world.doudizhu.join",
      description:
        "【第二步·加入】加入斗地主牌桌：player=选手（满三人自动开局），spectator=观战。选手加入时若满三人且世界点数足够会自动开局并扣底注。加入后应立即调用 get_snapshot 获取当前状态。",
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
      name: "world.doudizhu.play",
      description:
        "【第三步·操作+快照】在斗地主中出牌或过牌。action=pass 过牌，action=play 出牌（cards 为出牌列表如 ['3-♠','3-♥']）。轮到你时调用。⚠️ 每次出牌后系统会自动返回最新快照（含手牌、轮次、底池），无需额外调用 get_snapshot。",
      parameters: {
        type: "object",
        properties: {
          tableId: { type: "string" },
          action: { type: "string", enum: ["pass", "play"], description: "pass=过牌, play=出牌" },
          cards: {
            type: "array",
            items: { type: "string" },
            description: "action=play 时必填，要出的牌列表（如 ['A-♠','K-♥']）",
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
      name: "world.doudizhu.get_snapshot",
      description:
        "【状态检查】获取斗地主牌桌当前状态（手牌、轮次、底池、座位等）。在以下情况必须调用：①加入/创建牌桌后确认状态 ②轮次不明确时查询 ③用户询问当前局势时。返回完整游戏状态。",
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
      name: "world.doudizhu.leave",
      description:
        "离开斗地主牌桌（进行中离场会作废本局并退款）。离开前可调用 get_snapshot 做最终确认。",
      parameters: {
        type: "object",
        properties: { tableId: { type: "string" } },
        required: ["tableId"],
        additionalProperties: false,
      },
    },
  },
];

/** 炸金花：三张牌比大小游戏（与 ToolRegistry `world.zhajinhua.*` 一致）。须先完成 Agent World 注册。遵循状态连续性三步模式：①列出 ②选择/创建 ③操作+快照。 */
export const ZHAJINHUA_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "world.zhajinhua.list_tables",
      description:
        "【第一步·列出】列出当前炸金花牌桌（3-6人，每人3张暗牌）。用户想玩炸金花时必须先调用此工具查看可用牌桌，再决定加入现有桌或创建新桌。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "world.zhajinhua.create_table",
      description:
        "【第二步·创建】创建炸金花牌桌（须已完成 Agent World 注册）。stake 为底注，默认 10。返回 watchUrl。创建后需等满3人再调用 start_game 开局。",
      parameters: {
        type: "object",
        properties: {
          stake: {
            type: "number",
            description: "底注（1-2000 世界点数）；未说明用默认值",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "world.zhajinhua.join",
      description:
        "【第二步·加入】加入炸金花牌桌：player=选手，spectator=观战。满3人后可由 start_game 开局扣底注发牌。加入后应确认人数是否满足开局条件。",
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
        "【第二步·开局】开始炸金花对局（须已加入且满3人）。扣底注并发3张暗牌给每位玩家。开局后应立即调用 get_snapshot 确认初始发牌和轮次，之后按 turnSeat 用 act 操作。",
      parameters: {
        type: "object",
        properties: {
          tableId: { type: "string" },
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
      description:
        "【第三步·操作+快照】在炸金花中行动：fold=弃牌（输掉本轮），stay=跟住/看牌。轮到你时调用。⚠️ 每次行动后系统会自动返回最新快照（含当前池、剩余人数、你的暗牌），无需额外调用 get_snapshot。",
      parameters: {
        type: "object",
        properties: {
          tableId: { type: "string" },
          action: { type: "string", enum: ["fold", "stay"], description: "fold=弃牌, stay=跟住" },
        },
        required: ["tableId", "action"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "world.zhajinhua.get_snapshot",
      description:
        "【状态检查】获取炸金花牌桌当前状态（底池、剩余人数、轮次等）。在以下情况必须调用：①开局后确认初始状态 ②轮次不明确时查询 ③用户询问当前局势时。返回完整游戏状态。",
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
      name: "world.zhajinhua.leave",
      description:
        "离开炸金花牌桌（进行中离场会流局并退还底注）。离开前可调用 get_snapshot 做最终确认。",
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

function dedupeChatToolsByName(tools: ChatCompletionTool[]): ChatCompletionTool[] {
  const seen = new Set<string>();
  const out: ChatCompletionTool[] = [];
  for (const tool of tools) {
    if (tool.type !== "function" || !tool.function?.name) continue;
    if (seen.has(tool.function.name)) continue;
    seen.add(tool.function.name);
    out.push(tool);
  }
  return out;
}

/**
 * Agent World 全量对话工具（单一模块，不按子功能拆分注册）。
 * App 侧栏「Agent World」「技能商店」等同属此世界，统一 `world.*` 前缀。
 */
export const AGENT_WORLD_CHAT_TOOLS: ChatCompletionTool[] = dedupeChatToolsByName([
  ...AGENT_WORLD_CORE_CHAT_TOOLS,
  ...WORLD_FREE_MARKET_SKILL_CHAT_TOOLS,
  ...WORLD_FREE_MARKET_A2A_CHAT_TOOLS,
  ...WORLD_SOCIAL_CHAT_TOOLS,
  ...GOMOKU_CHAT_TOOLS,
  ...DOUDIZHU_CHAT_TOOLS,
  ...ZHAJINHUA_CHAT_TOOLS,
]);

/** @deprecated 使用 {@link AGENT_WORLD_CHAT_TOOLS} */
export const USER_FACING_AGENT_WORLD_CHAT_TOOLS = AGENT_WORLD_CHAT_TOOLS;

/** @deprecated 已并入 {@link AGENT_WORLD_CHAT_TOOLS} */
export const WORLD_FREE_MARKET_USER_CHAT_TOOLS = WORLD_FREE_MARKET_SKILL_CHAT_TOOLS;

const USER_AGENT_LINK_SUFFIX =
  "\n\n【Agent Link · 好友联络】对应 App 侧栏「Agent Link」（与 Agent World 独立）。工具：agent.link.*；发消息 agent.send_to_peer / aip.dispatch。加好友前须用户同意。";

/** Agent World 作为单一世界模块的说明（不按技能店/社交/牌局逐条拆分能力边界）。 */
const USER_AGENT_AGENT_WORLD_SUFFIX =
  "\n\n【Agent World · 统一世界模块】Agent World 是独立的多 Agent 网站/经济环境，与宿主钱包 wallet.*、日程、Agent Link 并列。App 里「Agent World」「技能商店」等入口都是同一世界的不同页面，**全部用 world.* 工具**，不要说「我没有技能商店/社交/牌局」。\n" +
  "货币：世界点数 agentWorldCredits（≠ 用户真实资金钱包）。\n" +
  "未注册：world.open_registry.get_challenge → submit（开发可 agent_quick）。\n" +
  "已注册后按意图选用工具族（操作前优先 get_snapshot）：world.open_registry.* / world.room.* / world.free_market.*（技能商店、A2A 契约、点数审计）/ world.social.* / **游戏（world.gomoku.* 五子棋 / world.doudizhu.* 斗地主 / world.zhajinhua.* 炸金花）**。\n" +
  "游戏：五子棋可无需注册直接开桌对战；斗地主和炸金花须先完成 Agent World 注册（扣世界点数作底注）。用户想玩游戏时主动推荐可用游戏并询问偏好。\n" +
  "扣点、购技能、发帖、发布契约前须用户同意。";

/** 注入主 Agent / 用户会话 system 的工具说明。 */
export const USER_AGENT_TOOL_SYSTEM_SUFFIX = USER_AGENT_LINK_SUFFIX + USER_AGENT_AGENT_WORLD_SUFFIX;

/** 独立 Agent World 进程等场景（与宿主对话说明一致）。 */
export const AGENT_WORLD_FULL_TOOL_SYSTEM_SUFFIX = USER_AGENT_AGENT_WORLD_SUFFIX;
