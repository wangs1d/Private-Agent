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

/** 五子棋：用户与 Agent 双人对战（侧栏「游戏」tab 中的独立娱乐功能）。✅ 无需注册，直接开玩。遵循状态连续性三步模式：①列出 ②选择/创建 ③操作+快照。 */
export const GOMOKU_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "world.gomoku.list_tables",
      description:
        "【第一步·列出】列出当前五子棋对局（15×15 棋盘）。**这是你和用户一起玩的游戏！** 用户想下棋时调用此工具查看可用棋桌。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "world.gomoku.create_table",
      description:
        "【第二步·创建】创建五子棋对局（✅ 无需注册）。你将与用户对战！userColor 指定用户执子颜色。返回 playUrl 后请用户进入对局。",
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

/** 斗地主：用户与 Agent（及子Agent/Bot）一起玩的扑克游戏（侧栏「游戏」tab 独立功能）。✅ 无需注册即可玩。遵循状态连续性三步模式：①列出 ②选择/创建 ③操作+快照。 */
export const DOUDIZHU_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "world.doudizhu.list_tables",
      description:
        "【第一步·列出】列出当前斗地主对局（三人局）。**这是你和用户一起玩的游戏！** 用户想玩时调用此工具。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "world.doudizhu.create_table",
      description:
        "【第二步·创建】创建斗地主对局（✅ 无需注册）。你将与用户及Bot/子Agent一起玩！stake 为底注。",
      parameters: {
        type: "object",
        properties: {
          stake: {
            type: "number",
            description: "底注（1-2000）；未说明用默认值",
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
        "【第二步·加入】加入斗地主牌桌：player=选手（满三人自动开局），spectator=观战。选手加入时若满三人会自动开局。加入后应立即调用 get_snapshot 获取当前状态。",
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
        "离开斗地主牌桌（进行中离场会作废本局）。离开前可调用 get_snapshot 做最终确认。",
      parameters: {
        type: "object",
        properties: { tableId: { type: "string" } },
        required: ["tableId"],
        additionalProperties: false,
      },
    },
  },
];

/** 炸金花：用户与 Agent（及子Agent/Bot）一起玩的比大小游戏（侧栏「游戏」tab 独立功能）。✅ 无需注册即可玩。遵循状态连续性三步模式：①列出 ②选择/创建 ③操作+快照。 */
export const ZHAJINHUA_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "world.zhajinhua.list_tables",
      description:
        "【第一步·列出】列出当前炸金花对局（3-6人）。**这是你和用户一起玩的游戏！** 用户想玩时调用此工具。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "world.zhajinhua.create_table",
      description:
        "【第二步·创建】创建炸金花对局（✅ 无需注册）。你将与用户及Bot/子Agent一起玩！stake 为底注。",
      parameters: {
        type: "object",
        properties: {
          stake: {
            type: "number",
            description: "底注（1-2000）；未说明用默认值",
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
        "【第二步·加入】加入炸金花牌桌：player=选手，spectator=观战。满3人后可由 start_game 开局发牌。加入后应确认人数是否满足开局条件。",
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
        "【第二步·开局】开始炸金花对局（须已加入且满3人）。发3张暗牌给每位玩家。开局后应立即调用 get_snapshot 确认初始发牌和轮次，之后按 turnSeat 用 act 操作。",
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
        "离开炸金花牌桌（进行中离场会流局）。离开前可调用 get_snapshot 做最终确认。",
      parameters: {
        type: "object",
        properties: { tableId: { type: "string" } },
        required: ["tableId"],
        additionalProperties: false,
      },
    },
  },
];

