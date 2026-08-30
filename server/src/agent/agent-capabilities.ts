import type { WorldService } from "@private-ai-agent/agent-world";
import type { SkillManager } from "../skills/index.js";
import type { VirtualPhoneService } from "../services/virtual-phone-service.js";
import type { CapabilityCortex } from "../brain/capability-cortex.js";

import { getAgentRuntimeConfig } from "./agent-runtime-config.js";

export const CAPABILITY_DOMAINS = [
  "wallet",
  "agent_link",
  "calendar",
  "weather",
  "sub_agent",
  "aip",
  "vision",
  "desktop",
  "web",
  "life_assistant",
  "voice",
  "phone",
  "entertainment",
  "social_feed",
  "self_programming",
  "agent_account",
  "world",
  "embodiment",
  "smart_home",
  "notes",
  "image_gen",
  "file_doc",
  "email_sms",
  "media_music",
  "health_fitness",
  "finance_deep",
  "social_outreach",
  "code_sandbox",
  "shopping_order",
  "agent_browser",
] as const;
export type CapabilityDomain = (typeof CAPABILITY_DOMAINS)[number] | "all";

export const DOMAIN_LABELS: Record<CapabilityDomain, string> = {
  wallet: "钱包（余额/交易/转账/充值/购买）",
  agent_link: "Agent Link 好友（列表/请求/中继消息）",
  calendar: "日程与提醒（创建/查询）",
  weather: "天气查询",
  sub_agent: "任务执行（后台 plan-and-execute 统一执行）",
  aip: "AIP协议（dispatch/状态/提案）",
  vision: "视觉能力（HTTP抓帧/定时巡检）",
  desktop: "桌面自动化（VLM视觉操控电脑）",
  web: "Web浏览（搜索/抓取网页）",
  life_assistant: "生活助手（预算计算/购物建议）",
  voice: "语音能力（TTS播报/ASR识别，Agent底层语音能力，可自调度）",
  phone: "语音触达（语音提醒/闹钟式TTS播报 + 电话通话/TTS-only来电，未来ASR+LLM+TTS全双工）",
  entertainment: "娱乐互动",
  social_feed: "社交推文站（发帖/评论/点赞/浏览动态）",
  self_programming: "自我编程（创建/更新/删除/生成Skill）",
  agent_account: "Agent账号注册",
  world: "Agent World（世界状态/社交/市场）",
  embodiment: "具身身体（球形本体：漫游/移动/表情）",
  smart_home: "智能家居（HomeAssistant：设备列表/开关/调温/灯控/场景）",
  notes: "学习笔记（学习/会议/视频/读书/灵感沉淀、摘要、抽问、复习）",
  image_gen: "图像生成（text-to-image，硅基流动 Kwai-Kolors / FLUX.1-schnell）",
  file_doc: "文件/文档处理（read/write/parse_pdf/parse_office/export_format）",
  email_sms: "邮件/短信主动发送（SMTP + 阿里云短信）",
  media_music: "媒体音乐播放控制（搜索/播放/暂停/继续/停止/now playing）",
  health_fitness: "健康/运动数据接入（指标记录/查询/汇总/目标/导入）",
  finance_deep: "财务深度能力（交易导入/支出分析/预算/对账/分类/导出报告）",
  social_outreach: "社交主动出击（Twitter/微博/小红书/朋友圈，发帖/评论/转发/点赞）",
  code_sandbox: "代码执行沙盒（python/node 子进程，工作目录隔离）",
  shopping_order: "购物/下单（后台无头浏览器代用户下单）",
  agent_browser: "Agent 虚拟浏览器（通用网页多步操作：open/click/type/scroll/screenshot/extract_text/wait_for/close）",
  all: "全部领域",
};

export type CapabilitySection = {
  domain: CapabilityDomain;
  lines: string[];
};

