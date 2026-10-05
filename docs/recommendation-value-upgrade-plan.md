# 产品推荐价值升级方案

> 目标:把 `shopping.suggest` 推荐线从「5 款种子商品的文字罗列」升级为「有立场、有证据、可行动」的购物推荐。
> 核心思路:**不新建管线**。展示管线(卡片标记 → AgentResultCard)、图片管线、比价线、UGC 通道、VLM、记忆系统全部已存在,方案 = 接线 + 补一张推荐卡。

---

## 1. 现状诊断:四个痛点 → 代码事实

| 痛点 | 代码事实 | 根因 |
|---|---|---|
| ① 搜到的照片不能单独展示产品 | 补图走 `fillCandidateImages`(`server/src/tools/life-tools.ts:48-83`),对每个候选只搜 **1 张**,9s 死线,失败静默无图;图来自 `searchImages`(`server/src/services/upstream-search-service.ts:246-305`)通用网搜,**没有「产品主体图」校验**。种子图目录 `data/recommendation/media` 不存在,种子图 404 | 图源只有通用网搜单发;比价线的联盟 API(淘宝客/京东联盟返回的官方商品主图,本身就是干净主体图)**没接进推荐线** |
| ② 推荐无区分度、没有立场 | `SuggestResult`(`server/src/recommendation/suggest-engine.ts:35-40`)= 并列 `candidates[]`,无主推/备选之分;个性化(`personalize.ts`)只改写话术,**不改变推荐结构** | 引擎产出是「并列罗列」,LLM 只做润色,没有「我主推谁、为什么、什么时候选别的」的立场输出 |
| ③ 全文字、无对比、无 UGC | 卡片通道存在(`tool-card-registry.ts:93-185` → `product_compare` 卡,客户端 `_ProductCompareCard`),**但**:仅当库里 ≥2 候选才出卡;oss 版被 Edition 闸剔除(`api_config.dart:162-167`);口碑 `reviewSummary` 是种子静态快照,**无真实 UGC**;小红书/微博搜索通道已建(`searchXiaohongshu/Weibo`,`social.search_posts`)**未接入推荐** | 卡型覆盖窄 + 口碑数据是死的;已建的 UGC 通道闲置 |
| ④ 已有技术没用上 | 闲置资产清单:`searchImagesBatch`(多维对比出图,仅旅游线在用)、`describeImagesWithVlm`(`image-caption-service.ts:110`)、联盟实时价 `official-price-source.ts` + Playwright 平台 adapter、price watch 降价监控(`shopping-compare-service.ts` + `price-history.json`)、购物偏好记忆(仅有通用画像注入)、灵动岛主动推送 | 推荐线是孤立小闭环,与比价线/搜索线/视觉线互不相连 |

另一个隐性事实:**商品库只有 5 款种子商品**(`seed-products.ts`,Sony XM5、Bose QC、Keychron K5、口红×2),且定位为 demo 冷启动数据。真实使用中大部分查询会落空,直接退化成文字泛建议——这是「推荐没有使用感」的最大底座问题。

## 2. 目标体验:一条有价值的推荐长什么样

```
┌────────────────────────────────────────────┐
│  🏆 主推:Sony WH-1000XM5          ¥1,899   │
│  [官方主体图,可点开看大图/更多图]           │
│  为什么推它:你的偏好(降噪优先、通勤场景)…  │
│  真实口碑:👍 降噪/佩戴 👎 触控误操作  (N条) │
│  实时价:京东 ¥1,899 | 淘宝 ¥1,949  [比价页] │
├────────────────────────────────────────────┤
│  备选:Bose QC Ultra(更贵但佩戴更好)  [卡]  │
│  备选:Keychron K5(预算内另选)        [卡]  │
├────────────────────────────────────────────┤
│  [🔔 降价提醒]  [换一批]  [为什么是它?]      │
└────────────────────────────────────────────┘
```

推荐价值 = **立场**(主推谁) + **证据**(实时价 + 真实 UGC) + **可行动**(比价页、降价提醒)。

## 3. 方案:两线三步

### 第一步(服务线):推荐产出升级 —— 对应痛点 ①②

