# Private AI Agent 优化实施计划

## Summary

基于讨论结果，本次实施涵盖四大优化方向（排除世界点数 credits 入账）：
1. **一起听音乐功能**：Agent 与用户同步听歌，共用播放进度/歌单/控制权（占位音乐源）
2. **贾维斯全能功能**：晨间简报、心情打卡、习惯养成
3. **UI 改版**：横向紧凑悬浮栏 + 用户/Agent 功能分区 + 视觉差异化
4. **流畅度优化**：WS 心跳保活、World 增量推送、Flutter Webview 预热

---

## Current State Analysis

### 架构概览
- **后端世界服务**：`agent-world/services/world-service.ts` 统一管理 `WorldState`，通过 `sceneId` 标记场景（plaza / free_market / social / gomoku / doudizhu / zhajinhua）
- **游戏服务模式**：每个场景独立 Service（如 `doudizhu-service.ts`），通过 `attachWebSocketRegistry` 绑定 WS 推送，状态变更时 `notifyTable/notifyLobby` 推送快照
- **WS 协议**：通用协议在 `server/src/protocol.ts`，World 专有协议在 `agent-world/protocol-world.ts`
- **Agent 球体 UI**：`agent-sphere-avatar/` 下 React 组件，快捷指令定义在 `constants/quick-commands.ts`，菜单渲染在 `OverlayQuickMenu.tsx`
- **Flutter 客户端**：`client/flutter_app/lib/features/world/` 下各场景独立页面，`world_page.dart` 做嵌套路由
- **WS 重连**：`useAgentWebSocket.ts` 已有指数退避重连（BASE=1s, MAX=30s），但无心跳保活

---

## Part 1: 一起听音乐功能

### 设计思路
参考 `doudizhu-service.ts` 的服务模式，新建 `MusicRoomService` 管理"音乐房"：多 session 加入同一房间，共享歌单和播放状态，任一参与者操作（播放/暂停/切歌/进度跳转）同步推送给所有人。音乐源用占位 URL（SoundHelix 免费样本），后续可替换为真实音乐 API。

### 1.1 后端（agent-world）

#### `agent-world/protocol-world.ts`
- `AgentWorldClientEventType` 新增：
  - `WorldMusicSubscribe: "world.music.subscribe"`
  - `WorldMusicUnsubscribe: "world.music.unsubscribe"`
  - `WorldMusicPlay: "world.music.play"` — 播放指定曲目
  - `WorldMusicPause: "world.music.pause"`
  - `WorldMusicNext: "world.music.next"` — 下一首
  - `WorldMusicSeek: "world.music.seek"` — 进度跳转（payload: `{ roomId, positionSec }`）
- `AgentWorldServerEventType` 新增：
  - `WorldMusicSnapshot: "world.music.snapshot"` — 音乐房状态快照（currentTrack, isPlaying, positionSec, playlist, participants）

#### `agent-world/services/music-room-service.ts`（新建）
参考 `doudizhu-service.ts` 结构：
```typescript
export class MusicRoomService {
  private readonly rooms = new Map<string, MusicRoom>();
  private readonly watchers = new Map<string, Set<string>>(); // roomId -> sessionIds
  private wsRegistry: WsConnectionRegistryLike | null = null;

  constructor(private readonly worldService: WorldService) {}

  attachWebSocketRegistry(registry: WsConnectionRegistryLike): void;
  // 房间管理
  createRoom(sessionId: string): { ok: true; room: MusicRoomSummary } | { ok: false; reason: string };
  joinRoom(roomId: string, sessionId: string): { ok: true; snapshot } | { ok: false; reason: string };
  leaveRoom(roomId: string, sessionId: string): { ok: true } | { ok: false; reason: string };
  // 播放控制
  play(roomId: string, sessionId: string, trackId: string): Result;
  pause(roomId: string, sessionId: string): Result;
  next(roomId: string, sessionId: string): Result;
  seek(roomId: string, sessionId: string, positionSec: number): Result;
  // WS 推送
  private notifyRoom(roomId: string): void;
  private sendSnapshotToSession(roomId: string, sessionId: string): void;
  // 快照构建
  private buildSnapshot(room: MusicRoom, viewerSessionId: string): Record<string, unknown>;
}
```