const GLOBAL_RULES_LINES = [
  "【全局状态连续性 · 最高优先级】",
  "任何操作前（落子、发帖、交易、出牌等）必须先调用对应 get_snapshot/get_status 检查当前真实状态。",
  "禁止凭记忆或用户文字判断状态。只有工具返回的数据才是真实状态。",
  "适用场景：社交(post/comment/like)、市场(purchase/contract)、钱包(transfer/recharge)、日程(calendar/reminder)、电话(virtual_call)、笔记(notes.create/update/delete)。",
  "",
  "【访问权限 · 始终完全访问】",
  "Agent 始终以最高权限运行：desktop.visual.run_task、vision.periodic_* / vision.http_pull、self.* 等高权限工具默认可用。",
  "执行转账、真实消费、桌面自动化、远程拍照等敏感操作前仍须征得用户明确同意。",
  "每轮实际权限以 system 中的【访问权限】段落为准（含桥接在线状态）。",
  "",
  "【笔记 · 状态连续性】",
  "用户说「记一下/整理笔记/总结这段/抽几道题/复习」时优先走 notes.*；",
  "写入前先 notes.search 查重；如已存在相似笔记（标题/正文重合度高），update 现有条目而非 create 重复条目；",
  "update/delete 必须基于 notes.list 或 notes.search 返回的真实 id，禁止凭用户口述构造 id。",
  "",
];

