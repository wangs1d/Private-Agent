# 学习笔记 / 知识笔记 功能规划

## Summary

为 Private AI Agent 增加一个 `notes` 能力域，让用户能用自然语言把**学习 / 会议 / 视频 / 读书 / 灵感**等知识内容沉淀为笔记，并让 Agent 主动参与**整理、摘要、抽问、复习提醒**全流程。覆盖三类用户行为：

- "我刚学完一节，帮我记一下要点" → 实时落笔记 + 摘要
- "刚才那个会议纪要整理一下" → 把对话/原文转结构化笔记
- "下周提醒我复习这些" → 接入 schedule

存储：**单用户、本地文件**（沿用项目里 `data/` 目录的 JSON 模式），不进入 Agent World 经济与社交。

---

## Current State Analysis

| 已有能力 | 路径 | 可复用点 |
|---------|------|---------|
| Capability Domains 注册 | `server/src/agent/agent-capabilities.ts` | 添加 `notes` 域 |
| HTTP 路由聚合 | `server/src/routes/http/index.ts` | 新增 notes 路由组 |
| 服务容器 | `server/src/bootstrap/create-app-services.ts` | 注入 `NotesService` |
| 任务调度 | `server/src/services/schedule-task-service.ts` + `routes/http/schedule.ts` | 复习提醒 |
| 外部 LLM | `server/src/external-model/index.ts` (createExternalChatProviderFromEnv) | 摘要/抽问 |
| 文件 JSON 存储 | 参考 `services/agent-self-learning-service.ts` (`data/agent-learning-log.jsonl`) | 笔记落盘 |
| Skill 文档 | `agent-world/skills/game-gomoku/SKILL.md`、`skill-assistant/SKILL.md` | 写新 skill |
| 工具注册 | `server/src/tools/*.ts`（如 `calendar-tools.ts`） | 写 `notes-tools.ts` |
| Schema 校验 | `server/src/schemas/api.ts` | 加 zod schema |
| 状态连续性原则 | `server/src/agent/agent-capabilities.ts` GLOBAL_RULES_LINES | 引用并扩展 |
| Flutter 客户端 | `client/flutter_app/lib/features/schedule/`、`mailbox/` | 写 `notes/` 页面 |

不在范围内的现成组件：**没有**。需要新建一个 `NotesService` + 路由 + 工具 + skill 文档 + 客户端页面。

---

## Proposed Changes

### 1. 新增 capability 域：`notes`

**文件**：`server/src/agent/agent-capabilities.ts`

- 在 `CAPABILITY_DOMAINS` 数组追加 `"notes"`
- 在 `DOMAIN_LABELS` 加中文标签：`notes: "学习笔记（学习/会议/视频/读书/灵感沉淀、摘要、抽问、复习）"`
- 在 `buildStaticSections()` 末尾追加 `notes` 段，列出工具：
  ```
  notes.create / list / get / update / delete
  notes.search（关键词）
  notes.summarize（生成摘要）
  notes.flashcards（生成记忆卡片）
  notes.quiz（自测题）
  notes.schedule_review（接入日程复习）
  ```
- 在 `GLOBAL_RULES_LINES` 末尾追加：涉及"记一下/整理/复习"等关键词时优先调用 `notes.*`；操作前先 `notes.list` 查重避免重复落库。

### 2. 新增 `NotesService`

**文件**：`server/src/services/notes-service.ts`

- 存储：`data/notes/<sessionId>.json`，首次访问时 `mkdir -p`。
- 数据模型：
  ```ts
  type NoteCategory = "study" | "meeting" | "video" | "reading" | "idea" | "todo" | "other";
  interface Note {
    id: string;              // ulid/uuid
    sessionId: string;
    title: string;
    content: string;         // 原文/Markdown
    category: NoteCategory;
    tags: string[];
    source?: string;         // "chat" | "video:<url>" | "meeting:<topic>" | "manual"
    summary?: string;        // LLM 生成的摘要（懒生成）
    flashcards?: { q: string; a: string }[];
    quiz?: { question: string; answer: string }[];
    createdAt: string;
    updatedAt: string;
    lastReviewedAt?: string;
    reviewCount: number;
  }
  ```
