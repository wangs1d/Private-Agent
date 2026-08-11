# Adaptive Hierarchical Tool Intelligence System Spec

## Why
现有 Agent 服务（`server/`，TypeScript）缺少统一的工具调度路由层：Tool / Skill / MCP-Server 三类资源分散注册、全量遍历检索、无置信度联动召回、无知识图谱候选增强、无在线反馈学习闭环。需要新建一个企业级、可扩容至 100000+ 工具资源规模的 Python/FastAPI 子系统，作为 Agent 操作系统核心的 Tool-Routing-Layer，统一管控三类调度资源，实现「用户任务理解 → 领域定位 → 能力检索 → 候选召回 → 精细重排 → 延迟加载 → 执行调用 → 反馈自优化」全自动闭环。

## What Changes
- 新增独立 Python 子系统 `tool-router/`（与现有 `server/` 并列，互不侵入）
- 实现四级分层路由（DomainGroup → Domain → Capability → Resource），硬性禁止全量遍历
- 实现动态权重混合检索引擎（embedding + BM25 + 历史成功率 + 延迟 - 失败惩罚）
- 实现 Adaptive-Top-P 自适应候选召回，置信度联动 top_p 阈值
- 实现 Neo4j 工具知识图谱（7 种关系枚举全量落地）
- 实现三级元数据延迟加载（Level-1 索引 / Level-2 能力描述 / Level-3 执行 Schema）
- 实现 Tool-Reranking 三级重排链路（规则硬过滤 → Cross-Encoder → LLM 精排）
- 实现反馈学习闭环（在线权重更新 / 冷启动保护 / 故障熔断 / 异步削峰）
- 实现 9 个 RESTful API 接口（注册 / 检索 / 加载 / 执行 / 反馈 / 健康检查 / 图谱 / 意图拆解）
- 接入完整技术栈：FastAPI + Pydantic + LangGraph + Qdrant + PostgreSQL + Redis + Neo4j + Celery + RabbitMQ/Kafka + OpenTelemetry + Prometheus
- **BREAKING**：本子系统作为新模块独立部署，不修改现有 `server/` TS 代码，后续通过 HTTP/gRPC 与主服务集成

## Impact
- Affected specs: 无（全新子系统，无既有 spec 受影响）
- Affected code:
  - 新增 `tool-router/` 整个目录树（Python 包）
  - 现有 `server/`、`agent-world/`、`client/` 等模块零改动
  - 新增 `docker-compose` 中 Qdrant / Neo4j / Redis / PostgreSQL / RabbitMQ 基础设施编排（独立 compose 文件，不覆盖现有 `docker-compose.yml`）
- 技术栈引入：Python 3.11+、FastAPI、Pydantic v2、LangGraph、qdrant-client、neo4j-driver、redis、SQLAlchemy、celery、kombu、opentelemetry

## ADDED Requirements

### Requirement: 固定端到端执行链路
系统 SHALL 严格按以下顺序执行工具调度，不可跳过、不可颠倒：
1. User Query + Agent 上下文指纹输入
2. Intent Router（多意图解析、任务约束提取、低置信度关键词兜底降级）
3. Hierarchical 四级分层路由（DomainGroup → Domain → Capability → 资源前置过滤）
4. Hybrid Retrieval Engine 多因子加权召回
5. Adaptive Top-P Candidate Selection 自适应概率召回
6. Knowledge-Graph 候选扩充（依赖项、替代工具、组合适配资源）
7. Tool-Reranking 三级排序（规则硬过滤 → Cross-Encoder 重排 → LLM 业务精排）
8. Dynamic Lazy-Loading（执行 Schema、MCP 连接池初始化、Skill 依赖存活校验）
9. Resource Execute（熔断、超时、依赖故障自动切换替代资源）
10. 结构化完整执行反馈上报
11. 在线更新检索权重、图谱边权重、Top-P 默认参数、故障资源状态标记

#### Scenario: 正常单意图调度
- **WHEN** Agent 提交单意图 query 且置信度 > 0.85
- **THEN** 依次走完 11 步链路，P99 < 200ms，返回已执行结果与反馈回执

#### Scenario: 复合任务调度
- **WHEN** is_compound_task = true
- **THEN** 每条子意图独立执行一次 Top-P 召回，最终合并排序结果

