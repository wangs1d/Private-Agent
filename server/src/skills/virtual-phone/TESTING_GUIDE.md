# 虚拟电话Agent感知功能测试指南

## 🧪 测试步骤

### 1. 启动服务

```bash
cd "e:\W-Project\Private AI Agent\server"
npm run dev
```

### 2. 测试场景

#### 场景A：新用户 - 未申领号码

**测试步骤**:
1. 打开Flutter应用或WebSocket客户端
2. 发送消息："你能做什么？" 或 "你有什么功能？"

**预期结果**:
Agent的System Prompt中应包含：
```
【虚拟电话能力】
⚠️ 尚未申领虚拟号码
可用功能：
- virtual_phone.ensure_my_number: 申领6位虚拟电话号码（用户明确要求时才可调用）
- 申领后可与其他Agent进行语音通话
提示：当用户说"帮我申请虚拟号码"时，调用 virtual_phone.ensure_my_number
```

**Agent应该能够**:
- ✅ 主动介绍虚拟电话功能
- ✅ 引导用户申领号码
- ✅ 解释虚拟电话的用途

**示例对话**:
```
用户：你能打电话吗？
Agent：是的！我有虚拟电话功能。不过您需要先申领一个6位虚拟号码。
       要说"帮我申请虚拟号码"就可以领取您的专属号码了。
       申领后您就可以和其他Agent进行语音通话啦！
```

---

#### 场景B：用户申领号码

**测试步骤**:
1. 发送消息："帮我申请虚拟号码"

**预期结果**:
- Agent调用 `virtual_phone.ensure_my_number` 工具
- 返回6位虚拟号码（如：123456）
- 数据保存到 `data/virtual-phones.json`

**示例对话**:
```
用户：帮我申请虚拟号码
Agent：[调用 virtual_phone.ensure_my_number]
Agent：好的！您的虚拟号码是 123456。
       现在您可以：
       1. 接收其他Agent的来电
       2. 拨打其他Agent的号码
       要拨打电话时，告诉我对方的号码和您想说的话即可。
```

---

#### 场景C：已申领号码 - 查询状态

**测试步骤**:
1. 重启服务（确保从持久化存储加载）
2. 发送消息："我的虚拟号码是多少？"

**预期结果**:
Agent的System Prompt中应包含：
```
【虚拟电话能力】
✅ 已申领虚拟号码：123456
可用功能：
- virtual_phone.ensure_my_number: 查询/确认你的虚拟号码
- phone.virtual_call: 拨打其他Agent的虚拟号码进行语音通话
- 可联系其他已配对的Agent，或给自己打电话作为提醒
```

**Agent应该能够**:
- ✅ 显示用户的虚拟号码
- ✅ 提供拨打功能的说明
- ✅ 知道可以进行语音通话

**示例对话**:
```
用户：我的号码是多少？
Agent：[调用 virtual_phone.ensure_my_number 或 virtual_phone.get_status]
Agent：您的虚拟号码是 123456。
       您可以使用这个号码：
       - 接收其他Agent的来电
       - 拨打其他Agent的号码进行语音通话
       需要我帮您拨打某个号码吗？
```

---

#### 场景D：拨打电话

**测试步骤**:
1. 确保已有虚拟号码
2. 发送消息："拨打 234567，说'晚上见面'"

**预期结果**:
- Agent调用 `phone.virtual_call` 工具
- 向目标号码推送来电事件
- 如果配置了TTS，会生成语音

**示例对话**:
```
用户：拨打 234567，告诉对方晚上7点开会
Agent：[调用 phone.virtual_call]
Agent：已成功拨打 234567！
       对方将听到："晚上7点开会"
       如果对方在线，会立即收到来电通知。
```

---

#### 场景E：给自己打电话（提醒）

**测试步骤**:
1. 发送消息：“提醒我喝水”

**预期结果**:
Agent可以建议给自己打电话作为提醒：

**示例对话**:
```
用户：提醒我每小时喝水
Agent：我可以给您自己打电话作为提醒。
       您的号码是 123456，要现在拨打吗？
       您会收到一个来电，提示“该喝水了”。
       
       或者您也可以设置定时任务来实现自动提醒。
```

---

#### 场景F：联系其他Agent - 对方未申领号码

**测试步骤**:
1. 确保自己已有虚拟号码
2. 发送消息：“我想给Bob打电话”

**预期结果**:
Agent应该从System Prompt中知道：
- 对方也需要有虚拟号码才能接听
- 需要询问用户Bob的号码
- 如果Bob没有号码，需要引导他申领

**示例对话**:
```
用户：我想给Bob打电话
Agent：好的！请问Bob的虚拟号码是多少？

💡 提示：如果Bob还没有虚拟号码，他需要先申领一个。
   请告诉他：“说'帮我申请虚拟号码'就可以领取6位号码”

申领后，您就可以拨打他的号码进行语音通话了。
```

---

#### 场景G：拨打不存在的号码

**测试步骤**:
1. 发送消息：“拨打 999999，说'你好'”

**预期结果**:
- Agent调用 `phone.virtual_call` 工具
- 返回错误：“该号码未注册虚拟线路”
- Agent理解这意味着对方未申领号码
- Agent提供针对性的解决方案

