# 回复展示形式架构优化方案

## —— 从"事后打分反推结构"到"生成时确定形态"

> 2026-09-15 · 针对 agent 回复内容展示效果触发率低的架构性问题
>
> **实施状态（2026-09-15）**：本方案已完成落地，实施映射与验证结果见文末「实施记录」附录。

---

## 1. 问题诊断

### 1.1 现状管线

```
LLM 产出散文回复
   ↓
[render-hint-service.ts]  routeRender()：工具信号 + 内容形态打分 → hint 类型
   ↓
[tool-result-processor.ts] processAssistantText()：按优先级链执行 hint，
   在纯文本里注入 [RENDER_AS:xxx] / [AGENT_RESULT_CARD_START]{json} 等标记
   ↓                              ↑
[display-effect-router.ts +      [agent-result-formatter.ts /
 display-effect-router]           render-scoring.ts]：从散文提取语义条目，
   cardType 路由                  按形态证据（时间戳/标签：数值/对比词）门控上卡
   ↓
WS 下发带标记的纯文本
   ↓
[客户端 message_body_renderer.dart] 用正则从文本里再解析出标记 → 分发到组件
```

### 1.2 根因（按重要性排序）

1. **决策与生产脱节（核心）**。LLM 写回复时**本来就知道**内容是三个步骤、还是 A/B 对比、还是一组指标——这个结构信息在生成时就存在，却被要求先退化成自然语言散文，服务端再用正则和打分去"反推"。这是有损压缩后再尝试还原，命中率天花板极低。
2. **模型没有任何结构化输出通道**。`prompt-assembler.ts` 的系统提示词从未告知模型渲染标记或卡片协议的存在（grep 全目录无一处提及）；模型偶尔把工具 JSON 直接吐进回复，反而要靠 `detectRawSearchResultJson` 这类"抢救检测器"兜住——结构化能力完全被浪费。
3. **文本内标记（in-band marker）是脆弱的传输方式**。标记可能与正文冲突、可能被模型模仿，需要 `reply-envelope.ts` 专门的兼容层剥离，客户端要用正则二次解析。
4. **三套路由职责重叠、门控层层加严**。hint 打分 → 优先级链 → 语义评分器（`formatSemanticResultForChat` 要求 ≥2 条语义条目、timeline/compare 必须有硬形态证据、2 条目只放行 timeline/metric），每层都在防误报，叠加的结果就是绝大多数内容落到 `plain` → 纯文本。
5. **链路分裂**。`chat-turn-runner.ts:153/160` 硬编码 `plainTextMode: true`（HTTP messages、微信桥、虚拟手机、message-hub 全走这条），与 WS 主链路是两套行为。
6. **工具绑定覆盖率极低**。`tool-card-registry.ts` 只注册了 5 个工具（weather.get_local / wallet.get_balance / calendar.list_tasks / shopping.compare.prices / shopping.order.list），而 `display-effect-router.ts` 里其实已经维护了一份更全的工具信号表——真正确定性的那层最薄。

客户端组件库本身是完善的（7 种特效卡 + 约 10 种结果卡形态）。**缺的不是渲染能力，是确定性触发。**

---

## 2. 业界调研：主流 Agent 与开源项目的做法

### 2.1 协议层：消息 = 类型化 parts 的数组，文本只是一种 part

