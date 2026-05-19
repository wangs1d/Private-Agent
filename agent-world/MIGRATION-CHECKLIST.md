# Agent World 单独复制清单

你现在可以直接复制目录：

- `agent-world/`

## 复制后第一步（建议）

1. 在新项目里保留 `agent-world/` 原始结构。
2. 由宿主 `index.ts` 引入 `agent-world/index.ts` 的导出能力（服务/路由/工具注册）。
3. 为宿主注入以下依赖：
   - `SkillManager`（技能读取、购买启用、社区技能）
   - `ToolRegistry`（注册 `world.free_market.*`、`world.doudizhu.*`）
   - `WsConnectionRegistry`（斗地主 WS 推送）
   - `AuditService`（对账/恢复日志，可选）
4. 若要在新仓库单独编译本目录，请先安装依赖：
   - 运行时（peer）：`fastify`、`zod`、`openai`
   - 开发：`typescript`、`@types/node`
   - 然后执行：`npm run build`（`tsconfig.build.json` → `dist/`）

## 当前已内置内容

- 世界服务：`services/world-service.ts`
- 自由市场 + A2A：`routes/world-free-market.ts`、`services/a2a-outsourcing-service.ts`
- 斗地主：`routes/world-doudizhu.ts`、`services/doudizhu-service.ts`
- World 协议常量：`protocol-world.ts`
- World schema：`schemas.ts`
- LLM 斗地主 tools 定义：`doudizhu-chat-tools.ts`

## 注意事项

- 该目录是「可复制源码包」，并不强制要求在当前仓库内直接独立编译。
- 当前已把宿主类型依赖抽到 `host-types.ts`（如 `HttpRouteDepsLike`、`ToolRegistryLike`、`SkillManagerLike`），便于在新项目按你的宿主实现进行适配。
- 社区技能元数据校验由宿主通过 `HttpRouteDepsLike.skillMetadataValidator` 注入，不再耦合 `deps/skills/skill-validator`。
- 本仓库内 `server` 已通过根目录 **npm workspaces** 依赖 `@private-ai-agent/agent-world`（单一源码来源）。
- 若 **完全不使用主仓库 `server`**，可在 `agent-world` 目录执行 `npm install` 后 `npm run standalone`，见 `standalone/host.ts`（仅 Fastify + 本包 `deps`，无聊天/钱包/Agent 核心）。

