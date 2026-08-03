// Agent Brain Center — TaskSwitchingCortex（任务切换皮层）
//
// 职责：多任务栈管理、上下文保存/恢复、切换决策。
//   像前额叶背外侧皮层维持任务集，支持多任务并行与切换。
//
// 核心机制：
//   1. 任务栈（LIFO）：每个 actor 维护一个待恢复任务栈
//   2. 暂停/恢复：pause 保存当前 WorkingMemory 快照，resume 还原
//   3. 切换决策：检测"切换到/暂停/恢复/继续做XX"等意图
//   4. 自动暂停：用户长时间未触碰某任务时自动 pause（与 WorkingMemoryCortex.decay 配合）
//
// 深度链接：
//   - cognize 阶段 1 读取当前活跃 Task 注入 context.currentTask
//   - DecisionHub 检测切换关键词时触发 switchTo
//   - 与 WorkingMemoryCortex 联动：暂停时快照 WM，恢复时还原
//
// 设计要点：
//   - 不主动调 LLM 判断意图（避免幻觉），用关键词规则匹配
//   - 与 PlannerCortex 区分：PlannerCortex 是单任务规划，TaskSwitching 是跨任务管理

import type { WorkingMemoryCortex, WorkingMemorySnapshot } from "./working-memory-cortex.js";

/** 任务上下文（被切换/暂停的任务） */
export interface TaskContext {
  id: string;
  actorId: string;
  summary: string;
  /** 暂停时的工作记忆快照 */
  workingMemorySnapshot?: WorkingMemorySnapshot;
  /** 暂停时的对话最近消息 ID */
  lastMessageAt?: string;
  pausedAt: string;
  resumedCount: number;
  status: "paused" | "active" | "completed" | "abandoned";
  /** 暂停原因 */
  pauseReason?: string;
  /** 创建时优先级 */
  priority: "high" | "medium" | "low";
}

/** 切换意图识别结果 */
export interface SwitchIntent {
  type: "pause" | "resume" | "switch" | "complete" | "list" | "none";
  targetTaskSummary?: string;
  confidence: number;
  reason: string;
}

// 关键词规则（与 RuleRouter 类似的纯规则驱动，避免 LLM 幻觉）
const PAUSE_KEYWORDS = ["等一下", "稍后", "先暂停", "停一下", "回头再说", "改天"];
const RESUME_KEYWORDS = ["继续", "回到刚才", "接着", "接着做", "继续做", "回到"];
const SWITCH_KEYWORDS = ["切换到", "换个话题", "另外", "顺便问下", "插一句"];
const COMPLETE_KEYWORDS = ["完成了", "做完了", "搞定了", "结束了", "ok 了"];
const LIST_KEYWORDS = ["有哪些任务", "进行中的任务", "未完成的", "任务列表"];

/**
 * 任务切换皮层。
 *
 * 维护每个 actor 的任务栈，支持跨任务上下文切换。
 * 与 WorkingMemoryCortex 配合实现上下文保存/恢复。
 */
export class TaskSwitchingCortex {
  /** actorId → 任务栈（LIFO，最后压入的是当前活跃任务） */
  private readonly stacks = new Map<string, TaskContext[]>();
  /** 统计 */
  private switchCount = 0;
  private pauseCount = 0;
  private resumeCount = 0;

  private workingMemory: WorkingMemoryCortex | null = null;

  /** 注入 WorkingMemoryCortex（用于暂停时快照、恢复时还原） */
  registerWorkingMemory(wm: WorkingMemoryCortex): void {
    this.workingMemory = wm;
  }

  /** 识别切换意图（纯规则驱动，不调 LLM） */
  recognizeIntent(text: string): SwitchIntent {
    const lower = text.toLowerCase();

    for (const kw of PAUSE_KEYWORDS) {
      if (lower.includes(kw)) {
        return { type: "pause", confidence: 0.85, reason: `命中暂停关键词：${kw}` };
      }
    }
    for (const kw of COMPLETE_KEYWORDS) {
      if (lower.includes(kw)) {
        return { type: "complete", confidence: 0.85, reason: `命中完成关键词：${kw}` };
      }
    }
    for (const kw of LIST_KEYWORDS) {
      if (lower.includes(kw)) {
        return { type: "list", confidence: 0.85, reason: `命中列表关键词：${kw}` };
      }
    }
    for (const kw of SWITCH_KEYWORDS) {
      if (lower.includes(kw)) {
        // 提取目标任务摘要：关键词后的内容
        const idx = lower.indexOf(kw);
        const target = text.slice(idx + kw.length).trim();
        return {
          type: "switch",
          targetTaskSummary: target || undefined,
          confidence: 0.8,
          reason: `命中切换关键词：${kw}`,
        };
      }
    }
    for (const kw of RESUME_KEYWORDS) {
      if (lower.includes(kw)) {
        const idx = lower.indexOf(kw);
        const target = text.slice(idx + kw.length).trim();
        return {
          type: "resume",
          targetTaskSummary: target || undefined,
          confidence: 0.8,
          reason: `命中恢复关键词：${kw}`,
        };
      }
    }

    return { type: "none", confidence: 0.3, reason: "未命中任何切换关键词" };
  }

  /** 创建新任务并压入栈顶（成为当前活跃任务） */
  startNewTask(actorId: string, summary: string, priority: TaskContext["priority"] = "medium"): string {
    const stack = this.stacks.get(actorId) ?? [];
    const id = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    // 如果已有活跃任务，自动暂停它
    const currentActive = stack.find((t) => t.status === "active");
    if (currentActive) {
      this.pauseTask(actorId, currentActive.id, "新任务启动，自动暂停前一个");
    }
    stack.push({
      id,
      actorId,
      summary,
      pausedAt: new Date().toISOString(),
      resumedCount: 0,
      status: "active",
      priority,
    });
    this.stacks.set(actorId, stack);
    return id;
  }

