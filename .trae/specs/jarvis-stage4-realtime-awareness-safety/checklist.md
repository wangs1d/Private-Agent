# Checklist

## Task 1: 记忆隐私分级 + Prompt-level 脱敏
- [x] MemoryItem 增加 sensitivity 字段（public/personal/sensitive/restricted）
- [x] recall 按 sensitivity 过滤（restricted 不进 prompt）
- [x] assembleMemory 中对 memory/facts 调 redactSensitiveText
- [x] redact.ts 扩展 PII 检测（邮箱、IP、信用卡 CVV）

## Task 2: 输出安全过滤
- [x] limbic-cortex.ts 新增 checkOutputSafety 方法
- [x] 检测 API key / private key / 长随机串 / 内部系统路径
- [x] 命中时替换为 [REDACTED] + 审计日志
- [x] cognize 阶段 3 后置执行
- [x] executeProactiveDecision 输出后执行

## Task 3: 元认知置信度评估
- [x] awareness-cortex.ts 新增 assessConfidence 方法
- [x] 评分规则含召回结果数/能力匹配/历史失败率
- [x] cognize 路由前调 assessConfidence
- [x] 低置信度时升级到 master_delegate

## Task 4: 熔断器与指数退避
- [x] 新建 circuit-breaker.ts（closed/open/half-open 三态）
- [x] 失败率 > 50%/1min → open → 30s → half-open → closed
- [x] FailoverChatProvider 每个 provider 包装熔断器
- [x] DefaultRecoveryPolicy retry 增加指数退避

## 编译与集成
- [x] `cd server; npx tsc --noEmit` 零错误
- [ ] 现有 brain-end-to-end 测试仍通过
- [ ] 现有 brain-subcortical 测试未回归