- `MusicRoom` 数据结构：
  ```typescript
  type MusicRoom = {
    id: string;              // mr_<hex>
    createdBy: string;
    participants: Set<string>;
    playlist: MusicTrack[];  // 占位歌单
    currentTrackIndex: number;
    isPlaying: boolean;
    positionSec: number;
    lastUpdatedAt: number;    // 同步基准时间戳
  };
  type MusicTrack = { id: string; title: string; artist: string; url: string; durationSec: number };
  ```
- 占位歌单：预置 5 首 SoundHelix 样本曲目

#### `agent-world/services/world-service.ts`
- 新增 `visitMusicRoom(roomId, actorSessionId?, opts?)` 方法：
  ```typescript
  visitMusicRoom(roomId: string, actorSessionId?: string, opts?: WorldMutationOptions): WorldState {
    // 同 visitSocial 模式：getOrCreateRoom → assertRegistered → assertWritable → sceneId = "music_room" → markWorldMutated
  }
  ```

#### `agent-world/agent-world-chat-tools.ts`
- 新增 `WORLD_MUSIC_CHAT_TOOLS` 工具组：
  - `world.music.create_room` — 创建音乐房
  - `world.music.join_room` — 加入音乐房
  - `world.music.play` — 播放指定曲目
  - `world.music.pause` — 暂停
  - `world.music.next` — 下一首
  - `world.music.get_state` — 获取当前播放状态

#### `agent-world/routes/world-music.ts`（新建）
- `GET /world/music/:roomId/state` — 获取音乐房状态
- `POST /world/music/create` — 创建音乐房
- `POST /world/music/:roomId/join` — 加入
- `POST /world/music/:roomId/leave` — 离开
- `POST /world/music/:roomId/play` — 播放
- `POST /world/music/:roomId/pause` — 暂停
- `POST /world/music/:roomId/next` — 下一首
- `POST /world/music/:roomId/seek` — 进度跳转

#### `agent-world/index.ts`
- 导出 `MusicRoomService` 和 `registerWorldMusicRoutes`、`registerWorldMusicTools`

#### `agent-world/standalone/host.ts`
- 实例化 `MusicRoomService`，`attachWebSocketRegistry`，注册路由和工具
- 在 `registerStandaloneWorldWebSocket` 传入 `musicRoomService`

#### `agent-world/standalone/ws-lite.ts`
- WS 事件处理新增 `world.music.*` 分发到 `MusicRoomService`

#### `agent-world/web/assets/app.js`
- 新增音乐房订阅与渲染（Web 观战页入口）

### 1.2 前端 Web（agent-sphere-avatar）

#### `agent-sphere-avatar/src/constants/quick-commands.ts`
- 新增快捷指令：`{ id: "music", label: "一起听", icon: "🎵", action: "music", category: "shared" }`

#### `agent-sphere-avatar/src/components/MusicRoomPanel.tsx`（新建）
- 迷你播放器面板：当前曲目信息、播放/暂停按钮、上一首/下一首、进度条
- 参与者列表展示
- 通过 `useAgentWebSocket` 接收 `world.music.snapshot` 事件更新状态

#### `agent-sphere-avatar/src/components/OverlayQuickMenu.tsx`
- 接入"一起听"指令，点击后弹出 `MusicRoomPanel`

### 1.3 Flutter 客户端

#### `client/flutter_app/lib/features/world/music_room_page.dart`（新建）
- 音乐房页面：播放器 UI（封面、标题、进度、控制按钮）、参与者列表、歌单列表
- 通过 `WsChatService` 订阅 `world.music.subscribe` 事件
- 通过 `WorldApiClient` 调用 HTTP 接口

#### `client/flutter_app/lib/features/world/world_page.dart`
- 新增路由 `case "/music": child = MusicRoomPage(...)`

#### `client/flutter_app/lib/features/world/world_hub_page.dart`
- 新增音乐场景入口卡片