  /** 暂停指定任务（保存 WorkingMemory 快照） */
  pauseTask(actorId: string, taskId: string, reason?: string): boolean {
    const stack = this.stacks.get(actorId);
    if (!stack) return false;
    const task = stack.find((t) => t.id === taskId);
    if (!task || task.status !== "active") return false;

    task.status = "paused";
    task.pauseReason = reason;
    task.pausedAt = new Date().toISOString();
    if (this.workingMemory) {
      task.workingMemorySnapshot = this.workingMemory.snapshot(actorId);
    }
    this.pauseCount++;
    return true;
  }

  /** 恢复任务（还原 WorkingMemory 快照） */
  resumeTask(actorId: string, taskId: string): TaskContext | null {
    const stack = this.stacks.get(actorId);
    if (!stack) return null;
    const task = stack.find((t) => t.id === taskId);
    if (!task || task.status !== "paused") return null;

    // 暂停当前活跃任务
    const currentActive = stack.find((t) => t.status === "active");
    if (currentActive) {
      this.pauseTask(actorId, currentActive.id, "切换到另一个任务");
    }

    task.status = "active";
    task.resumedCount++;
    if (task.workingMemorySnapshot && this.workingMemory) {
      this.workingMemory.restore(actorId, task.workingMemorySnapshot);
    }
    this.resumeCount++;
    return task;
  }

  /** 按摘要模糊查找并恢复任务 */
  resumeBySummary(actorId: string, summaryHint: string): TaskContext | null {
    const stack = this.stacks.get(actorId);
    if (!stack) return null;
    // 模糊匹配：包含任意关键词
    const keywords = summaryHint.split(/\s+|[，,。.]/).filter((s) => s.length >= 2);
    let bestMatch: TaskContext | null = null;
    let bestScore = 0;
    for (const task of stack) {
      if (task.status !== "paused") continue;
      let score = 0;
      for (const kw of keywords) {
        if (task.summary.includes(kw)) score += kw.length;
      }
      if (score > bestScore) {
        bestScore = score;
        bestMatch = task;
      }
    }
    if (bestMatch && bestScore > 0) {
      return this.resumeTask(actorId, bestMatch.id);
    }
    return null;
  }

  /** 获取当前活跃任务 */
  getCurrentTask(actorId: string): TaskContext | null {
    const stack = this.stacks.get(actorId);
    if (!stack) return null;
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].status === "active") return stack[i];
    }
    return null;
  }

  /** 列出所有未完成任务（active + paused） */
  listActiveTasks(actorId: string): TaskContext[] {
    const stack = this.stacks.get(actorId) ?? [];
    return stack.filter((t) => t.status === "active" || t.status === "paused");
  }

  /** 完成任务（标记为 completed） */
  completeTask(actorId: string, taskId: string): boolean {
    const stack = this.stacks.get(actorId);
    if (!stack) return false;
    const task = stack.find((t) => t.id === taskId);
    if (!task) return false;
    const wasActive = task.status === "active";
    task.status = "completed";
    // 如果完成的是活跃任务，自动恢复栈顶的 paused 任务
    if (wasActive) {
      const nextPaused = [...stack].reverse().find((t) => t.status === "paused");
      if (nextPaused) this.resumeTask(actorId, nextPaused.id);
    }
    return true;
  }

  /** 统一切换入口：根据意图执行对应操作 */
  applyIntent(actorId: string, intent: SwitchIntent, currentText?: string): TaskContext | null {
    this.switchCount++;
    switch (intent.type) {
      case "pause": {
        const cur = this.getCurrentTask(actorId);
        if (cur) {
          this.pauseTask(actorId, cur.id, "用户主动暂停");
          return cur;
        }
        return null;
      }
      case "resume": {
        if (intent.targetTaskSummary) {
          return this.resumeBySummary(actorId, intent.targetTaskSummary);
        }
        // 恢复最近一个 paused 任务
        const stack = this.stacks.get(actorId) ?? [];
        const last = [...stack].reverse().find((t) => t.status === "paused");
        return last ? this.resumeTask(actorId, last.id) : null;
      }
      case "switch": {
        // 先尝试 resume 已有任务
        if (intent.targetTaskSummary) {
          const resumed = this.resumeBySummary(actorId, intent.targetTaskSummary);
          if (resumed) return resumed;
        }
        // 否则创建新任务
        const summary = intent.targetTaskSummary ?? currentText ?? "新任务";
        const id = this.startNewTask(actorId, summary);
        const stack = this.stacks.get(actorId) ?? [];
        return stack.find((t) => t.id === id) ?? null;
      }
      case "complete": {
        const cur = this.getCurrentTask(actorId);
        if (cur) {
          this.completeTask(actorId, cur.id);
          return cur;
        }
        return null;
      }
      default:
        return null;
    }
  }

  getStats(): {
    activeActors: number;
    totalTasks: number;
    switchCount: number;
    pauseCount: number;
    resumeCount: number;
  } {
    let total = 0;
    for (const stack of this.stacks.values()) total += stack.length;
    return {
      activeActors: this.stacks.size,
      totalTasks: total,
      switchCount: this.switchCount,
      pauseCount: this.pauseCount,
      resumeCount: this.resumeCount,
    };
  }

  async start(): Promise<void> {
    console.log("[TaskSwitchingCortex] 启动完成");
  }
  async stop(): Promise<void> {
    this.stacks.clear();
    console.log("[TaskSwitchingCortex] 已停止");
  }
}