### Requirement: 模块1 Intent Router 意图路由层
系统 SHALL 提供 Intent Router，输入 `raw_user_query: str` 与 `agent_context_hash: str`，输出固定 JSON 结构体，所有字段必须实现：
`intent`(核心任务目标)、`domain_candidates`(多领域数组)、`primary_capability`(首要能力标签)、`confidence`(0.0~1.0)、`query_constraints`(`max_latency_ms`、`read_only`、`file_type`、`auth_level`)、`param_extract`(参数对象)、`is_compound_task`(复合任务标记)。

#### Scenario: LLM 语义路由为主
- **WHEN** LLM 路由 confidence >= 0.6
- **THEN** 直接采用 LLM 路由结果，输出结构可直接供给下层消费，无需二次解析

#### Scenario: 低置信度关键词兜底
- **WHEN** LLM 路由 confidence < 0.6
- **THEN** 强制启用 BM25 关键词路由兜底，重新输出意图结果

#### Scenario: 复合意图拆解
- **WHEN** 用户问句包含多步骤复合任务
- **THEN** 拆分为多个子任务、多个 domain_candidates，标记 is_compound_task=true

#### Scenario: 高频意图缓存
- **WHEN** 同一 query+context 命中 Redis 缓存
- **THEN** 毫秒级返回缓存意图，跳过 LLM 调用

### Requirement: 模块2 Hierarchical 四级分层路由
系统 SHALL 实现四级索引层级（DomainGroup → Domain → Capability → Resource），检索空间逐层缩小。任何场景下禁止全量遍历所有注册资源。前置过滤规则在路由阶段执行：按租户 ID 过滤无权限资源、过滤 status 为 offline/maintenance/rate_limited 的资源。Neo4j 图谱提供跨领域依赖跳转，自动加载任务所需关联领域能力。高频 Capability 存入 Redis 热点缓存，命中则跳过向量库检索。

#### Scenario: 分层逐级收敛
- **WHEN** 路由收到 domain_candidates
- **THEN** 依次定位 DomainGroup → Domain → Capability → Resource，仅在最末级 Capability 分片内检索

#### Scenario: 跨领域依赖跳转
- **WHEN** 任务所需能力横跨多个领域
- **THEN** 通过 Neo4j 图谱自动加载关联领域能力，纳入候选

#### Scenario: 热点 Capability 缓存命中
- **WHEN** 高频 Capability 命中 Redis 热点缓存
- **THEN** 跳过向量库检索，直接返回缓存资源集合

### Requirement: 模块3 Tool-Registry 三级分层存储
系统 SHALL 实现三级元数据存储架构。服务启动阶段禁止加载全部 Level-3 执行 Schema，严格延迟加载。
- **Level-1 轻量索引元数据**（Qdrant/Milvus 向量库 + Redis 常驻，用于检索）：含 `resource_id`、`resource_type`、`name`、`description`、`domain`、`capability`、`tags`、`version`、`status`、`base_score`、`embedding`。
- **Level-2 能力描述元数据**（PostgreSQL 存储，重排阶段加载）：含 `input_type`、`output_type`、`use_cases`、`limitations`、`preconditions`、`dependencies`。
- **Level-3 延迟加载执行 Schema**（仅选中资源后读取）：
  - tool：参数列表、必填字段、参数校验规则、超时时间
  - skill：工作流编排结构、子工具序列、分支判断条件、重试策略、异常兜底资源 id
  - mcp_server：传输协议、endpoint 地址、rpc 方法名称、鉴权配置、连接池参数、心跳检测间隔

#### Scenario: 三级分层隔离
- **WHEN** 检索阶段执行
- **THEN** 仅读取 Level-1 索引；重排阶段才读 Level-2；选中后才读 Level-3

#### Scenario: 环境隔离
- **WHEN** 资源注册时指定 dev/staging/prod 环境标签
- **THEN** 检索按当前运行环境过滤，跨环境资源不可见

#### Scenario: 版本管理与灰度
- **WHEN** 资源更新版本
- **THEN** 支持版本管理、灰度发布、版本回退接口

#### Scenario: Skill 循环依赖检测
- **WHEN** Skill 注册时图谱检测到循环依赖
- **THEN** 直接拒绝注册并返回错误码

