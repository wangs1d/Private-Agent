/**
 * 内置 Agent LLM 工具 schema 清单（ChatCompletionTool）——单一事实源。
 *
 * 2026-09-11 链路重构：此前这些 schema 手写内联在 openai-compatible-tool-loop.ts
 * 单体中段（该文件 3400+ 行，schema/编排/超时/压缩混杂）。抽出后与 ToolRegistry
 * 注册的执行器做 bootstrap 双向 diff（chat-tool-drift.ts），「有 schema 无执行器 /
 * 有执行器无 schema」的漂移在启动时直接暴露，而不是等模型调用时报「未知工具」
 * （2026-08-30 self.list_custom_skills 实例）。
 *
 * 新增工具的接线方式：在本文件（或领域工具文件）声明 schema + 在 tools/*.ts 注册
 * 执行器；启动时 drift 检查会校验两者对齐。
 */
import type { ChatCompletionTool } from "openai/resources/chat/completions";

export const INFO_WEB_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "search_web",
      description:
        "联网搜索公开网页信息（按发布时间从新到旧）。query 由你按用户意图组织成完整、具体、语义清晰的搜索词（可含主体+特征+限定词），不要机械截成 2-6 字短词；时效话题请加当前年月或「最新」。\n如果有多个独立的查询维度（例如对比多个商品 / 多个主题），请在同一轮内并行发起多个 search_web 调用，每个 tool_call 用不同的 query，避免串行等待。\n【强制调用规则】涉及时事、新闻、股价、排片、票价、天气、价格、公告等时效信息时必须先调用本工具，禁止仅凭训练数据作答；本地消费（电影票、外卖等）同样须先搜索再试。整合结果时优先引用发布时间最新的条目并注明日期。动态/新闻/盘点/对比类问题要把多来源信息按主题整理充分（保留日期、数字、人名、作品名等细节），用 Markdown 小标题/加粗/表格组织成结构清晰的充分回答；只有真正的单一事实判断（是/否、单个数据点）才用「结论 + 1句依据」收尾。若摘要不足以覆盖用户要的细节（事件经过、正文内容），继续用 fetch_web / deep_search 深读相关链接后再回答。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "integer", description: "返回数量，1-20，默认 8" },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_web",
      description: "读取指定网页正文并返回标题、摘要与纯文本内容。自动移除导航栏、页脚、广告等噪音，提取核心正文。\n如果已经从 search_web 拿到多个需要深读的独立 URL，请在同一轮内并行发起多个 fetch_web 调用，每个 tool_call 用不同的 url，避免串行等待。",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "要读取的网页 URL" },
          include_links: { type: "boolean", description: "是否同时返回页面中的链接列表（默认 false）" },
        },
        required: ["url"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_images",
      description:
        "搜索公开图片结果，下载并转存为服务端本地 PNG，返回可在对话中直接预览的 mediaUrl/thumbnailUrl（形如 /agent/images/...png），以及可打开来源页的 pageUrl。\n" +
        "适用场景：用户**主动表达**想看/找图/照片/实拍图/长什么样/配图/壁纸/风景照/表情包/给我看看等视觉诉求时，并行调用本工具（可与 search_web 并行），直接出图，不要建议用户去其他平台。\n" +
        "不要误触发：仅当**当前轮**用户明确要图时才调用。若只是普通提及某事物（如聊天里带\"图\"字、或前面轮次搜过图），且本轮用户并未索图，不要调用本工具——宁缺勿滥，避免无关照片刷屏。\n" +
        "回答时优先展示 3-6 条最相关图片 PNG，附来源页链接；不要把图片搜索误用成 image.generate（生成图）。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "图片搜索词，按要找的图片内容具体描述（主体+外观特征+场景），完整具体，不要过度截短" },
          limit: { type: "integer", description: "返回数量，1-8，默认 4" },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_images_batch",
      description:
        "多维对比出图：一次调用同时搜索多个维度、每个维度两侧的对比图，返回按维度分组的 mediaGroups（每个 group 含维度标题 + 左/右两侧图片列表），供前端「一段文字介绍后放一组对比照片」交错渲染。\n" +
        "适用场景：用户要求对比两类事物（如「A 与 B 的区别」「A vs B 哪个好」），或要求从多个方面/维度找图（如「颜色持久度、价格、色号对比」）时，**优先**用本工具代替普通 search_images，以实现多维度、两侧对比而非单批平铺。\n" +
        "用法：query 写「A 对比 B」（自动拆两侧）；可选 dimensions 数组指定要对比的维度（如 [\"持久度\",\"防水\",\"色号\"]），不传时自动按两侧共同点推断维度标题。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "对比关键词，含「A 对比 B / A vs B / A 和 B 区别」等对比语义" },
          dimensions: {
            type: "array",
            items: { type: "string" },
            description: "对比维度列表（可选），如 [\"持久度\",\"防水\",\"色号\"]；缺省时按两侧共同点自动推断",
          },
          limit_per_group: { type: "integer", description: "每组每侧返回张数，1-4，默认 3" },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_videos",
      description:
        "搜索公开视频结果并返回标题、播放页 pageUrl、缩略图 thumbnailUrl 与来源。\n" +
        "适用场景：用户明确要「搜视频」「找视频」「教程视频」「B站/YouTube 视频」「视频素材」等。回答时给出可点击播放页，必要时附缩略图；不要重复用普通 search_web 搜同一视频需求。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "视频搜索词，完整具体，按要找的视频内容描述" },
          limit: { type: "integer", description: "返回数量，1-12，默认 8" },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "info.inspect_webpage",
      description: "巡检网页：返回标题、摘要、内容预览、主要链接和同域链接，便于继续导航。",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "info.navigate_site",
      description: "从起始 URL 自动多层跟进链接，直到命中目标关键词页面（如注册入口）。",
      parameters: {
        type: "object",
        properties: {
          startUrl: { type: "string" },
          goalKeywords: { type: "array", items: { type: "string" } },
          maxDepth: { type: "integer", description: "默认 2，最大 5" },
          maxPages: { type: "integer", description: "默认 20，最大 80" },
          sameHostOnly: { type: "boolean", description: "默认 true" },
        },
        required: ["startUrl"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "deep_search",
      description:
        "深度搜索：一次调用完成「搜索 + 抓取 Top 网页正文」。先按 query 搜索，再并行读取前 N 条结果的完整正文（自动去导航栏/广告噪音），每条结果同时带 snippet 摘要与 content 全文。\n" +
        "适用场景：需要深入了解某个主题、扒取细节/数据/结论（如产品详情、事件经过、技术细节、行情解读）时，优先用本工具而不是 search_web + 逐个 fetch_web 来回多次。\n" +
        "若只需快速浏览话题就继续用 search_web。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "搜索词，完整具体，按要查的主题语义组织" },
          limit: { type: "integer", description: "搜索返回条数，1-20，默认 8" },
          fetch_pages: { type: "integer", description: "抓取完整正文的 Top 条数，1-10，默认 3" },
          content_limit: { type: "integer", description: "单条正文最大字符数，1000-8000，默认 3000" },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "hot_rankings",
      description:
        "实时热点榜单：聚合微博/百度/知乎/B站 当前热门话题，每条含平台、排名、话题与热度。\n" +
        "适用场景：用户问「今天有什么热点/大家都在看什么/热搜」「最近关注什么」等要掌握当下时事话题，或需要补充实时热点素材时调用；可指定 platforms（weibo/baidu/zhihu/bilibili）只看特定平台。",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "integer", description: "返回条数，1-60，默认 20" },
          platforms: { type: "array", items: { type: "string" }, description: "可选平台：weibo/baidu/zhihu/bilibili，默认全部" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "weather.get_local",
      description:
        "获取当地天气与穿衣建议（Open-Meteo）。\n" +
        "⚠️ 不要猜测用户所在城市——如果用户未明确说城市名，不要传 city/latitude/longitude，工具会自动获取用户真实位置。\n" +
        "用户明确说了城市名时才传 city（如「上海天气」→ city:'上海'）。\n" +
        "可选 timezone（IANA，默认 Asia/Shanghai）。",
      parameters: {
        type: "object",
        properties: {
          latitude: { type: "number" },
          longitude: { type: "number" },
          city: { type: "string", description: "城市名（与坐标二选一）" },
          timezone: { type: "string" },
          locationLabel: { type: "string", description: "展示用地点名" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "http.request",
      description:
        "发起任意 HTTP 请求（等价 curl），对接外部 API / Webhook / 自建服务。自动 SSRF 防护（拒绝内网地址），响应 body 默认截断 8KB。method 默认 GET；headers/body 可选；超时默认 15s 上限 60s。",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "完整 http(s) URL（内网地址会被拒绝）" },
          method: {
            type: "string",
            enum: ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"],
            description: "默认 GET",
          },
          headers: {
            type: "object",
            description: "请求头，如 {\"Authorization\":\"Bearer xxx\",\"Content-Type\":\"application/json\"}",
            additionalProperties: { type: "string" },
          },
          body: { type: "string", description: "请求体（POST/PUT/PATCH 时使用）。JSON 请序列化为字符串" },
          timeoutMs: { type: "integer", description: "超时毫秒，默认 15000，上限 60000" },
          maxBytes: { type: "integer", description: "响应 body 截断字节数，默认 8192，上限 65536" },
          followRedirects: { type: "boolean", description: "是否跟随重定向，默认 true（最多 5 次）" },
        },
        required: ["url"],
        additionalProperties: false,
      },
    },
  },
];

