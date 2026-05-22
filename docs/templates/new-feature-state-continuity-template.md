# 新功能开发模板 - 状态连续性合规版

> 📅 创建时间: 2026-05-22
> 🔗 关联规则: [.trae/rules/project_rules.md](../.trae/rules/project_rules.md)
> ⚠️ 强制级别: MUST（必须遵守）

---

## 📋 开发前必读

在开始任何**有状态的新功能**开发前，请确保：

1. ✅ 已阅读 [project_rules.md](../.trae/rules/project_rules.md)
2. ✅ 理解"状态连续性原则"的核心要求
3. ✅ 准备好使用本模板

---

## 🎯 模板清单（按顺序完成）

### 1️⃣ 状态机设计

```typescript
// 📁 src/services/new-feature/types.ts

/**
 * 新功能的状态枚举
 *
 * 设计原则：
 * - 状态数量尽量少（3-5个）
 * - 转换路径清晰，无歧义
 * - 每个状态都有明确的进入/退出条件
 */
export type NewFeatureStatus =
  | "waiting"      // 等待启动（初始状态）
  | "active"       // 进行中（可执行操作）
  | "completed"    // 已完成（终态）
  | "failed"       // 失败（可重试）
  | "cancelled";   // 已取消（终态）

/**
 * 状态转换矩阵
 *
 * 格式：[当前状态] → 可转换到的目标状态列表
 */
export const VALID_TRANSITIONS: Record<NewFeatureStatus, NewFeatureStatus[]> = {
  "waiting": ["active", "cancelled"],
  "active": ["completed", "failed", "cancelled"],
  "completed": [],           // 终态，不可再转
  "failed": ["active"],      // 可重试
  "cancelled": [],           // 终态，不可再转
};

/**
 * 快照数据结构（返回给 Agent 的完整状态）
 */
export type NewFeatureSnapshot = {
  /** 唯一标识 */
  id: string;

  /** 当前状态（核心字段！） */
  status: NewFeatureStatus;

  // ===== 业务字段（根据需求添加）=====
  // progress?: number;         // 进度百分比
  // result?: unknown;          // 执行结果
  // error?: string;            // 错误信息
  // participants?: string[];   // 参与者列表
  // metadata?: Record<string, unknown>;

  // ===== 时间戳（必须包含）=====
  createdAt: string;   // ISO 8601
  updatedAt: string;   // ISO 8601
};
```

### 2️⃣ Service 层实现