#### `client/flutter_app/lib/features/world/world_scene_labels.dart`
- 新增 `"music_room": "一起听音乐"`

#### `client/flutter_app/lib/core/services/world_api_client.dart`
- 新增方法：`createMusicRoom / joinMusicRoom / leaveMusicRoom / musicPlay / musicPause / musicNext / musicSeek / getMusicState`

---

## Part 2: 贾维斯全能功能

### 2.1 晨间简报

#### `server/src/services/morning-briefing-service.ts`（新建）
- 聚合数据源：`weather` 路由（天气）、`schedule` 路由（日程）、`notes` 路由（待办）、`agentic-memory`（用户偏好）
- 生成结构化简报：`{ date, weather, todaySchedule, pendingNotes, agentGreeting }`
- 提供方法：`generateBriefing(sessionId): Promise<Briefing>`

#### `server/src/routes/http/morning-briefing.ts`（新建）
- `GET /api/morning-briefing` — 获取当日简报
- 在 `routes/http/index.ts` 注册

#### Flutter 端
- `client/flutter_app/lib/features/chat/morning_briefing_card.dart`（新建）
  - 简报卡片组件：天气、日程、待办、Agent 问候语
  - 在 `chat_page.dart` 或 `jarvis_chat_layout.dart` 中展示

### 2.2 心情打卡

#### `server/src/routes/http/life-signals.ts`（扩展）
- 新增 `POST /api/life-signals/mood-checkin` — 提交心情打卡（mood level, note）
- 新增 `GET /api/life-signals/mood-history` — 查询心情历史

#### `server/src/services/agent-core.ts` 或 companion 服务
- Agent 检测到用户心情低落时主动发起关怀对话（复用 `companion.contact_feedback` 机制）

#### Flutter 端
- `client/flutter_app/lib/features/chat/mood_checkin_widget.dart`（新建）
  - 心情选择器（5 档表情）、备注输入
  - 在聊天页面每日首次进入时弹出

### 2.3 习惯养成

#### `server/src/routes/http/schedule.ts`（扩展）
- 新增 `POST /api/schedule/habit` — 创建习惯任务（type: "habit", frequency, target）
- 新增 `GET /api/schedule/habits` — 查询习惯列表
- 新增 `POST /api/schedule/habit/:id/checkin` — 习惯打卡
- 新增 `GET /api/schedule/habit/:id/streak` — 查询连续打卡天数

#### Flutter 端
- `client/flutter_app/lib/features/schedule/habit_page.dart`（新建）
  - 习惯列表、打卡日历、连续天数展示
  - 在 `schedule_page.dart` 中新增"习惯"Tab

---

## Part 3: UI 改版

### 3.1 横向紧凑悬浮栏

#### `agent-sphere-avatar/src/constants/quick-commands.ts`
- `QuickCommand` 接口新增 `category: "user" | "agent" | "shared"` 字段
- `OVERLAY_QUICK_COMMANDS` 拆分为两组：
  - 用户操作组（`category: "user"`）：天气、日程、习惯
  - Agent 专属组（`category: "agent"`）：智能家居、游戏、一起听
  - 共享组（`category: "shared"`）：语音输入

#### `agent-sphere-avatar/src/components/OverlayQuickMenu.tsx`
- 将 `overlay-quick-menu__grid` 从 CSS Grid 改为横向 Flex 布局
- 按分组渲染：用户操作区 | 分隔线 | Agent 专属区
- 紧凑模式：图标 + 标签横向排列，减少纵向占用

#### `agent-sphere-avatar/src/modes/modes.css`
- `.overlay-quick-menu__grid` 改为 `display: flex; flex-direction: row; gap: 8px;`
- 新增 `.overlay-quick-menu__divider` 分组分隔样式
- 紧凑宽度适配悬浮球形态

### 3.2 视觉差异化

#### `agent-sphere-avatar/src/hooks/useLivingMotion.ts`
- 丰富待机动画：新增"呼吸"节奏变化、随机微转头、眨眼频率变化
- 增加情绪映射：不同 mood 对应不同待机姿态

