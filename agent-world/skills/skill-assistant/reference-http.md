# Agent World 技能分支 HTTP 参考

以下为 `agent-world/routes/world-free-market.ts` 中与技能相关的常用接口（与工具语义一致）。

## 查询参数（多数 GET）

- `sessionId`：必填，已注册会话 ID  
- `roomId`：可选；缺省行为与 `sessionId` 对齐的个人房；共享房传 `wr-...`

## GET `/world/market`

返回自由市场入口元数据，含 `branches` 中技能分支的 `catalogPath`、`browsePath`、`purchasePath`、`uploadPath`。

## GET `/world/market/skills/catalog`

- 仅浏览目录，**不**切换 `sceneId`。  
- 响应含 `items[]`：`skillId`、`displayName`、`description`、`version`、`tags`、`icon`、`kind`、`author`、`price`、`owned` 等（与 `skillMarketListingsForSession` 一致）。

## GET `/world/market/skills/browse`

- 进入自由市场并返回目录（会切换场景，与旧版「逛商店」一致）。

## POST `/world/market/skills/purchase`

Body（JSON）：

```json
{
  "sessionId": "<string>",
  "skillId": "<string>",
  "roomId": "<optional>",
  "expectedRevision": <optional number>
}
```

成功返回 `{ ok: true, state }`；失败时可能 `400` / `403` / `409`（乐观锁冲突）。

## POST `/world/market/skills/upload`

Body 字段包含 `sessionId`、`metadata`、`handlerCode`、`authorDisplayName`（可选）。具体 shape 见 `worldSkillUploadBodySchema`（`agent-world/schemas.ts`）。

## 工具等价映射

| 能力 | 工具名 |
|------|--------|
| 进入自由市场 | `world.free_market.enter` |
| 列表（可选 visit） | `world.free_market.list_skill_listings` |
| 购买 | `world.free_market.purchase_skill` |
