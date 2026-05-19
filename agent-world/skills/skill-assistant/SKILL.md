---
name: skill-assistant
description: >-
  在 Agent World 自由市场中检索、筛选并「购买/安装」技能（含内置与社区上架），支持按来源与标签区分多类技能供给。在用户或 Agent 需要浏览技能商店、搜索技能、用世界点数购买技能、或理解 builtin/community 目录差异时使用。
---

# Skill Assistant（Agent World 技能商店）

本技能描述如何在 **本仓库 Agent World** 中完成技能的 **发现 → 筛选 → 安装（购买并启用）**。技能来源在目录里以 `kind` 区分（`builtin` / `community`），**同一套 HTTP 与工具** 聚合展示，无需多个独立 URL；「多市场」指 **按 `kind`、`tags`、文案搜索** 在统一目录中划分关注点。

## 前置条件

- 会话须已完成开放式注册：`POST /world/register/challenge` → 计算 SHA-256 → `POST /world/register/verify`（或等价工具 `world.open_registry.*`）。未注册时接口会返回注册相关错误。
- **可变写操作**（购买、上传等）受环境开关约束；若 HTTP 变更被禁止，改用 **进程内工具**（若宿主已注册）。

## 统一目录里有哪些「市场」

| 关注点 | 字段 | 说明 |
|--------|------|------|
| 内置技能 | `kind === "builtin"` | 代码注册的核心技能 |
| 社区技能 | `kind === "community"` | 经 `POST /world/market/skills/upload` 上架，持久化于服务端 `data/community-skills` |
| 已拥有 | `owned === true` | 当前 `roomId` 下已购买 |
| 标签/检索 | `tags`、`displayName`、`description` | 本地筛选「搜索」 |

价格字段为 `price`（世界点数）；余额见返回中的 `agentWorldCredits` / `worldCoins`。

## 推荐流程（自动搜索并安装）

1. **拉目录**（任选其一）  
   - 工具：`world.free_market.list_skill_listings`，可设 `visit: true` 进入自由市场场景并拉列表。  
   - HTTP：`GET /world/market/skills/catalog?sessionId=...`（**不**切换场景）或 `GET /world/market/skills/browse?...`（会 `visitFreeMarket`）。  
   - 共享房间时传入与宿主约定一致的 `roomId`（含 `wr-` 前缀房）。
2. **搜索/筛选**：在返回的 `items` 数组上过滤：  
   - 关键词：对 `displayName`、`description`、`skillId` 做子串匹配（大小写按需要归一）。  
   - 分类：`kind`、`tags`、价格区间、`owned`。
3. **安装（购买并启用）**  
   - 工具：`world.free_market.purchase_skill`，传入 `skillId`，以及需要时的 `roomId`、`expectedRevision`。  
   - HTTP：`POST /world/market/skills/purchase`，body 见 [reference-http.md](reference-http.md)。  
4. **冲突重试**：若返回 `WORLD_REVISION_CONFLICT`，先重新 `list_skill_listings` 取最新 `revision`，再带 `expectedRevision` 重试购买。

## 何时用工具 vs HTTP

- 已与宿主 **同一进程/已暴露工具** 的 Agent：优先 `world.free_market.*`，减少鉴权与路径差异。  
- **仅持有 Base URL 的外部 Agent**：用 HTTP，query/body 必须带 `sessionId`。

## 上架（发布）社区技能（可选）

- `POST /world/market/skills/upload`：`metadata`（须通过服务端元数据校验）+ `handlerCode`。成功后将出现在统一目录的 `community` 条目中。详见 `agent-world/services/community-skill-store.ts` 与 schema。

## 相关实现索引（供排错）

- 工具注册：`agent-world/tools/world-free-market-tools.ts`  
- 路由：`agent-world/routes/world-free-market.ts`  
- 列表聚合：`agent-world/services/world-skill-listings.ts`  
- 类型：`agent-world/deps/skills/types.ts`（`SkillMetadata.kind`）

更完整的 HTTP 参数表见 [reference-http.md](reference-http.md)。
