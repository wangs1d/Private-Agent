# 智能分析提醒系统使用示例

## 系统概述

智能分析提醒系统提供三种提醒方式，并支持智能升级机制：

1. **弹窗文字提醒 (popup)** - 基础级别，显示简洁弹窗
2. **闹钟TTS提醒 (tts_alarm)** - 中等级别，语音播报+渐强音量
3. **电话呼叫提醒 (phone_call)** - 最高级别，双向交互确保接收

## 快速开始

### 1. 初始化系统

```typescript
import { createIntelligentReminderSystem } from "./services/intelligent-reminder/index.js";

const reminderSystem = createIntelligentReminderSystem({
  toolRegistry: registry,
  sendToClient: async (userId, payload) => {
    // 发送到客户端 WebSocket
    ws.sendToUser(userId, payload);
  },
  synthesizeSpeech: async ({ text, voiceId, speed }) => {
    // 调用 TTS 服务合成语音
    return await ttsService.synthesize(text, { voiceId, speed });
  },
  playAudio: async (userId, audioBuffer, volume) => {
    // 在客户端播放音频
    await audioService.play(userId, audioBuffer, volume);
  },
  initiatePhoneCall: async ({ userId, transcript, waitForResponse }) => {
    // 发起电话呼叫
    return await phoneService.call(userId, transcript, waitForResponse);
  },
  playAudioInCall: async (callId, audio) => {
    // 在通话中播放音频
    await phoneService.playAudio(callId, audio);
  },
  recognizeSpeech: async (callId, durationMs) => {
    // 识别用户语音输入
    return await speechRecognitionService.recognize(callId, durationMs);
  },
  hangupCall: async (callId) => {
    // 挂断电话
    await phoneService.hangup(callId);
  },
});

const { reminderService } = reminderSystem;
```

### 2. 创建基础弹窗提醒

```typescript
// 通过工具调用（Agent 使用）
await toolExecutor.execute("reminder.create", {
  title: "会议提醒",
  message: "您有一个会议将在 10 分钟后开始",
  priority: "medium",
  initialLevel: "popup",
  metadata: { userId: "user_123" }
});
```

### 3. 创建 TTS 闹钟提醒（带渐强音量）

```typescript
await toolExecutor.execute("reminder.create", {
  title: "重要截止日期",
  message: "注意！项目报告提交截止时间还剩 1 小时",
  priority: "high",
  initialLevel: "tts_alarm",
  ttsConfig: {
    volumeStart: 0.3,
    volumeEnd: 1.0,
    rampUpDurationMs: 10000,
    repeatIntervalMs: 15000,
    voiceId: "zh-CN-WomanNeural",
    speed: 1.1
  },
  metadata: { userId: "user_123" }
});
```

### 4. 创建电话呼叫提醒（双向交互）

```typescript
await toolExecutor.execute("reminder.create", {
  title: "紧急通知",
  message: "紧急提醒：您的账户存在异常登录，请立即处理",
  priority: "urgent",
  initialLevel: "phone_call",
  phoneConfig: {
    waitForResponse: true,
    maxRingDurationSec: 300,
    allowUserInput: true,
    disconnectCommand: ["退下", "知道了", "收到"],
    retryOnNoAnswer: true,
    retryCount: 2
  },
  metadata: { userId: "user_123" }
});
```

### 5. 智能级别选择（自动推荐）

```typescript
// 让系统根据用户历史响应数据推荐最佳级别
await toolExecutor.execute("reminder.create", {
  title: "智能提醒测试",
  message: "这是一条智能级别选择的提醒",
  priority: "high",
  initialLevel: "auto",  // 自动选择最佳级别
  metadata: { userId: "user_123" }
});
```

## 升级机制说明

### 默认升级规则

系统默认配置以下升级路径：

1. **popup → tts_alarm**：30秒无响应后升级
2. **tts_alarm → phone_call**：60秒无响应后升级

### 自定义升级规则

```typescript
// 自定义升级规则
reminderService.setEscalationRules([
  {
    fromLevel: "popup",
    toLevel: "tts_alarm",
    triggerCondition: "timeout",
    timeoutMs: 20_000,  // 20秒后升级
  },
  {
    fromLevel: "tts_alarm",
    toLevel: "phone_call",
    triggerCondition: "timeout",
    timeoutMs: 45_000,  // 45秒后升级
    maxEscalations: 2   // 最多升级2次
  }
]);
```

### 手动触发升级

```typescript
// 手动升级提醒
await toolExecutor.execute("reminder.escalate", {
  reminderId: "uuid-xxx",
  reason: "用户长时间未响应"
});
```

## 用户响应处理

### 确认提醒

```typescript
// 用户点击确认或回应
await toolExecutor.execute("reminder.acknowledge", {
  reminderId: "uuid-xxx"
});
```

### 取消提醒

```typescript
// 取消未完成的提醒
await toolExecutor.execute("reminder.cancel", {
  reminderId: "uuid-xxx"
});
```

