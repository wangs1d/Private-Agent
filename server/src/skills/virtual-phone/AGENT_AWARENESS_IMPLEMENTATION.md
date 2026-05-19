# Agent虚拟电话能力感知实现

## 🎯 目标

让Agent在System Prompt中知道自己拥有虚拟电话技能，了解可以做什么，以及如何响应用户请求。

## ✅ 实现的修改

### 1. 修改 `world-agent-capabilities.ts`

**文件**: `server/src/agent/world-agent-capabilities.ts`

**修改内容**:
- 添加 `VirtualPhoneService` 类型导入
- 在 `buildWorldCapabilityPromptSection` 函数中添加可选参数 `virtualPhoneService`
- 根据用户是否已申领虚拟号码，动态生成不同的能力说明

**生成的Prompt示例**:

#### 未申领号码时:
```
【虚拟电话能力】
⚠️ 尚未申领虚拟号码
可用功能：
- virtual_phone.ensure_my_number: 申领6位虚拟电话号码（用户明确要求时才可调用）
- 申领后可与其他Agent进行语音通话
提示：当用户说"帮我申请虚拟号码"时，调用 virtual_phone.ensure_my_number
```

#### 已申领号码时:
```
【虚拟电话能力】
✅ 已申领虚拟号码：123456
可用功能：
- virtual_phone.ensure_my_number: 查询/确认你的虚拟号码
- phone.virtual_call: 拨打其他Agent的虚拟号码进行语音通话
- 可联系其他已配对的Agent，或给自己打电话作为提醒
```

### 2. 修改 `agent-core.ts`

**文件**: `server/src/services/agent-core.ts`

**修改内容**:
- 添加 `VirtualPhoneService` 类型导入
- 在构造函数中添加 `virtualPhoneService` 参数
- 在 `buildStreamOptions` 方法中调用 `buildWorldCapabilityPromptSection` 时传入 `virtualPhoneService`

### 3. 修改 `agent-runtime.ts`

**文件**: `server/src/agent/agent-runtime.ts`

**修改内容**:
- 添加 `VirtualPhoneService` 类型导入
- 在 `AgentCoreDependencies` 类型中添加 `virtualPhoneService` 字段
- 在 `createAgentCore` 函数中传递 `virtualPhoneService` 参数

### 4. 修改 `create-app-services.ts`

**文件**: `server/src/bootstrap/create-app-services.ts`

**修改内容**:
- 在创建 `agentCore` 时传入 `virtualPhoneService` 参数

## 🔄 工作流程

```
用户启动应用
    ↓
create-app-services.ts 初始化所有服务
    ↓
创建 VirtualPhoneService
    ↓
创建 AgentCore 并传入 virtualPhoneService
    ↓
用户发送消息
    ↓
AgentCore.handleUserMessage()
    ↓
buildStreamOptions() 构建系统提示
    ↓
buildWorldCapabilityPromptSection() 
    ↓
查询 VirtualPhoneService.getPhoneForActor(actorId)
    ↓
根据是否已申领号码生成不同的能力说明
    ↓
注入到 System Prompt 的 【虚拟电话能力】部分
    ↓
发送给LLM
    ↓
LLM知道可用的虚拟电话功能
```

## 📝 System Prompt 结构

完整的System Prompt现在包含以下部分：

```
【人格与角色】
...

【价值观与原则】
...

【能力倾向】
...

【Agent World 当前资源与已解锁技能】
世界点数（agentWorldCredits）：当前数值
当前场景 sceneId：场景标识
已解锁社区技能 id：...
当前会话还可使用内置类 Skill（无需购买）：...

【虚拟电话能力】  ← 新增部分
✅ 已申领虚拟号码：123456
可用功能：
- virtual_phone.ensure_my_number: ...
- phone.virtual_call: ...

【相关长期叙事与履历】
...

【持久记忆与偏好】
...

You are a helpful, safe assistant...
```

## ✨ 效果

### 对Agent的影响

1. **明确知道自己的能力**
   - Agent现在清楚地知道有虚拟电话这个功能
   - 知道如何申领号码
   - 知道如何拨打电话
   - 知道何时可以调用这些工具

2. **正确的行为引导**
   - 当用户询问虚拟电话时，Agent会主动介绍功能
   - 当用户想拨打但未申领时，Agent会引导先申领
   - Agent不会在未要求时主动申领号码（遵循安全规则）

3. **上下文感知**
   - 如果用户已有号码，Agent会显示号码并提供拨打选项
   - 如果用户没有号码，Agent会提示申领

### 用户体验改进

**场景1：新用户首次询问**
```
用户：你能做什么？
Agent：我可以帮助您管理虚拟电话！目前您还没有申领虚拟号码。
       如果您想要一个6位数的虚拟号码用于和其他Agent通话，
       可以说"帮我申请虚拟号码"。
```

**场景2：用户想打电话**
```
用户：我想给Alice打电话
Agent：好的，请问Alice的虚拟号码是多少？
       （如果您还没有自己的虚拟号码，需要先申领一个）
```

**场景3：已申领号码的用户**
```
用户：我的号码是多少？
Agent：您的虚拟号码是 123456。
       您可以使用这个号码接收来电，也可以拨打其他Agent的号码。
```

## 🔧 技术细节

### 数据流

1. **查询时机**: 每次用户发送消息时
2. **数据来源**: `VirtualPhoneService.getPhoneForActor(actorId)`
3. **存储位置**: `data/virtual-phones.json`
4. **更新频率**: 实时（申领后立即生效）

### 性能考虑

- ✅ 轻量级查询（Map查找，O(1)复杂度）
- ✅ 仅在需要时构建prompt（isWorldCapsPromptEnabled控制）
- ✅ 不影响其他功能的性能

### 可扩展性

这种设计模式可以轻松扩展到其他能力：
- 日历管理能力
- 联系人管理能力
- 其他通信方式
- ...

## 📊 代码统计

**修改的文件**: 4个
- `world-agent-capabilities.ts`: +20行
- `agent-core.ts`: +8行
- `agent-runtime.ts`: +3行
- `create-app-services.ts`: +1行

**总计**: 约32行代码修改

## 🎓 设计原则

1. **渐进式披露**: 只在需要时才显示能力信息
2. **上下文相关**: 根据用户状态显示不同的提示
3. **安全第一**: 明确标注"用户明确要求时才可调用"
4. **用户友好**: 提供清晰的操作指引和示例

## 🔮 未来优化

1. **更智能的意图识别**: 检测用户隐含的电话需求
2. **快捷操作建议**: 在适当时机主动推荐相关功能
3. **使用统计**: 记录用户对虚拟电话功能的使用情况
4. **个性化提示**: 根据用户习惯调整提示方式

---

**实现时间**: 2026-05-17  
**版本**: 1.0.0  
**状态**: ✅ 已完成并集成