```typescript
// 📁 src/services/new-feature/new-feature-service.ts

import type { NewFeatureStatus, NewFeatureSnapshot } from "./types.js";
import { VALID_TRANSITIONS } from "./types.js";

export class NewFeatureService {
  private readonly store = new Map<string, NewFeatureSnapshot>();

  /**
   * 🔴 获取快照（必须提供！）
   *
   * 这是状态连续性的核心方法。
   * 所有操作前都必须先调用此方法获取最新状态。
   */
  async getSnapshot(id: string, sessionId: string): Promise<{
    ok: true;
    snapshot: NewFeatureSnapshot;
  } | {
    ok: false;
    reason: string;
  }> {
    const snap = this.store.get(id);
    if (!snap) {
      return { ok: false, reason: `记录不存在: ${id}` };
    }
    return { ok: true, snapshot: { ...snap } }; // 返回副本，防止外部修改
  }

  /**
   * 🔴 带状态守卫的操作执行器
   *
   * 统一封装：
   * 1. 获取当前状态
   * 2. 验证前置条件
   * 3. 执行业务逻辑
   * 4. 返回更新后的快照
   */
  private async executeWithStateGuard<T>(
    id: string,
    sessionId: string,
    expectedStatus: NewFeatureStatus[],
    action: (current: NewFeatureSnapshot) => Promise<{
      status: NewFeatureStatus;
      updates: Partial<NewFeatureSnapshot>;
      result?: T;
    }>,
  ): Promise<{
    ok: true;
    snapshot: NewFeatureSnapshot;
    result?: T;
  } | {
    ok: false;
    reason: string;
  }> {
    // Step 1: 获取当前状态
    const current = await this.getSnapshot(id, sessionId);
    if (!current.ok) return current;

    // Step 2: 状态守卫
    if (!expectedStatus.includes(current.snapshot.status)) {
      return {
        ok: false,
        reason: `非法状态转换: 当前 ${current.snapshot.status}, 期望 ${expectedStatus.join(" 或 ")}`,
      };
    }

    // Step 3: 执行业务逻辑
    try {
      const { status: newStatus, updates, result } = await action(current.snapshot);

      // 验证状态转换合法性
      const allowedTargets = VALID_TRANSITIONS[current.snapshot.status];
      if (!allowedTargets.includes(newStatus)) {
        return {
          ok: false,
          reason: `非法状态转换: ${current.snapshot.status} → ${newStatus}`,
        };
      }

      // Step 4: 更新并返回新快照
      const now = new Date().toISOString();
      const updated: NewFeatureSnapshot = {
        ...current.snapshot,
        ...updates,
        status: newStatus,
        updatedAt: now,
      };

      this.store.set(id, updated);

      return {
        ok: true,
        snapshot: { ...updated },
        result,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, reason: message };
    }
  }

  // ========== 业务方法示例 ==========

  /**
   * 创建新记录
   */
  async create(sessionId: string, params: CreateParams): Promise<...> {
    const id = generateId();
    const now = new Date().toISOString();
    const snap: NewFeatureSnapshot = {
      id,
      status: "waiting",
      createdAt: now,
      updatedAt: now,
      // ... 其他初始化字段
    };

    this.store.set(id, snap);
    return { ok: true, snapshot: snap };
  }

  /**
   * 执行操作（带状态守卫）
   */
  async doAction(
    id: string,
    sessionId: string,
    params: ActionParams,
  ): Promise<...> {
    return this.executeWithStateGuard(
      id,
      sessionId,
      ["active"], // 只允许在 active 状态下执行
      async (current) => {
        // ... 你的业务逻辑 ...

        return {
          status: "completed", // 或保持 "active"
          updates: { /* 更新的字段 */ },
          result: /* 操作结果 */,
        };
      },
    );
  }

  /**
   * 取消操作
   */
  async cancel(id: string, sessionId: string): Promise<...> {
    return this.executeWithStateGuard(
      id,
      sessionId,
      ["waiting", "active"],
      async (current) => ({
        status: "cancelled",
        updates: {},
      }),
    );
  }
}
```

### 3️⃣ 工具注册层