### Requirement: 模块4 Hybrid Retrieval Engine 动态权重混合检索
系统 SHALL 使用固定打分公式，全部得分归一化至 0-1：
`final_score = embedding_score*w1 + keyword_score*w2 + history_success_score*w3 + latency_score*w4 - failure_penalty*w5`。
动态权重自适应：短关键词指令 w2(BM25)=0.4、w1(embedding)=0.25；长文本/模糊开放式需求 w1=0.6、w2=0.2；w3/w4/w5 可调。`failure_penalty` 根据最近滑动窗口失败率动态上涨，频繁报错工具获高额扣分。检索仅在当前 Capability 对应向量分片内搜索，禁止全库扫描。`history_success_score` 使用滑动窗口，久远调用记录自动衰减权重。

#### Scenario: 短关键词权重切换
- **WHEN** query 为短关键词指令
- **THEN** w2=0.4、w1=0.25 生效

#### Scenario: 长文本权重切换
- **WHEN** query 为长文本/模糊开放式需求
- **THEN** w1=0.6、w2=0.2 生效

#### Scenario: 失败惩罚动态上涨
- **WHEN** 滑动窗口内某资源失败率上升
- **THEN** failure_penalty 上涨，拉低该资源 final_score

#### Scenario: 分片内检索
- **WHEN** 执行检索
- **THEN** 仅在当前 Capability 向量分片内搜索，绝不全库扫描

### Requirement: 模块5 Adaptive-Top-P 自适应候选召回
系统 SHALL 禁止硬编码固定 Top-K，使用概率累积采样。top_p 阈值绑定意图置信度：confidence > 0.85 → top_p=0.7；0.6 < confidence <= 0.85 → top_p=0.9；confidence <= 0.6 → top_p=0.95。强制硬边界保护：min_candidate=3、max_candidate=25。is_compound_task=true 时，每条子意图独立执行一次 Top-P 召回。

#### Scenario: 高置信度召回
- **WHEN** confidence > 0.85
- **THEN** top_p=0.7，候选集精简

#### Scenario: 低置信度召回
- **WHEN** confidence <= 0.6
- **THEN** top_p=0.95，候选集扩大

#### Scenario: 硬边界保护
- **WHEN** 概率累积候选数 < 3
- **THEN** 强制补足至 3；当 > 25 则截断至 25

#### Scenario: 复合任务拆分召回
- **WHEN** is_compound_task=true
- **THEN** 每条子意图独立执行一次 Top-P 召回并合并

### Requirement: 模块6 Tool-Reranking 三级重排
系统 SHALL 按固定顺序执行三级重排，不可颠倒：
1. 规则硬过滤：校验租户权限、最大延迟约束、只读属性、黑名单、资源在线状态
2. Cross-Encoder 对全部候选资源做精细语义打分
3. LLM-Reranker 只接收排序后前 10 条候选，处理复杂业务上下文匹配
重排输入字段：原始 query、agent 上下文指纹、上一轮工具返回结果、query_constraints 任务约束。

#### Scenario: 规则硬过滤前置
- **WHEN** 候选资源不满足租户权限/延迟/只读/黑名单/在线状态
- **THEN** 在第一层即被剔除，不进入 Cross-Encoder

#### Scenario: LLM 精排仅看前 10
- **WHEN** 进入第三层重排
- **THEN** LLM-Reranker 仅接收前 10 条候选

### Requirement: 模块7 Dynamic Lazy-Loading 动态延迟加载
系统 SHALL 实现延迟加载生命周期：检索筛选资源 → 命中选中 resource_id → 读取 Level-3 Schema → 存入 Redis-LRU 缓存。MCP-Server 维护连接池、定时心跳探测、复用长连接。加载 Skill 时校验全部依赖资源 status；依赖下线则查询知识图谱加载 `alternative_to` 替代资源。资源版本更新后主动触发对应缓存 key 失效，实现 Schema 热重载。服务初始化绝对不加载任何一条 Level-3 执行配置。

#### Scenario: Schema 缓存命中
- **WHEN** 同一 resource_id 重复调用
- **THEN** 直接读取 Redis-LRU 缓存，不重复加载

