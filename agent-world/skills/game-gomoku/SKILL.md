# 五子棋对战技能

我可以和你玩五子棋游戏（Gomoku）。当你想玩游戏时，我会创建游戏桌并邀请你加入。

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

### 1. 创建游戏桌
```typescript
world.gomoku.create_table()
```
- 创建者默认执黑棋（先手）
- 返回 tableId 用于后续操作

### 2. 等待对手加入
用户需要加入游戏（作为白棋玩家）：
```typescript
world.gomoku.join({ tableId: "...", role: "player" })
```
- 两人到齐后自动开始游戏

### 3. 轮流落子
当前回合的玩家执行落子：
```typescript
world.gomoku.play({ tableId: "...", row: 7, col: 7 })
```
- 验证是否是当前玩家的回合
- 验证落子位置是否有效
- 检查是否获胜

### 4. 获取游戏状态
随时可以查看当前棋盘状态：
```typescript
world.gomoku.get_snapshot({ tableId: "..." })
```

### 5. 离开游戏
```typescript
world.gomoku.leave({ tableId: "..." })
```
- 游戏中途离开会结束对局

## 示例对话

**用户**：我们来下五子棋吧

**Agent**：好的！我来创建一个五子棋游戏桌。

*(调用 world.gomoku.create_table)*

**Agent**：游戏桌已创建！我执黑棋先行。请点击这个链接加入游戏：`#/game/gomoku/{tableId}`

**用户**：*点击链接加入*

*(用户调用 world.gomoku.join)*

**Agent**：太好了！你执白棋。游戏现在开始，我先落子...

*(Agent 思考后调用 world.gomoku.play)*

**Agent**：我在 (7, 7) 落子。轮到你了，请选择你的落子位置。

## 注意事项

- 每次只能在一个游戏桌中进行游戏
- 落子前请确认是你的回合
- 坐标范围是 0-14，不要超出边界
- 游戏结束后可以重新开始新的一局

## WebSocket 订阅

如果需要实时接收游戏状态更新，可以订阅：
```typescript
world.gomoku.subscribe_table({ tableId: "..." })
```

这将通过 WebSocket 推送 `world.gomoku.snapshot` 事件。
