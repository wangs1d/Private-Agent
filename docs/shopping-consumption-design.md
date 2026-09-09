# 购物与消费执行(代下单 / 比价 / 找房租房)实现方案

> 状态:设计稿 · 2026-09-08
> 目标:在不新建并行体系的前提下,基于现有 shopping-order / booking / browser-session / alipay-bot 底座,补齐三大"管家"能力。

## 0. 现状盘点(方案的事实依据)

### 已有且可直接复用
| 能力 | 现状 | 位置 |
|---|---|---|
| 代下单底座 | Playwright 无头浏览器 + 平台适配器(淘宝/天猫/京东/美团)+ Cookie 双重门禁(已导入且 agentAllowed)+ 两阶段确认 token(TTL 5min)+ 单笔 ¥5000 上限 + 审计 | `server/src/services/shopping-order-service.ts`、`server/src/services/shopping-platforms/` |
| 统一预订编排 | `BookingProvider` 接口(domain: ride/home_service/restaurant/travel),两阶段确认 + 单笔/单日双限额 + 阶段二复查 + actor 锁 + 本地订单落库(`data/booking/orders.json`)+ 承诺板 | `server/src/services/booking/` |
| 真实支付通道 | 用户本人支付宝钱包(alipay-bot CLI,真实扣款):submitPayment / queryPaymentStatus / proxyTradeRequest;travel 域已跑通 travel-pay → travel-pay-check → travel-issue 三步范式 | `server/src/services/alipay-bot-service.ts`、`skills/builtin/booking-travel-skills.ts` |
| 浏览器自动化 | 通用有状态会话池(open/click/type/scroll/screenshot/extract_text 等 8 原子操作)+ Cookie 保管(`data/browser-sessions/{actorId}.json` 加密落盘)+ 站点白名单(ctrip/taobao/jd/…/douyin 10 站) | `agent-browser-service.ts`、`browser-session-service.ts`、`browser-session-sites.ts` |
| 读价原语 | 单平台搜索(含 maxPrice/sort=price_asc)、`extractPriceHints` 正则读价、"价格/对比"搜索意图识别 | `shopping-order-service.ts`、`browser-page-fetch.ts`、`search-enhancements.ts` |
| 自动挂钩(新工具注册即得) | ① catalog risk=spend → 自动进任务安全审批 + 决策中心(`catalog/class-map.ts`、`agent-task-safety.ts`、`approval-inbox-service.ts`);② `CONSUMPTION_TOOL_RE` 命中即自动记账;③ `tool-card-registry.ts` 加 builder → 客户端零改动渲染 | — |
| 定时/主动推送 | schedule agent_task(到点把 prompt 当消息喂回完整 agent 循环)+ ProactiveAgentCenter 世界事件规则推送 | `schedule-task-service.ts`、`proactive-agent-center.ts` |

### 缺口
- **代下单**:无本地订单表(查历史/对账靠重爬);pdd/douyin 枚举已列但 adapter 未实现;演唱会票等品类缺失;下单与支付未打通(下单后需用户手动去 App 付款);两阶段 token 5 分钟 TTL 不适配抢票场景。
- **比价**:无跨平台并行聚合、无同款商品归一化、无价格历史/降价提醒;保险/服务类比价完全空白。
- **找房租房**:全仓库零功能代码(仅无关的分类关键词命中),数据模型、平台抓取、筛选体系、看房协调全需新建。
- **通用**:适配器对页面改版脆弱(`shopping-platforms/types.ts` L72-76 明示无视觉兜底),需要统一的"结构失效自检"。

## 1. 总体设计原则

1. **不新建并行体系**:订单落库抄 `booking-order-store` 模式;看房预约直接扩 `BookingDomain`;支付走既有 alipay-bot 通道;审批/记账/渲染靠注册即得的自动挂钩。
2. **支付边界不变**:Agent 只在用户本人账号、用户本人支付授权下代办;真实扣款永远经用户本人支付宝确认,Agent 不持有支付凭据。
3. **只读先行**:比价(M1)→ 下单(M2)→ 找房(M3),风险与工作量递增,且 M1 的对比/监控框架被 M2/M3 复用。
4. **诚实失败**:adapter 结构失效时报明确错误 + 截图存档,不猜测、不伪造结果。

## 2. 里程碑一:比价中心(约 1.5–2 周,纯只读、零支付风险)

### 2.1 新 capability-module:`tools/capability-modules/shopping-compare/`(四件套)

**`shopping.compare.prices`** — 商品跨平台比价
- 入参:`{ keyword, platforms: ["taobao","jd","pdd"...], filters: { maxPrice, minPrice, sort } }`
- 实现:并行调用既有 `ShoppingOrderService.searchProduct`(各平台 adapter + 同一 Cookie 门禁),聚合归一:
  - 归一策略:标题清洗(去营销词)→ 规格 token(容量/颜色/型号)相似度匹配 → 置信度低于阈值时 LLM 裁决"是否同款"
  - 输出:`items[]{ platform, title, priceCny, shop, link, sales, confidence }`,按价格升序
