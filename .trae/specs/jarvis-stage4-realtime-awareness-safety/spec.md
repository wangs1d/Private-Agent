# 第四阶段：实时响应 + 觉察 + 安全 Spec

## Why
当前发给 LLM 的 prompt 完全未脱敏（redactSensitiveText 仅用于审计/WAL），MemoryCortex 无 sensitivity 字段（敏感数据与一般记忆同等暴露），输出安全完全依赖 LLM 自觉无后置过滤，Agent 不知道自己不知道（无元认知置信度评估）。这些是"私人 Agent"的根本性安全与质量短板。

## What Changes
- MemoryItem 增加 sensitivity 字段，recall 按 sensitivity 过滤
- prompt-context-builder 组装 prompt 前对 memory/facts 字段调 redactSensitiveText
- LimbicCortex 新增 checkOutputSafety 后置过滤
- AwarenessCortex 新增 assessConfidence 元认知评估
- BrainCenter.cognize 路由前调 assessConfidence，低置信度时升级路由
- FailoverChatProvider 增加熔断器 + 指数退避

## Impact
- `server/src/brain/memory-cortex.ts`（sensitivity 字段）
- `server/src/agent/prompt-context-builder.ts`（prompt 脱敏）
- `server/src/utils/redact.ts`（扩展 PII 检测）
- `server/src/brain/limbic-cortex.ts`（输出安全过滤）
- `server/src/brain/awareness-cortex.ts`（元认知评估）
- `server/src/brain/brain-center.ts`（置信度路由）
- `server/src/external-model/failover-chat-provider.ts`（熔断 + 退避）

## ADDED Requirements

### Requirement: 记忆隐私分级
系统 SHALL 在 MemoryItem 增加 sensitivity 字段，recall 时按 sensitivity 过滤，restricted 级记忆永不进 prompt。

#### Scenario: 敏感记忆不进 prompt
- **WHEN** MemoryCortex.recall 返回结果中含 sensitivity=restricted 的记忆
- **THEN** 该记忆不注入 system prompt
- **AND** personal 级记忆在注入前经 redactSensitiveText 脱敏

### Requirement: Prompt-level 脱敏
系统 SHALL 在 prompt 组装前对 memory/facts/userProfile 字段调 redactSensitiveText 脱敏。

#### Scenario: 用户手机号脱敏
- **WHEN** 用户记忆中含手机号 13800138000
- **AND** 该记忆注入 system prompt
- **THEN** prompt 中手机号被替换为 ***PHONE***
- **AND** LLM 看到的是脱敏后的文本

### Requirement: 输出安全过滤
系统 SHALL 在 LLM 输出后执行 checkOutputSafety 后置过滤，检测敏感信息泄露和有害内容。

#### Scenario: 输出含 API key
- **WHEN** LLM 输出文本中包含 API key 格式字符串（sk-xxx）
- **THEN** checkOutputSafety 检测到并替换为 [REDACTED]
- **AND** 记录审计日志

### Requirement: 元认知置信度评估
系统 SHALL 在 AwarenessCortex 新增 assessConfidence 方法，评估对当前回答的置信度。

#### Scenario: 低置信度升级路由
- **WHEN** cognize 路由前调 assessConfidence 返回 score < 0.4
- **THEN** 强制升级到 master_delegate 路由
- **AND** 记录低置信度原因

### Requirement: 熔断器与指数退避
系统 SHALL 在 FailoverChatProvider 增加熔断器和指数退避，防止单 provider 故障时雪崩。

#### Scenario: Provider 故障熔断
- **WHEN** 某 provider 1 分钟内失败率 > 50%
- **THEN** 熔断器打开，30s 内跳过该 provider
- **AND** 30s 后进入 half-open 状态试探 1 个请求
- **AND** retry 增加指数退避（200ms × 2^n，封顶 2s）