**A. 数据源:从「静态种子库」转向「实时聚合为主、种子库为冷启动缓存」**
- `shopping.suggest` handler(`life-tools.ts:109`)检索顺序改为:① 种子库命中 → 直接用;② 未命中 → 走比价线既有能力(`shopping.compare.prices` → `official-price-source.ts` 联盟 API,兜底 Playwright adapter)实时拉 3-5 款在售商品(名/价/渠道/官方主图),命中结果落 `product-catalog` 作缓存(带 TTL)。
- 这是本方案最大的架构决策(见决策点 1)。做完它,推荐从「演示品」变「实用品」,查询落空不再发生。

**B. 图片:三优先级图源 + VLM 验图 —— 对应痛点 ①**
1. 联盟 API 官方商品主图(干净主体图,天然达标,零成本);
2. `searchImagesBatch`(`upstream-search-service.ts:321`)每候选搜 3-5 张候选图;
3. `describeImagesWithVlm`(`image-caption-service.ts:110`)对候选图并行打分:「是否为产品主体图/是否含大段水印文字/是否场景图」,选最优 1 张为主图。VLM 只跑 2-3 张,控制延迟与成本。
- 落点:`fillCandidateImages` 重写 + `create-app-services.ts:1938-2000` 装配注入新图源依赖;每候选存多图(`images[]`),主图 + 细节图供客户端轮播。

**C. 立场化:Top-Pick 结构 —— 对应痛点 ②**
- `SuggestResult` 增加字段:`pick: SuggestCandidate`、`alternatives[]`、`pickReason`(从用户画像中引用的匹配点)、`whenChooseAlt`(每个备选一句话「什么时候选它」)。
- `personalize.ts` 的 `PERSONALIZATION_RULES_PROMPT` 改为「先定主推与理由,再给备选的差异化定位」;LLM 失败时降级为确定性规则(评分/价格/口碑加权选主推),不让卡空。
- 头部 `summary` 与正文改写为立场化表述;`compare` 表保留作为卡下方的展开区。

### 第二步(服务线):口碑 UGC 接入 —— 对应痛点 ③

- 推荐回合并行发起 `searchXiaohongshu` / `searchWeibo`(`upstream-search-service.ts:802/720`)搜「{商品名} 值得买/踩雷/评测」,每候选聚合出:`pros[] / cons[] / 提及热度 / 来源帖子(标题+链接)`。
- 数据经一个纯函数聚合器(新建 `server/src/recommendation/ugc-aggregator.ts`),规则抽取优缺点句,LLM 只做去重合并,不编造;来源链接随卡下发,客户端可点。
- 死线控制:UGC 搜索 6-8s 死线,超时则口碑区留白(卡片结构不变,不阻断主推荐)。
- 种子静态 `reviewSummary` 降级为最后兜底。

### 第三步(客户线):推荐卡 + 交互闭环 —— 对应痛点 ③④

**D. 新卡型 `product_pick`(服务端 builder + 客户端组件)**
- 服务端:`tool-card-registry.ts` 新增 `shopping.suggest` → `product_pick` builder(替代/收编现 `product_compare` compare-only 的场景),payload:`pick`(大图+价+实时渠道价+口碑摘要)+ `alternatives[]`(紧凑条目)+ `compare`(可折叠表)+ `actions`。
- 客户端:参考 `_ProductCompareCard`(`agent_result_card.dart:2088-2468`)与轮播卡(`carousel_effect_card.dart`)新建 `_ProductPickCard`:主推大图区(接入既有 `ImagePreviewLauncher` 点击放大)、备选横滑条、口碑区(pros/cons + 来源链接走 `launchUrlFromText`)、底部 action 按钮(走既有 `chat.user_action` 回传,`ws_chat_service.dart:291-317`)。
- `agent_result_parser.dart` 增加 `pick/alternatives` 字段解析;`media_thumbnail.dart` 复用为商品缩略图。

**E. CTA 接线(Windows 优先)**
- 点击「比价页/去购买」→ 应用内 WebView:复刻 `TravelWebPanelHost` 常驻宿主模式(`travel_web_panel_host.dart`),或直接复用 `SharedBrowserHost`(共享登录态,比价页可直接用用户已登录的电商账号)。
- 移动端无 WebView → 降级 `url_launcher` 外部浏览器(既有 `link_utils.dart:60`)。
- 图片磁盘缓存:引入 `cached_network_image`(可选,低成本高体验)。