| 参照 | 做法 |
|---|---|
| **OpenAI（Responses API / ChatGPT）** | 消息输出是类型化 item 流（`message` / `function_call` / `reasoning` / 工具结果），内容是 content parts 数组；搜索结果组、Canvas 等富展示由**工具调用驱动**，不是对散文打分 |
| **Anthropic（Messages API / Artifacts）** | 回复 = content blocks（`text` / `tool_use` / `tool_result` / `thinking`）；Artifacts 作为独立块产出，带类型和 schema，前端按块分发渲染 |
| **AG-UI 协议**（CopilotKit 团队，agent↔前端开放协议） | 事件驱动：`TextMessageStart/Content/End`、`ToolCallStart/Args/End/Result`、`ActivitySnapshot/Delta`（结构化 JSON 载荷 + activityType 区分）、`Custom` 事件作扩展点。**tool-based generative UI**：前端按 `toolCallName` 映射组件，参数以 JSON 增量流式到达 |
| **飞书卡片 JSON 2.0** | 卡片 = `schema + config + header + body.elements[]`，组件带 `tag` + `element_id`；`config.streaming_mode` 原生支持卡片级流式打字机（`print_frequency_ms`/`print_step`），低版本客户端自动降级为"标题 + 升级提示"——**能力降级内建于协议** |

### 2.2 产品/框架层：确定性绑定，不打分

| 参照 | 做法 |
|---|---|
| **扣子 Coze 卡片** | 卡片是组件化 JSON（文本/图片/按钮），**可视化搭建后绑定到工作流/插件输出上**——输出到卡是确定性绑定；Card SDK 自定义渲染；按渠道（豆包/飞书）适配 |
| **Vercel AI SDK（Generative UI）** | 工具用 zod schema 声明 → 模型决定何时调用 → 服务端执行 → 前端按 `part.type === 'tool-${toolName}'` **精确映射 React 组件**，按 part 状态机（input-available → output-available / output-error）先渲染占位再切真实数据。官方明确理由：模型只负责决策，UI 结构由开发者组件控制，数据经 schema 校验——**不让模型自由发挥 UI，也不靠事后猜测** |
| **LobeChat（开源）** | 消息块（message blocks）架构：一条回复 = 思考块 + 内容块 + 工具调用块 + 引用块等独立块，各自是独立组件、可流式更新；插件 manifest 携带 UI 配置，`function_call` 参数直接映射卡片组件 |
| **Adaptive Cards（微软）** | 声明式、平台无关的卡片 JSON schema（TextBlock/Image/Input.*/Action.*/Container/ColumnSet），各平台（Teams/Outlook/Bot Framework）用各自渲染器渲染同一份 JSON；卡片作为消息附件下发，按钮 action 回传 bot——**"一次编写，处处渲染" + 交互回传** |

### 2.3 三条铁律（业界完全一致，本项目全部相反）

| # | 业界铁律 | 本项目现状 |
|---|---|---|
| 1 | **UI 形态由"工具名 ↔ 组件"注册表确定性决定**，没有任何主流实现靠给散文打分决定渲染 | 打分/启发式是主路径，确定性注册表只覆盖 5 个工具 |
| 2 | **结构化数据经 schema 校验端到端流动**，组件吃类型化 props，不从文本猜 | 卡片数据靠正则从散文里提取语义条目 |
| 3 | **消息是类型化 parts/blocks/事件数组**，文本只是其中一种 part，渲染器遍历分发 | 消息是纯文本，卡片以文本内标记夹带，正则二次解析 |

**结论：问题不是打分不准，而是"打分"这个环节本不该承担主责。** 业界的打分/启发式只出现在两种次要位置：markdown 静态渲染（表格/代码块，客户端已具备）和纯文本渠道的降级摘要。

---

## 3. 目标架构：三层确定性渲染管线

```
                        ┌─────────────────────────────────────────┐
                        │        消息 = parts 数组（新传输协议）      │
                        └─────────────────────────────────────────┘
L1 工具绑定层（确定性，覆盖结构化工具输出）                              ← 主力
    工具 output JSON ──(ui.card 声明)──► CardPart          零打分
L2 模型生成层（生成时确定形态，覆盖无工具长尾）                            ← 主力
    LLM 调用 render_card(cardType, items...) ──(schema 校验)──► CardPart
L3 兜底层（薄启发式，只留确定性信号）                                    ← 收缩退役中
    裸 JSON 抢救 / 超长折叠 summary_card / brief 定时简报 / markdown 原样透传
```

