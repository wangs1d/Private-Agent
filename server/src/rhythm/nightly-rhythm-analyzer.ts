import type { LifeRhythmEngine } from "./engine.js";

/**
 * 夜间节律分析任务：克隆 NightlyMemoryTaskService 的调度模式
 * （分钟级 tick + 全局触发小时 + 按日去重），对每个已知 actor 完整跑一轮
 * 引擎分析（传感器拉取 → 统计建模 → 消费方落权）。
 *
 * 触发时刻用凌晨低活跃时段（env RHYTHM_ANALYSIS_HOUR，默认 3 点），错开
 * NightlyMemoryTaskService 的夜窗切换节点，避免同时抢 IO。
 */
export type NightlyRhythmAnalyzerDeps = {
  engine: LifeRhythmEngine;
  /** 已知 actor 清单（bootstrap 桥接 memorySync.listSessionIds + journal actor 目录） */
  listActorIds: () => string[];
};

export class NightlyRhythmAnalyzer {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: NightlyRhythmAnalyzerDeps) {}

  /** 触发小时（env RHYTHM_ANALYSIS_HOUR，默认 3） */
  private triggerHour(): number {
    const h = Number.parseInt(process.env.RHYTHM_ANALYSIS_HOUR ?? "", 10);
    return Number.isFinite(h) && h >= 0 && h <= 23 ? h : 3;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        console.error("[RhythmAnalyzer] tick failed:", err);
      });
    }, 60_000);
    this.timer.unref?.();
    console.log(`[RhythmAnalyzer] 夜间节律分析已启动（每日 ${this.triggerHour()} 点）`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    const now = new Date();
    if (now.getHours() !== this.triggerHour()) return;
    await this.runAll(now);
  }

  /** 立即为所有 actor 跑一轮（诊断/测试/手动补跑用） */
  async runAll(now = new Date()): Promise<string[]> {
    const today = now.toISOString().slice(0, 10);
    const actorIds = this.deps.listActorIds();
    for (const actorId of actorIds) {
      if (!actorId || actorId === "system") continue;
      const profile = this.deps.engine.getProfile(actorId);
      if (profile && profile.lastAnalyzedDay === today) continue;
      try {
        await this.deps.engine.runAnalysis(actorId, { now });
      } catch (error) {
        console.error(`[RhythmAnalyzer] actor ${actorId} analysis failed:`, error);
      }
    }
    return actorIds;
  }

  /** 单 actor 补跑（测试/诊断用；engine 侧按 lastAnalyzedDay 幂等） */
  async runActor(actorId: string, now = new Date()): Promise<void> {
    await this.deps.engine.runAnalysis(actorId, { now });
  }
}