export const LIFE_ASSISTANT_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "budget.calculate",
      description: "根据收入与各项支出计算剩余预算并给出建议。",
      parameters: {
        type: "object",
        properties: {
          income: { type: "number", description: "月收入" },
          rent: { type: "number", description: "房租" },
          food: { type: "number", description: "餐饮" },
          transport: { type: "number", description: "交通" },
        },
        required: ["income"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "shopping.suggest",
      description: "根据商品与预算给出购物建议（比价决策辅助，不执行购买）。",
      parameters: {
        type: "object",
        properties: {
          item: { type: "string", description: "商品名称或品类" },
          budget: { type: "number", description: "预算上限（元）" },
        },
        required: ["item"],
        additionalProperties: false,
      },
    },
  },
];

/** 宿主 Agent 真实资金钱包（与 Agent World 世界点数无关）。 */
export const WALLET_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "wallet.get_balance",
      description: "查询当前用户绑定的真实资金钱包余额（CNY，只读）。",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "wallet.get_transactions",
      description: "查询用户钱包交易记录，支持分页与类型过滤。",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "integer", description: "返回条数，默认 20" },
          offset: { type: "integer", description: "偏移，默认 0" },
          type: {
            type: "string",
            enum: ["all", "income", "expense", "transfer"],
            description: "交易类型过滤，默认 all",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "wallet.transfer",
      description: "在用户明确同意后，代其向其他 Agent 转账（recipientId 为对方 session/user id）。",
      parameters: {
        type: "object",
        properties: {
          recipientId: { type: "string", description: "收款方 Agent id" },
          amount: { type: "number", description: "转账金额（CNY，须 > 0）" },
          remark: { type: "string", description: "可选备注" },
        },
        required: ["recipientId", "amount"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "wallet.recharge",
      description: "在用户明确要求后，代其向钱包充值（演示/测试用）。",
      parameters: {
        type: "object",
        properties: {
          amount: { type: "number", description: "充值金额（CNY，须 > 0）" },
        },
        required: ["amount"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "wallet.purchase",
      description:
        "代用户消费/购物（须用户授权）。覆盖外卖、打车、酒店、电影票、网购、缴费、红包等50+类别。category 示例：food_delivery/taxi/hotel/movie/shopping/phone_bill/red_packet 等。",
      parameters: {
        type: "object",
        properties: {
          category: {
            type: "string",
            description:
              "消费类别，如 food_delivery, taxi, hotel, movie, shopping, train, flight, phone_bill, red_packet, other 等",
          },
          amount: { type: "number", description: "消费金额（CNY，须 > 0）" },
          description: { type: "string", description: "消费描述（订单摘要）" },
          merchant: { type: "string", description: "商户/平台名称，如美团、滴滴、京东" },
          orderDetails: {
            type: "object",
            description: "可选订单细节（商品名、数量等）",
          },
        },
        required: ["category", "amount", "description"],
        additionalProperties: false,
      },
    },
  },
];

/** Agent Link：好友列表、好友请求（与 App 侧栏「Agent Link」/ MailboxPage 对齐）。 */
export const AGENT_LINK_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "agent.link.list_friends",
      description: "列出当前用户的好友（Agent Link）。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "agent.link.list_friend_requests",
      description: "列出好友请求。scope: all（默认）| incoming | outgoing。",
      parameters: {
        type: "object",
        properties: {
          scope: { type: "string", enum: ["all", "incoming", "outgoing"] },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "agent.link.send_friend_request",
      description: "向另一用户发送好友请求（须用户明确要求）。",
      parameters: {
        type: "object",
        properties: {
          toActorId: { type: "string", description: "对方 userId/sessionId" },
          message: { type: "string", description: "可选附言" },
        },
        required: ["toActorId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "agent.link.respond_friend_request",
      description: "接受或拒绝收到的好友请求。",
      parameters: {
        type: "object",
        properties: {
          requestId: { type: "string" },
          accept: { type: "boolean" },
        },
        required: ["requestId", "accept"],
        additionalProperties: false,
      },
    },
  },
];

export const AGENT_RELAY_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "agent.send_to_peer",
      description: "向好友或其它已配对 Agent 发送中继消息（可与 agent.link 好友配合）。",
      parameters: {
        type: "object",
        properties: {
          targetSessionId: { type: "string", description: "对方 sessionId" },
          body: { type: "string", description: "消息正文" },
          subject: { type: "string", description: "可选主题" },
          traceId: { type: "string", description: "可选追踪 id" },
        },
        required: ["targetSessionId", "body"],
        additionalProperties: false,
      },
    },
  },
];