### 3.1 L1 工具绑定层：把注册表升格为声明式 schema，全量覆盖

- 将 `tool-card-registry.ts` 的 5 个手写 builder 升级为**声明式注册**：每个工具定义处声明 `ui: { card: { cardType, map } }`，`map` 是工具 output → CardPart props 的纯函数（可继续放 registry，但按 schema 写）。
- 把 `display-effect-router.ts` 中已有的工具信号测试表（`search_images`/`search_videos`/`search_web`/`info.*`/`finance.*`…）**迁进注册表**——那份表本质就是绑定表的雏形。
- 收益：所有"工具产出结构化数据"的场景（约占富展示需求的多数）不再经过任何打分，`weather`/`finance`/`travel`/`search`/`file`/`order` 全部确定性出卡。

### 3.2 L2 模型生成层：给模型 `render_card` 工具（业界 generative UI 的标准做法）

- 新增内置工具 **`render_card`**，进 `openai-compatible-tool-loop` 的工具集：

```jsonc
// 工具 schema（要点）
{
  "name": "render_card",
  "description": "当回复内容具有明确结构（步骤/对比/指标/清单/时间线…）时，调用本工具以卡片展示；纯叙述和闲聊不要调用",
  "parameters": {
    "cardType": "steps | metric | carousel | chips | fold_list | compare | comparison_table | timeline | progress | quote",
    "title": "string ≤40字",
    "items": [{ "text": "string", "side": "A|B（仅对比类）", "url": "string?" }],
    "footer": "string?"
  }
}
```

- 执行语义：`execute` 不做任何事（或直接回 `{ok:true}`），服务端把 tool call 参数经 zod 校验后**变成 CardPart 插入消息流**，LLM 继续输出前导/追问文本。这与现有 tool-loop 完全兼容。
- 系统提示词注入两条简明准则（放 `prompt-assembler` 动态层）：何时用卡（对比→comparison_table、操作指引→steps、多条并列→fold_list…）、频控（一条回复 ≤2 张卡）。
- 校验与回退：schema 校验失败 → 该卡降级为 `toPlainText()` 文本并记日志；不允许裸 JSON 泄漏。
- **收益**：中文口语形态（"方案 A 便宜但慢，方案 B 贵但快"）不再依赖正则反推——模型自己声明"这是对比"，误报率天然低于任何形态打分。

### 3.3 L3 兜底层：启发式大幅收缩

保留（都是确定性信号）：
- `detectRawSearchResultJson` / `detectRawTravelItineraryJson` 裸 JSON 抢救；
- 超阈值长文 → `summary_card` 折叠；
- brief / data_brief 等本来就来自结构化源头的消息形态；
- markdown 表格/代码块/引用块——客户端已能渲染，服务端无需标记。

退役：`render-hint-service.ts` 的内容形态打分（`analyzeContentStructure`/`analyzeListStructure` 意图词门控）、`formatSemanticResultForChat` 的 `extractSemanticItems` 散文反推、`render-scoring.ts` 主体。理由：L2 上线后"从散文猜结构"的命中率永远不可能高于模型自报，且其误报（闲聊上卡）伤害大于漏报。

### 3.4 传输层：文本内标记 → 消息 parts 协议

```jsonc
// chat.assistant_done（或新事件 chat.parts）载荷
{
  "messageId": "…",
  "parts": [
    { "type": "text", "text": "帮你对比好了：" },
    { "type": "card", "cardType": "comparison_table",
      "title": "两个方案怎么选", "items": [ … ] },
    { "type": "media", "items": [ … ] }
  ]
}
```

- 流式：文本 part 复用现有 delta 流；card part 首版一次成型，二期可加 `part.update` 增量（对齐飞书 `streaming_mode` / AG-UI Snapshot-Delta 模式）。
- 客户端：`message_body_renderer.dart` 增加 parts 遍历分发入口，**现有组件全部复用**；文本标记解析器保留为 v1 兜底（历史消息回放、老服务端）。
- **v1 编码器**：parts → 现有文本标记串（复用现有生成逻辑），供旧客户端与纯文本渠道。