- 关键方法：
  - `createNote(input)` / `getNote(id)` / `updateNote(id, patch)` / `deleteNote(id)`
  - `listNotes({ sessionId, category?, tag?, from?, to?, limit? })`
  - `searchNotes(sessionId, query, topK?)` —— 复用 `server/src/agent/retrieval/bm25-lite.ts`（已存在）
  - `generateSummary(noteId, chatProvider)` —— 调 LLM，懒写回
  - `generateFlashcards(noteId, chatProvider)`
  - `generateQuiz(noteId, chatProvider)`
  - `scheduleReview(noteId, scheduleTaskService, when)` —— 调 `scheduleTaskService.createTask`（cron 触发时由 Agent 复盘）

### 3. 新增 HTTP 路由

**文件**：`server/src/routes/http/notes.ts`

| Method | Path | 说明 |
|--------|------|------|
| GET | `/notes` | 列表（`sessionId` 必填，`category`、`tag`、`from`、`to`、`limit` 选填） |
| GET | `/notes/:id` | 详情 |
| POST | `/notes` | 创建（body: `title`、`content`、`category`、`tags[]`、`source`） |
| PATCH | `/notes/:id` | 更新（部分字段） |
| DELETE | `/notes/:id` | 删除 |
| POST | `/notes/search` | `{ sessionId, query, topK? }` |
| POST | `/notes/:id/summarize` | 触发 LLM 摘要（带 cache，未生成才调） |
| POST | `/notes/:id/flashcards` | 生成卡片 |
| POST | `/notes/:id/quiz` | 生成自测题 |
| POST | `/notes/:id/schedule-review` | `{ when, recurrence? }` 创建复习任务 |

**Zod schema**：`server/src/schemas/api.ts` 追加 `notesCreateBodySchema`、`notesUpdateBodySchema`、`notesListQuerySchema`、`notesSearchBodySchema`、`notesScheduleReviewBodySchema`。

### 4. 启动注入

**文件**：`server/src/bootstrap/create-app-services.ts`

- `new NotesService({ dataDir: ... })`，单例化。
- 把 `notesService` 加入 `registerHttpRoutes` 所需的 `HttpRouteDeps`。

### 5. 路由注册

**文件**：`server/src/routes/http/index.ts`

- `import { registerNotesRoutes } from "./notes.js";`
- 在 `registerHttpRoutes` 中调用 `registerNotesRoutes(app, deps);`

### 6. 新增 Agent 工具

**文件**：`server/src/tools/notes-tools.ts`

参照 `tools/calendar-tools.ts` 的注册方式，注册到 `ToolRegistry`：
- `notes.create` `notes.list` `notes.get` `notes.update` `notes.delete`
- `notes.search`
- `notes.summarize` `notes.flashcards` `notes.quiz`
- `notes.schedule_review`

每个工具的 `description` 用中文写明**何时调用**与**必填/选填参数**，便于 LLM 在工具选择阶段挑中。

### 7. 新增 Skill 文档

**文件**：`agent-world/skills/study-notes/SKILL.md`（同时也是 Skill Manager 加载的目标）

仿照 `game-gomoku/SKILL.md` 写一份：
- **触发短语**：用户说"记一下/整理笔记/帮我记/总结这段/抽几道题/复习"时启动
- **典型工作流**：
  1. 收到内容 → `notes.search` 查重（避免重复）
  2. 调 `notes.create`，把对话原文落 `content`，`source: "chat"`
  3. 用户要求"总结" → `notes.summarize`
  4. 用户要求"出题" → `notes.quiz`（或 `notes.flashcards`）
  5. 用户说"下周提醒我复习" → `notes.schedule_review`
