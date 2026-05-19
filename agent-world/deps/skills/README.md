# Skills 目录

此目录包含 AI Agent 的 Skill（技能）定义和实现。

## 📁 文件说明

### 核心文件
- `types.ts` - Skill 系统的类型定义
- `skill-validator.ts` - Skill 验证器
- `skill-sandbox.ts` - 沙箱执行环境
- `skill-manager.ts` - Skill 管理器（核心）
- `example-skills.ts` - 示例 Skills
- `index.ts` - 主入口

### 如何创建新 Skill

1. **在代码中定义**（推荐用于核心功能）：

```typescript
// 在任何地方定义
import type { SkillDefinition } from './skills/types.js';

export const mySkill: SkillDefinition = {
  metadata: {
    name: "namespace.action",
    version: "1.0.0",
    displayName: "显示名称",
    description: "功能描述",
    parameters: [
      { name: "param1", type: "string", required: true }
    ],
    permissions: ["wallet:read"],
  },
  handler: async (input, context) => {
    // 实现逻辑
    return { result: "success" };
  },
};

// 注册
skillManager.register(mySkill);
```

2. **从文件加载**（适合第三方扩展）：

创建 `my-skill.ts` 文件，然后：
```typescript
await skillManager.loadFromFile('./path/to/my-skill.ts');
```

## 🎯 可用权限

| 权限 | 说明 |
|------|------|
| `wallet:read` | 读取钱包余额 |
| `wallet:write` | 修改钱包 |
| `calendar:read/write` | 日历访问 |
| `contacts:read` | 联系人读取 |
| `location:read` | 位置信息 |
| `notifications:write` | 发送通知 |
| `storage:read/write` | 本地存储 |
| `network:external` | 外部网络访问 |
| `filesystem:read/write` | 文件系统访问 |

## 📚 文档

- [架构设计](../../docs/SKILL-ARCHITECTURE.md) - 详细的技术架构
- [使用指南](../../docs/SKILL-USAGE-GUIDE.md) - 完整的使用教程
- [实现总结](../../docs/SKILL-IMPLEMENTATION-SUMMARY.md) - 实现概览

## 🔍 示例

查看 `example-skills.ts` 了解3个完整的 Skill 示例：
- 💰 预算分析器
- ⏰ 智能提醒调度
- 🛒 购物比价助手

## 🧪 测试

运行测试：
```bash
npm test
```

测试文件位于 `server/test/skill-system.test.ts`