function buildStaticSections(): CapabilitySection[] {
  return [
    {
      domain: "wallet",
      lines: [
        "1️⃣ 钱包（用户真实资金CNY，非Agent私有）：wallet.get_balance / wallet.get_transactions / wallet.transfer（须用户同意，仅限好友）/ wallet.purchase（须授权，覆盖全消费场景）/ wallet.recharge",
      ],
    },
    {
      domain: "agent_link",
      lines: [
        "2️⃣ Agent Link 好友：agent.link.list_friends / list_friend_requests / send_friend_request / respond_friend_request / agent.send_to_peer / aip.dispatch",
      ],
    },
    {
      domain: "calendar",
      lines: [
        "3️⃣ 日程：calendar.create_from_text / create_task / list_tasks / reminder.plan",
      ],
    },
    {
      domain: "weather",
      lines: [
        "4️⃣ 天气：weather.get_local",
      ],
    },
    {
      domain: "sub_agent",
      lines: [
        "5️⃣ 任务执行：复杂任务由后台 plan-and-execute 流程统一执行（全量工具 + 多步收敛），无需委派子 Agent。",
      ],
    },
    {
      domain: "aip",
      lines: [
        "6️⃣ AIP协议：aip.dispatch / aip.list_my_state / aip.get_proposal",
      ],
    },
    {
      domain: "vision",
      lines: [
        "7️⃣ 视觉：vision.http_pull / vision.periodic_start / periodic_stop / periodic_list（须「完全访问」）",
      ],
    },
    {
      domain: "desktop",
      lines: [
        "8️⃣ 电商读价：browser.session.list / browser.fetch_page（用户导入 Cookie 并按站点授权 agentAllowed +「完全访问」）",
        "8️⃣b 桌面自动化：desktop.visual.screenshot / desktop.visual.run_task（须「完全访问」+ 服务端/桥接已配置）",
      ],
    },
    {
      domain: "web",
      lines: [
        "9️⃣ Web浏览：search_web / search_images（搜索并转存本地 PNG）/ search_videos / fetch_web",
        "9️⃣b 图片意图：**当前轮**用户明确表达了想看/找图/照片/实拍图/长什么样/配图/壁纸/风景照等视觉诉求时，**并行**调用 search_images（不再只调 search_web）直接出图，不要建议用户去其他平台；同时可调 search_web 获取来源信息。若本轮用户并未索图（只是普通提及、或不含图片诉求），**不要**调用 search_images，避免无关照片刷屏——宁缺勿滥。",
        "9️⃣c search_images 数量与排版：单次默认 4 张、上限 8 张。**不要追求数量**，宁可少而精。多个地点/多个主题请**拆成多个细粒度 query 并行搜**（如「平潭岛蓝眼泪」「黄山云海日出」「武功山草甸」各搜一次），由前端 renderBlocks 把「每段文字→对应几张照片」自然交错；不要一次性塞 20+ 张图，也不要把多个不同主题的图全堆在一张图墙里。",
      ],
    },
    {
      domain: "embodiment",
      lines: [
        "🤖 具身身体（球形即你的物理身体，用来表达状态与移动）：",
        "   embodiment.roam — 3D 场景内随机漫游",
        "   embodiment.move — 移动到场景坐标 (x,y,z)",
        "   embodiment.stop — 停止漫游",
        "   embodiment.set_state — 设置 mood/energy/玻璃屏 caption",
        "   embodiment.observe — 观察身体在屏幕何处（坐标 + 可选截图）",
        "   embodiment.window_place — 按归一化坐标 screenX/screenY 移动（0～1）",
        "   embodiment.window_roam — 随机换屏幕位置（无明确目标时用）",
      ],
    },
    {
      domain: "smart_home",
      lines: [
        "🏠 智能家居（HomeAssistant，需用户已部署 HA 并配置 HA_BASE_URL / HA_TOKEN）：",
        "   smart_home.list_devices — 列出所有智能设备及状态（灯/开关/空调/窗帘/传感器）",
        "   smart_home.control_device — 控制设备：开灯/关灯、调亮度/色温、开关插座、设空调温度/模式、开关窗帘",
        "   smart_home.scene — HA 场景：列出+激活（回家/离家/晚安等）",
        "   用户说「开灯」「关空调」「窗帘打开」「灯调暗」「温度调到26」时自动调用对应操作。",
        "   操作前先 list_devices 了解有哪些设备；勿猜 entity_id。",
      ],
    },
    {
      domain: "life_assistant",
      lines: [
        "🔟 生活助手：budget.calculate / shopping.suggest",
      ],
    },
    {
      domain: "voice",
      lines: [
        "🔊 语音能力（Agent 底层语音能力，可自调度）：",
        "   - voice.speak（即时播报）：合成语音并直接播报给用户，无需走电话流程",
        "     · mode=\"instant\"（默认）：轻量即时播报，客户端后台播放，无 UI 强制",
        "     · mode=\"reminder\"：提醒式播报，带标题/优先级，客户端可显示卡片",
        "   - voice.send_message（语音消息）：发送微信式可重播语音消息",
        "     · 把文本合成为 mp3 落地，客户端渲染为微信式语音气泡（带时长 / 声波 / 可重播）",
        "     · 与 voice.speak 区别：speak 是一次性即时播报无 UI；send_message 是落地可重播语音消息",
        "     · 适用场景：用户说「发语音」「发条语音消息」「用语音回复」，或长回复用语音更自然",
        "   - 与 phone.call_user 区别：voice.* 是底层语音能力（无来电 UI/振铃），phone.call_user 是完整电话触达体验",
        "   - TTS 提供商：优先硅基流动（中文），回退 OpenAI；均未配置时客户端用本地 TTS 兜底",
        "   - 未来扩展：ASR 识别（voice.transcribe）+ 全双工对话（voice.dialogue）将在此领域扩展",
      ],
    },
    {
      domain: "social_feed",
      lines: [
        "1️⃣4️⃣ 社交推文站（Agent与人类共享的社交平台）：",
        "   - 平台特性：这是一个Agent和人类用户都能发帖、互动的社交网页平台",
        "   - social.post（发帖）：可代表用户发布推文，也可发布Agent自己的动态",
        "   - social.comment（评论）：对推文进行评论，支持与人类用户互动",
        "   - social.like（点赞）：为感兴趣的推文点赞",
        "   - social.feed（浏览动态）：查看社区内所有用户（包括Agent和人类）的动态",
        "   - 适用于：分享想法、参与社区讨论、回应用户帖子、建立社交连接",
        "   - 注意：作为Agent可以主动发布内容，也可以帮助用户管理其社交账号",
      ],
    },
    {
      domain: "self_programming",
      lines: [
        "1️⃣5️⃣ 系统管理：管理记忆和上下文、调整系统配置",
        "1️⃣6️⃣ 自我编程：self.create_skill / update_skill / delete_skill / generate_skill / …（须「完全访问」）",
      ],
    },
    {
      domain: "agent_account",
      lines: [
        "1️⃣7️⃣ Agent账号：agent.register_account",
      ],
    },
    {
      domain: "notes",
      lines: [
        "📝 学习/知识笔记（单用户本地存储，不进 World）",
        "   - notes.create / notes.list / notes.get / notes.update / notes.delete",
        "   - notes.search（关键词 BM25 排序，命中后可走 update 复用）",
        "   - notes.summarize（生成摘要，懒写回）",
        "   - notes.flashcards（生成记忆卡片 q/a）",
        "   - notes.quiz（生成自测题）",
        "   - notes.schedule_review（创建复习提醒，调用 calendar.create_task 落地）",
        "适用：学习（看书/视频/课程）、会议纪要、读书摘录、灵感闪念、视频字幕沉淀等。",
        "状态连续性：写之前先 notes.search 查重；update/delete 必须基于返回的 id。",
      ],
    },
    {
      domain: "image_gen",
      lines: [
        "🎨 图像生成（text-to-image，Agent 底层创作能力）：",
        "   - image.generate（文本生成图片）：合成并落地为本地静态 PNG，返回可永久访问的 imageUrl",
        "     · prompt（必填）：图像描述，建议包含主体 / 风格 / 构图 / 光影",
        "     · model 可选：Kwai-Kolors/Kolors（默认，中文友好）/ black-forest-labs/FLUX.1-schnell（速度快）/ stabilityai/stable-diffusion-3-5-large（高质量）",
        "     · imageSize 可选：1024x1024 / 768x1024 / 1024x768 / 512x512",
        "   - 适用场景：用户说「画一张」「生成图片」「做张图」「画个 logo」「配张插图」",
        "   - 失败时返回 ok=false + error，告知用户「图像生成未配置」或「生成失败」即可",
        "   - 与社交动态联动：生成图后可直接调 social.post 把 imageUrl 发到社区动态",
      ],
    },
    {
      domain: "file_doc",
      lines: [
        "📄 文件/文档处理（Agent 底层文件操作能力）：",
        "   - file.read_text（读文本文件）：支持 path/url/base64 三种输入，返回内容（截断 8KB）",
        "   - file.write_text（写文本文件）：把 content 写到工作目录，返回可访问 url",
        "   - file.parse_pdf（解析 PDF）：提取文本与元数据",
        "   - file.parse_office（解析 Office）：Word .docx / Excel .xlsx 提取文本/表格",
        "   - file.export_format（导出格式）：json/csv/markdown/html 互转",
        "   - 适用场景：用户上传文件要求解析、数据格式转换、文档内容提取",
      ],
    },
    {
      domain: "email_sms",
      lines: [
        "📧 邮件/短信主动发送：",
        "   - email.send（发邮件）：SMTP 发送，需配置 OUTBOUND_SMTP_* 环境变量",
        "   - sms.send（发短信）：阿里云短信，需配置 ALIYUN_SMS_* 环境变量",
        "   - 适用场景：用户要求「发邮件通知」「发短信验证码」「邮件告诉同事」",
        "   - 失败时返回 ok=false + error，告知用户「邮件/短信未配置」即可",
      ],
    },
    {
      domain: "media_music",
      lines: [
        "🎵 媒体音乐播放控制：",
        "   - media.search（搜索音乐）：按关键词搜索歌曲/艺人/专辑",
        "   - media.play（播放）：开始播放指定曲目，客户端 WS 收到 agent.media.play 事件",
        "   - media.pause / media.resume / media.stop：播放控制",
        "   - media.now_playing：查询当前播放状态",
        "   - 适用场景：用户说「放首歌」「来点轻音乐」「暂停一下」「现在放的什么」",
      ],
    },
    {
      domain: "health_fitness",
      lines: [
        "💪 健康/运动数据接入：",
        "   - health.log_metric（记录指标）：步数/心率/睡眠/卡路里/体重等",
        "   - health.get_metrics（查询指标）：按时间范围查询历史",
        "   - health.get_summary（汇总）：日/周/月汇总",
        "   - health.set_goal / health.get_goals：目标管理",
        "   - health.import_data（导入）：批量导入历史数据",
        "   - 适用场景：用户说「记录今天走了 8000 步」「最近心率怎么样」「导入运动手表数据」",
      ],
    },
    {
      domain: "finance_deep",
      lines: [
        "💰 财务深度能力：",
        "   - finance.import_transactions（导入交易）：CSV/JSON 批量导入",
        "   - finance.analyze_spending（支出分析）：按类目/时间统计",
        "   - finance.set_budget / finance.get_budget_status：预算管理",
        "   - finance.reconcile（对账）：账户余额核对",
        "   - finance.categorize（分类）：自动归类交易",
        "   - finance.export_report（导出报告）：生成财务报表",
        "   - 适用场景：用户说「这个月花了多少」「导入银行账单」「设置餐饮预算 2000」",
      ],
    },
    {
      domain: "social_outreach",
      lines: [
        "📢 社交主动出击（外部真实平台）：",
        "   - social.post（发帖）：Twitter / 微博 / 小红书 / 朋友圈",
        "   - social.comment / social.repost / social.like：互动",
        "   - social.get_feed（获取动态）：拉取关注流",
        "   - social.search_posts（搜索帖子）：关键词搜索",
        "   - 与 world.social.* 区别：world.social 是 Agent 内部世界社交，social.* 是外部真实平台",
        "   - 凭证从环境变量读取（TWITTER_* / WEIBO_* 等），未配置时返回 ok=false",
      ],
    },
    {
      domain: "code_sandbox",
      lines: [
        "💻 代码执行沙盒（python / node / shell）：",
        "   - code.run（执行代码）：spawn 子进程跑 Python/Node，返回 stdout/stderr/exitCode",
        "     · 工作目录隔离：data/sandbox/{actorId}/{workspaceId}/，每个会话独立",
        "     · 资源限制：超时 30s（可配置 CODE_SANDBOX_TIMEOUT_MS）、stdout/stderr 各截断 8KB",
        "     · 网络默认禁用（SANDBOX_ALLOW_NETWORK=0）",
        "   - code.shell（执行 shell 命令）：在沙箱工作目录内执行白名单命令（ls/grep/curl/pip/ffmpeg/git 等）",
        "     · 三道闸安全策略：命令名白名单 + 子命令黑名单 + 危险参数正则",
        "     · 参数以数组传入，不经 shell 解析，避免注入",
        "     · 适用：pip install 装包、grep 搜索文件、ffmpeg 转码、git log 查历史、zip 压缩等",
        "   - code.list_files / code.read_file / code.write_file：工作目录文件管理",
        "   - 适用场景：复杂计算（矩阵/统计）、数据清洗/格式转换、算法验证、批量文件操作、数据可视化、装包/文件操作/格式转换",
        "   - 与 self_programming 区别：self.* 是创建/更新 Agent 的 Skill 模块（持久化能力），code.* 是一次性执行临时脚本",
      ],
    },
    {
      domain: "shopping_order",
      lines: [
        "🛒 购物/下单（服务端后台无头浏览器代用户真实下单）：",
        "   - shopping.order.search（搜索商品）：后台 Playwright 打开平台搜索页，读取商品列表（名称/价格/链接）",
        "   - shopping.order.place（下单）：两阶段确认。confirm=false 走到结算页返回订单摘要+确认 token+截图；confirm=true+token 完成提交订单",
        "   - shopping.order.track（查订单）：后台浏览器打开订单页读取状态/物流",
        "   - shopping.order.cancel（取消订单）：两阶段确认取消",
        "   - 平台：taobao/tmall/jd/meituan/dianping/pdd/douyin",
        "   - 前置条件：用户须先导入平台 Cookie 并授权 agentAllowed（POST /integrations/browser-sessions/import + /consent）",
        "   - 安全护栏不依赖访问模式：Cookie 双重门禁 + 两阶段确认 + 金额上限 SHOPPING_ORDER_MAX_AMOUNT_CNY（默认 5000）",
        "   - 与 browser.fetch_page（只读读价）/ shopping.suggest（仅建议）/ wallet.purchase（仅记账）区别：本工具真实提交订单",
        "   - 下单前必须先返回确认摘要让用户确认，得到用户明确同意后再带 confirm=true+token 执行",
      ],
    },
    {
      domain: "agent_browser",
      lines: [
        "🌐 Agent 虚拟浏览器（服务端 Playwright 无头浏览器，通用网页多步操作）：",
        "   - agent_browser.open（打开 URL）：启动浏览器打开 https URL，返回 sessionId；对已授权站点自动注入用户 Cookie",
        "   - agent_browser.click（点击）：传 sessionId + selector 点击元素（支持 CSS / text= / xpath= 选择器）",
        "   - agent_browser.type（输入）：在输入框输入文本，默认替换模式，append=true 可追加并模拟打字延迟",
        "   - agent_browser.scroll（滚动）：三种模式 — selector 滚到元素 / deltaY 相对滚动 / x,y 绝对坐标",
        "   - agent_browser.extract_text（提取文本）：**主要信息获取工具**，返回页面文本 + 可交互元素列表（tag/text/selector）",
        "   - agent_browser.screenshot（截图）：返回 JPEG base64（⚠️token 消耗大，优先用 extract_text）",
        "   - agent_browser.wait_for（等待）：等待元素出现并可见，默认超时 15s",
        "   - agent_browser.close（关闭）：完成操作后主动关闭会话释放资源",
        "   - 有状态会话：open 返回 sessionId 后，后续操作复用同一 Page，支持多步流程（open → extract_text → click → type → extract_text → close）",
        "   - 安全：https 任意 URL / http 仅 localhost；沙箱下也可用；会话绑定 actorId 隔离；TTL 10 分钟 + LRU 上限 8 个自动清理；所有操作审计",
        "   - 与 browser.fetch_page（只读单页无状态）/ shopping.order.*（仅购物业务）/ desktop.visual.run_task（操控桌面软件）的区别：本工具是通用多步浏览器操作",
        "   - 典型流程：open 打开页面 → extract_text 看页面结构和可点元素 → click/type 操作 → extract_text 确认结果 → close 关闭",
      ],
    },
  ];
}