/** 对话中自动创建/查询日程与提醒的内置工具组（写入定时任务，非独立日历应用）。 */
export const CALENDAR_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "reminder.plan",
      // 2026-09-05 与 calendar.create_from_text/create_task 的重复行为规则互相去重：
      // 每个 tool 只保留自身必需的最小说明（delegate 全量注入时 schema 按轮计费）。
      description:
        "【生活助手】按用户原句创建定时提醒并写入服务端日程。带明确时间点的单次提醒（「明天 9:00 提醒我开会」「晚上10点叫我吃药」）必须直接调用本工具，不要追问、不要只口头答应。仅当返回 needsRecurrenceConfirm=true 时，按 suggestedQuestion 向用户追问一次后再次调用。成功返回 taskId、nextRunAt（UTC）、nextRunAtLocal（展示给用户必须用此字段）、recurrence。\n提醒方式默认弹窗（popup）；仅用户明确要求（「打电话提醒我」「语音喊我」）才用 TTS/电话，不要主动升级。",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "用户原句，须含时间与提醒事项" },
          subject: { type: "string", description: "可选，与 date 组合解析（无 text 时）" },
          date: { type: "string", description: "可选，如「明天 09:00」（无 text 时）" },
          runAt: { type: "string", description: "可选 ISO-8601，与 subject 结构化创建" },
          recurrence: {
            type: "string",
            enum: ["none", "daily", "weekly", "yearly"],
            description: "默认 none；仅用户明确要每天/每周/每年重复时才填 daily/weekly/yearly",
          },
          shortTitle: { type: "string", description: "简洁展示标题（「今日安排」紧凑列表用）：去掉指令词与时间词只留核心事项，如「明天9点提醒我吃药」→\"吃药\"；用户对助手的称呼（如「小弟」「老哥」）也要去掉。缺省时服务端自动生成。" },
          category: { type: "string", enum: ["itinerary", "trivia"], description: "trivia=喝水/睡觉/锻炼等生活琐事(照常提醒,不进「今日安排」)；行程正事填 itinerary；缺省 itinerary。" },
          reminderMessage: { type: "string", description: "到点时展示给用户的友好提醒文案，如「该睡觉啦！」而非「喊我睡觉」；不要把用户对助手的称呼（如「小弟」）写进文案" },
          timezone: { type: "string", description: "IANA 时区，默认 Asia/Shanghai" },
        },
        required: ["text"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "calendar.create_from_text",
      description:
        "【内置 Calendar】按用户原句一句话创建日程/提醒。带明确时间点的单次日程/提醒必须直接调用，不要追问；仅当返回 needsRecurrenceConfirm=true 才按 suggestedQuestion 追问一次后重调。解析失败返回 matched=false；展示时间用返回的 nextRunAtLocal。",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "用户原句，含时间与事项" },
          timezone: { type: "string", description: "IANA 时区，默认 Asia/Shanghai" },
          forceCreate: {
            type: "boolean",
            description: "用户明知时间冲突仍坚持创建时传 true（跳过冲突拦截）",
          },
        },
        required: ["text"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "calendar.create_task",
      description:
        "【内置 Calendar】按结构化字段创建定时任务：reminder（提醒）/action（HTTP 动作）/weather_brief（天气简报，需用户已在天气页保存定位）/agent_task（到点让 Agent 执行 prompt）。runAt 须为 ISO-8601 未来时间；时间/类型已明确时优先用本工具，含糊时用 calendar.create_from_text。返回 taskId、nextRunAt（UTC）、nextRunAtLocal（展示用）。",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "完整任务标题（用于日程页完整列表；reminder 类型可选，由 reminderMessage 兜底）" },
          shortTitle: { type: "string", description: "简洁展示标题（「今日安排」紧凑列表用）：去掉指令词与时间词只留核心事项，如「明天9点提醒我吃药」→\"吃药\"；用户对助手的称呼（如「小弟」「老哥」）也要去掉。reminder 类型必填；其他类型缺省用 title 兜底。" },
          description: { type: "string" },
          kind: {
            type: "string",
            enum: ["reminder", "action", "weather_brief", "agent_task"],
            description: "weather_brief 需用户已在天气页保存定位；agent_task 会在到点后让 Agent 执行 prompt",
          },
          category: {
            type: "string",
            enum: ["itinerary", "trivia"],
            description: "trivia=喝水/睡觉/锻炼等生活琐事(照常提醒,不进「今日安排」)；行程正事填 itinerary；缺省 itinerary。",
          },
          runAt: { type: "string", description: "ISO-8601" },
          recurrence: {
            type: "string",
            enum: ["none", "daily", "weekly", "yearly"],
            description: "默认 none；勿在用户未要求时填 daily",
          },
          timezone: { type: "string" },
          durationMinutes: { type: "number", description: "事件时长（分钟）。会议/就诊/课程等有时长的安排必填（用于冲突检测与区间展示）；纯时间点提醒不填。" },
          remindBeforeMinutes: {
            type: "array",
            items: { type: "number" },
            description: "提前量提醒（分钟数组，如 [15,5] 表示提前 15 和 5 分钟各提醒一次）。重要安排可填。",
          },
          forceCreate: {
            type: "boolean",
            description: "用户明知时间冲突仍坚持创建时传 true（跳过冲突拦截）",
          },
          reminderMessage: { type: "string", description: "仅 kind=reminder。到点时展示给用户的友好提醒文案，如「该睡觉啦！」而非「喊我睡觉」" },
          action: {
            type: "object",
            description: "仅 kind=action",
            properties: {
              url: { type: "string" },
              method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
            },
          },
          actionUrl: { type: "string", description: "与 action.url 二选一" },
          agentTask: {
            type: "object",
            description: "仅 kind=agent_task",
            properties: {
              prompt: { type: "string", description: "到点后交给 Agent 执行的自然语言任务" },
              accessMode: { type: "string", enum: ["sandbox", "full"], description: "已废弃，Agent 始终以 full 运行；保留字段仅为协议兼容" },
            },
          },
          prompt: { type: "string", description: "agent_task 的快捷 prompt 字段" },
        },
        required: ["description", "kind", "runAt"],
        additionalProperties: true,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "calendar.list_tasks",
      description:
        "【内置 Calendar】查询当前用户已创建的定时日程/提醒（含下次执行时间）。仅当用户**明确**要查看/确认日程或定时任务时调用；禁止用于「你确定？」「真的吗？」等短句追问（应结合对话线程上一轮回复作答）。",
      parameters: {
        type: "object",
        properties: {
          from: { type: "string", description: "范围起点 ISO，可选" },
          to: { type: "string", description: "范围终点 ISO，可选" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "calendar.delete_task",
      description:
        "【内置 Calendar】删除用户已创建的定时日程/提醒。仅当用户明确要求删除/取消某个日程或提醒时调用；可先用 calendar.list_tasks 找到 taskId。",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "要删除的日程/提醒 taskId（list_tasks 返回）" },
        },
        required: ["taskId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "calendar.update_task",
      description:
        "【内置 Calendar】改期/编辑单个日程：改时间、改时长、改提前量、暂停或恢复。taskId 来自 calendar.list_tasks。",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "要更新的日程 taskId" },
          title: { type: "string" },
          shortTitle: { type: "string" },
          description: { type: "string" },
          reminderMessage: { type: "string" },
          category: { type: "string", enum: ["itinerary", "trivia"] },
          runAt: { type: "string", description: "新时间（ISO-8601，改期用）" },
          recurrence: { type: "string", enum: ["none", "daily", "weekly", "yearly"] },
          timezone: { type: "string" },
          durationMinutes: { type: "number", description: "新时长（分钟）" },
          remindBeforeMinutes: {
            type: "array",
            items: { type: "number" },
            description: "新提前量提醒数组（分钟）",
          },
          status: {
            type: "string",
            enum: ["active", "paused", "cancelled"],
            description: "paused=暂停提醒；cancelled=取消（软删）；active=恢复",
          },
          forceCreate: { type: "boolean", description: "用户明知改期后仍冲突时传 true 强制改" },
        },
        required: ["taskId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "calendar.find_free_slots",
      description:
        "【内置 Calendar】查询未来空闲时段（自动扣除已有安排占用）。用于「什么时候有空」「帮我约时间」，或改期遇 conflict=true 后给用户改期建议。返回 slots[]（startLocal/endLocal 展示），由用户选定。",
      parameters: {
        type: "object",
        properties: {
          durationMinutes: { type: "number", description: "需要的连续时长（分钟），默认 60" },
          from: { type: "string", description: "范围起点 ISO，可选" },
          to: { type: "string", description: "范围终点 ISO，可选" },
          dailyWindow: {
            type: "object",
            description: "每日可用窗口（HH:MM），默认 09:00–21:00",
            properties: {
              start: { type: "string" },
              end: { type: "string" },
            },
          },
          timezone: { type: "string", description: "IANA 时区" },
          excludeTaskId: { type: "string", description: "排除自身任务" },
          limit: { type: "number", description: "最多返回几个空闲槽" },
        },
        additionalProperties: false,
      },
    },
  },
];