**示例对话**:
```
用户：拨打 999999
Agent：[调用 phone.virtual_call]
Agent：抱歉，号码 999999 尚未注册虚拟线路。

这说明对方还没有申领虚拟号码。要与他通话，需要：
1. 先联系对方（通过其他方式）
2. 让他说“帮我申请虚拟号码”来领取6位号码
3. 拿到他的新号码后，您就可以拨打了

需要我帮您设置一个提醒，等对方申领号码后再通知您吗？
```

---

#### 场景H：配对要求的解释

**测试步骤**:
1. 尝试拨打其他Agent的号码（在未配对的情况下）

**预期结果**:
- 返回错误：“拨打其他 Agent 需先配对”
- Agent理解这是跨Agent通信的安全机制
- Agent解释配对流程

**示例对话**:
```
用户：为什么拨打失败？
Agent：拨打失败是因为需要配对验证。

这是为了保护隐私和安全，不同Agent之间通话需要先配对：
1. 您和对方需要使用相同的配对码
2. 双方都执行配对操作：POST /agent/pair
3. 配对成功后即可互相拨打

如果您是在开发环境，可以联系管理员关闭配对要求。
需要我帮您生成一个配对码吗？
```

---

### 3. 验证System Prompt

#### 方法1：查看日志

在服务器日志中搜索 `worldCaps` 或 `虚拟电话能力`，应该能看到生成的prompt内容。

#### 方法2：调试模式

在 `agent-core.ts` 中添加临时日志：

```typescript
console.log("World Caps Prompt:", worldCaps);
```

#### 方法3：直接询问Agent

```
用户：你知道你有虚拟电话功能吗？
Agent：是的，我知道！我有虚拟电话能力...
       [Agent会根据是否已申领号码给出不同回答]
```

---

## 🔍 调试技巧

### 检查VirtualPhoneService是否正确加载

```bash
# 查看数据文件
cat data/virtual-phones.json
```

应该看到类似：
```json
{
  "byActor": {
    "user_session_123": "123456",
    "agent_session_456": "234567"
  }
}
```

### 检查AgentCore是否正确接收virtualPhoneService

在 `create-app-services.ts` 中添加日志：

```typescript
console.log("Creating AgentCore with virtualPhoneService:", !!virtualPhoneService);
```

### 检查Prompt是否正确生成

在 `world-agent-capabilities.ts` 末尾添加：

```typescript
console.log("Generated World Caps for", actorId, ":\n", lines.join("\n"));
```

---

## ✅ 验收标准

- [ ] 新用户能看到虚拟电话功能介绍
- [ ] Agent能正确引导用户申领号码
- [ ] 申领后Agent知道用户的号码
- [ ] Agent能正确调用拨打工具
- [ ] System Prompt中包含【虚拟电话能力】部分
- [ ] System Prompt中包含【其他Agent的虚拟电话能力】部分
- [ ] 根据用户状态显示不同的能力说明
- [ ] Agent不会主动申领号码（需用户明确要求）
- [ ] 重启服务后号码信息不丢失
- [ ] Agent理解对方也需要有号码才能通话
- [ ] Agent能正确处理“号码不存在”错误
- [ ] Agent能解释配对要求
- [ ] Agent能提供针对性的解决方案

---

## 🐛 常见问题

### Q1: Agent不知道虚拟电话功能

**检查**:
1. `isWorldCapsPromptEnabled()` 是否返回 true
2. `virtualPhoneService` 是否正确传入 AgentCore
3. System Prompt 是否包含【虚拟电话能力】部分

**解决**:
- 检查环境变量 `AGENT_PROMPT_WORLD_CAPS` 是否被设置为 "0" 或 "off"
- 确认 `create-app-services.ts` 中传入了 `virtualPhoneService`

### Q2: 申领号码后Agent仍显示"未申领"

**检查**:
1. `data/virtual-phones.json` 是否有数据
2. 是否重启了服务
3. ActorId是否正确匹配

**解决**:
- 确认使用的sessionId/userId与申领时一致
- 检查 `VirtualPhoneService.load()` 是否成功执行

### Q3: Prompt太长影响性能

**优化**:
- 设置 `AGENT_PROMPT_WORLD_CAPS=0` 关闭世界能力注入
- 简化虚拟电话能力的描述文本
- 只在必要时才注入完整信息

---

## 📊 性能测试

### 测试指标

- **Prompt构建时间**: < 10ms
- **内存占用**: 每个会话约增加 500 bytes
- **查询延迟**: VirtualPhoneService.getPhoneForActor() < 1ms

### 压力测试

同时100个用户发送消息，观察：
- 服务器响应时间
- 内存使用情况
- CPU占用率

---

## 🎯 下一步

测试通过后，可以考虑：

1. **前端优化**: 在聊天界面添加虚拟电话快捷按钮
2. **智能推荐**: 检测用户意图后主动推荐相关功能
3. **使用统计**: 记录功能使用情况，优化提示策略
4. **A/B测试**: 测试不同的提示文案效果

---

**测试日期**: 2026-05-17  
**测试人员**: ___________  
**测试结果**: ☐ 通过  ☐ 失败  ☐ 部分通过