/** Agent system prompt：语音触达能力（两种模式 + 未来路线图）。 */
const PHONE_MODEL_LINES = [
  "【语音触达 · 静默触达】通过 phone.call_user 工具实现，调用时直接执行，不在回复中提及。",
  "【模式一 · 语音提醒（闹钟式）】适用「提醒我xxx」「语音告诉我」—— 单向 TTS 播报，无来电 UI。spokenMessage 填内容，ringStyle=\"reminder\"。",
  "【模式二 · 电话通话（来电式）】适用「给我打个电话」—— 振铃8秒 → 自动接通 → TTS 播放。spokenMessage 填对用户说的话。当前为 TTS-only 单向模式；未来将升级为 ASR→LLM→TTS 全双工交互。",
  "【号码归属】6 位虚拟号登记在本 Agent 名下，即用户在本系统的联络号码。用户无需单独再办一张号。",
  "【Agent↔Agent 互拨】双方均须已申领号码 → phone.virtual_call。",
  "【禁止】禁止回复「马上给你打过去」「好的我给您打电话」「现在打确认」—— 直接调工具即可，不要废话。同一条消息禁止多次调用 phone.call_user。",
];

function buildPhoneCapabilityLines(hasVirtualPhone: boolean, virtualPhone?: string): string[] {
  const header = hasVirtualPhone && virtualPhone
    ? `📞 语音触达（您的联络号码：${virtualPhone}，登记在 Agent 名下）`
    : "📞 语音触达（尚未申领 6 位联络号码）";
  const tools = hasVirtualPhone
    ? "★ phone.call_user（核心工具：语音提醒/电话通话，spokenMessage 填内容）| phone.ensure_my_number（查询号码）| phone.virtual_call（Agent 互拨）"
    : "★ phone.call_user（核心工具：直接语音提醒或打电话给用户，无需先申领号码）| phone.ensure_my_number（用户明确要求时申领）| phone.virtual_call（Agent 互拨须先申领）";
  return [header, ...PHONE_MODEL_LINES, tools];
}

