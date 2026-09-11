# 神经级检索质量方案（Neural Retrieval Plan）

> 状态：**N1–N4 已全部实施（2026-09-11）**。实施记录与实测参数见 §7。
> 目标：在进程内检索架构（`in-process-tool-search.md`）上叠加真正的神经模型
> 能力——语义 embedding 与交叉编码重排——把「找对工具」从词面匹配升级到
> 语义理解，同时不破坏检索链路「零外部依赖也可用」的稳定性底线。

## 0. 设计原则（与边界军规一致）

- **分层增强，逐级可关**：BM25 词面 → embedding 语义 → cross-encoder 精排，
  每级独立开关与预算；任何一级失败/超时自动落到下一级，检索永不阻塞。
- **常驻 sidecar，HTTP JSON**：本地 FastAPI 服务（同 PaddleOCR 模式），
  不按需 spawn、不用 gRPC（内网单机延迟差 <1ms，可 curl 调试更重要）。
- **状态归 Node**：模型无状态；缓存/学习状态在 TS 侧（磁盘 + 内存）。
- **可评估**：每级用 golden 召回集（`test/tool-discover-golden-recall.test.ts`）
  与延迟基准（`scripts/eval-tool-recall.ts`）验收，A/B 可回滚。

## 1. 阶段 N1：本地 embedding sidecar（替换 OpenAI API 依赖）

**现状**：`tool-embedding.ts` 走 OpenAI `text-embedding-3-small`（带磁盘缓存），
无 key/失败时全目录退化为 hash 向量（语义通道失效）。

**方案**：新增本地 sidecar `server/neural-retrieval-sidecar/`（见同目录脚手架）：

```
POST /embed  { "texts": ["查询今天天气", ...] }
→  { "model": "bge-small-zh-v1.5", "dim": 512, "vectors": [[...], ...] }
GET  /health → { "model": ..., "warm": true }
```

- 模型：`BAAI/bge-small-zh-v1.5`（中文优先，512 维，CPU 上单条 <5ms、批量 32 条 <40ms；
  显存/CPU 充裕可换 `bge-base-zh` 或多语 `bge-m2`）。
- TS 侧改造（一处）：`tool-embedding.ts` 的 provider 顺序改为
  `AGENT_TOOL_EMBEDDING_PROVIDER`（`local` | `openai` | `auto`）：
  - `local`：优先 sidecar，失败回落 openai，再失败回落 hash；
  - 缓存键带模型名，混用不污染。
- 预算：单次调用 300ms 超时；连续 2 次失败熔断 60s 内直接走下一 provider
  （沿用原 router-endpoint-guard 数值经验）。
- 验收：golden 21/21 不降；embedding 通道冷启动（首查）p95 < 100ms。

## 2. 阶段 N2：交叉编码重排（激活 `llmReranker` 钩子）

**现状**：`reranking-pipeline.ts` 第三层 `llmReranker` 是预留接口，从未注入；
第二层"cross-encoder"是 token Jaccard 模拟（Python 原型的忠实移植）。

**方案**：sidecar 增加 `/rerank`：

```
POST /rerank { "query": "...", "documents": ["name|description|capability ...", ...], "top_k": 10 }
→  { "scores": [0.92, 0.11, ...] }   // 与 documents 等长，按相关度
```

- 模型：`BAAI/bge-reranker-base`（中文交叉编码器，CPU 单对 ~15ms、
  10 对批 <80ms；GPU 无需）。输入文档统一拼
  `name + " " + description + " " + capability.join(" ") + " " + aliases.join(" ")`。
- TS 注入（一处）：`adaptive-catalog.ts` 构造管线处传入 `llmReranker`，
  内部实现 = fetch sidecar + 400ms 预算 + 熔断；失败/超时管线自动回退
  词面序（现有 try/catch 语义不变）。
- 触发面：仅低置信路径（intent.confidence < 0.85 且候选 ≥3）调用；
  高置信短路路径不增加延迟。
- 验收：golden top-1 命中率 ≥ 现基线；低置信查询 p95 增量 < 120ms
  （重排预算内）；sidecar 停机时全部测试仍绿（降级路径）。

## 3. 阶段 N3：查询意图神经化（可选，收益最大也最贵）

把 `intent-router` 的正则域推断换成小模型分类（sidecar `/classify-intent`，
`uer/roberta-base-finetuned-cluener` 级别或 3 层 MLP over bge embedding）。
仅在 N1/N2 落地后、golden 显示域误路由（如「今天有什么热搜」→clock/shopping）
仍是 top 错因时启动。正则意图保留为 fallback（fast-path 与降级路径）。