**F. 价值闭环:偏好记忆 + 降价提醒上灵动岛**
- 购物偏好入库:`agent-memory-sync-service.ts` 的 `user_profile` KV 抽取规则扩展「品类偏好/预算带/品牌偏好/已购清单」(现只抽「喜欢/讨厌」句式,:292/:375),注入 personalize 上下文(通道已有,`create-app-services.ts:1968-1976`)。
- 卡片「降价提醒」按钮 → `chat.user_action` → 调既有 `shopping.compare.watch` 建 price watch;到价经既有 proactive 推送通道上灵动岛(`dynamic_island.dart` `IslandKind` 增加 `deal` 类,或复用 `inbox`)。
- 回访:已推荐过的商品再次提及/追问时,用 `price-history.json` 展示价格变化。

## 4. 关键决策点(请拍板)

1. **推荐数据源架构**(最大决策):推荐改为「实时聚合为主、种子库为冷启动缓存」?—— 我推荐是,否则 5 款商品撑不起任何真实使用感。代价:每次未命中推荐会多 3-8s(联盟 API 快,Playwright 兜底慢),需按渠道分级超时。
2. **VLM 验图成本**:每候选 2-3 张图打分。若考虑 token 成本,可先只做「联盟官方主图优先」,VLM 只在网搜兜底时启用。—— 我推荐保留 VLM 兜底启用。
3. **Edition 闸**:现 `product_compare` 是 internal 能力,oss 版剔除。新 `product_pick` 卡是否同样闸内?(若目标用户全在 internal 版,无影响;若计划 oss 发布,需另定降级版式。)
4. **UGC 平台范围**:小红书 + 微博通道现成;抖音/什么值得买需新增 mcporter alias。首期是否先只做前两者?—— 我推荐首期只做小红书(电商口碑密度最高)。

## 5. 分期与验收

| 期 | 内容 | 主要落点 | 验收 |
|---|---|---|---|
| P1 | A 实时聚合数据源 + B 图片三优先级 + C Top-Pick 结构 | life-tools.ts / suggest-engine.ts / personalize.ts / create-app-services.ts | 库外品类(如「洗碗机」)可出推荐;主图为产品主体图(VLM 判定通过);结果含主推+理由+备选 |
| P2 | D `product_pick` 卡 + E CTA/WebView | tool-card-registry.ts / agent_result_parser.dart / agent_result_card.dart / 新 web panel host | 卡片渲染主推+备选+对比表;点图放大;「比价页」应用内打开 |
| P3 | UGC 口碑接入 | ugc-aggregator.ts(新)/ upstream-search-service.ts | 口碑区显示真实优缺点,来源链接可点;超时留白不阻断 |
| P4 | F 偏好记忆 + 降价提醒上灵动岛 | agent-memory-sync-service.ts / dynamic_island.dart | 说一次偏好后下次推荐生效;订阅降价后到价灵动岛弹提醒 |

**演示脚本**(沿用 `server/scripts/recommendation-runtime-e2e.ts` 扩展):
1. 「帮我推荐一款降噪耳机,预算 2000」→ 主推卡 + 实时价 + 口碑;
2. 「想买个洗碗机」(库外)→ 实时聚合出 3 款,不冷场;
3. 「你上次推荐的耳机降价了吗」→ 价格历史 + 订阅提醒演示灵动岛到价。

**端到端回归**:补 `verify-` 系脚本校验——① 主推图主体性(VLM 判定日志);② UGC 摘要每条带来源 URL;③ personalize 失败时立场化降级路径出卡不空。

## 6. 不做什么(边界)

- 不做交易闭环改版(`shopping.order.*` 下单线保持现状,推荐卡 CTA 到落地页为止);
- 不做客户端自建电商数据爬虫(图/价一律走比价线既有 adapter 与联盟 API,合规边界不变);
- 不动既有 `product_compare` 卡(保留,作为 `product_pick` 卡内对比表的展开形态数据源)。
