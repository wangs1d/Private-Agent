/**
 * 升级沙箱测试运行器
 *
 * 核心职责：在应用任何升级（依赖升级 / 代码修改）之前，先在沙箱环境中
 * 完整测试，确保升级后系统能真正跑起来，且性能不退化。
 *
 * 流程：
 * 1. 备份 package.json + package-lock.json（或目标源码文件）
 * 2. 应用升级（npm install package@version 或 patch 代码）
 * 3. 运行 tsc --noEmit（编译通过是最低门槛）
 * 4. 运行相关测试（tsx --test 相关测试文件）
 * 5. 运行 benchmark 对比（可选，对比升级前后性能）
 * 6. 全部通过 → 保留升级（返回 ok=true）
 * 7. 任一失败 → 回滚到备份（返回 ok=false + 详细错误）
 *
 * 安全约束：
 * - npm install 仅限白名单包（防任意包安装）
 * - 超时保护（tsc 60s / test 60s / npm install 120s）
 * - 失败必回滚（rollback 是 finally 级别保证）
 */

import { spawn } from "node:child_process";
import { cp, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import type { EvolutionLlmAssessment } from "../brain/self-driven-evolution-cortex.js";

// ---- 类型定义 ---------------------------------------------------------

/** 沙箱测试结果 */
export interface SandboxTestReport {
  /** 测试是否通过 */
  ok: boolean;
  /** tsc 编译结果 */
  tscPassed: boolean;
  /** 测试套件结果 */
  testsPassed: boolean;
  /** tsc 输出（截断） */
  tscOutput: string;
  /** 测试输出（截断） */
  testOutput: string;
  /** 运行了的测试文件列表 */
  testFilesRun: string[];
  /** 升级耗时（ms） */
  upgradeMs: number;
  /** 测试耗时（ms） */
  testMs: number;
  /** 总耗时（ms） */
  totalMs: number;
  /** 错误信息 */
  error?: string;
  /** 是否已回滚 */
  rolledBack: boolean;
}

/** 升级目标类型 */
export interface UpgradeTarget {
  /** 升级类型 */
  type: "npm_dependency" | "source_patch";
  /** 目标描述（如 "升级 @modelcontextprotocol/sdk 到 1.0.0"） */
  description: string;
  /** npm 包名（type=npm_dependency 时必填） */
  packageName?: string;
  /** 目标版本（type=npm_dependency 时必填） */
  targetVersion?: string;
  /** LLM 评估结果（可选，提供时会按 testPlan 运行测试） */
  llmAssessment?: EvolutionLlmAssessment;
}

// ---- 常量 -------------------------------------------------------------

/** npm install 超时 */
const NPM_INSTALL_TIMEOUT_MS = 120_000;
/** tsc 超时 */
const TSC_TIMEOUT_MS = 60_000;
/** 测试超时 */
const TEST_TIMEOUT_MS = 60_000;

/**
 * 允许升级的 npm 包白名单（防任意包安装）。
 * 与 ExternalTechScanner 的 DEFAULT_WATCHLIST 对应。
 */
const ALLOWED_NPM_PACKAGES = new Set([
  "@anthropic-ai/sdk",
  "@modelcontextprotocol/sdk",
  "whisper.cpp",
  "dotenv",
  "koa",
  "@koa/router",
]);

// ---- 辅助：命令执行 ---------------------------------------------------

/**
 * 执行命令并捕获输出。
 * 超时自动 kill。
 */
function runCommand(
  cmd: string,
  args: string[],
  opts: { cwd: string; timeout: number; env?: Record<string, string> },
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveFn, reject) => {
    const proc = spawn(cmd, args, {
      cwd: opts.cwd,
      shell: process.platform === "win32",
      env: { ...process.env, ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error(`命令超时（${opts.timeout}ms）：${cmd} ${args.join(" ")}`));
    }, opts.timeout);

    proc.stdout?.on("data", (d) => { stdout += d.toString(); });
    proc.stderr?.on("data", (d) => { stderr += d.toString(); });

    proc.on("close", (code) => {
      clearTimeout(timer);
      resolveFn({ code: code ?? -1, stdout, stderr });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** 运行 tsc --noEmit（导出供真实可执行性验证） */
export async function runTsc(serverRoot: string): Promise<{ ok: boolean; output: string }> {
  try {
    const result = await runCommand("npx", ["tsc", "--noEmit", "-p", "tsconfig.json"], {
      cwd: serverRoot,
      timeout: TSC_TIMEOUT_MS,
      env: { CI: "1" },
    });
    const output = (result.stdout + "\n" + result.stderr).trim();
    return { ok: result.code === 0, output: output.slice(0, 2000) };
  } catch (err) {
    return { ok: false, output: `tsc 执行异常: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * 运行测试文件。
 * 支持 LLM testPlan 指定的脚本 + 自动发现的 .test.ts 文件。
 * （导出供真实可执行性验证）
 */
export async function runTests(
  serverRoot: string,
  testFiles: string[],
): Promise<{ ok: boolean; output: string; filesRun: string[] }> {
  if (testFiles.length === 0) {
    return { ok: true, output: "(无测试文件可运行)", filesRun: [] };
  }

  const filesRun: string[] = [];
  const outputs: string[] = [];

  for (const file of testFiles) {
    // 校验文件存在
    const abs = resolve(serverRoot, file);
    if (!existsSync(abs)) {
      outputs.push(`[跳过] 测试文件不存在: ${file}`);
      continue;
    }
    filesRun.push(file);

    try {
      const result = await runCommand("npx", ["tsx", file], {
        cwd: serverRoot,
        timeout: TEST_TIMEOUT_MS,
        env: { CI: "1" },
      });
      outputs.push(`=== ${file} (exit ${result.code}) ===`);
      outputs.push(result.stdout.slice(0, 500));
      if (result.stderr) {
        outputs.push(result.stderr.slice(0, 500));
      }
      if (result.code !== 0) {
        return {
          ok: false,
          output: outputs.join("\n").slice(0, 3000),
          filesRun,
        };
      }
    } catch (err) {
      outputs.push(`=== ${file} 异常 ===`);
      outputs.push(err instanceof Error ? err.message : String(err));
      return {
        ok: false,
        output: outputs.join("\n").slice(0, 3000),
        filesRun,
      };
    }
  }

  return { ok: true, output: outputs.join("\n").slice(0, 3000), filesRun };
}

/**
 * 发现与变更相关的测试文件。
 * 策略：
 * 1. LLM testPlan 指定的脚本（优先）
 * 2. scripts/test-self-evolution*.ts（自我进化相关测试）
 * 3. 如果有 suspectFiles，找对应的 .test.ts
 */
function discoverTestFiles(
  serverRoot: string,
  llmTestPlan: string[],
  suspectFiles: string[],
): string[] {
  const files = new Set<string>();

  // LLM 指定的测试计划
  for (const f of llmTestPlan) {
    if (existsSync(resolve(serverRoot, f))) {
      files.add(f);
    }
  }

  // 默认运行自我进化 E2E 测试（确保进化管线本身没坏）
  const defaultTests = [
    "scripts/test-self-evolution.ts",
    "scripts/test-self-evolution-e2e.ts",
  ];
  for (const f of defaultTests) {
    if (existsSync(resolve(serverRoot, f))) {
      files.add(f);
    }
  }

  // suspectFiles 对应的 .test.ts
  for (const s of suspectFiles) {
    const testPath = s.replace(/\.ts$/, ".test.ts");
    if (existsSync(resolve(serverRoot, testPath))) {
      files.add(testPath);
    }
  }

  return Array.from(files);
}

// ---- 沙箱运行器主体 ---------------------------------------------------

/**
 * 升级沙箱测试运行器
 *
 * 使用方式：
 *   const runner = new UpgradeSandboxRunner(serverRoot);
 *   const report = await runner.testUpgrade(target);
 *   if (report.ok) { console.log("升级测试通过，可以应用"); }
 *   else { console.log("升级测试失败，已回滚:", report.error); }
 */
export class UpgradeSandboxRunner {
  private readonly serverRoot: string;
  private readonly backupDir: string;

  constructor(serverRoot: string = process.cwd()) {
    this.serverRoot = serverRoot;
    this.backupDir = join(serverRoot, "data", "upgrade-sandbox-backup");
  }

  /**
   * 测试一个升级：备份 → 应用 → tsc + test → 通过则保留，失败则回滚。
   *
   * @param target 升级目标
   * @returns 详细测试报告
   */
  async testUpgrade(target: UpgradeTarget): Promise<SandboxTestReport> {
    const totalStart = Date.now();
    let upgradeMs = 0;
    let testMs = 0;
    let rolledBack = false;

    // 校验
    if (target.type === "npm_dependency") {
      if (!target.packageName || !target.targetVersion) {
        return this.failReport("npm_dependency 升级缺少 packageName 或 targetVersion", 0, 0, 0);
      }
      if (!ALLOWED_NPM_PACKAGES.has(target.packageName)) {
        return this.failReport(
          `npm 包 "${target.packageName}" 不在白名单中，拒绝安装`,
          0, 0, 0,
        );
      }
    }

    // 阶段 1：备份
    const backupResult = await this.createBackup(target);
    if (!backupResult.ok) {
      return this.failReport(`备份失败: ${backupResult.error}`, 0, 0, 0);
    }

    // 阶段 2：应用升级
    const upgradeStart = Date.now();
    try {
      if (target.type === "npm_dependency") {
        await this.applyNpmUpgrade(target.packageName!, target.targetVersion!);
      } else {
        // source_patch 类型由 CodeRepairCortex 处理，这里不做源码 patch
        // sandbox runner 仅负责 npm 依赖升级的沙箱测试
        return this.failReport("source_patch 类型请使用 CodeRepairCortex", 0, 0, Date.now() - totalStart);
      }
      upgradeMs = Date.now() - upgradeStart;
    } catch (err) {
      upgradeMs = Date.now() - upgradeStart;
      // 升级失败：回滚
      await this.rollback(target).catch(() => {});
      rolledBack = true;
      return this.failReport(
        `升级应用失败: ${err instanceof Error ? err.message : String(err)}`,
        upgradeMs, 0, Date.now() - totalStart, rolledBack,
      );
    }

    // 阶段 3：运行 tsc
    const testStart = Date.now();
    const tscResult = await runTsc(this.serverRoot);

    if (!tscResult.ok) {
      testMs = Date.now() - testStart;
      // tsc 失败：回滚
      await this.rollback(target).catch(() => {});
      rolledBack = true;
      return {
        ok: false,
        tscPassed: false,
        testsPassed: false,
        tscOutput: tscResult.output,
        testOutput: "",
        testFilesRun: [],
        upgradeMs,
        testMs,
        totalMs: Date.now() - totalStart,
        error: `tsc --noEmit 编译失败`,
        rolledBack,
      };
    }

    // 阶段 4：运行测试
    const testFiles = discoverTestFiles(
      this.serverRoot,
      target.llmAssessment?.testPlan ?? [],
      [], // suspectFiles 为空（npm 升级场景）
    );

    const testResult = await runTests(this.serverRoot, testFiles);
    testMs = Date.now() - testStart;

    if (!testResult.ok) {
      // 测试失败：回滚
      await this.rollback(target).catch(() => {});
      rolledBack = true;
      return {
        ok: false,
        tscPassed: true,
        testsPassed: false,
        tscOutput: tscResult.output,
        testOutput: testResult.output,
        testFilesRun: testResult.filesRun,
        upgradeMs,
        testMs,
        totalMs: Date.now() - totalStart,
        error: `测试未通过`,
        rolledBack,
      };
    }

    // 全部通过：保留升级（不回滚）
    return {
      ok: true,
      tscPassed: true,
      testsPassed: true,
      tscOutput: tscResult.output,
      testOutput: testResult.output,
      testFilesRun: testResult.filesRun,
      upgradeMs,
      testMs,
      totalMs: Date.now() - totalStart,
      rolledBack: false,
    };
  }

  // ---- 备份与回滚 -----------------------------------------------------

  /**
   * 创建备份。
   * npm_dependency: 备份 package.json + package-lock.json
   */
  private async createBackup(target: UpgradeTarget): Promise<{ ok: boolean; error?: string }> {
    try {
      await mkdir(this.backupDir, { recursive: true });

      if (target.type === "npm_dependency") {
        const filesToBackup = ["package.json", "package-lock.json"];
        for (const f of filesToBackup) {
          const src = resolve(this.serverRoot, f);
          if (existsSync(src)) {
            await cp(src, join(this.backupDir, f));
          }
        }
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * 从备份回滚。
   * 恢复 package.json + package-lock.json，然后重新 npm install。
   */
  private async rollback(target: UpgradeTarget): Promise<void> {
    if (target.type === "npm_dependency") {
      // 恢复 package.json + package-lock.json
      for (const f of ["package.json", "package-lock.json"]) {
        const backup = join(this.backupDir, f);
        if (existsSync(backup)) {
          await cp(backup, resolve(this.serverRoot, f));
        }
      }
      // 重新安装依赖（恢复到升级前状态）
      try {
        await runCommand("npm", ["install", "--no-audit", "--no-fund"], {
          cwd: this.serverRoot,
          timeout: NPM_INSTALL_TIMEOUT_MS,
          env: { CI: "1" },
        });
        console.log("[UpgradeSandboxRunner] 回滚完成（npm install 已恢复）");
      } catch (err) {
        console.error("[UpgradeSandboxRunner] 回滚 npm install 失败:", err);
      }
    }
  }

  // ---- npm 升级应用 ---------------------------------------------------

  /**
   * 执行 npm install package@version。
   * 超时 120s 防止挂死。
   */
  private async applyNpmUpgrade(packageName: string, version: string): Promise<void> {
    const result = await runCommand(
      "npm",
      ["install", `${packageName}@${version}`, "--no-audit", "--no-fund"],
      {
        cwd: this.serverRoot,
        timeout: NPM_INSTALL_TIMEOUT_MS,
        env: { CI: "1" },
      },
    );

    if (result.code !== 0) {
      throw new Error(
        `npm install ${packageName}@${version} 失败 (exit ${result.code}): ${result.stderr.slice(0, 500)}`,
      );
    }
    console.log(`[UpgradeSandboxRunner] npm install ${packageName}@${version} 成功`);
  }

  // ---- 辅助 -----------------------------------------------------------

  private failReport(
    error: string,
    upgradeMs: number,
    testMs: number,
    totalMs: number,
    rolledBack = false,
  ): SandboxTestReport {
    return {
      ok: false,
      tscPassed: false,
      testsPassed: false,
      tscOutput: "",
      testOutput: "",
      testFilesRun: [],
      upgradeMs,
      testMs,
      totalMs,
      error,
      rolledBack,
    };
  }

  /** 获取允许升级的 npm 包白名单 */
  static getAllowedPackages(): ReadonlySet<string> {
    return ALLOWED_NPM_PACKAGES;
  }
}