- **状态连续性**：`notes.list` 必须先于写操作；`update` / `delete` 必须基于已存在的 `id`，禁止凭用户口述构造 id
- **权限与沙箱**：默认沙箱即可用（纯本地 + LLM），无需"完全访问"

### 8. 客户端：Flutter 页面

**文件**：
- `client/flutter_app/lib/features/notes/notes_page.dart`
- `client/flutter_app/lib/features/notes/note_detail_page.dart`
- `client/flutter_app/lib/core/services/notes_api_client.dart`

仿照 `features/schedule/schedule_page.dart`：
- 列表页：分类 Tab（学习/会议/视频/读书/灵感）+ 搜索框 + FAB 新建
- 详情页：标题、Markdown 渲染、`content`、分类/标签编辑、**生成摘要 / 抽问 / 复习**三个按钮
- `notes_api_client.dart` 调 `GET/POST/PATCH/DELETE /notes*`

### 9. 客户端：Web 入口（可选但建议）

在 `server/src/routes/http/chat-web.ts` 已有的 chat-web 端追加一个 `/notes` 子页面（或单独 `notes.html`）：
- 极简单页：`sessionId` 输入 → 列表 / 详情 / 编辑
- 用最小化原生 JS（不引新框架），与 gomoku play web 风格一致

### 10. 文档

**文件**：`docs/features/notes.md`（按 `docs/templates/new-feature-state-continuity-template.md` 模板写）

- 概述 / 数据模型 / 工具表 / 状态连续性规则 / 排错指引

---

## Assumptions & Decisions

| 假设 | 决策 | 原因 |
|------|------|------|
| 笔记范围 | 学习 + 会议 + 视频 + 读书 + 灵感 + todo | 用户明确"不只学习" |
| 存储 | 本地 `data/notes/<sessionId>.json` | 用户选"本地(单用户)"；与 `agent-self-learning-service` 一致 |
| 不进入 World | 不发到 `world.*` | 用户没要求分享 |
| LLM 后端 | 复用 `createExternalChatProviderFromEnv` | 项目已有；不引入新依赖 |
| 检索 | 复用 `bm25-lite.ts` | 避免引入新检索栈 |
| 复习提醒 | 复用 `ScheduleTaskService` | 已有现成能力 |
| 客户端 | Flutter 必做、Web 可选 | 与项目现有形态对齐 |
| 附件 | v1 不支持图片/文件 | 保持范围最小；字段预留 |
| 权限 | 沙箱即可用 | 无需 desktop/vision 权限 |

---

## Verification Steps

1. **构建**
   - `npm run build --prefix agent-world`
   - `npm run build --prefix server`
2. **类型检查**：`npx tsc --noEmit -p server/tsconfig.json`
3. **启动服务**：`npm run dev:stack`，确认无启动错误，`/notes` 返回 200
4. **HTTP 冒烟**（curl 或 REST 客户端）：
   - 创建一条 `category=meeting` 笔记 → 201
   - `GET /notes?sessionId=...&category=meeting` 包含该条
   - `POST /notes/search` 关键词命中
   - `POST /notes/:id/summarize` 拿到 `summary` 字段
   - `POST /notes/:id/quiz` 拿到 `quiz` 数组
   - `POST /notes/:id/schedule-review` → 紧接着 `GET /schedule/tasks` 看到对应任务
5. **Agent 端到端**：
   - 在 chat 发送 "帮我记一下今天学的 transformer self-attention" → 工具调用日志出现 `notes.create`
   - 发送 "出 3 道题考我" → 出现 `notes.quiz`
   - 发送 "明早 9 点提醒我复习" → 出现 `notes.schedule_review` + `schedule` 工具链
6. **状态连续性回归**：连续 3 次"再记一下刚才那个" → 应先 `notes.search` 命中已存在笔记并 `update`，不重复 `create`
7. **Flutter**：进入 notes 页面，列表显示刚才创建的笔记，点击详情可见 `summary`/`quiz`