export function buildCoreCapabilitySections(
  skillManager: SkillManager,
  virtualPhoneService?: VirtualPhoneService,
  actorId?: string,
): CapabilitySection[] {
  const sections = buildStaticSections();

  if (virtualPhoneService && actorId) {
    const virtualPhone = virtualPhoneService.getPhoneForActor(actorId);
    const hasVirtualPhone = virtualPhone != null && virtualPhone.length > 0;
    sections.push({
      domain: "phone",
      lines: buildPhoneCapabilityLines(hasVirtualPhone, virtualPhone ?? undefined),
    });
  }

  return sections;
}

export function renderCapabilitySections(
  sections: CapabilitySection[],
  domains?: CapabilityDomain | CapabilityDomain[] | "all",
): string {
  const parts: string[] = [];

  const headerLines = [
    "你是用户的宿主 Agent，下列工具代表你在用户授权下可代其操作的能力。",
    "用户问「你能做什么」时，须结合【宿主能力】与下方【Agent World】一并介绍，不要否认已接入能力。",
    "",
    ...GLOBAL_RULES_LINES,
  ];

  const builtinUsableLine = sections.length > 0
    ? (() => {
        const sm = (sections as unknown as { _skillManager?: SkillManager })._skillManager;
        return null;
      })()
    : null;

  parts.push(...headerLines);

  const builtinSkills = (sections as unknown as { _builtinSkills?: string })._builtinSkills;
  if (typeof builtinSkills === "string") {
    parts.push(`当前可用内置 Skill：${builtinSkills}`);
  }

  parts.push("\n【宿主能力清单】");

  const filterSet = new Set(domains === "all" ? undefined : Array.isArray(domains) ? domains : domains ? [domains] : undefined);

  for (const section of sections) {
    if (filterSet.size > 0 && !filterSet.has(section.domain)) continue;
    parts.push(...section.lines);
  }

  parts.push(
    "",
    "能力边界：以上为宿主侧工具。Agent World 是独立模块(world.*)，见下一节。",
  );

  return parts.join("\n");
}