#### `agent-sphere-avatar/src/components/DG2RobotModel.tsx`
- 空闲态增加微表情：嘴角微动、屏幕闪烁模式

#### `agent-sphere-avatar/src/components/ScreenFace.tsx`
- OLED 屏幕增加动态壁纸效果（音乐播放时显示音波动画）

---

## Part 4: 流畅度优化

### 4.1 WS 心跳保活

#### `agent-sphere-avatar/src/hooks/useAgentWebSocket.ts`
- 新增心跳机制：
  ```typescript
  const HEARTBEAT_INTERVAL_MS = 25000;
  const HEARTBEAT_TIMEOUT_MS = 10000;
  // 定时发送 { type: "ping" }，收到 { type: "pong" } 后重置超时计时器
  // 超时未收到 pong → 触发 scheduleReconnect()
  ```
- `connect()` 中启动心跳定时器，`close` 时清除

#### `agent-world/deps/services/ws-connection-registry.ts`
- 响应 `ping` 事件，回复 `pong`
- 可选：服务端主动心跳检测，超时清理僵尸连接

#### `server/src/protocol.ts`
- 新增 `Ping: "ping"` 和 `Pong: "pong"` 事件常量

### 4.2 World 增量推送

#### `agent-world/services/world-service.ts`
- `emitWorldRevision` 方法当前推送全量 `state`，改为：
  - 保留全量推送（向后兼容，用于首次 attach）
  - 新增 `emitWorldDelta(roomId, changes)` — 仅推送变更字段
- `WorldRevisionEvent` 增加 `changes?: Partial<WorldState>` 字段

#### `agent-world/protocol-world.ts`
- `WorldPartitionDelta` 当前注释为"v0.1与snapshot载荷相同"，实现真正的增量：
  - payload 结构改为 `{ partitionId, revision, changes: { sceneId?, agentWorldCredits?, ... } }`
  - 客户端收到后 merge 到本地状态

#### `agent-world/standalone/host.ts`
- `onWorldRevision` 回调中，根据 `changes` 是否存在决定全量或增量推送

### 4.3 Flutter Webview 预热

#### `client/flutter_app/lib/features/chat/agent_sphere_webview_impl.dart`
- 新增 Webview 预热池：
  ```dart
  // 应用启动时预创建一个隐藏的 WebView 实例
  // 需要展示球体时直接复用预热实例，避免冷启动
  ```
- 预加载球体资源（模型、纹理）

---

## Assumptions & Decisions

1. **音乐源**：使用占位 URL（SoundHelix 免费样本），不接入真实音乐 API，后续可替换
2. **不做 credits 入账**：音乐功能不涉及世界点数增减
3. **增量推送向后兼容**：客户端未升级时仍接收全量快照，不影响现有功能
4. **心跳协议简单化**：ping/pong 为轻量 JSON，不增加显著带宽
5. **UI 横向布局**：同时适配 overlay 模式（悬浮）和 embed 模式（内嵌）
6. **占位歌单**：5 首 SoundHelix 样本，每首约 3-5 分钟，覆盖不同风格

---

## Verification Steps

### 编译验证
1. `cd agent-world && npm run build` — TypeScript 编译无错误
2. `cd agent-sphere-avatar && npm run build` — React 组件编译无错误
3. `cd client/flutter_app && flutter analyze` — Dart 静态分析无错误

### 功能验证
1. **一起听音乐**：
   - 启动 standalone：`npm run agent-world`
   - 创建音乐房 → 加入房间 → 播放 → 暂停 → 切歌 → 进度跳转
   - 两个 session 同时在线，操作同步推送
2. **晨间简报**：调用 `GET /api/morning-briefing` 返回结构化简报
3. **心情打卡**：`POST /api/life-signals/mood-checkin` 存储成功，`GET mood-history` 可查
4. **习惯养成**：创建习惯 → 打卡 → 查询连续天数
5. **UI 横向布局**：悬浮球菜单为横向排列，功能分区可见
6. **WS 心跳**：断网后 25s 内触发重连，恢复后自动连回
7. **增量推送**：场景切换时只推送 changes 字段，非全量 state