export const PHONE_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "phone.ensure_my_number",
      description:
        "仅当用户明确要求办理虚拟电话时调用：分配或查询用户与 Agent 共用的 6 位虚拟号码（登记在 Agent 名下）。禁止未要求时主动占号。Agent 互拨前须已申领；对用户可说「您的虚拟号码」。App 内用户呼叫 Agent 不必再输 6 位号。跨 Agent 配对规则同中继。",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "phone.virtual_call",
      description:
        "Agent 互拨：拨打另一 Agent 的 6 位虚拟号码（被叫须已申领）。主叫 Agent 须已申领号码（用户明确要求时用 phone.ensure_my_number 办理）。向目标 Agent 推送虚拟来电并朗读 spokenMessage。ringStyle：reminder=自提醒；peer=联络其他 Agent（默认）。与用户通话请用 phone.call_user，勿用本工具。",
      parameters: {
        type: "object",
        properties: {
          toPhone: { type: "string", description: "6 位数字虚拟号码" },
          spokenMessage: { type: "string", description: "对方将听到的播报正文（尽量简短清晰）" },
          ringStyle: {
            type: "string",
            enum: ["peer", "reminder"],
            description: "peer=联络其他 Agent；reminder=提醒风格",
          },
        },
        required: ["toPhone", "spokenMessage"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "phone.call_user",
      description:
        "Agent 呼叫当前用户：通过 WebSocket 向用户客户端推送语音来电（含 TTS），用户可接听并文字/语音回复。用户不需要虚拟号码。spokenMessage 为播报正文。ringStyle：reminder=提醒；peer=联络（默认）。\n【绝对禁止】\n- 一轮只许调用一次，多次调用系统只认第一次。\n- 禁止回复「马上给你打过去」「好的我给您打个电话」「现在给你打确认」「再打一次」「马上去设」等任何提前告知或重复承诺——用户不需要知道你要打，直接打就是。\n- 别一上来就甩「我是 AI 打不了电话」「没法拨号」这种话。\n- 打电话是后台事儿，跟用户说话时别提倒计时、别说「到时候接一下」、别提「准时喊你」这种内部细节。",
      parameters: {
        type: "object",
        properties: {
          toUserId: { type: "string", description: "被叫用户 ID，通常省略则使用当前会话用户" },
          spokenMessage: { type: "string", description: "用户将听到的播报正文" },
          ringStyle: {
            type: "string",
            enum: ["peer", "reminder"],
            description: "peer=联络；reminder=提醒",
          },
        },
        required: ["spokenMessage"],
        additionalProperties: false,
      },
    },
  },
];