## 4. 阶段 N4：规模化（目录 >2000 工具）

- `embeddingIndex` 暴力余弦 → HNSW（`hnswlib-node`，进程内，~50k 向量 p99 <5ms）；
- BM25/trigram 索引已按签名缓存，无需改；
- 真到多实例共享目录需求，再评估外置 qdrant（契约仍是纯搜索 API）。

## 5. 实施顺序与成本

| 阶段 | 工作量 | 风险 | 回滚 |
|---|---|---|---|
| N1 embedding sidecar | sidecar 脚手架已备；TS 接入 ~0.5 天 | 低（双 provider 回落） | env 一键切回 openai |
| N2 rerank 注入 | ~0.5 天 | 低（失败回退词面序） | env 关闭注入 |
| N3 意图分类 | ~2 天 + 标注 | 中（改路由行为） | 正则 fallback 常驻 |
| N4 HNSW | ~1 天 | 低 | 索引签名回退 |

## 6. 观测

- sidecar 自带 `/metrics`（Prometheus 文本：qps / p95 / 模型 warm）；
- TS 侧 `observability/metrics.ts` 增加 `neural_embedding_fallback_total`、
  `neural_rerank_timeout_total`，融断事件 warn 日志；
- golden 召回 + eval-tool-recall 进 CI 周期任务，任何一级的开关状态都跑双遍
  （开/关），确保降级路径不腐化。

## 7. 实施记录（2026-09-11，N1–N4 全部落地）

### 7.1 交付物

| 层 | 文件 | 内容 |
|---|---|---|
| sidecar | `server/neural-retrieval-sidecar/main.py` | `/embed` `/rerank` `/classify-intent`（支持 label_vectors 形态）`/health` `/metrics`；HF_HUB_OFFLINE=1 启动可跳过联网校验 |
| 客户端 | `tool-search/neural-sidecar.ts` | 统一入口：每特性独立熔断（2 连败 / 60s 冷却）+ 超时 + metrics 计数；批量 embed 分块（热路径 300ms 预算 / 后台补全 10s 预算分离）；域标签向量缓存 |
| N1 | `tool-search/tool-embedding.ts` | provider 链 sidecar→openai（`AGENT_TOOL_EMBEDDING_PROVIDER`）；缓存条目与 query LRU 均带模型键（512/1536 维混存不串味）；`getQueryEmbeddingBounded` 首查有界等待 400ms |
| N2 | `tool-search/reranking/neural-reranker.ts` | 挂入 `llmReranker` 钩子；仅低置信路径触发（高置信短路不经 rerank）；top-6 × 120 字符；sidecar 不可用静默回退词面序 |
| N3 | `tool-search/intent-router/neural-intent-router.ts` | 挂入 `SemanticIntentRouter` 钩子；相对差值采纳规则（top≥2.5×second 且 ≥3×均匀分布），置信度 = 0.6+0.1·ln(ratio)；正则 fast-path 与降级路径完整保留 |
| N4 | `tool-search/tool-embedding-index.ts` | `hnswlib-node`（optionalDependencies，已安装）惰性 ANN：目录 ≥2000 自动启用，未装/失败回落暴力扫描；legacy 通道改子集内余弦扫描 `rankAllWithin` |
| 观测 | `observability/metrics.ts` | `neural.{embed,rerank,intent}.{requests,ok,fallback,timeout,breaker_skips}` + Prometheus 指标 |
| 测试 | `test/tool-discover-neural-recall.test.ts` | 神经在线集成测试（sidecar 不可达自动 skip）；golden 测试钉死神经全关保证确定性 |

### 7.2 实测数据（i7 CPU / bge-small-zh-v1.5 + bge-reranker-base / 101 工具）

| 指标 | 神经全关 | 神经全开 | 备注 |
|---|---|---|---|
| tool_discover 热查询 p50 | 10.7ms | 42–275ms | 全开 p50 取决于低置信 query 占比（rerank ~200ms 仅低置信路径付）；高置信短路路径 ~30–50ms |
| tool_discover 热查询 p95 | 16.3ms | ~305ms | 合成基准全部为冷查询+低置信，比生产分布悲观 |
| golden 21 条 top-1 | 21/21 | —（神经关闭钉死） | 降级路径无回归 |
| 改写集 6 条 top-3（零词面重叠） | 4/6 | **6/6** | 语义通道的净增量所在 |
| 全量测试套件 | 1555/1555 | — | 神经全关下无任何回归 |
| ANN 500 向量 | — | 构建 55ms / 查询 <1ms / recall@5=5/5 | N4 仅目录 ≥2000 才启用 |
| 工具向量全量补全 | — | ~3s（一次性，落盘后 0） | 后台 fire-and-forget，不阻塞检索 |