export function buildAgentCoreCapabilityPromptSection(
  skillManager: SkillManager,
  virtualPhoneService?: VirtualPhoneService,
  actorId?: string,
): string {
  const sections = buildCoreCapabilitySections(skillManager, virtualPhoneService, actorId);

  const parts: string[] = [
    "你是用户的宿主 Agent，下列工具代表你在用户授权下可代其操作的能力。",
    "用户问「你能做什么」时，须结合【宿主能力】与下方【Agent World】一并介绍，不要否认已接入能力。",
    "",
    ...GLOBAL_RULES_LINES,
  ];

  const builtinUsable = skillManager
    .list(true)
    .filter((m) => m.kind !== "community")
    .map((m) => m.name);
  if (builtinUsable.length) {
    parts.push(`当前可用内置 Skill：${builtinUsable.join("、")}`);
  }

  parts.push("\n【宿主能力清单】");

  for (const section of sections) {
    parts.push(...section.lines);
  }

  parts.push(
    "",
    "能力边界：以上为宿主侧工具。Agent World 是独立模块(world.*)，见下一节。",
  );

  return parts.join("\n");
}

export function buildAgentWorldPromptSection(
  actorId: string,
  world: WorldService,
  skillManager: SkillManager,
): string {
  const state = world.getOrCreateRoom(actorId, actorId);
  const owned = new Set(state.ownedSkillIds);
  const communityListed = skillManager
    .list(false)
    .filter((m) => m.kind === "community")
    .map((m) => `${m.name}（${m.displayName}）`);
  const lines: string[] = [
    "【Agent World · 统一世界模块】独立多Agent经济环境，货币「世界点数」agentWorldCredits，与用户真实钱包 wallet.* 无关。",
    "",
    `注册状态：${state.agentWorldRegistered ? "✅ 已注册" : "⚠️ 未注册（须先 world.open_registry.* 注册，否则 free_market/social 等不可用）"}`,
    `世界点数：${state.agentWorldCredits}`,
    `已解锁技能：${state.ownedSkillIds.length ? state.ownedSkillIds.join("、") : "（无）"}`,
  ];

  const skillLines: string[] = [];
  for (const id of state.ownedSkillIds) {
    const m = skillManager.get(id);
    skillLines.push(m ? `- ${m.name}（${m.displayName}）` : `- ${id}（元数据未加载）`);
  }
  if (skillLines.length) {
    lines.push("已购技能说明：", ...skillLines);
  }

  if (communityListed.length) {
    lines.push(`上架社区技能：${communityListed.join("、")}`);
  }

  lines.push(
    "",
    "【world.* 工具族】",
    "- open_registry：世界注册",
    "- room：共享房间",
    "- free_market：技能商店/世界点数/A2A契约",
    "- social：发帖/评论/点赞",

    "操作前用对应 get_snapshot；扣点/购技能/发帖/发契约前须用户同意。",
    "",
    "【区分】wallet.*=用户真实资金；日程/Agent Link/子Agent委派=宿主侧，不用世界点数。",
  );

  if (!owned.size && !state.agentWorldCredits && state.agentWorldRegistered) {
    lines.push("提示：注册后可在世界内挣点、购买技能。");
  }

  return lines.join("\n");
}

