# Tasks

- [ ] Task 1: 记忆隐私分级 + Prompt-level 脱敏
  - [ ] SubTask 1.1: 在 MemoryItem 类型增加 `sensitivity: "public" | "personal" | "sensitive" | "restricted"` 字段，默认 "public"
  - [ ] SubTask 1.2: MemoryCortex.recall 按 sensitivity 过滤（restricted 不返回给 prompt 路径）
  - [ ] SubTask 1.3: 在 prompt-context-builder.ts assembleMemory 中，对注入 prompt 的 memory/facts 调 redactSensitiveText
  - [ ] SubTask 1.4: 扩展 redact.ts 的 PII 检测：增加邮箱、IP 地址、信用卡 CVV 模式

- [ ] Task 2: 输出安全过滤
  - [ ] SubTask 2.1: 在 limbic-cortex.ts 新增 `checkOutputSafety(text, ctx): { safe: boolean, sanitized: string, reason?: string }` 方法
  - [ ] SubTask 2.2: 检测模式：API key（sk-xxx）、private key（BEGIN PRIVATE KEY）、长随机串、内部系统路径
  - [ ] 2.3: 命中时替换为 [REDACTED] + 记录审计日志
  - [ ] SubTask 2.4: 在 BrainCenter.cognize 阶段 3 后置执行 checkOutputSafety
  - [ ] SubTask 2.5: 在 executeProactiveDecision 输出话术后也执行 checkOutputSafety

- [ ] Task 3: 元认知置信度评估
  - [ ] SubTask 3.1: 在 awareness-cortex.ts 新增 `assessConfidence(query, recallResult, capabilities): { score: number, reason: string }` 方法
  - [ ] SubTask 3.2: 评分规则：召回结果数/相关度 + 能力域匹配度 + 历史失败率
  - [ ] SubTask 3.3: 在 BrainCenter.cognize 路由前调 assessConfidence
  - [ ] SubTask 3.4: 低置信度（score < 0.4）时强制升级到 master_delegate

- [ ] Task 4: 熔断器与指数退避
  - [ ] SubTask 4.1: 新建 `server/src/external-model/circuit-breaker.ts`，实现 CircuitBreaker 类（closed/open/half-open 三态）
  - [ ] SubTask 4.2: 失败率 > 50%/1min 窗口 → open（30s 拒绝）→ half-open（试探 1 个）→ closed
  - [ ] SubTask 4.3: FailoverChatProvider 每个 provider 包装熔断器
  - [ ] SubTask 4.4: DefaultRecoveryPolicy retry 增加指数退避（200ms × 2^n，封顶 2s）

# Task Dependencies
- 全部独立，可并行
