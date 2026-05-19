# 关怀提醒功能使用指南

## 📅 功能概述

关怀提醒功能允许用户记录重要日期（生日、纪念日等），并自动在日程服务中创建每年重复的提醒任务。提醒会在日期前一天早上8点触发，帮助用户及时送上祝福。

## 🎯 核心特性

- ✅ **自然对话设置**：通过对话即可添加重要日期
- ✅ **自动创建提醒**：系统自动在日程中创建周期性提醒任务
- ✅ **个性化提醒消息**：根据关系和类型生成温馨的提醒文案
- ✅ **持久化存储**：数据保存在用户记忆中，跨会话可用
- ✅ **灵活管理**：支持查看、删除已记录的重要日期

## 🔧 可用工具

### 1. `care.set_important_date` - 设置重要日期

**用途**：记录生日、纪念日等重要日期，并自动创建提醒任务

**参数**：
- `name` (必填): 人物或事件名称，如"妈妈"、"结婚纪念日"
- `date` (必填): 日期，格式为 `YYYY-MM-DD` 或 `MM-DD`
- `type` (可选): 类型，可选值：`birthday`（默认）、`anniversary`、`custom`
- `relationship` (可选): 关系描述，如"母亲"、"配偶"
- `year` (可选): 出生年份（用于计算年龄）
- `notes` (可选): 备注信息

**示例**：

```javascript
// 设置妈妈的生日
await toolRegistry.execute("care.set_important_date", {
  name: "妈妈",
  date: "1970-05-20",
  type: "birthday",
  relationship: "母亲",
}, context);

// 返回：
{
  ok: true,
  importantDate: {
    id: "uuid...",
    name: "妈妈",
    date: "05-20",
    year: 1970,
    type: "birthday",
    relationship: "母亲"
  },
  reminderTask: {
    taskId: "task-uuid...",
    nextRunAt: "2026-05-19T08:00:00.000Z"
  },
  message: "已记录\"妈妈\"的生日（05-20），并设置了每年提前1天的提醒"
}
```

### 2. `care.get_important_dates` - 获取所有重要日期

**用途**：查看已记录的所有重要日期列表

**参数**：无

**示例**：

```javascript
const result = await toolRegistry.execute("care.get_important_dates", {}, context);

// 返回：
{
  ok: true,
  count: 3,
  importantDates: [
    {
      id: "uuid-1",
      name: "爸爸",
      date: "08-15",
      year: 1968,
      type: "birthday",
      relationship: "父亲"
    },
    {
      id: "uuid-2",
      name: "结婚纪念日",
      date: "06-15",
      type: "anniversary",
      relationship: "配偶"
    }
  ]
}
```

### 3. `care.delete_important_date` - 删除重要日期

**用途**：删除不再需要的重要日期记录

**参数**：
- `id` (必填): 要删除的重要日期 ID

**示例**：

```javascript
await toolRegistry.execute("care.delete_important_date", {
  id: "uuid-123",
}, context);

// 返回：
{
  ok: true,
  deletedDate: { ... },
  message: "已删除\"测试日期\"的重要日期记录"
}
```

## 💬 对话示例

用户可以通过自然对话与 Agent 交互：

**场景 1：设置生日**
```
用户：我想让 Agent 记得我妈妈的生日
Agent：好的，您妈妈的生日是哪天呢？
用户：5月20日
Agent：明白了，是每年5月20日对吗？需要我在那天早上提醒您送上祝福吗？
用户：是的
Agent：✅ 已记录"妈妈"的生日（05-20），并设置了每年提前1天的提醒
```

**场景 2：查看所有重要日期**
```
用户：我都记录了哪些重要日期？
Agent：您当前记录了以下重要日期：
       1. 爸爸的生日 - 08-15
       2. 结婚纪念日 - 06-15
       3. 好朋友小明的生日 - 12-25
```

**场景 3：删除日期**
```
用户：删除小明的生日记录
Agent：✅ 已删除"好朋友小明"的重要日期记录
```

## ⚙️ 技术实现细节

### 数据存储
- 重要日期列表存储在 `AgentMemorySyncService` 的 `important_dates` 键中
- 每个日期包含：id、name、date (MM-DD)、year (可选)、type、relationship、notes

### 提醒任务
- 自动在 `ScheduleTaskService` 中创建提醒任务
- 提醒时间：日期前一天早上 8:00（Asia/Shanghai 时区）
- 提醒消息根据类型自动生成：
  - 生日：`明天是XXX（母亲）的生日（即将XX岁）！别忘了送上祝福哦 🎂`
  - 纪念日：`明天是XXX（配偶）纪念日！准备好庆祝了吗？🎉`
  - 自定义：`明天是XXX！记得关注这个特殊的日子 ✨`

### 周期性提醒
- 当前版本创建的是单次提醒任务
- 未来可扩展支持 `recurrence: "yearly"` 实现真正的年度循环

## 🧪 测试

运行测试验证功能：

```bash
cd server
npm test -- care-reminder-tools.test.ts
```

测试覆盖：
- ✅ 设置生日并自动创建提醒任务
- ✅ 设置纪念日
- ✅ 获取所有重要日期（按日期排序）
- ✅ 拒绝无效的日期格式
- ✅ 创建的提醒任务正确存在于日程服务中

## 📝 注意事项

1. **日期格式**：支持 `YYYY-MM-DD`（如 1970-05-20）或 `MM-DD`（如 05-20）
2. **时区**：提醒时间基于 Asia/Shanghai 时区
3. **提醒时机**：目前设置为日期前一天早上8点，可根据需求调整
4. **数据隔离**：每个用户（sessionId/userId）的重要日期独立存储

## 🚀 未来扩展方向

- [ ] 支持多种提醒时间选择（当天早上、前一天晚上等）
- [ ] 支持真正的年度循环提醒（`recurrence: "yearly"`）
- [ ] 集成祝福模板库，提供更多样化的祝福语
- [ ] 支持农历日期
- [ ] 前端 UI 界面，可视化管理重要日期
- [ ] 提醒时的推送通知优化