/** 21点：用户与 Agent（庄家）对战（侧栏「游戏」tab 独立功能）。✅ 无需 Agent World 注册。 */
export const BLACKJACK_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "world.blackjack.start",
      description:
        "【开局】为用户开一局 21 点（✅ 无需 Agent World 注册）。你担任庄家，用户为玩家。返回 snapshot 后请用户进入对局或在聊天中说要牌/停牌。",
      parameters: {
        type: "object",
        properties: {
          stake: { type: "integer", description: "可选底注，1–2000，默认 50" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "world.blackjack.get_snapshot",
      description:
        "【状态检查】获取 21 点当前牌局（手牌、庄家明牌、阶段、胜负）。用户询问局势或操作前必须调用。",
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
      name: "world.blackjack.hit",
      description: "【代用户要牌】用户口述「要牌/再来一张」时调用。",
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
      name: "world.blackjack.stand",
      description: "【代用户停牌】用户口述「停牌/不要了」时调用。",
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
  ...BLACKJACK_CHAT_TOOLS,
]);

/** @deprecated 使用 {@link AGENT_WORLD_CHAT_TOOLS} */
export const USER_FACING_AGENT_WORLD_CHAT_TOOLS = AGENT_WORLD_CHAT_TOOLS;

/** @deprecated 已并入 {@link AGENT_WORLD_CHAT_TOOLS} */
export const WORLD_FREE_MARKET_USER_CHAT_TOOLS = WORLD_FREE_MARKET_SKILL_CHAT_TOOLS;

const USER_AGENT_LINK_SUFFIX =
  "\n\n【Agent Link · 好友联络】对应 App 侧栏「Agent Link」（与 Agent World 独立）。工具：agent.link.*；发消息 agent.send_to_peer / aip.dispatch。加好友前须用户同意。";

/**
 * 主 Agent 工具说明（游戏 + Agent World + Agent Link）。
 * ⚠️ 重要架构区分：
 * - 「游戏」= 侧边栏独立 tab，用户与 Agent 一起玩的娱乐功能（本文件重点）
 * -「Agent World」= 多 Agent 经济环境（技能商店/社交），与游戏无关
 */
const USER_AGENT_AGENT_WORLD_SUFFIX =
  "\n\n【🎮 游戏 · 你可以陪用户一起玩！】\n" +
  "App 侧栏「**游戏**」tab 里列出的**每一款**（五子棋、斗地主、炸金花、21点）都是**你和用户一起玩的对局**，不是 App 独立功能，也不是 Agent World 经济模块。\n\n" +
  "**⚠️ 禁止说「游戏中心我调不了」「只有五子棋能玩」「那是 App 功能」——这些游戏就是你的能力！**\n\n" +
  "**🎯 四款游戏（工具前缀 world.* 仅历史命名，与 Agent World 注册/点数无关）**：\n" +
  "1. 🎯 **五子棋**（world.gomoku.*）：双人棋盘对战。list_tables → create_table/join → play\n" +
  "2. 🃏 **斗地主**（world.doudizhu.*）：三人局。list_tables → create_table/join → play\n" +
  "3. 🎴 **炸金花**（world.zhajinhua.*）：比大小。list_tables → create_table/join → start_game/act\n" +
  "4. 🃏 **21点**（world.blackjack.*）：你当庄家。start → get_snapshot；用户要牌/停牌时用 hit/stand\n\n" +
  "**🎮 你的角色**：\n" +
  "- ✅ 你是**玩家/对手**（21点为庄家），不是裁判或旁观者\n" +
  "- ✅ 用户说「来一局」「想玩游戏」「斗地主/21点」时，**立即**调用对应工具开局\n" +
  "- ✅ 四款游戏工具（world.gomoku/doudizhu/zhajinhua/blackjack.*）已直接可用，**不要** tool_search 后再说「没有上线」\n\n" +
  "**📋 通用流程**：① list_tables（21点用 start）→ ② create_table/join → ③ play/act/hit/stand + 快照\n\n" +
  "---\n\n" +
  "【🌍 Agent World · 经济环境（与游戏完全独立）】\n" +
  "如果用户提到「技能商店」「社交推文」「世界点数」「A2A 外包」，才使用以下工具：\n" +
  "- world.open_registry.* （注册）\n" +
  "- world.free_market.* （技能商店/A2A 契约）\n" +
  "- world.social.* （社交动态）\n" +
  "⚠️ 游戏不属于 Agent World，直接玩即可！";

/** 注入主 Agent / 用户会话 system 的工具说明。 */
export const USER_AGENT_TOOL_SYSTEM_SUFFIX = USER_AGENT_LINK_SUFFIX + USER_AGENT_AGENT_WORLD_SUFFIX;

/** 独立 Agent World 进程等场景（与宿主对话说明一致）。 */
export const AGENT_WORLD_FULL_TOOL_SYSTEM_SUFFIX = USER_AGENT_AGENT_WORLD_SUFFIX;
