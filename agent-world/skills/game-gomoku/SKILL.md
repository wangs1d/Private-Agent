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

### ⚠️ 状态连续性原则（最重要）
**在任何操作前，必须先检查当前游戏状态！**

```typescript
// 1. 先获取最新快照
world.gomoku.get_snapshot({ tableId: "..." })
// 根据 snapshot.status 和 snapshot.winner 决定下一步：
// - status === "waiting": 等待用户加入
// - status === "playing": 正常落子
// - status === "finished": 游戏已结束，按结束流程处理
```

### 1. 创建游戏桌（无需 Agent World 注册）
```typescript
world.gomoku.create_table({ userColor: "random" }) // black | white | random
```
- `userColor`：用户执子；用户说执黑/先手→`black`，执白/后手→`white`，未说明→`random`
- 返回 `playUrl`：用户打开链接加入对局

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
**返回关键字段：**
- `status`: "waiting" | "playing" | "finished"
- `winner`: "black" | "white" | null（finished 时必有值）
- `currentPlayer`: 当前该谁落子
- `moveCount`: 已落子数

### 5. 游戏结束处理（必须严格遵守！）
当检测到 `snapshot.status === "finished"` 时：

**禁止行为（绝对不要做）：**
- ❌ 再调用 `world.gomoku.play` 落子
- ❌ 直接开新局（除非用户明确要求）
- ❌ 说"让我确认一下棋局状态"（你已经确认了）

**正确流程：**
1. **立即识别结局**：根据 `snapshot.winner` 判断谁赢了
2. **给出得体回应**：
   - 如果 Agent 赢了："哈哈，承让承让！这局下得挺精彩的～"
   - 如果用户输了（Agent赢）："不错不错，进步很大！要不要再来一局？"
   - 如果 Agent 输了："厉害啊！这局你发挥得很好，我输得心服口服 😄"
   - 如果用户赢了（Agent输）："哇，这么快就输了！看来我得再练练 🎯"
3. **等待用户指示**：
   - 用户说"再来一局" → 调用 `create_table` 开新局
   - 用户说其他话题 → 正常对话，不主动提五子棋
   - 用户嘲讽/调侃 → 配合人设自然回应，但**不要再提开新局**

**示例对话（错误示范 ❌）：**
> 用户：我都赢了
> Agent：厉害啊！这么快吗？让我确认一下棋局状态～
> Agent：*(调用 get_snapshot 发现已结束)*
> Agent：棋局开好了，你执白棋（后手）...  *(❌ 错误！未等用户同意就开新局)*

**示例对话（正确示范 ✅）：**
> 用户：我都赢了
> Agent：*(先调用 get_snapshot 确认 status=finished, winner=white)*
> Agent：哈哈，确实是你赢了！这局下得漂亮，有几步棋走得我很被动 👏 要再来一局吗？

## 示例对话

**用户**：我们来下五子棋吧

**Agent**：好的！我来开一桌，我执黑先行。

*(调用 world.gomoku.create_table)*

**Agent**：好的，棋局已开好！你执白棋（后手）。请点击对话中的灰色「进入对局」卡片加入（勿在正文重复粘贴 playUrl）。

（Flutter 客户端会在 App 内嵌棋盘；`/play/gomoku/...` 为浏览器备用入口。）

**用户**：*点击链接*

**Agent**：游戏开始，我先落子…

*(Agent 调用 world.gomoku.play)*

## 注意事项

- 五子棋**不需要** Agent World 注册
- 必须把工具返回的 **playUrl 完整链接**发给用户
- 坐标范围是 0-14，不要超出边界
- **⚠️ 状态连续性（最重要）：**
  - 收到用户任何关于五子棋的消息时，**必须先调用 `get_snapshot` 检查当前状态**
  - 绝对不能凭记忆或用户文字判断游戏状态（用户可能记错、调侃、或测试你）
  - 游戏结束后，**禁止擅自开新局**，必须等用户明确要求
  - 示例错误：用户说"我都赢了" → Agent直接回应并开新局（❌ 未验证状态）
  - 示例正确：用户说"我都赢了" → Agent先调用get_snapshot → 发现确实finished → 得体回应结局（✅）
