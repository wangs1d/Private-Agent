/**
 * 基准自评服务（Phase 5.4）
 *
 * 设计原则：
 * - 定期（默认每周日 04:00）运行 scripts/bench-*.ts 子集
 * - 对比历史基线，检测性能回归（regressionPercent > 10%）
 * - 纯脚本执行 + 数值对比，无 LLM 调用
 * - 回归报告输出给 SelfDrivenEvolutionProposer.proposeFromBenchmark
 *
 * 降级开关：BRAIN_BENCHMARK_ASSESSMENT_ENABLED=0 时 runAssessment() 直接返回空。
 *
 * 基线存储：data/benchmark-baselines.json（首次运行时建立基线）
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import type { BenchmarkRegressionReport } from "../brain/self-driven-evolution-cortex.js";

/** 是否启用 benchmark 自评 */
export function isBenchmarkAssessmentEnabled(): boolean {
  const raw = process.env.BRAIN_BENCHMARK_ASSESSMENT_ENABLED?.trim().toLowerCase();
  if (raw === "0" || raw === "off" || raw === "false") return false;
  return true;
}

/** benchmark 结果项 */
export interface BenchmarkResult {
  /** benchmark 名称 */
  name: string;
  /** 测量值（如 token 数、延迟 ms、命中率等） */
  value: number;
  /** 单位 */
  unit: string;
  /** 测量时间戳 */
  measuredAt: string;
}

/** 基线存储结构 */
interface BaselineStorage {
  /** benchmark name → 基线值 */
  baselines: Record<string, { value: number; unit: string; establishedAt: string }>;
  /** 历史测量记录（最近 N 条） */
  history: BenchmarkResult[];
}

/** 默认基线路径 */
const DEFAULT_BASELINE_PATH = join(process.cwd(), "data", "benchmark-baselines.json");

/** 历史记录最大条数 */
const MAX_HISTORY = 100;

/**
 * 基准自评服务
 *
 * 使用方式：
 *   const svc = new BenchmarkSelfAssessment();
 *   await svc.load();
 *   const results = await svc.runAssessment();
 *   // results.regressions 包含回归项，可传给 SelfDrivenEvolutionProposer
 */
export class BenchmarkSelfAssessment {
  private readonly baselinePath: string;
  private storage: BaselineStorage = { baselines: {}, history: [] };
  private loaded = false;

  constructor(baselinePath: string = DEFAULT_BASELINE_PATH) {
    this.baselinePath = baselinePath;
  }