#### Scenario: 依赖故障自动切换
- **WHEN** Skill 依赖资源 status 下线
- **THEN** 查询图谱 alternative_to，加载替代资源执行

#### Scenario: 版本更新缓存失效
- **WHEN** 资源版本更新
- **THEN** 主动失效对应缓存 key，下次读取重新加载新 Schema

#### Scenario: 启动零 Level-3 加载
- **WHEN** 服务初始化
- **THEN** 不加载任何 Level-3 执行配置

### Requirement: 模块8 Neo4j Tool Knowledge-Graph 工具图谱
系统 SHALL 在代码内定义全部 7 种关系类型常量：`similar_to`(功能相似)、`depends_on`/`requires`(前置依赖)、`alternative_to`(可替代)、`combine_with`(适合组合)、`supersede`(新版替换旧版)、`conflict_with`(互斥)、`child_of`(Skill 下属子资源)。业务功能：选中工具执行失败立刻读取 `alternative_to` 候选无需从头检索；扩充召回候选集合补齐语义检索漏掉的关联资源；自动生成工具组合链路辅助 Skill 编排；根据历史调用频次动态更新每条关系边权重。

#### Scenario: 失败自动取替代
- **WHEN** 选中工具执行失败
- **THEN** 立刻读取 alternative_to 候选执行，无需从头检索

#### Scenario: 候选扩充
- **WHEN** 召回阶段完成
- **THEN** 图谱补齐 similar_to/combine_with/depends_on 关联资源

#### Scenario: 边权重动态更新
- **WHEN** 历史调用频次变化
- **THEN** 离线任务更新对应关系边权重

### Requirement: 模块9 Feedback-Learning 闭环自优化
系统 SHALL 接收完整反馈结构体，字段不可省略：`raw_query`、`parsed_intent`(intent router 完整对象)、`resource_id`、`resource_type`、`success`、`error_code`、`latency_ms`、`result_quality_score`(0~1)、`user_feedback`、`context_hash`、`call_timestamp`(iso-str)。在线学习规则全部实现：增量更新 history_success_score 与 failure_penalty；失败样本降低对应意图-资源匹配权重；同类意图多次召回失败自动上调该意图组别默认 top_p；新注册资源冷启动保护分配基础 base_score 保障曝光；滑动窗口统计失败率，连续失败触达阈值自动设 status=rate_limited 并触发告警；反馈日志通过消息队列异步落库，绝不阻塞主调用链路。

#### Scenario: 在线增量更新
- **WHEN** 收到一条反馈
- **THEN** 增量更新对应资源 history_success_score 与 failure_penalty

#### Scenario: 召回失败上调 top_p
- **WHEN** 同类意图多次召回失败
- **THEN** 自动上调该意图组别默认 top_p

#### Scenario: 冷启动保护
- **WHEN** 新资源注册
- **THEN** 分配基础 base_score，保障曝光，不永久排在末尾

#### Scenario: 故障熔断
- **WHEN** 连续失败触达阈值
- **THEN** 自动设 status=rate_limited 并触发告警

#### Scenario: 异步落库不阻塞
- **WHEN** 反馈上报
- **THEN** 通过消息队列异步落库，主调用链路不被阻塞

### Requirement: 模块10 RESTful API 完整接口清单
系统 SHALL 提供以下 9 个接口，全部必须开发：
- `POST /api/resource/register`：注册 Tool/Skill/MCP-Server
- `POST /api/resource/search`：接收 query，返回排序后候选资源列表
- `POST /api/resource/load`：动态加载指定 id 的 Level-3 执行 Schema
- `POST /api/resource/execute`：发起资源调用，内置超时、熔断参数
- `POST /api/feedback/report`：单条执行反馈上报
- `POST /api/feedback/batch`：批量反馈上报，高并发接口
- `GET /api/resource/health-check`：探测资源存活状态
- `POST /api/graph/query`：查询依赖、替代、组合等图谱关系
- `POST /api/intent/decompose`：复合任务意图拆解接口
通用配置强制：租户 id 请求头、资源版本标识、调用耗时埋点、接口限流、异常捕获、结构化返回体。

#### Scenario: 全量接口可用
- **WHEN** 任一接口被调用
- **THEN** 返回结构化响应体，含租户隔离、版本标识、耗时埋点

