# 钱包管理技能

## 概述

这个技能让 Agent 能够管理用户的钱包，包括查询余额、执行转账、查看交易记录等操作。所有操作都会自动记录在案，用户和 Agent 都可以随时查看。

## 可用工具

### 1. wallet.get_balance - 查询余额

查询当前会话的钱包余额。

**参数：**
- 无

**返回：**
```json
{
  "summary": "查询成功",
  "balance": 1000.00,
  "currency": "CNY",
  "actorId": "user_session_id"
}
```

**使用示例：**
```
用户：我还有多少钱？
Agent：让我查询一下您的余额...
[调用 wallet.get_balance]
Agent：您当前的余额是 ¥1000.00
```

---

### 2. wallet.transfer - 执行转账

向其他 Agent 或用户转账。

**参数：**
- `recipientId` (必需): 收款人的 ID 或会话ID
- `amount` (必需): 转账金额（必须大于0）
- `remark` (可选): 转账备注说明

**返回：**
```json
{
  "summary": "转账成功",
  "transactionId": "tx_1234567890_abc123",
  "recipientId": "agent_b_session",
  "amount": 100.00,
  "previousBalance": 1000.00,
  "currentBalance": 900.00,
  "remark": "项目协作费用",
  "createdAt": "2024-01-15T10:30:00.000Z",
  "message": "已成功转账 ¥100.00 给 agent_b_session"
}
```

**错误情况：**
- 余额不足：`余额不足，当前余额：¥100.00，需要：¥200.00`
- 缺少收款人：`缺少收款人ID (recipientId)`
- 金额无效：`转账金额必须大于0`

**使用示例：**
```
用户：给 Agent-A 转 500 元，备注"项目费用"
Agent：好的，我将为您转账 ¥500.00 给 Agent-A
[调用 wallet.transfer，参数：{recipientId: "agent_a", amount: 500, remark: "项目费用"}]
Agent：转账成功！已转账 ¥500.00 给 Agent-A，当前余额 ¥500.00
```

---

### 3. wallet.get_transactions - 查询交易记录

查询历史交易记录，支持分页和类型过滤。

**参数：**
- `limit` (可选): 返回记录数量，默认 20
- `offset` (可选): 偏移量，默认 0
- `type` (可选): 交易类型过滤
  - `"all"`: 全部（默认）
  - `"income"`: 收入
  - `"expense"`: 支出
  - `"transfer"`: 转账

**返回：**
```json
{
  "summary": "查询成功",
  "total": 5,
  "limit": 20,
  "offset": 0,
  "transactions": [
    {
      "id": "tx_001",
      "type": "transfer",
      "title": "转账给 agent_a",
      "amount": -500.00,
      "balance": 500.00,
      "createdAt": "2024-01-15T10:30:00.000Z",
      "recipient": "agent_a",
      "remark": "项目费用",
      "status": "completed"
    }
  ],
  "actorId": "user_session_id"
}
```

**使用示例：**
```
用户：显示我最近的交易记录
Agent：让我查询您的交易记录...
[调用 wallet.get_transactions，参数：{limit: 10}]
Agent：您最近有 5 笔交易：
1. 转账给 agent_a: -¥500.00 (余额: ¥500.00)
2. 充值: +¥1000.00 (余额: ¥1000.00)
...
```

---

### 4. wallet.recharge - 充值（测试用）

为钱包充值，主要用于测试场景。

**参数：**
- `amount` (必需): 充值金额（必须大于0）

**返回：**
```json
{
  "summary": "充值成功",
  "transactionId": "tx_1234567890_xyz789",
  "amount": 1000.00,
  "previousBalance": 500.00,
  "currentBalance": 1500.00,
  "message": "已成功充值 ¥1000.00"
}
```

**使用示例：**
```
用户：给我的账户充值 1000 元
Agent：好的，正在为您充值...
[调用 wallet.recharge，参数：{amount: 1000}]
Agent：充值成功！已充值 ¥1000.00，当前余额 ¥1500.00
```

---

## 最佳实践

### 1. 转账前确认

在执行转账前，应该向用户确认关键信息：

```javascript
// 推荐的做法
用户：给 Bob 转 200 元
Agent：我将为您转账 ¥200.00 给 Bob，请确认是否正确？
用户：确认
Agent：[执行转账]
```

### 2. 检查余额

转账前系统会自动检查余额，但 Agent 可以主动提示：

```javascript
用户：转 2000 元给 Alice
Agent：[尝试转账]
// 如果余额不足，系统会返回错误
Agent：抱歉，您的余额不足。当前余额 ¥1000.00，需要 ¥2000.00
```

### 3. 提供交易详情

完成操作后，提供清晰的反馈：

```javascript
Agent：转账已完成！
- 收款人：Alice
- 金额：¥500.00
- 备注：午餐费用
- 当前余额：¥500.00
- 交易ID：tx_1234567890_abc
```

### 4. 查询时合理分页

查询大量交易时使用分页：

```javascript
// 首次查询最近10条
wallet.get_transactions({ limit: 10 })

// 如果需要更多，继续查询
wallet.get_transactions({ limit: 10, offset: 10 })
```

---

## 安全注意事项

1. **金额验证**：所有金额必须大于0
2. **余额检查**：系统会自动检查余额是否充足
3. **交易记录**：每笔交易都会永久记录，包括：
   - 交易ID
   - 交易类型
   - 金额
   - 时间戳
   - 收款人（如果是转账）
   - 备注
   - 交易状态

4. **不可撤销**：转账一旦完成无法撤销，请在执行前仔细确认

---

## 常见场景

### 场景1：日常转账
```
用户：我想给同事转 100 元吃饭钱
Agent：好的，请告诉我同事的 ID
用户：colleague_123
Agent：将转账 ¥100.00 给 colleague_123，备注"吃饭钱"，确认吗？
用户：确认
Agent：[执行转账] 转账成功！
```

### 场景2：查询消费
```
用户：我今天花了多少钱？
Agent：让我查询今天的交易记录...
[调用 wallet.get_transactions，然后过滤今天的记录]
Agent：今天您共有 3 笔支出，总计 ¥150.00
```

### 场景3：余额不足
```
用户：转 5000 元给供应商
Agent：[尝试转账]
Agent：抱歉，余额不足。当前余额 ¥1000.00，需要 ¥5000.00
建议：您可以先充值，或者减少转账金额
```

---

## 技术细节

- **数据存储**：当前使用内存存储，重启后会重置（生产环境应使用数据库）
- **交易ID格式**：`tx_{timestamp}_{random}`
- **时间格式**：ISO 8601 (`2024-01-15T10:30:00.000Z`)
- **金额精度**：保留两位小数
- **货币单位**：人民币 (CNY)
