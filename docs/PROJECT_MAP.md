# 项目地图

这份文档专门回答 4 个问题：

1. 这个仓库到底有哪些子系统
2. 功能、skill、tool、service 分别放哪
3. 新功能应该加到哪里
4. 哪些目录是主线，哪些更像产物、预览或桥接

## 一、顶层目录怎么理解

### 主线目录

| 目录 | 角色 | 说明 |
| --- | --- | --- |
| `server/` | 主服务端 | Agent 主流程、工具注册、skills、接口层 |
| `client/flutter_app/` | 主客户端 | Flutter 桌面客户端 |
| `agent-world/` | 独立世界模块 | World 状态、世界工具、独立 host |
| `agent-sphere-avatar/` | 形象层 | 3D 球体 Agent、嵌入页、悬浮组件 |
| `desktop-visual/` | 桌面视觉桥 | 视觉理解、桌面自动化、OCR / VLM 相关 |

### 扩展 / 桥接目录

| 目录 | 角色 | 说明 |
| --- | --- | --- |
| `openclaw-plugins/` | 外部插件 | 比如微信桥接插件 |
| `sphere-overlay-py/` | 桌面悬浮层 | PySide6 / overlay 相关 |
| `scripts/` | 根级脚本 | 启动、端口释放、桥接安装等 |
| `docs/` | 说明文档 | 设计、模板、开发说明 |

### 预览 / 产物 / 临时性质较强

| 目录 / 文件 | 建议理解 |
| --- | --- |
| `windows_dist/` | 打包产物 |
| `docs/design-drafts/private-agent-ui-optimized/` | UI 设计稿 / 页面草案（已归档至 docs/design-drafts/，含 flutter-app-ui/） |
| `*.html` 顶层预览页 | 独立预览，不一定是正式入口 |
| `.uploads/` `data/` | 运行数据 / 上传内容 |

## 二、服务端最重要的分层

`server/` 是整个项目最容易“看起来很乱”的地方，但其实可以按下面理解：

### 1. 对话与 Agent 主流程

目录：

- `server/src/agent/`
- `server/src/bootstrap/`
- `server/src/external-model/`

职责：

- 组装 prompt
- 处理 turn 生命周期
- 决定工具怎么选、怎么调
- 管理 access mode、多 Agent、记忆等

### 2. 接口入口层

目录：

- `server/src/routes/http/`
- `server/src/ws/`

职责：

- 对外暴露 HTTP API
- 维护 WebSocket 会话
- 将前端请求接入 Agent 主流程

### 3. 能力暴露层

目录：

- `server/src/tools/`
- `server/src/skills/`

区别：

- `tools/`：内建工具注册与工具 schema，偏系统内置能力
- `skills/`：技能管理、校验、沙箱、装载机制，偏可扩展能力系统

建议记忆方式：

- “要让模型能调用某种能力”先看 `tools/`
- “要把能力做成可管理 skill”再看 `skills/`

### 4. 能力实现层

目录：

- `server/src/services/`

职责：

- 真正执行业务逻辑
- 对接外部系统
- 提供给 tools / routes / agent 使用

原则：

- `tools` 不要堆太多业务细节
- 复杂逻辑尽量下沉到 `services`

## 三、`tools`、`capability modules`、`skills` 的关系

这是当前最容易混淆的部分。

### `server/src/tools/*.ts`

这是传统工具层，通常直接向 `ToolRegistry` 注册工具。

适合放：

- 通用能力
- 基础协议工具
- 较早期的内建工具

### `server/src/tools/capability-modules/`

这是已经开始成型的“按领域收口”的能力层。

每个模块通常包含：

- `chat-tools.ts`
- `handlers.ts`
- `intent.ts`
- `index.ts`

当前已经有的能力域包括：

- `agent-browser`
- `code-sandbox`
- `email-sms`
- `file-doc`
- `finance-deep`
- `health-fitness`
- `image-gen`
- `media-music`
- `shopping-order`
- `social-outreach`

这层的价值是：

- 能力域更清晰
- intent、schema、handler 被放到一起
- 方便后续扩展和工具检索

### `server/src/skills/`

这是 skill 基础设施层，不是简单“工具列表”。

它主要负责：

- skill 类型定义
- skill 校验
- skill 沙箱
- skill 管理与装载
- builtin skills 与 community skills 的统一执行入口

你可以把它理解成：

- `tools` 是“模型可调用的能力”
- `skills` 是“能力的管理系统”

## 四、现在推荐的新增功能落点

### 场景 A：新增一个普通业务能力

优先考虑：

1. 在 `server/src/services/` 写实现
2. 在 `server/src/tools/capability-modules/` 新增或归入某个能力域
3. 只在确实需要时再暴露到 `routes/http/`

### 场景 B：新增一个可复用、可装载的技能

优先考虑：

1. 放到 `server/src/skills/`
2. 如果是内建能力，再看是否要同时提供 `tools` 暴露

### 场景 C：新增 UI 页面

先区分清楚：

- 正式客户端页面：`client/flutter_app/lib/features/`
- 3D / 悬浮球界面：`agent-sphere-avatar/src/`
- 单独视觉预览页：尽量不要再直接堆到根目录

## 五、我建议你以后这样看文件

### 想找“功能入口”

先看：

- [server/src/bootstrap/create-app-services.ts](/E:/ws-project/Private-Agent/server/src/bootstrap/create-app-services.ts)
- [server/src/tools/tool-registry.ts](/E:/ws-project/Private-Agent/server/src/tools/tool-registry.ts)
- [server/src/tools/capability-modules/index.ts](/E:/ws-project/Private-Agent/server/src/tools/capability-modules/index.ts)

### 想找“某个能力到底怎么实现”

顺序建议：

1. `server/src/tools/...`
2. `server/src/services/...`
3. `server/src/routes/http/...` 或 `server/src/ws/...`

### 想找“前端正式页面”

先看：

- `client/flutter_app/lib/features/`
- `client/flutter_app/lib/core/`

不要先从根目录的 HTML 预览页开始。

## 六、当前仓库整理建议

### 低风险、立刻值得做

- 保持根 README 只做导航，不再放模板内容
- 后续把根目录预览 HTML 迁到 `docs/previews/` 或独立 `prototypes/`
- 给 `server/src/tools` 补一份命名约定文档
- 给 `client/flutter_app/lib/features/` 补一份页面地图

### 中期建议

- 继续把零散 `tools/*.ts` 能力往 `capability-modules/` 收
- 明确哪些是正式功能，哪些是实验功能
- 给桥接能力单独建分组，例如 `bridges/` 或 `integrations/`

### 暂时不建议急着动

- 大规模挪目录
- 一次性重命名大量文件
- 在当前存在较多未提交改动时做结构性迁移

原因很简单：现在更适合先把“认知结构”整理清楚，再做物理移动，风险更低。

## 七、一句话版本

如果以后再回来看这个仓库，可以先记住这一句：

`server` 是大脑，`client` 是正式界面，`agent-sphere-avatar` 是形象层，`desktop-visual` 是桌面感知执行层，`agent-world` 是独立世界模块，`skills` 和 `capability-modules` 是能力组织核心。