- 渲染:`tool-card-registry.ts` BUILDERS 注册 builder,输出 `cardType=price_compare` 结果卡(通用列表卡即可用;可选在 `agent_result_card.dart` 加专属双列对比卡型)

**`shopping.compare.quote_report`** — 保险/服务类比价(无法结构化抓取的领域)
- 模式:调研报告 —— `UpstreamSearchService.searchWeb` + `browser.fetch_page` 只读抓取 → LLM 结构化提取(方案名/保费/保障范围/免责条款/评分)→ 输出对比表(`data_brief` 渲染),并明确标注"信息为网页调研结果,投保以官方条款为准"

**`shopping.compare.watch`** — 降价监控
- 仿 `interest-watch-tools.ts` 订阅模式:存 `data/shopping/price-watches.json`(actorId/keyword/platform/targetPrice/lastPrice/createdAt)
- 执行体注册为 schedule agent_task(每日 tick 把"检查价格 watches"喂回 agent 循环,零新调度代码);命中 → ProactiveAgentCenter 规则主动推送"已降到 ¥X,低于你的目标 ¥Y"

### 2.2 数据与治理
- 价格历史:`data/shopping/price-history/{actorId}.json`(watch 顺带写入,支撑"近 30 天走势")
- `catalog/class-map.ts`:compare/watch 全部 risk=read(不进审批、不记账)
- intent 路由:无需新 intent(realtime_lookup + search 能力束已覆盖);「比价」已在 `task-intent.ts` ACTION_VERB_RE 与 intent-metadata alias 中

### 2.3 改动文件清单
1. `tools/capability-modules/shopping-compare/{chat-tools,handlers,intent,index}.ts`(新建)
2. `tools/capability-modules/index.ts`:`buildCapabilityModules` 数组注册
3. `bootstrap/create-app-services.ts`:`capabilityModuleDeps` 注入
4. `services/tool-card-registry.ts`:price_compare builder
5. `catalog/class-map.ts`:风险分类
6. 可选:`agent/llm-task-router.ts` buildRoutePrompt 补一行比价场景描述

## 3. 里程碑二:代下单扩展(约 2–3 周)

### 3.1 本地订单表(最先做,track/对账/客服的基础)
- `data/shopping/orders.json`,仿 `booking-order-store.ts`(原子写 tmp+rename)
- 字段:`so_*` 本地单号 / platform / platformOrderId / actorId / items / amountCny / status(pending_payment|paid|shipped|cancelled)/ checkoutSnapshot / createdAt
- `shopping.order.place` 阶段二成功后落库;`shopping.order.track` 优先读本地、平台刷新兜底;重复下单前查重提示

### 3.2 品类扩展
- **杂货/日用品(先做,风险最低)**:美团 adapter 扩展闪购/超市类目(搜索 URL + 类目过滤),京东超市同理 —— 主要是 adapter 内 URL 与选择器扩展,不动架构
- **演唱会票**:`damai-adapter`(大麦)+ `maoyan-adapter`(猫眼)
  - 实名制:`SearchFilters` 扩展 `attendees`(观演人姓名/证件,从用户确认中获取,日志脱敏)
  - 抢票时效:两阶段 token TTL 5 分钟不适配 —— 改"预选快照"模式:阶段一到选座/提交前一步即暂停,用户确认后立即提交,并放宽该场景 token TTL
  - 开售提醒:演出开售时间表 → schedule agent_task 到点提醒(是否自动抢由用户在确认中显式授权,合规边界 = 仅用户本人已登录账号,不绕风控,失败诚实上报)
- **pdd / douyin**:enum 已预留,按 `taobao-adapter.ts` 模板补齐,并在 `browser-session-sites.ts` 加站点

### 3.3 支付打通(方案 A 推荐,备选 B)
- **方案 A(复用 travel-pay 三步范式)**:`place` 成功 → 订单 `pending_payment` → 新 skill 族 `shopping.pay`:`shopping.pay-submit`(经 `AlipayBotService.proxyTradeRequest` 提取平台收银台 `alipay_` 短链,拉起用户本人支付宝)→ `shopping.pay-check`(queryPaymentStatus 轮询)→ 确认后订单落库 paid
- **方案 B(平台收银台拉不出短链时)**:维持"只下单不代付",订单标 `await_user_payment`,客户端通知用户去 App 支付,track 工具轮询平台状态回写
- 无论 A/B:支付类工具 risk=spend 自动进决策中心审批

### 3.4 限额与治理
- 仿 BookingService 双限额:单笔 + 单日(分类目:演出票上限高、日用品低),阶段二复查防多 token 击穿
- `CONSUMPTION_TOOL_RE` 补 `shopping.pay.*`(place 已在)→ 支付自动入账
- 审计 category 延续 `shopping_order`,支付单列 `shopping_pay`