### 3.5 渠道能力协商替代链路分裂

- `chat-turn-runner.ts` 去掉硬编码 `plainTextMode: true`，管线参数改为 `channels: [{ kind: "ws" | "wechat" | "http", capability: "rich" | "plain" }]`；
- plain 渠道不再是"整条链路禁卡"，而是"正常出卡 → 每个卡组件的 `toPlainText()` 降级序列化"（`buildTravelPlainTextSummary`、`formatContentSummaryForPlainText` 已是雏形，补齐其余卡型）；
- 一条管线，两种编码，行为可测。

---

## 4. 分阶段落地

| 阶段 | 内容 | 主要改动 | 验收 |
|---|---|---|---|
| **0 链路统一**（低风险，先行） | plainTextMode → 能力协商；两处 `processAssistantText` 调用合一 | `chat-turn-runner.ts`、`tool-result-processor.ts` | 微信桥行为不变（golden 回归），WS 不变 |
| **1 L1 + parts 协议** | 声明式工具绑定全量覆盖；WS 下发 parts；客户端 parts 分发入口 | `tool-card-registry.ts`、`display-effect-router.ts`（迁移）、`chat-user-message.ts`、`message_body_renderer.dart` | weather/travel/search 等工具场景 100% 确定性出卡；历史消息回放不受影响 |
| **2 L2 render_card** | 工具注册 + schema 校验 + 提示词准则 + 灰度开关（按 actorId 比例） | `agent/loop`、`prompt-assembler.ts`、新 `render-card-tool.ts` | 灰度组卡片触发率显著上升、闲聊误卡率不高于现网 |
| **3 收缩兜底 + 回归集** | 退役形态打分；建 ~50 条典型回复 golden set（断言期望 parts 序列，含中文口语样本） | 删 `render-scoring.ts` 主体、精简 `render-hint-service.ts` | 回归集跑绿；`logRoutingDecision` 监控面板保留 |

每阶段独立可回滚；阶段 2 有开关，阶段 3 依赖 2 的灰度数据。

---

## 5. 风险与对策

| 风险 | 对策 |
|---|---|
| 模型出卡质量差 / 过度出卡 | zod 严格校验 + 失败降级文本；提示词准则 + 频控（≤2 卡/条）；灰度 + 触发率/误报率监控（复用 `logRoutingDecision` trace） |
| token 成本增加 | `render_card` 工具定义 + 准则约几百 token，一次性成本；相比打分链路的持续维护成本低 |
| 历史消息兼容 | 旧消息存的是标记文本，v1 解析器长期保留；新协议仅对新消息生效 |
| 双端改动量 | 客户端组件零重写，仅 `message_body_renderer.dart` 加 parts 入口；主要工作在服务端管线重组 |
| 微信桥等 plain 渠道回归 | 阶段 0 用 golden 回归锁定现行为；`toPlainText()` 逐卡补齐 |

---

## 6. 一句话结论

> 业界（OpenAI / Anthropic / AG-UI / Vercel AI SDK / Coze / 飞书 / LobeChat / Adaptive Cards）没有任何一家靠"给散文打分"决定展示形态——全部是 **工具↔组件确定性绑定 + 模型生成时结构化（tool call）+ 类型化消息 parts 协议**，启发式只做纯文本渠道降级。本方案把现有三层打分管线的职责压缩为"两层确定性 + 一层薄兜底"，客户端组件全部复用。

## 参考来源

- AG-UI 协议（事件类型 / tool-based generative UI）：https://docs.ag-ui.com/concepts/events
- Vercel AI SDK Generative User Interfaces：https://ai-sdk.dev/docs/ai-sdk-ui/generative-user-interfaces
- 扣子卡片官方文档：https://docs.coze.cn/guides_message_card 、Card SDK：https://docs.coze.cn/developer_guides_card_sdk
- 飞书卡片 JSON 2.0 结构（含流式更新）：https://open.feishu.cn/document/feishu-cards/card-json-v2-structure
- Adaptive Cards：https://adaptivecards.microsoft.com/
- LobeChat（消息块架构 / 插件卡片）：https://github.com/lobehub/lobe-chat