/** 沙箱模式下从模型 tools 列表移除、完全访问时须下发的视觉高权限工具。 */
export const VISION_SANDBOX_RESTRICTED_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "vision.http_pull",
      description:
        "【服务端视觉】通过 HTTP(S) 抓取远程快照图像（如摄像头 MJPEG/快照接口）。抓取成功后图像会注入当前对话下一轮模型上下文用于识别场景。**请勿用于探测内网**（服务端默认阻断 localhost 与私网 IP；可对可信域名配置 AGENT_VISION_HTTP_PULL_ALLOW_HOSTS）。",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "http(s) 图像快照完整 URL" },
          sourceId: { type: "string", description: "可选稳定源标记（telemetry）" },
        },
        required: ["url"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "vision.periodic_start",
      description:
        "【服务端定时视觉】按固定间隔从给定 HTTP(S) 快照 URL 拉帧并向模型推送一轮「配图」巡检推理。**客户端 WebSocket 需在线**才能收到助手的 chunk/done。与单次 vision.http_pull 不同：此为服务端调度无需用户每次手动发送图像。",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "快照 URL（同上约束）" },
          intervalSeconds: {
            type: "integer",
            description: "间隔秒数（下限约 30s，可由环境变量收紧）",
          },
          prompt: {
            type: "string",
            description: "每轮发给模型的巡检文案（可选）",
          },
        },
        required: ["url", "intervalSeconds"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "vision.periodic_stop",
      description: "停止指定的定时视觉任务（需提供 vision.periodic_start 返回的 jobId）。",
      parameters: {
        type: "object",
        properties: { jobId: { type: "string" } },
        required: ["jobId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "vision.periodic_stop_all",
      description: "停止当前会话用户的全部定时视觉任务。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "vision.periodic_list",
      description: "列出当前会话用户的定时视觉任务（jobId、url、间隔与巡检文案）。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "vision.list_cameras",
      description:
        "【视觉设备清单】列出当前用户所有「能看」的在线设备：IP 摄像头（camera.*）、手机/电脑摄像头、电脑屏幕（screen_capture.*）、智能眼镜（glasses.display.*）等。" +
        "返回每个设备的 deviceId / kind / name / 在线状态 / 视觉 capability（含可调 action 清单，如 camera.take_photo）。" +
        "用户说「我有哪些摄像头」「能看哪里」「监控一下家里」「看看门口」时先调本工具知道有哪些设备可看，再调 vision.see_device 取画面。" +
        "与 device.list 区别：device.list 返回所有设备（含纯传感器/智能家居等），本工具只返回具备视觉能力的设备。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "vision.see_device",
      description:
        "【从设备取实时画面】从指定设备取一帧当前画面并注入下一轮模型上下文（让 Agent「看到真实世界」）。" +
        "用户说「看一下门口」「看下家里」「看看我面前」「实时看下摄像头」「看看我电脑屏幕」「看一下我桌面」时调用本工具。" +
        "参数：device_id（从 vision.list_cameras 结果中选取）+ 可选 action（默认按设备 capability 自动选 camera.take_photo / screen_capture.screenshot / glasses.display.capture）。" +
        "特殊 device_id='desktop:bridge'：走 desktop-bridge-coordinator 路径截取本机桌面（用户电脑通过 desktop_bridge_register 注册的桌面），" +
        "支持可选 region=[x,y,w,h] 截取区域。" +
        "与 vision.http_pull 区别：http_pull 拉远程 URL（公网/局域网快照接口）；see_device 调 device-bus 接入的真实设备（IP 摄像头/手机/眼镜）或 desktop-bridge 桌面，是真正的「看真实世界」。" +
        "返回简要元数据（mimeType/byteLength/capturedAt），图像已注入模型上下文，请基于图像描述场景并回答。",
      parameters: {
        type: "object",
        properties: {
          device_id: {
            type: "string",
            description: "设备 ID（从 vision.list_cameras 结果中选取，如 camera:front / phone:abc / glasses:xyz / desktop:bridge）",
          },
          action: {
            type: "string",
            description: "可选：指定调用的 action（如 camera.take_photo / screen_capture.screenshot / glasses.display.capture）。留空则按设备 capability 自动选择。",
          },
          params: {
            type: "object",
            description: "可选：action 的额外参数（如 PTZ 预设位、摄像头选择等）",
            additionalProperties: true,
          },
          region: {
            type: "array",
            items: { type: "number" },
            description: "可选：仅 desktop:bridge 路径生效，截取区域 [x, y, width, height]",
          },
          timeoutMs: {
            type: "number",
            description: "可选：仅 desktop:bridge 路径生效，截图超时毫秒（默认 60000，上限 120000）",
          },
        },
        required: ["device_id"],
        additionalProperties: false,
      },
    },
  },
];

