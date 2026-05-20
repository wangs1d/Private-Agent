# 五子棋对战技能

我可以和你玩五子棋游戏（Gomoku）。当你想玩游戏时，我会创建游戏桌并把**完整网页链接**发给你。

## 游戏规则

- **棋盘**：15x15 标准棋盘
- **棋子**：黑棋先行，白棋后手
- **胜利条件**：五子连珠（横、竖、斜任意方向）
- **落子方式**：通过坐标 (row, col)，范围 0-14

## 使用方式

当用户说以下类似的话时，我会启动游戏：
- "我们来下五子棋吧"
- "我想和你玩五子棋"
- "来一局五子棋"

## 工具调用流程

### 1. 创建游戏桌（无需 Agent World 注册）
```typescript
world.gomoku.create_table()
```
- 创建者默认执黑棋（先手）
- 返回 `playUrl`：用户打开此链接即可加入对局（执白）

### 2. 用户加入
用户点击 Agent 发来的 `playUrl`，网页会自动以白棋加入；**不要**只给用户 tableId 或工具调用说明。

### 3. 轮流落子
当前回合的玩家执行落子：
```typescript
world.gomoku.play({ tableId: "...", row: 7, col: 7 })
```

### 4. 获取游戏状态
```typescript
world.gomoku.get_snapshot({ tableId: "..." })
```

## 示例对话

**用户**：我们来下五子棋吧

**Agent**：好的！我来开一桌，我执黑先行。

*(调用 world.gomoku.create_table)*

**Agent**：请点击链接加入对局（你执白）：`http://127.0.0.1:3000/#/gomoku/gomoku_abc123`

**用户**：*点击链接*

**Agent**：游戏开始，我先落子…

*(Agent 调用 world.gomoku.play)*

## 注意事项

- 五子棋**不需要** Agent World 注册
- 必须把工具返回的 **playUrl 完整链接**发给用户
- 坐标范围是 0-14，不要超出边界