### 7.3 对原方案参数的实测修正

1. **rerank 预算 400ms→600ms，对数 10→6、文档 260→120 字符**：本机 CPU 实测
   10 对 × 260 字符 ≈ 400ms+，抖动下频繁打穿预算→熔断反复把增强静默关掉；
   收窄后 ~200ms 稳定。方案 §2 的「p95 增量 <120ms」在 CPU 现实下不成立
   （原型数字假设更短文档），换 GPU/更小模型后可回收。
2. **意图分类置信度改相对差值规则**：18 类 softmax 绝对置信度失真（正确域仅
   0.4），原定 0.6 阈值会全部拒判；top/second 比值规则对 18 类稳健。
3. **首查语义化**：原「后台预取、下次生效」让改写 query 首查永远吃不到语义
   通道；改为 sidecar 提供者下首查有界等待 400ms（OpenAI 慢路径维持后台预取）。
4. **索引签名含 embedding 指纹**：后台补全的向量落盘后签名变化→索引重建，
   修复「语义向量已算好但索引缓存一直持有 hash 占位向量」的隐性缺陷。
5. **写动词词表补「定个/定一个/定一下」**：「定个闹钟」此前被当只读查询，
   创建类工具被 read_only 过滤（与当年补「记住|记下|保存」同类缺口）。
6. **A/B 对比驱动的两项修复（2026-09-12）**：
   - **boost 覆盖重排**：管线在 llmReranker 之后还按 final_score 重排，而重排
     只输出数组顺序不改分数——神经顺序被整体推翻，钩子形同虚设。修复：
     `llm_seen_count > 0` 时 boost 只校正展示分不再排序；同时加采信门禁
     （head 候选 keyword_score 全 0 即词面完全失效才进重排）——词面+校准已
     调优的查询上交叉编码接管是负收益（实测无条件接管 golden 19/20→15/16）。
   - **动作对齐加成**：「提醒我开会」（意图 reminder.schedule）的创建类候选
     与删除类候选同分 0.491、靠数组序定名次。businessScore 补 intent
     动作对齐（schedule/plan/add→create 族相交 +0.05），top-3 恢复确定。

### 7.5 A/B 前后对比（2026-09-12 实测，`scripts/compare-neural-ab.ts`）

同一查询集（golden 20 条 + 零词面重叠改写集 8 条）、同一目录（102 工具），
仅神经开关不同，分进程各跑一遍：

| 指标 | 神经全关（≈改造前） | 神经全开 | 变化 |
|---|---|---|---|
| golden top-1 | 18/20 | **19/20** | +1（动作对齐修复连带收益） |
| golden top-3 | 20/20 | 20/20 | 持平（零回归红线达成） |
| 改写集 top-1（零词面重叠） | 5/8 | **6/8** | +1（语义通道主战场） |
| 改写集 top-3 | 6/8 | **7/8** | +1 |
| 冷查询 p50 / p95 | 9 / 15ms | 66 / 84ms | 首查有界等待 + 检索 60-80ms，远低于 500ms/波预算 |
| 同批热查询平均 | 8ms | 34ms | — |

结论：零词面重叠的改写表达（语义通道目标场景）top-3 6/8→7/8、top-1 5/8→6/8，
golden 基线零回归且 top-1 +1；延迟增量 ~25-60ms 仅占快速通道单波预算的
5-15%，对比 top-1 失手触发「2 波预算白烧 + 升级完整通道」的秒级代价为正收益。

### 7.4 回滚开关（全部 env 一键）

```bash
AGENT_TOOL_EMBEDDING_PROVIDER=openai      # N1 退回 OpenAI API
AGENT_NEURAL_EMBED_ENABLED=off            # N1 关（回落 openai/hash/BM25）
AGENT_NEURAL_RERANK_ENABLED=off           # N2 关（词面序，行为=注入前）
AGENT_NEURAL_INTENT_ENABLED=off           # N3 关（正则路由）
AGENT_TOOL_SEARCH_ANN=off                 # N4 关（暴力扫描）
```

sidecar 启动：`cd server/neural-retrieval-sidecar && HF_HUB_OFFLINE=1 python -m uvicorn main:app --host 127.0.0.1 --port 8790`
（权重缓存后离线启动 ~7s；首请求懒加载。停机时 TS 侧全部降级路径自动生效，
golden 与全量测试在 sidecar 停机状态下验证全绿。）
