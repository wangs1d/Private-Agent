// 打断成本自校准器（CostCalibrator）—— 反馈驱动的阈值呼吸，零 LLM。
//
// 原理：alert 档"中等成本直投"的边界（默认 4.5）不该是拍死的常量。
// 用 outcome 回灌的全局接受率（accepted+replied 占非 delivered 总量的比例）
// 做 EWMA：用户近来越接得越积极 → 阈值上浮（更敢说）；连续被忽略 → 下浮
// （更收敛）。浮动范围 [3.5, 5.5]，防抽风边界由 burst 熔断另行承担。
//
// 数据源：Pipeline OutcomeStore（bootstrap 定时喂入）+ 落盘恢复。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const ALERT_COST_BASE = 4.5;
const ALERT_COST_MIN = 3.5;
const ALERT_COST_MAX = 5.5;
const EWMA_ALPHA = 0.2;
const LOW_ACCEPT = 0.35;
const HIGH_ACCEPT = 0.65;
/** 每档调整幅度 */
const STEP = 0.25;
/** 最小样本量（不足不动阈值，防早期噪声带偏） */
const MIN_SAMPLES = 8;

export type CostCalibrationSnapshot = {
  alertMidThreshold: number;
  acceptanceEwma: number | null;
  samples: number;
};

type PersistShape = {
  acceptanceEwma: number | null;
  samples: number;
  threshold: number;
};

export class CostCalibrator {
  private acceptanceEwma: number | null = null;
  private samples = 0;
  private threshold = ALERT_COST_BASE;
  private readonly filePath: string;

  constructor(dataPath: string) {
    this.filePath = join(dataPath, "cost-calibration.json");
    this.load();
  }

  /**
   * 喂入一次触达结果（bootstrap 从管道 outcome 回传桥接）。
   * delivered 不计（只统计用户真正表态的：接受/回复 vs 忽略/关闭/推迟）。
   */
  observe(outcome: string): void {
    if (outcome === "delivered") return;
    const accepted = outcome === "accepted" || outcome === "replied";
    this.acceptanceEwma =
      this.acceptanceEwma === null ? (accepted ? 1 : 0) : this.acceptanceEwma * (1 - EWMA_ALPHA) + (accepted ? 1 : 0) * EWMA_ALPHA;
    this.samples += 1;
    this.recompute();
    this.persist();
  }

  /** 批量喂入（bootstrap 定时从 OutcomeStore 汇总；outcome 列表） */
  observeAll(outcomes: string[]): void {
    for (const o of outcomes) this.observe(o);
  }

  /** 当前 alert 档中等成本阈值（裁决时读取） */
  alertMidThreshold(): number {
    return this.threshold;
  }

  /** 快照（selftest/诊断展示） */
  snapshot(): CostCalibrationSnapshot {
    return {
      alertMidThreshold: this.threshold,
      acceptanceEwma: this.acceptanceEwma,
      samples: this.samples,
    };
  }

  private recompute(): void {
    if (this.samples < MIN_SAMPLES || this.acceptanceEwma === null) return;
    let target = ALERT_COST_BASE;
    if (this.acceptanceEwma < LOW_ACCEPT) target = ALERT_COST_BASE - STEP;
    else if (this.acceptanceEwma > HIGH_ACCEPT) target = ALERT_COST_BASE + STEP;
    target = Math.max(ALERT_COST_MIN, Math.min(ALERT_COST_MAX, target));
    if (target !== this.threshold) {
      console.log(
        `[CostCalibrator] 阈值调整 ${this.threshold} → ${target}（接受率 EWMA=${this.acceptanceEwma.toFixed(2)}, n=${this.samples}）`,
      );
      this.threshold = target;
    }
  }

  private load(): void {
    try {
      if (!existsSync(this.filePath)) return;
      const raw = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<PersistShape>;
      if (typeof raw.acceptanceEwma === "number") this.acceptanceEwma = raw.acceptanceEwma;
      if (typeof raw.samples === "number") this.samples = raw.samples;
      if (typeof raw.threshold === "number") this.threshold = raw.threshold;
    } catch {
      /* 损坏文件按默认阈值 */
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const out: PersistShape = {
        acceptanceEwma: this.acceptanceEwma,
        samples: this.samples,
        threshold: this.threshold,
      };
      writeFileSync(this.filePath, JSON.stringify(out));
    } catch {
      /* 落盘失败忽略 */
    }
  }
}