```typescript
// 📁 src/tools/world-new-feature-tools.ts

import type { ToolRegistryLike } from "../host-types.js";
import type { NewFeatureService } from "../services/new-feature/new-feature-service.js";

/**
 * 🔴 新功能工具注册（必须遵循状态连续性！）
 *
 * 参考实现:
 * - world-gomoku-tools.ts ✅
 * - world-doudizhu-tools.ts ✅
 * - world-zhajinhua-tools.ts ✅
 */
export function registerWorldNewFeatureTools(
  registry: ToolRegistryLike,
  service: NewFeatureService,
): void {

  // ============================================================
  // 🔴 第一步：注册状态连续性约束（必须！）
  // ============================================================
  if ('registerStatefulModule' in registry) {
    (registry as unknown as {
      registerStatefulModule: (config: import("../deps/tools/tool-registry.js").StatefulToolConfig) => void;
    }).registerStatefulModule({
      modulePrefix: "world.new_feature",
      snapshotToolName: "world.new_feature.get_snapshot",
      validStatuses: ["waiting", "active", "completed", "failed", "cancelled"],
      mustReturnSnapshot: true,
    });
  }

  // ============================================================
  // 第二步：注册状态检查工具（必须提供！）
  // ============================================================
  registry.register("world.new_feature.get_snapshot", async (input, context) => {
    const id = String(input.id ?? "").trim();
    if (!id) throw new Error("缺少 id");

    const result = await service.getSnapshot(id, context.sessionId);
    if (!result.ok) throw new Error(result.reason);

    return {
      ok: true,
      snapshot: result.snapshot,
      message: `当前状态: ${result.snapshot.status}`,
    };
  });

  // ============================================================
  // 第三步：注册业务操作工具（必须包含状态检查！）
  // ============================================================

  registry.register("world.new_feature.create", async (input, context) => {
    // 创建操作通常不需要前置状态检查
    const result = await service.create(context.sessionId, input);
    if (!result.ok) throw new Error(result.reason);

    return {
      ok: true,
      snapshot: result.snapshot,
      message: "已创建",
    };
  });

  registry.register("world.new_feature.do_action", async (input, context) => {
    const id = String(input.id ?? "").trim();
    if (!id) throw new Error("缺少 id");

    // 🔴 核心状态检查在这里自动执行（Service 层的 executeWithStateGuard）
    const result = await service.doAction(id, context.sessionId, input);
    if (!result.ok) throw new Error(result.reason);

    // ✅ 必须返回更新后的快照！
    return {
      ok: true,
      snapshot: result.snapshot,
      result: result.result,
      message: "操作成功",
    };
  });

  registry.register("world.new_feature.cancel", async (input, context) => {
    const id = String(input.id ?? "").trim();
    if (!id) throw new Error("缺少 id");

    const result = await service.cancel(id, context.sessionId);
    if (!result.ok) throw new Error(result.reason);

    return {
      ok: true,
      snapshot: result.snapshot,
      message: "已取消",
    };
  });
}
```

### 4️⃣ SKILL.md 文档

```markdown
# 新功能技能文档

## 功能描述
简要描述这个功能的用途和场景。

## ⚠️ 状态连续性原则（强制遵守）

**在任何操作前，必须先调用 `get_snapshot` 检查当前真实状态！**

### 为什么？
- 用户可能基于过时信息说话
- 后端状态可能已被其他操作改变
- **只有工具返回的数据才是真实的**

### 状态检查流程

```
用户消息 → 判断是否涉及此功能
         ↓
    调用 get_snapshot
         ↓
    根据 status 决定下一步：
    ├─ waiting → 引导用户启动
    ├─ active → 正常执行操作
    ├─ completed → 回应结局，禁止继续
    ├─ failed → 告知错误，提供恢复方案
    └─ cancelled → 已终止，可引导重新创建
```

### 状态说明

| 状态 | 含义 | 允许的操作 |
|------|------|-----------|
| `waiting` | 等待启动 | 开始/取消 |
| `active` | 进行中 | 执行操作/取消 |
| `completed` | 已完成 | 查看（不可再操作）|
| `failed` | 失败 | 重试/取消 |
| `cancelled` | 已取消 | 重新创建 |

## 工具调用示例

### 创建新任务
```typescript
world.new_feature.create({ /* 参数 */ })
// 返回: { ok: true, snapshot: {...} }
```

### 执行操作（必须先检查状态！）
```typescript
// ❌ 错误：直接执行
world.new_feature.do_action({ id: "...", params })