---

## 附录：实施记录（2026-09-15）

### 与方案的实施映射

实施时发现架构已有部分"parts 协议"地基（`assistant_done` 的 `blocks` 信封 = reply-envelope、`renderBlocks` 交错块、`mediaCards` 独立字段，且管线已支持模型自声明 `[RENDER_HINT:]` 但从未在提示词中告知——dormant 通道）。因此按"根因优先、复用地基"落地，与方案的对应关系：

| 方案层 | 落地实现 |
|---|---|
| L2 模型生成层（生成时结构化） | `render-protocol-prompt.ts`：展示形式协议注入 `assembleSystemPrompt` 稳定层（`[RENDER_HINT:structured/brief]` + 9 种 cardType 卡片块声明规范、频控与 JSON 规则）；`sanitizeModelCardBlocks`（tool-result-processor.ts）：模型卡片块校验/归一化/非法整块丢弃 |
| L2 流式配套 | `utils/stream-marker-guard.ts`：chunk 出口防泄漏（独占行标记扣下、卡片块整块丢弃、行内 token 剥离、误伤保护），接入 `sendAssistantChunk` |
| L1 工具绑定层 | `tool-card-registry.ts`：新增 `search_web`/`info.search` → search_result 卡；WS 聚合 `executedSearchToolResults`（onExternalToolExecuted）→ `attachSearchResultCardFromExecuted` 覆盖 tool-loop 路径 |
| L3 薄兜底层 | 语义路径补传 `numberedItemRatio`（编号证据，extractSemanticItems 剥前缀导致的信息丢失修复）；`scoreSteps` 2 条目门控放宽（显式标记/编号占比 ≥0.8 放行）；其余打分保留（summary_card 的"≥400 字+结构化"口径经论证属产品定义，未改） |
| 链路统一 | `chat-turn-runner.ts`：`capability: "rich"/"plain"` 能力协商替代 `plainTextMode:true` 双跑；`reply-envelope.ts` 新增 `stripMarkersToPlainText` 纯文本渠道降级编码器 |

### flutter_markdown 评估结论：保留自研渲染器

- `flutter_markdown` 官方包已 **discontinued**（最后版本 0.7.7+1，pub.dev 明确标注 "replaced by: flutter_markdown_plus"），切换即引入停止维护的依赖或社区 fork。
- 自研渲染器（`content_summary_detail_formatter.dart`）具备 flutter_markdown 不支持的项目专属能力：表格跨行跨列（`{colspan=2}`）、标题锚点书签导航（GlobalKey）、裸 URL 自动转链接 + 内嵌缩略图、行内图片 WidgetSpan、打字机光标集成、与 AppTypography 主题 token 深度耦合。
- Markdown 基础层不是触发率低的瓶颈（客户端渲染测试全绿证明渲染能力完好），瓶颈是触发确定性——本次已修复。切换成本高、收益为零。

### 验证结果

- 服务端形态覆盖测试 `test/render-forms-coverage.test.ts`：31/31 绿（每种形态独立用例）
- 服务端流式 guard 单测 `test/stream-marker-guard.test.ts`：7/7 绿
- 渲染相关回归集（processor/router/corpus/golden/registry）：205/205 绿；golden 快照仅 1 处预期内漂移（已带标记文本经 sanitize 归一化补默认字段），已审核更新
- 服务端全量套件：fail 0；`tsc --noEmit` 无错误
- 客户端形态覆盖测试 `test/render_forms_client_coverage_test.dart`：17/17 绿（经 `buildMessageBody` 生产路径）
- 客户端全量套件：82/82 绿