export const VISION_CHAT_TOOLS: ChatCompletionTool[] = VISION_SANDBOX_RESTRICTED_CHAT_TOOLS;

/**
 * Agent 底层语音能力 ChatCompletionTool schema（说 + 听）。
 *
 * 之前 voice.speak / voice.send_message 已在 ToolRegistry 注册 handler，
 * 但缺这份 schema，导致 LLM 看不到这两个工具——是个真正的盲点。
 * 本数组把它们正式暴露给 LLM，并新增 voice.transcribe（主动 ASR）。
 *
 * 与 phone.call_user 的区别：phone 走 `isExplicitPhoneCallRequest` 旁路注入，
 * voice 工具族走常规 tool-search 选择 + 关键词分类。
 */

/**
 * Surface-on-Demand：召唤客户端信息面板（语音模式"念+显"双通道的"显"）。
 * handler 在 ToolRegistry（surface-tools.ts）；核心库 dialogue 分组收录，
 * 每轮注入。典型场景：语音模式下用户问"今天有什么安排"→ 调用本工具把
 * 「今日安排」悬浮窗召唤到桌面，同时文本给出简短口头摘要（会被 TTS 朗读）。
 */
export const SURFACE_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "surface.show",
      description:
        "【召唤桌面悬浮卡】要求客户端在桌面上展示一个信息面板（悬浮卡），配合文本回答形成" +
        "\"念+显\"双通道：文本回答给口头摘要（语音模式下会被朗读），悬浮卡给可视化细节。" +
        "典型场景：用户问「今天有什么安排」「看看日程」「今天要做什么」→ 调用本工具展示" +
        "today_schedule，同时用一两句话口头概括今日要点。不要为纯闲聊调用本工具。",
      parameters: {
        type: "object",
        properties: {
          surface: {
            type: "string",
            enum: ["today_schedule"],
            description: "要召唤的面板：today_schedule=今日安排悬浮卡",
          },
          ttlSeconds: {
            type: "number",
            description: "可选：悬浮卡展示时长（秒，5~300，默认 30，到期自动淡出）",
          },
        },
        required: ["surface"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "surface.dismiss",
      description:
        "【收起桌面展示页】用户要求关闭/收起桌面上展示的内容面板时调用。" +
        "典型场景：语音模式下屏幕中央正在展示照片/视频，用户说「把图片收了」「关掉这个页面」「不想看了」" +
        "→ 调用本工具收起展示页。内容面板不会自动消失，依赖本工具或用户手动关闭。",
      parameters: {
        type: "object",
        properties: {
          surface: {
            type: "string",
            enum: ["media", "all"],
            description: "要收起的面板：media=媒体中央展示页（默认），all=全部浮层面板",
          },
        },
        additionalProperties: false,
      },
    },
  },
];

