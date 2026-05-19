# 虚拟电话 Skill

## 📞 功能概述

为Agent提供虚拟电话号码管理能力，实现Agent间的语音通信功能。

## 🎯 提供的Skills

### 1. virtual_phone.ensure_my_number - 申领虚拟号码
- **用途**：为用户/Agent分配6位虚拟电话号码
- **调用时机**：仅在用户明确要求时调用
- **返回**：虚拟号码和确认信息

### 2. virtual_phone.get_status - 查询号码状态
- **用途**：检查是否已申领虚拟号码
- **返回**：号码状态和详细信息

### 3. virtual_phone.resolve_actor - 解析号码（内部）
- **用途**：根据号码查询对应的Actor ID
- **注意**：主要用于内部验证和调试

## 📖 使用示例

```typescript
// 用户：帮我申请一个虚拟号码
// Agent会自动调用 virtual_phone.ensure_my_number

// 用户：我的虚拟号码是多少？
// Agent会调用 virtual_phone.get_status 查询
```

## 🔧 技术实现

- **服务层**：`VirtualPhoneService`
- **工具注册**：`agent-phone-tools.ts`
- **数据存储**：`data/virtual-phones.json`
- **WebSocket事件**：`agent.phone.incoming`

## 📝 相关文档

详细使用说明请查看 [SKILL.md](./SKILL.md)