## 4. 里程碑三:找房/租房(约 3–4 周,绿地)

### 4.1 数据模型 `data/housing/{actorId}/`
- `requirements.json`:城市/区域/租金区间/户型/整租合租/地铁线/通勤点/必需条件 —— 用户对话中逐步补全
- `favorites.json`:收藏房源;看房预约直接进 booking 订单表

### 4.2 房源平台适配器(新 `HousingPlatformAdapter` 接口)
- 接口:`searchListings / extractListings / extractDetail / checkAvailability`,放 `services/housing-platforms/`,模式照抄 `shopping-platforms/`
- 首批:贝壳 / 链家 / 自如(结构相对规整);58/安居客假房源多、反爬强,放后期或不接
- `browser-session-sites.ts` 加 lianjia/beike/ziru → 自动获得 Cookie 导入门禁
- 反爬兜底:extract 空结果 → 明确报错 + 截图存档;复杂页转 `agent_browser` 原子操作 + 视觉兜底

### 4.3 capability-module `house-rental` 工具族
- `housing.search`:条件 → 房源列表;通勤时间用既有 geo-utils + 高德路径规划(`amap-ride-provider` 先例),输出"到通勤点 X 分钟"
- `housing.detail`:详情 + 周边配套
- `housing.compare`:收藏夹对比(复用 M1 的 price_compare 对比卡框架)
- `housing.watch`:按 requirements 定时抓新上房源(schedule agent_task)→ 新房源经 ProactiveAgentCenter 推送

### 4.4 协调看房 = booking 域扩展
- `BookingDomain` 加 `"housing"`,新 `housing-viewing-provider`:book = 按房源联系经纪人约看房(初期:生成约看话术 + 用户确认后经站内 IM/短信通道发送;后期:virtual-phone / message-platform-gateway 自动外呼)
- 免费获得:两阶段确认、单日限额、actor 锁、承诺板跟踪、订单落库
- 预约成功 → `calendar.create_task` 看房日程 + 出发提醒
- 治理:search/detail/compare/watch 为 risk=read;book-viewing 为 risk=outbound(不花钱但外呼他人,仍需确认)

## 5. 横切工程项(三个里程碑共用)

1. **adapter 结构失效自检**:所有新 adapter 统一约定 —— extract 结果为空时返回 `{ok:false, error:"STRUCTURE_CHANGED", screenshotPath}` 并存档截图,便于快速修复
2. **FeatureCatalog 登记**:每个新工具必须进 `catalog/class-map.ts` 正确分类,审批/记账/工具 pin 等自动行为全部依赖它
3. **prompt 注入**:`agent-capabilities.ts` CAPABILITY_DOMAINS + DOMAIN_LABELS 登记新域;`llm-task-router.ts` buildRoutePrompt 补场景例子
4. **高频工具 pin**:可选在 `runtime-kernel.ts` `detectPinnedTools` 加 housing/compare 关键词
5. **Flutter(全部可选,不阻塞)**:`agent_result_card.dart` cardType switch 加 `price_compare`/`housing_list` 专属卡型;不加则走通用列表卡

## 6. 风险清单

| 风险 | 应对 |
|---|---|
| 页面改版导致 adapter 失效(已知,无视觉兜底) | 结构失效自检 + 截图存档;`agent_browser` 原子操作兜底;失败诚实报错 |
| 平台风控( Cookie 自动化) | 白名单内 + 用户本人 Cookie + 现有拟人化参数;抢票场景接受失败率 |
| 合规:实名证件信息 | 观演人信息日志脱敏、不落明文;仅用户本人账号操作 |
| 合规:爬虫/代下单边界 | 只读抓取为低风险;下单仅经用户本人授权账号;真实扣款永远由用户本人支付宝确认;全程审计 |
| 房源数据真伪 | 首批只接贝壳/链家/自如;结果卡标注"房源信息以平台为准" |
| 比价同款误判 | 规格归一 + 置信度 + 低置信标"疑似同款",不静默合并 |

## 7. 里程碑与验收

| 里程碑 | 内容 | 验收 |
|---|---|---|
| M1 比价(1.5–2 周) | compare.prices / quote_report / watch + 降价推送 | "帮我比价 XX" 返回跨平台对比卡;"XX 降到 500 内告诉我" 到价主动推送 |
| M2 代下单(2–3 周) | 订单落库 + 杂货/演出票/pdd/douyin + 支付打通 | "买 X" → 快照确认 → 本人支付宝支付 → 订单表可查可track;消费自动入账 |
| M3 找房(3–4 周) | housing.search/watch/compare + 看房预约 | "找两居室,通勤 30 分钟内" → 筛选列表;新房源推送;约看房进日历 |