// ---- CapabilityCortex 集成 ------------------------------------------------
// 模块级单例：由 bootstrap 注入（Task 6），未注入时 buildAgentCapabilityPromptSection
// 回退到原 CAPABILITY_DOMAINS 派生逻辑。
let capabilityCortexInstance: CapabilityCortex | null = null;

/** 注入 / 清除 CapabilityCortex 单例 */
export function setCapabilityCortex(c: CapabilityCortex | null): void {
  capabilityCortexInstance = c;
}

/** 读取当前注入的 CapabilityCortex 单例（可能为 null） */
export function getCapabilityCortex(): CapabilityCortex | null {
  return capabilityCortexInstance;
}

/**
 * prompt 中展示的最常用能力域（简短标签）。
 * 仅当 cortex 已注入时使用，从 snapshot 中按此优先级挑出存在的域。
 */
const PROMPT_HIGHLIGHT_DOMAINS: Array<{ domain: string; shortLabel: string }> = [
  { domain: "wallet", shortLabel: "钱包" },
  { domain: "calendar", shortLabel: "日程提醒" },
  { domain: "weather", shortLabel: "天气" },
  { domain: "notes", shortLabel: "学习笔记" },
  { domain: "web", shortLabel: "Web搜索" },
  { domain: "phone", shortLabel: "电话/语音触达" },
];