  /** 加载基线存储 */
  async load(): Promise<void> {
    try {
      const raw = await readFile(this.baselinePath, "utf8");
      this.storage = JSON.parse(raw) as BaselineStorage;
      this.loaded = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("ENOENT")) {
        console.log(`[BenchmarkSelfAssessment] load 失败: ${msg}`);
      }
      this.storage = { baselines: {}, history: [] };
      this.loaded = true;
    }
  }

  /**
   * 运行一次评估
   * @param benchmarkScripts 要运行的 bench 脚本路径数组（默认空，由调用方指定）
   * @returns 回归报告 + 本次测量结果
   */
  async runAssessment(
    benchmarkScripts: string[] = [],
  ): Promise<{ regressions: BenchmarkRegressionReport[]; results: BenchmarkResult[] }> {
    if (!isBenchmarkAssessmentEnabled()) {
      return { regressions: [], results: [] };
    }

    if (!this.loaded) {
      await this.load();
    }

    const results: BenchmarkResult[] = [];

    // 运行每个 bench 脚本，解析输出
    for (const script of benchmarkScripts) {
      const result = await this.runScript(script);
      if (result) results.push(result);
    }

    // 如果没有脚本，用内置的「token 占用」自评（从 history 推断）
    if (results.length === 0 && this.storage.history.length > 0) {
      const lastResult = this.storage.history[this.storage.history.length - 1];
      results.push({
        name: lastResult.name,
        value: lastResult.value,
        unit: lastResult.unit,
        measuredAt: new Date().toISOString(),
      });
    }

    // 更新历史
    this.storage.history.push(...results);
    if (this.storage.history.length > MAX_HISTORY) {
      this.storage.history = this.storage.history.slice(-MAX_HISTORY);
    }

    // 检测回归 + 更新基线
    const regressions: BenchmarkRegressionReport[] = [];
    for (const result of results) {
      const baseline = this.storage.baselines[result.name];
      if (baseline) {
        // 已有基线：检测回归
        const regressionPercent = ((result.value - baseline.value) / baseline.value) * 100;
        if (regressionPercent > 10) {
          regressions.push({
            benchmarkName: result.name,
            currentValue: result.value,
            baselineValue: baseline.value,
            regressionPercent,
            baselineAt: baseline.establishedAt,
          });
        }
      } else {
        // 无基线：建立基线（首次测量）
        this.storage.baselines[result.name] = {
          value: result.value,
          unit: result.unit,
          establishedAt: result.measuredAt,
        };
      }
    }

    await this.persist();
    return { regressions, results };
  }

  /** 运行单个 bench 脚本，解析输出 */
  private async runScript(scriptPath: string): Promise<BenchmarkResult | null> {
    return new Promise((resolve) => {
      try {
        const proc = spawn("npx", ["tsx", scriptPath], {
          cwd: process.cwd(),
          shell: true,
          stdio: ["ignore", "pipe", "pipe"],
        });

        let stdout = "";
        let stderr = "";

        proc.stdout?.on("data", (data) => {
          stdout += data.toString();
        });
        proc.stderr?.on("data", (data) => {
          stderr += data.toString();
        });

        const timeout = setTimeout(() => {
          proc.kill("SIGTERM");
          resolve(null);
        }, 60_000);

        proc.on("close", (code) => {
          clearTimeout(timeout);
          if (code !== 0) {
            console.log(`[BenchmarkSelfAssessment] 脚本 ${scriptPath} 退出码 ${code}: ${stderr.slice(0, 200)}`);
            resolve(null);
            return;
          }

          // 解析输出：期望最后一行是 JSON {"name":"...","value":N,"unit":"..."}
          const lines = stdout.trim().split("\n");
          const lastLine = lines[lines.length - 1];
          try {
            const parsed = JSON.parse(lastLine) as { name: string; value: number; unit: string };
            resolve({
              name: parsed.name,
              value: parsed.value,
              unit: parsed.unit,
              measuredAt: new Date().toISOString(),
            });
          } catch {
            console.log(`[BenchmarkSelfAssessment] 脚本 ${scriptPath} 输出无法解析: ${lastLine.slice(0, 100)}`);
            resolve(null);
          }
        });

        proc.on("error", (err) => {
          clearTimeout(timeout);
          console.log(`[BenchmarkSelfAssessment] 脚本 ${scriptPath} 启动失败: ${err}`);
          resolve(null);
        });
      } catch (err) {
        console.log(`[BenchmarkSelfAssessment] 脚本 ${scriptPath} 异常: ${err}`);
        resolve(null);
      }
    });
  }

  /** 获取当前基线 */
  getBaselines(): Readonly<Record<string, { value: number; unit: string; establishedAt: string }>> {
    return this.storage.baselines;
  }

  /** 获取历史记录 */
  getHistory(): ReadonlyArray<BenchmarkResult> {
    return this.storage.history;
  }

  /** 重置基线（强制下次测量为新基线） */
  resetBaselines(): void {
    this.storage.baselines = {};
  }

  /** 持久化到磁盘 */
  private async persist(): Promise<void> {
    try {
      await mkdir(dirname(this.baselinePath), { recursive: true });
      await writeFile(this.baselinePath, JSON.stringify(this.storage, null, 2), "utf8");
    } catch (err) {
      console.log(`[BenchmarkSelfAssessment] persist 失败: ${err}`);
    }
  }
}