export const VOICE_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "voice.speak",
      description:
        "【语音播报·即时模式】合成语音并立即对用户播报（无来电 UI、无振铃，客户端后台一次性播放）。适用于：状态告知、提醒、即时反馈、不需要用户回应的简短播报。与 phone.call_user 区别：phone 是来电体验（振铃+接通+通话 UI），voice.speak 是轻量后台播报。用户问「能不能说话」「用语音告诉我」时调用本工具。\n【绝对禁止】调用后不要在文本回复里复述语音内容，工具会替你落地。禁止回复「马上给你播报」「好的我给您念」等提前告知。",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "要朗读的文字内容（建议 200 字以内，过长会被截断）" },
          mode: {
            type: "string",
            enum: ["instant", "reminder"],
            description: "instant=即时播报（默认），reminder=提醒式播报（带标题/优先级，客户端可显示卡片）",
          },
          title: { type: "string", description: "reminder 模式下的标题（仅 mode=reminder 生效）" },
          priority: {
            type: "string",
            enum: ["low", "medium", "high", "urgent"],
            description: "reminder 模式下的优先级（默认 medium）",
          },
        },
        required: ["text"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "voice.send_message",
      description:
        "【语音消息·微信式】合成语音并落地为可重播的语音消息（客户端渲染为微信式语音气泡，用户可多次点击重播）。适用于：用户明确要求「发语音」「发条语音消息」、长文本回复用语音更自然、朋友式聊天场景。与 voice.speak 区别：speak 是一次性即时播报无 UI，send_message 是落地可重播语音消息。短指令回复（如「好的」「知道了」）请用文本，不要滥用本工具。\n【绝对禁止】调用后不要在文本回复里复述语音内容，工具会替你落地。",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "语音消息要朗读的内容" },
          replyToMessageId: {
            type: "string",
            description: "可选：要回复的历史消息 ID（用于上下文关联）",
          },
        },
        required: ["text"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "voice.transcribe",
      description:
        "【ASR 主动识别】把已落地的语音消息文件转写为文本，让 Agent 能「听」用户发来的语音。mediaUrl 形如 /agent/voice/messages/{actorId}/{msgId}.mp3（用户上传或 voice.send_message 落地后产生）。适用于：用户引用了某条历史语音要求重新理解、多轮对话中需要复核语音内容、跨模态推理。注意：通常用户发来 voice 消息时 chat-user-message 已自动调 ASR 把 transcript 喂给模型，本工具主要用于「重听」或「主动检查」历史语音。",
      parameters: {
        type: "object",
        properties: {
          mediaUrl: {
            type: "string",
            description: "语音消息的访问 URL，形如 /agent/voice/messages/{actorId}/{msgId}.mp3",
          },
          language: {
            type: "string",
            description: "语言提示（如 zh、en），默认 zh",
          },
        },
        required: ["mediaUrl"],
        additionalProperties: false,
      },
    },
  },
];