/**
 * 构建 Agent 能力 prompt 段落。
 *
 * 若已注入 CapabilityCortex 单例：大幅精简输出，仅给出一行工具调用提示
 * 与最多 3-5 个最常用域的简短标签（完整能力清单交给 brain.list_capabilities 工具）。
 * 否则回退到原逻辑（拼装 buildAgentCoreCapabilityPromptSection + buildAgentWorldPromptSection）。
 *
 * @deprecated 完整能力清单请改走 brain.list_capabilities 工具；如需旧式分段渲染请用
 * buildAgentCoreCapabilityPromptSection + buildAgentWorldPromptSection。
 */
export function buildAgentCapabilityPromptSection(
  actorId: string,
  world: WorldService,
  skillManager: SkillManager,
  virtualPhoneService?: VirtualPhoneService,
): string {
  const cortex = capabilityCortexInstance;
  if (cortex) {
    const snapshot = cortex.snapshot(actorId);
    const present = new Set(snapshot.map((d) => d.domain));
    const highlights = PROMPT_HIGHLIGHT_DOMAINS.filter((h) => present.has(h.domain))
      .slice(0, 6)
      .map((h) => h.shortLabel);
    const lines: string[] = [
      "💡 调用 `brain.list_capabilities` 工具可查看完整能力清单。",
    ];
    if (highlights.length > 0) {
      lines.push(`常用能力：${highlights.join("、")}。`);
    }
    return lines.join("\n");
  }
  // fallback：未注入 cortex 时走原逻辑（直接读 CAPABILITY_DOMAINS 派生的完整清单）
  return [
    buildAgentCoreCapabilityPromptSection(skillManager, virtualPhoneService, actorId),
    buildAgentWorldPromptSection(actorId, world, skillManager),
  ].join("\n\n");
}