// ✅ 正确：先检查状态
const snap = await world.new_feature.get_snapshot({ id: "..." })
if (snap.status === "active") {
  await world.new_feature.do_action({ id: "...", params })
} else if (snap.status === "completed") {
  // 回应结局
} else {
  // 处理其他状态
}
```

## 示例对话

### 场景1：正常流程 ✅
**用户**: "帮我创建一个xxx"
**Agent**: *(调用 create)*
**Agent**: "已创建！ID是 xxx"

**用户**: "现在执行吧"
**Agent**: *(调用 get_snapshot → status="waiting")*
**Agent**: *(调用 do_action)*
**Agent**: "执行中..."

**用户**: "完成了吗？"
**Agent**: *(调用 get_snapshot → status="completed")*
**Agent**: "是的，已完成！结果是..."

### 场景2：状态异常处理 ✅
**用户**: "继续执行"
**Agent**: *(调用 get_snapshot → status="completed")*
**Agent**: "这个任务已经完成了哦～ 结果是... 要创建新任务吗？"

### 场景3：错误示范 ❌
**用户**: "完成了吗？"
**Agent**: "让我检查一下..." *(❌ 浪费一轮，应该直接调用工具)*

## 注意事项

- ⚠️ **绝对不能凭记忆判断状态**
- ⚠️ **操作完成后必须告知用户新状态**
- ⚠️ **已完成的任务禁止继续操作**
- ⚠️ **失败的任务提供明确的恢复方案**
```

### 5️⃣ Agent 能力描述更新

```typescript
// 📁 server/src/agent/agent-capabilities.ts

// 在对应的能力区块添加：

lines.push(`\n🆕 【新功能名称】`);
lines.push(`可用工具：`);
lines.push(`- world.new_feature.create: 创建新任务`);
lines.push(`- world.new_feature.do_action: 执行操作`);
lines.push(`- world.new_feature.get_snapshot: 获取当前状态`);
lines.push(`- world.new_feature.cancel: 取消任务`);
lines.push(`⚠️ 状态连续性要求：任何操作前必须先调用 get_snapshot 检查状态！`);
lines.push(`⚠️ 若 status==="completed"，立即回应结局，禁止继续操作`);
lines.push(`提示：简短的功能描述`);
```

---

## ✅ 发布前自检清单

在提交 PR 前，逐项确认：

### 代码层面
- [ ] 类型定义包含完整的 Status 枚举和 Snapshot 结构
- [ ] Service 层实现了 `getSnapshot()` 方法
- [ ] Service 层使用 `executeWithStateGuard()` 统一封装
- [ ] 工具注册时调用了 `registerStatefulModule()`
- [ ] 所有变更操作返回更新后的快照
- [ ] 包含单元测试覆盖状态转换

### 文档层面
- [ ] SKILL.md 包含"状态连续性原则"章节
- [ ] 提供了正确/错误示例对比
- [ ] agent-capabilities.ts 添加了能力描述+状态警告
- [ ] README（如有）提及状态管理策略

### 运行时验证
- [ ] 启动后控制台输出 `[ToolRegistry] ✅ 已注册有状态模块`
- [ ] 调用操作工具时若未返回 snapshot 会看到警告日志
- [ ] 在非法状态下操作会收到清晰的错误提示

---

## 🚨 常见错误及修复

### 错误1: 忘记注册状态约束
**症状**: 控制台无 `[ToolRegistry] ✅` 日志
**修复**: 在工具文件开头添加 `registerStatefulModule()` 调用

### 错误2: 操作未返回快照
**症状**: 控制台警告 `未返回 snapshot`
**修复**: 确保 Service 层的 execute 方法返回 `{ snapshot: updatedSnap }`

### 错误3: SKILL.md 缺少状态说明
**症状**: Agent 不知道要先检查状态
**修复**: 复制本模板的"状态连续性原则"章节到 SKILL.md

### 错误4: 直接操作不检查状态
**症状**: Agent 在已完成任务上继续操作
**修复**: 在 Service 层使用 executeWithStateGuard 封装所有操作

---

## 📚 相关资源

- **完整规则**: [.trae/rules/project_rules.md](../.trae/rules/project_rules.md)
- **参考实现**:
  - [gomoku-service.ts](../agent-world/services/gomoku-service.ts)
  - [world-gomoku-tools.ts](../agent-world/tools/world-gomoku-tools.ts)
  - [game-gomoku/SKILL.md](../agent-world/skills/game-gomoku/SKILL.md)

---

**模板版本**: 1.0
**最后更新**: 2026-05-22
**适用范围**: 所有新增的有状态功能