/** 时钟工具：获取当前时间和日期信息（通过IP地址查询用户时区）。 */
export const CLOCK_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "clock.get_current_time",
      description:
        "获取当前时间（注册名 clock.get_current_time）。通过 IP 查询时区与城市，返回本地时间（精确到秒）、星期。\n【强制调用规则】用户询问时间或所在城市/当前位置时必须调用本工具或 clock.get_user_location；禁止使用 IP 或训练数据臆测位置。",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "clock.get_user_location",
      description:
        "通过 IP 识别用户当前所在城市、省份/州、国家和时区。用户问「我在哪个城市」「我在哪」「当前位置」时必须调用。",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "clock.get_date",
      description: "获取当前日期和星期。通过IP地址查询自动识别用户所在城市，返回当地日期信息。当用户询问今天几号、今天星期几时使用此工具。",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "clock.format_timestamp",
      description: "将 Unix 时间戳格式化为可读的本地时间（通过IP地址识别用户时区）。",
      parameters: {
        type: "object",
        properties: {
          timestamp: { type: "number", description: "Unix 时间戳（秒）" },
        },
        required: ["timestamp"],
        additionalProperties: false,
      },
    },
  },
];

/** Agent 能力详细查询工具（Layer 3）：system prompt 已包含行为规则和路由表（Layer 2），本工具用于获取某领域的完整能力描述和运行时状态。 */
export const AGENT_CAPABILITY_QUERY_CHAT_TOOLS: ChatCompletionTool[] = [  {
    type: "function",
    function: {
      name: "agent.query_capabilities",
      description:
        "查询指定领域的完整能力描述和运行时状态。system prompt 中已有基础规则和路由表，本工具用于：①用户问「你能做什么」需展示完整清单时 ②需要某领域的详细工具说明/参数提示时 ③查看Agent World完整状态(社交推文站/技能商店/world.*工具族)时 ④确认虚拟电话号码等动态信息时。结果会保留在对话上下文供后续参考。",
      parameters: {
        type: "object",
        properties: {
          domain: {
            type: "string",
            enum: ["wallet", "agent_link", "calendar", "weather", "sub_agent", "aip", "vision", "desktop", "web", "life_assistant", "phone", "entertainment", "social_feed", "self_programming", "agent_account", "world", "embodiment", "all", "travel", "dining", "home", "finance", "health", "social", "media", "learning", "work", "comms", "self", "system"],
            description:
              "能力领域过滤。不传或传 'all' 返回全部；传具体域名仅返回该领域。建议优先指定领域以减少 token 消耗：wallet=钱包, agent_link=好友, calendar=日程, weather=天气, sub_agent=子Agent委派, aip=AIP协议, vision=视觉, desktop=桌面自动化, web=网页浏览, life_assistant=生活助手, phone=虚拟电话, entertainment=娱乐互动, self_programming=自我编程, agent_account=账号注册, embodiment=具身身体, world=Agent World。生活 12 域（Feature Catalog 自动分类）：travel=出行, dining=餐饮, home=居家, finance=财务, health=健康, social=社交, media=娱乐, learning=学习, work=生产力, comms=通讯触达, self=自身, system=系统基础。",
          },
        },
        additionalProperties: false,
      },
    },
  },
];

/**
 * ObservationPack 读回工具（借鉴 NVlabs/SoL-Pi，MIT）：被压缩/折叠的大体积工具结果
 * 归档为稳定句柄（obs_N）后，模型用本工具分页读回原文，替代「重新执行原工具」。
 * 执行在 openai-compatible-tool-loop 循环层（不进 ToolRegistry，chat-tool-drift 豁免）。
 */
export const OBS_RECALL_CHAT_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "obs_recall",
    description:
      "读回此前被压缩或折叠的工具结果原文（分页）。当早前结果摘要缺少你需要的细节（具体数字、URL、正文段落）时，" +
      "用结果提示中给出的 id（形如 obs_1）分页读回，按 nextOffset 翻页，读完即作答。" +
      "不要用它读回近期完整可见的结果，也不要为了「确认」而重复读回同一段。",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "待读回的结果句柄（见工具结果或折叠摘要中的 obs_recall 提示）" },
        offset: { type: "integer", description: "起始字符偏移，默认 0（续页用上一页返回的 nextOffset）" },
        limit: { type: "integer", description: "本次读回的字符数，默认 4000，上限 12000" },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
};