## 查询功能

### 获取提醒状态

```typescript
const result = await toolExecutor.execute("reminder.get_status", {
  reminderId: "uuid-xxx"
});
/*
返回：
{
  ok: true,
  reminder: {
    id: "uuid-xxx",
    title: "会议提醒",
    status: "active",
    currentLevel: "tts_alarm",
    escalationCount: 1,
    createdAt: "2026-05-27T...",
    startedAt: "2026-05-27T..."
  }
}
*/
```

### 列出所有活跃提醒

```typescript
const result = await toolExecutor.execute("reminder.list_active", {});
/*
返回：
{
  ok: true,
  count: 3,
  reminders: [
    { id: "...", title: "...", status: "active", currentLevel: "popup" },
    ...
  ]
}
*/
```

## 高级场景示例

### 场景1：重要日期关怀提醒

```typescript
// 结合 care-reminder-tools 的重要日期功能
async function createBirthdayReminder(userName: string, relationship: string) {
  await toolExecutor.execute("care.set_important_date", {
    name: userName,
    date: "1990-06-15",
    type: "birthday",
    relationship: relationship
  });

  // 同时创建一个强化的提醒
  await toolExecutor.execute("reminder.create", {
    title: `🎂 ${userName}的生日提醒`,
    message: `明天是${relationship}${userName}的生日！别忘了准备祝福和礼物哦`,
    priority: "high",
    initialLevel: "tts_alarm",
    ttsConfig: {
      volumeStart: 0.5,
      volumeEnd: 1.0,
      rampUpDurationMs: 8000,
      repeatIntervalMs: 20000
    },
    scheduledAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
  });
}
```

### 场景2：紧急事件多级升级

```typescript
async function createUrgentEscalatingReminder(eventDescription: string) {
  const instance = await toolExecutor.execute("reminder.create", {
    title: "⚠️ 紧急事件",
    message: eventDescription,
    priority: "urgent",
    initialLevel: "popup",  // 从最低级开始
    maxLevel: "phone_call", // 最高可升级到电话
    popupConfig: {
      autoCloseAfterMs: 15000,  // 15秒后自动关闭
      position: "center"
    }
  });

  console.log(`创建提醒 ${instance.reminderId}，将按需自动升级`);
  
  // 系统会自动在30秒后升级到 TTS，再过60秒升级到电话
}
```

### 场景3：定时批量提醒

```typescript
async function scheduleBatchReminders(tasks: Array<{
  title: string;
  message: string;
  scheduledTime: Date;
  priority: "low" | "medium" | "high" | "urgent";
}>) {
  for (const task of tasks) {
    await toolExecutor.execute("reminder.create", {
      ...task,
      initialLevel: "auto",  // 智能选择
      scheduledAt: task.scheduledTime.toISOString(),
      metadata: { userId: "user_123", batchId: "batch_001" }
    });
  }

  console.log(`已创建 ${tasks.length} 个定时提醒`);
}
```

## 配置参数详解

### PopupReminderConfig

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| showConfirmButton | boolean | true | 是否显示确认按钮 |
| confirmText | string | "我知道了" | 确认按钮文字 |
| autoCloseAfterMs | number | undefined | 自动关闭时间（毫秒） |
| position | string | "center" | 弹窗位置 |

### TTSAlarmConfig

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| volumeStart | number | 0.3 | 初始音量（0-1） |
| volumeEnd | number | 1.0 | 最终音量（0-1） |
| rampUpDurationMs | number | 10000 | 渐强时长（毫秒） |
| repeatIntervalMs | number | 15000 | 重复间隔（毫秒） |
| voiceId | string | undefined | TTS语音ID |
| speed | number | undefined | 语速（0.5-2.0） |

### PhoneCallConfig

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| waitForResponse | boolean | true | 是否等待用户响应 |
| maxRingDurationSec | number | 300 | 最大通话时长（秒） |
| allowUserInput | boolean | true | 允许用户语音输入 |
| disconnectCommand | string[] | ["退下","知道了"] | 挂断命令列表 |
| retryOnNoAnswer | boolean | false | 无应答时重试 |
| retryCount | number | 2 | 最大重试次数 |

## 最佳实践

1. **合理设置优先级**：不是所有提醒都需要电话，low/medium 用 popup 即可
2. **利用智能选择**：使用 `initialLevel: "auto"` 让系统根据历史数据决策
3. **配置超时时间**：根据任务紧迫性调整升级超时
4. **记录用户反馈**：通过 acknowledge 接口记录响应，优化后续策略
5. **避免滥用电话**：phone_call 应仅用于真正紧急的情况

## 注意事项

- 电话功能需要正确配置电话服务集成
- TTS 功能需要可用的语音合成服务
- 所有时间相关参数单位为毫秒（ms）或秒（sec）
- 用户响应数据用于优化升级算法，请确保隐私合规