#### Scenario: 限流与异常
- **WHEN** 接口被高频调用或抛异常
- **THEN** 触发限流；异常被捕获并返回结构化错误码，不静默吞掉

### Requirement: 技术栈全量落地
系统 SHALL 使用以下技术栈：后端 Python + FastAPI + Pydantic（所有结构体强制校验）；Agent 工作流编排 LangGraph；向量数据库 Qdrant/Milvus；关系数据库 PostgreSQL（读写分离）；内存缓存 Redis（LRU 缓存、意图缓存、Schema 缓存、热点 Capability）；图数据库 Neo4j；异步任务调度 Celery（资源心跳巡检、图谱边权重离线更新、路由统计）；消息队列 RabbitMQ/Kafka（反馈日志异步削峰）；可观测体系 OpenTelemetry 全链路追踪 + Prometheus + Grafana 监控告警；Pg-Vector 用于小规模部署替代独立向量库。

#### Scenario: Pydantic 强制校验
- **WHEN** 任一接口或内部链路传输数据
- **THEN** 使用 Pydantic 模型校验，禁止裸字典传参

#### Scenario: 异步任务与消息队列分离
- **WHEN** 耗时任务（心跳巡检/图谱更新/统计/反馈落库）
- **THEN** 交给 Celery 与消息队列处理，不阻塞同步核心链路

### Requirement: 硬性性能目标
系统 SHALL 达成以下性能指标：初始支持 >= 10000 条调度资源，架构可平滑扩容至 100000+；路由 + 召回 + 重排链路 P99 < 200ms；任何业务路径禁止全量遍历资源列表；Level-3 Schema 缓存命中率 >= 90%；意图路由准确率 >= 95%；向量库基于 domain 分片，支持水平扩容分片。

#### Scenario: P99 延迟达标
- **WHEN** 执行完整调度链路
- **THEN** P99 < 200ms

#### Scenario: 缓存命中达标
- **WHEN** 统计 Level-3 Schema 缓存命中率
- **THEN** >= 90%

#### Scenario: 意图准确率达标
- **WHEN** 统计意图路由准确率
- **THEN** >= 95%

### Requirement: 八阶段强制开发顺序
系统 SHALL 严格按八阶段分步迭代，每阶段完成后必须通过单元测试、接口测试、运行结果输出、性能指标校验才可进入下一阶段：
- Phase-1：资源注册中心，三级元数据模型、CRUD 接口、版本管理、环境隔离、循环依赖检测
- Phase-2：四级分层路由模块、意图路由、降级兜底、权限过滤、Redis 热点缓存
- Phase-3：混合检索引擎、向量检索、BM25、动态权重、滑动窗口历史得分
- Phase-4：Adaptive-Top-P 召回、置信度绑定阈值、候选上下限、复合任务拆分召回
- Phase-5：反馈学习闭环、上报接口、在线权重更新、冷启动、故障熔断、异步消息队列
- Phase-6：Neo4j 工具知识图谱、全部关系类型、替代工具自动推荐、召回候选扩充
- Phase-7：动态延迟加载、MCP 连接池、Skill 依赖存活校验、故障自动切换、熔断超时执行层
- Phase-8：生产级加固、全链路监控、租户隔离、限流、压力测试、十万级分片扩容验证

#### Scenario: 阶段门禁
- **WHEN** 任一阶段开发完成
- **THEN** 必须通过单元测试、接口测试、运行结果输出、性能指标校验后才进入下一阶段

### Requirement: 编码规范
系统 SHALL 遵守：全部数据结构体使用 Pydantic 模型校验，禁止裸字典传参；所有核心链路添加日志埋点、异常捕获，禁止静默失败吞掉异常；模块之间解耦，新增功能不改动原有分层链路；MCP-Server 增加熔断、超时、心跳检测；所有缓存设置合理过期时间，资源更新后主动失效对应缓存键；编写完整异常枚举、错误码体系；区分同步核心链路与异步后台任务，耗时任务一律交给 Celery 与消息队列处理。

#### Scenario: 禁止裸字典
- **WHEN** 传输参数
- **THEN** 必须经 Pydantic 模型校验

#### Scenario: 禁止静默失败
- **WHEN** 核心链路抛异常
- **THEN** 日志埋点 + 异常捕获，不静默吞掉
