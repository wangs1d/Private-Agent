// Agent Brain Center — 自我修复皮层
//
// 设计目标：当 Agent 在运行时遇到 bug（异常、兜底频发、编译失败、用户报告）时，
// 自动隔离问题 → 分析根因 → 生成 patch → 跑测试 → 应用并回滚。
//
// 与 EvolutionCortex 的边界：
//  - EvolutionCortex：生成 NEW skill handler（capability-modules/ 下），不碰源码骨架
//  - CodeRepairCortex：修改 src/ 下已有源码骨架，修 bug 不增能力
//
// 安全边界（白名单 + 黑名单 + 双闸门）：
//  ALLOWED：src/ws/、src/external-model/、src/utils/、src/tools/、src/agent/、
//           src/services/、src/skills/
//  DENY：   limbic-cortex.ts（安全闸门）、brain-center.ts（外观）、
//           code-repair-cortex.ts（自身）、agent-self-learning-service.ts、
//           package.json、tsconfig.json、.env、process 级入口
//
// 状态机：
//   pending → isolating → analyzing → patching → testing → applying → fixed
//                                                    ↘ failed (retryCount < maxRetries → 重试)
//                                                    ↘ rejected (retryCount >= maxRetries)
//
// 设计原则（用户明确要求）：
//  1. 出问题的地方把它隔离 → isolate() 把相关文件 + 日志 + 上下文打包到会话目录
//  2. 让 agent 自己去修复 → analyze + patch 调 LLM 生成 unified diff
//  3. 自己测试 → runTests() 跑 tsc --noEmit + 受控的 test 子集
//  4. 自己改正 → applyPatch 应用 + 失败回滚 + 重试
//
// 默认通过 env BRAIN_CODE_REPAIR_ENABLED=1 开启；未开启时所有方法 no-op。

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, cp, rm, access } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import type {
  BugSignal,
  BugSignalSource,
  RepairProposal,
  RepairStatus,
} from "./types.js";

// ---- 子系统最小化外观接口 ---------------------------------------------

/** LLM 调用外观：CodeRepairCortex 通过它做根因分析 + patch 生成 */
export interface CodeRepairLlmLike {
  /**
   * 一次性 LLM 调用（非流式）。返回完整文本。
   * CodeRepairCortex 不直接依赖 ExternalChatProvider，避免与主聊天通道耦合。
   */
  complete(
    systemPrompt: string,
    userPrompt: string,
    opts?: { maxTokens?: number; temperature?: number },
  ): Promise<string>;
}

/** 测试运行器外观：cortex 不直接 spawn tsc/test，由调用方注入实现 */
export interface RepairTestRunnerLike {
  /**
   * 运行测试。返回 ok=true 表示通过。
   * 默认实现会跑 `tsc --noEmit` + 可选的 test 子集。
   * cortex 内部提供默认实现（DefaultTestRunner），调用方可注入自定义实现。
   */
  runTests(opts: {
    suspectFiles: string[];
  }): Promise<{ ok: boolean; output: string; durationMs: number }>;
}

// ---- 持久化结构 -------------------------------------------------------

interface PersistEnvelope {
  version: 1;
  proposals: RepairProposal[];
}

// ---- 路径安全闸门 -----------------------------------------------------

/**
 * 允许修改的目录前缀（相对 server/ 根）。
 * 任何 patch 中的文件路径必须落在这几个前缀之内。
 *
 * 设计原则：自我修复本就是能够修复所有出现问题的地方。
 * 除 DENY 列表外的所有 src/ 子目录都在白名单内：
 *  - src/brain/ 之外的所有 cortex 也算被修复对象（cortex 本身也是 brain 模块）
 *  - src/brain/ 内除安全闸门/外观/自身外的其他 cortex（memory/planner/proaction/...）
 *  - src/ 下所有其他子目录（ws/external-model/utils/tools/agent/services/skills/
 *    agentic-memory/device-bus/routes/config/http-rate-limit/vision/tokenjuice/
 *    schemas/types/aip/bootstrap）
 *  - scripts/（测试脚本）
 */
const ALLOWED_DIR_PREFIXES = [
  "src/",
  "scripts/",
];

/**
 * 禁止修改的文件（即使落在 ALLOWED 目录内也拦截）。
 *
 * 最小化原则：只列「自我修改会引发反馈循环或安全失效」的文件：
 *  - 安全闸门（limbic-cortex）：自我削弱
 *  - 外观（brain-center）：注册逻辑自我篡改
 *  - 自身（code-repair-cortex）：防反馈循环
 *  - 学习数据源（agent-self-learning-service）：防污染
 *  - skill 装载（skill-promotion-pipeline）：防绕过安全闸门
 *  - 启动入口（start-with-gateway.mjs）：防改启动逻辑
 *
 * 注：evolution-cortex.ts 不在 DENY 列表。
 *   - EvolutionCortex 负责新架构/新算法的自我进化（生成新 skill/重构模块）
 *   - CodeRepairCortex 负责修 evolution-cortex.ts 本身的 bug
 *   - 两者职责不同，互不冲突
 */
const DENY_FILES = new Set<string>([
  "src/brain/limbic-cortex.ts", // 安全闸门：禁止自我削弱
  "src/brain/brain-center.ts", // 外观：禁止改注册逻辑
  "src/brain/code-repair-cortex.ts", // 自身：禁止自我修改
  "src/services/agent-self-learning-service.ts", // 学习数据源：禁止污染
  "src/services/skill-promotion-pipeline.ts", // skill 装载：禁止改安全闸门
  "scripts/start-with-gateway.mjs", // 启动入口：禁止改
]);

/**
 * 黑名单关键字：patch 内容若包含这些字符串直接拒绝（防 prompt injection 让 LLM 写恶意代码）。
 */
const PATCH_FORBIDDEN_PATTERNS: RegExp[] = [
  /child_process\.exec\s*\(/, // 防 exec 任意命令注入
  /eval\s*\(/, // 防 eval
  /new\s+Function\s*\(/, // 防动态函数构造
  /require\s*\(\s*['"][^'"]*['"]\s*\)/, // 防 require 任意模块（CommonJS）
  /process\.env\.[A-Z_]+_KEY\s*=/, // 防覆盖密钥
  // Phase 5.5：禁止 patch 直接修改 package.json（依赖升级走专门审批流程）
  /["']\/?package\.json["']/, // 防 patch 路径包含 package.json
  /npm\s+(install|uninstall|update)\s+--save/, // 防 npm install 修改依赖
  /yarn\s+(add|remove|upgrade)/, // 防 yarn 修改依赖
  /pnpm\s+(add|remove|update)/, // 防 pnpm 修改依赖
];

// ---- 辅助：路径安全校验 ------------------------------------------------

/**
 * 把任意路径归一化为相对 server/ 根的 POSIX 风格路径。
 * 校验是否在 ALLOWED 范围内且不在 DENY 列表。
 */
function normalizeAndCheckPath(
  rawPath: string,
  serverRoot: string,
): { ok: boolean; normalized: string; reason?: string } {
  // 转 POSIX 风格（替换 \\）
  const abs = resolve(serverRoot, rawPath);
  const rel = relative(serverRoot, abs).replace(/\\/g, "/");
  if (rel.startsWith("..")) {
    return { ok: false, normalized: rel, reason: "路径越界（位于 server/ 之外）" };
  }
  if (DENY_FILES.has(rel)) {
    return { ok: false, normalized: rel, reason: `路径在 DENY 列表中（${rel}）` };
  }
  const inAllowed = ALLOWED_DIR_PREFIXES.some((p) => rel.startsWith(p));
  if (!inAllowed) {
    return {
      ok: false,
      normalized: rel,
      reason: `路径不在允许修改的目录内（${rel}）`,
    };
  }
  return { ok: true, normalized: rel };
}

/** 检查 patch 内容是否含危险模式 */
function containsForbiddenPatterns(patch: string): string | null {
  for (const re of PATCH_FORBIDDEN_PATTERNS) {
    if (re.test(patch)) {
      return re.source;
    }
  }
  return null;
}

// ---- 默认测试运行器 ----------------------------------------------------

/**
 * 默认测试运行器：跑 tsc --noEmit + test 子集。
 * 实际执行通过 spawn，超时 60s 防止挂死。
 */
export class DefaultTestRunner implements RepairTestRunnerLike {
  constructor(
    private readonly serverRoot: string,
    private readonly opts: { tscTimeoutMs?: number; testTimeoutMs?: number } = {},
  ) {}

  async runTests(opts: {
    suspectFiles: string[];
  }): Promise<{ ok: boolean; output: string; durationMs: number }> {
    const start = Date.now();
    const tscTimeout = this.opts.tscTimeoutMs ?? 60_000;
    const output: string[] = [];

    // 阶段 1：tsc --noEmit（编译通过是最低门槛）
    try {
      const tscResult = await this.runCommand(
        "npx",
        ["tsc", "--noEmit", "-p", "tsconfig.json"],
        tscTimeout,
      );
      output.push("=== tsc --noEmit ===");
      output.push(tscResult.stdout);
      output.push(tscResult.stderr);
      if (tscResult.code !== 0) {
        return {
          ok: false,
          output: output.join("\n"),
          durationMs: Date.now() - start,
        };
      }
    } catch (e) {
      output.push(`=== tsc 异常 ===\n${e instanceof Error ? e.message : String(e)}`);
      return { ok: false, output: output.join("\n"), durationMs: Date.now() - start };
    }

    // 阶段 2：跑相关 test 文件（仅当 suspectFiles 有匹配的 .test.ts）
    // 测试文件命名约定：foo.ts → foo.test.ts（同级 test/ 目录或同目录）
    const testFiles = this.findTestFilesForSuspects(opts.suspectFiles);
    if (testFiles.length > 0) {
      const testTimeout = this.opts.testTimeoutMs ?? 30_000;
      try {
        const testResult = await this.runCommand(
          "npx",
          ["tsx", "--test", ...testFiles],
          testTimeout,
        );
        output.push("=== tsx --test ===");
        output.push(testResult.stdout);
        output.push(testResult.stderr);
        if (testResult.code !== 0) {
          return {
            ok: false,
            output: output.join("\n"),
            durationMs: Date.now() - start,
          };
        }
      } catch (e) {
        output.push(`=== test 异常 ===\n${e instanceof Error ? e.message : String(e)}`);
        return { ok: false, output: output.join("\n"), durationMs: Date.now() - start };
      }
    }

    return { ok: true, output: output.join("\n"), durationMs: Date.now() - start };
  }

  private findTestFilesForSuspects(suspects: string[]): string[] {
    const tests: string[] = [];
    for (const s of suspects) {
      // foo/bar.ts → foo/bar.test.ts
      const testPath = s.replace(/\.ts$/, ".test.ts");
      const abs = resolve(this.serverRoot, testPath);
      if (existsSync(abs)) {
        tests.push(testPath);
      }
    }
    return tests;
  }

  private runCommand(
    cmd: string,
    args: string[],
    timeoutMs: number,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const proc = spawn(cmd, args, {
        cwd: this.serverRoot,
        shell: process.platform === "win32",
        env: { ...process.env, CI: "1" },
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        proc.kill("SIGTERM");
        reject(new Error(`命令超时（${timeoutMs}ms）：${cmd} ${args.join(" ")}`));
      }, timeoutMs);
      proc.stdout.on("data", (d) => {
        stdout += d.toString();
      });
      proc.stderr.on("data", (d) => {
        stderr += d.toString();
      });
      proc.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? -1, stdout, stderr });
      });
      proc.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }
}

// ---- 工具：从 LLM 输出中提取 JSON --------------------------------------

/**
 * 从 LLM 输出中提取 JSON 对象（容错处理 ```json 包裹 + 前后噪声）。
 */
function extractJsonFromLlm(text: string): unknown | null {
  let t = text.trim();
  // 去掉 ```json ... ``` 包裹
  const fenceMatch = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    t = fenceMatch[1].trim();
  }
  // 找第一个 { 到最后一个 }（贪婪但限制范围）
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;
  const jsonStr = t.slice(first, last + 1);
  try {
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}

// ---- CodeRepairCortex 主体 --------------------------------------------

/**
 * 自我修复皮层。
 *
 * 触发入口：
 *  1. reportBug(signal)：外部代码 / process 监听 / 用户报告都走这个
 *  2. 自动 loop：每 N 分钟扫描 pending → 触发一次修复尝试
 *
 * 修复闭环：
 *  pending → isolating（备份 + 收集文件）→ analyzing（LLM 根因）→
 *  patching（LLM 生成 unified diff）→ testing（tsc + test）→
 *  applying（应用 patch）→ 重新 testing → fixed
 *  任意阶段失败 → failed + retryCount++ → 下轮重试 → 达上限 rejected
 */
export class CodeRepairCortex {
  private readonly proposals = new Map<string, RepairProposal>();
  private llm: CodeRepairLlmLike | null = null;
  private testRunner: RepairTestRunnerLike | null = null;

  private readonly serverRoot: string;
  private readonly persistPath: string;
  private readonly sessionsRoot: string;
  private persistTimer: NodeJS.Timeout | null = null;
  private started = false;

  /** 自动重试 loop 定时器 */
  private autoLoopTimer: NodeJS.Timeout | null = null;
  /** 自动 loop 间隔：5 分钟 */
  private static readonly AUTO_LOOP_INTERVAL_MS = 5 * 60 * 1000;
  /** 最大重试次数：超过即转 rejected */
  private static readonly MAX_RETRIES = 3;
  /** 单次 LLM 调用超时：60s */
  private static readonly LLM_TIMEOUT_MS = 60_000;

  constructor(opts?: {
    serverRoot?: string;
    persistPath?: string;
    sessionsRoot?: string;
  }) {
    this.serverRoot = opts?.serverRoot ?? process.cwd();
    this.persistPath =
      opts?.persistPath ??
      process.env.BRAIN_CODE_REPAIR_PERSIST_PATH?.trim() ??
      join(this.serverRoot, "data", "brain-code-repair-proposals.json");
    this.sessionsRoot =
      opts?.sessionsRoot ??
      process.env.BRAIN_CODE_REPAIR_SESSIONS_ROOT?.trim() ??
      join(this.serverRoot, "data", "self-healing");
  }

  // ---- 子系统注册 ------------------------------------------------------

  registerLlm(llm: CodeRepairLlmLike): void {
    this.llm = llm;
    console.log("[CodeRepairCortex] 已注册 Llm");
  }

  registerTestRunner(runner: RepairTestRunnerLike): void {
    this.testRunner = runner;
    console.log("[CodeRepairCortex] 已注册 TestRunner");
  }

  // ---- 生命周期 --------------------------------------------------------

  async start(): Promise<void> {
    if (this.started) {
      console.log("[CodeRepairCortex] 已启动，跳过重复 start");
      return;
    }
    await this.load();
    this.started = true;
    this.startAutoLoop();
    console.log("[CodeRepairCortex] 启动完成（自动修复 loop 已启动）");
  }

  async stop(): Promise<void> {
    if (!this.started) {
      console.log("[CodeRepairCortex] 未启动，跳过 stop");
      return;
    }
    if (this.autoLoopTimer) {
      clearInterval(this.autoLoopTimer);
      this.autoLoopTimer = null;
    }
    await this.flush();
    this.started = false;
    console.log("[CodeRepairCortex] 已停止");
  }

  // ---- 公共 API：报告 bug + 查询 ---------------------------------------

  /**
   * 报告一个 bug 信号。会自动创建 pending 提案并触发修复尝试。
   * 返回创建的 RepairProposal（含 id）。
   */
  async reportBug(signal: BugSignal): Promise<RepairProposal> {
    const now = new Date().toISOString();
    const id = signal.id ?? `repair-${randomUUID()}`;
    const proposal: RepairProposal = {
      id,
      bugSignalId: signal.id ?? id,
      source: signal.source,
      title: signal.title,
      errorMessage: signal.errorMessage,
      suspectFiles: signal.suspectFiles ?? [],
      status: "pending",
      retryCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.proposals.set(id, proposal);
    this.schedulePersist();
    console.log(`[CodeRepairCortex] 收到 bug 信号 [${signal.source}] ${signal.title}`);

    // 立即触发一次修复尝试（不阻塞调用方）
    void this.tryRepair(id).catch((err) => {
      console.error(`[CodeRepairCortex] 立即修复异常 ${id}:`, err);
    });

    return proposal;
  }

  /** 列出所有修复提案（可按状态过滤） */
  listRepairs(status?: RepairStatus): RepairProposal[] {
    const all = Array.from(this.proposals.values());
    if (status) return all.filter((p) => p.status === status);
    return all;
  }

  /** 查询单个修复提案 */
  getRepair(id: string): RepairProposal | null {
    return this.proposals.get(id) ?? null;
  }

  /** 用户强制重试某个 failed 提案 */
  async retry(id: string): Promise<RepairProposal | null> {
    const p = this.proposals.get(id);
    if (!p) return null;
    if (p.status !== "failed" && p.status !== "rejected") {
      console.log(`[CodeRepairCortex] retry: ${id} 状态 ${p.status}，仅 failed 可重试`);
      return p;
    }
    // 重置为 pending，retryCount 不变（达到 MAX_RETRIES 时不能再 retry）
    if (p.retryCount >= CodeRepairCortex.MAX_RETRIES) {
      console.log(
        `[CodeRepairCortex] retry: ${id} 已达最大重试次数 ${CodeRepairCortex.MAX_RETRIES}`,
      );
      return this.setStatus(p, "rejected");
    }
    const reset = this.setStatus(p, "pending");
    this.proposals.set(id, reset);
    this.schedulePersist();
    void this.tryRepair(id).catch((err) => {
      console.error(`[CodeRepairCortex] retry 异常 ${id}:`, err);
    });
    return reset;
  }

  // ---- 修复闭环主流程 --------------------------------------------------

  private startAutoLoop(): void {
    if (this.autoLoopTimer) clearInterval(this.autoLoopTimer);
    this.autoLoopTimer = setInterval(() => {
      void this.runAutoLoop().catch((err) => {
        console.error("[CodeRepairCortex] autoLoop 异常:", err);
      });
    }, CodeRepairCortex.AUTO_LOOP_INTERVAL_MS);
    if (typeof this.autoLoopTimer.unref === "function") {
      this.autoLoopTimer.unref();
    }
  }

  /**
   * 自动 loop：扫描 failed 提案 → 重试。
   * pending 提案在 reportBug 时已立即触发，loop 不重复处理。
   */
  private async runAutoLoop(): Promise<void> {
    for (const proposal of this.proposals.values()) {
      if (proposal.status !== "failed") continue;
      if (proposal.retryCount >= CodeRepairCortex.MAX_RETRIES) {
        this.setStatus(proposal, "rejected");
        continue;
      }
      // 重置为 pending 触发重试
      const reset = this.setStatus(proposal, "pending");
      this.proposals.set(proposal.id, reset);
      console.log(
        `[CodeRepairCortex] autoLoop 重试 ${proposal.id}（第 ${reset.retryCount + 1} 次）`,
      );
      await this.tryRepair(proposal.id).catch((err) => {
        console.error(`[CodeRepairCortex] autoLoop 重试 ${proposal.id} 异常:`, err);
      });
    }
  }

  /**
   * 单次修复尝试：完整走 pending → isolating → analyzing → patching → testing → applying → fixed。
   * 任意阶段失败 → failed + retryCount++。
   */
  private async tryRepair(proposalId: string): Promise<void> {
    const current = this.proposals.get(proposalId);
    if (!current) return;
    if (current.status === "fixed" || current.status === "rejected") return;
    if (current.status === "pending" || current.status === "failed") {
      // 继续修复
    } else {
      // 正在修复中（isolating/analyzing/...），不重复触发
      return;
    }

    try {
      // 阶段 1：isolating（收集文件内容 + 错误堆栈）
      const isolated = await this.isolate(current);
      const isolatingProposal = this.setStatus(current, "isolating");
      isolatingProposal.isolatedContext = isolated;
      this.proposals.set(proposalId, isolatingProposal);
      this.schedulePersist();

      if (!this.llm) {
        throw new Error("LLM 未注册，无法分析根因");
      }

      // 阶段 2：analyzing（LLM 分析根因 + 给出嫌疑文件）
      const analyzingProposal = this.setStatus(isolatingProposal, "analyzing");
      this.proposals.set(proposalId, analyzingProposal);
      this.schedulePersist();
      const analysis = await this.analyzeRootCause(analyzingProposal, isolated);
      analyzingProposal.rootCause = analysis.rootCause;
      if (analysis.refinedSuspects.length > 0) {
        analyzingProposal.suspectFiles = analysis.refinedSuspects;
      }
      this.proposals.set(proposalId, analyzingProposal);
      this.schedulePersist();

      // 阶段 3：patching（LLM 生成 unified diff）
      const patchingProposal = this.setStatus(analyzingProposal, "patching");
      this.proposals.set(proposalId, patchingProposal);
      this.schedulePersist();
      const patchResult = await this.generatePatch(patchingProposal);
      if (!patchResult.ok || !patchResult.patch) {
        throw new Error(patchResult.error ?? "LLM 未生成有效 patch");
      }
      // 路径安全闸门：检查 patch 中所有文件路径
      const pathCheck = this.validatePatchPaths(patchResult.patch);
      if (!pathCheck.ok) {
        throw new Error(`patch 路径安全检查失败：${pathCheck.reason}`);
      }
      // 内容安全闸门：检查危险模式
      const forbidden = containsForbiddenPatterns(patchResult.patch);
      if (forbidden) {
        throw new Error(`patch 含危险模式：${forbidden}`);
      }
      patchingProposal.patch = patchResult.patch;
      patchingProposal.explanation = patchResult.explanation;
      this.proposals.set(proposalId, patchingProposal);
      this.schedulePersist();

      // 阶段 4：testing（先在隔离环境跑 tsc/test）
      const testingProposal = this.setStatus(patchingProposal, "testing");
      this.proposals.set(proposalId, testingProposal);
      this.schedulePersist();

      if (!this.testRunner) {
        throw new Error("TestRunner 未注册");
      }

      // 应用 patch 前先备份
      const backupDir = await this.createBackup(testingProposal);
      testingProposal.backupDir = backupDir;

      // 应用 patch（先应用，再测试；失败回滚）
      try {
        await this.applyPatch(patchResult.patch);
      } catch (applyErr) {
        // 应用失败：立即回滚 + 标记 failed
        await this.rollbackFromBackup(backupDir).catch((rbErr) => {
          console.error(`[CodeRepairCortex] 应用失败后回滚异常 ${proposalId}:`, rbErr);
        });
        throw new Error(
          `patch 应用失败：${applyErr instanceof Error ? applyErr.message : String(applyErr)}`,
        );
      }

      // 跑测试
      const testResult = await this.testRunner.runTests({
        suspectFiles: testingProposal.suspectFiles,
      });
      testingProposal.testOutput = testResult.output;
      testingProposal.testPassed = testResult.ok;

      if (!testResult.ok) {
        // 测试失败：回滚
        await this.rollbackFromBackup(backupDir).catch((rbErr) => {
          console.error(`[CodeRepairCortex] 测试失败后回滚异常 ${proposalId}:`, rbErr);
        });
        throw new Error(
          `测试未通过：${testResult.output.slice(-400)}`,
        );
      }

      // 阶段 5：applying（测试通过，标记 fixed）
      const fixedProposal = this.setStatus(testingProposal, "applying");
      this.proposals.set(proposalId, fixedProposal);
      this.schedulePersist();
      // 实际上 patch 已应用且测试通过，直接转 fixed
      const finalProposal = this.setStatus(fixedProposal, "fixed");
      this.proposals.set(proposalId, finalProposal);
      this.schedulePersist();
      console.log(`[CodeRepairCortex] 修复完成 ${proposalId}：${finalProposal.title}`);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[CodeRepairCortex] 修复失败 ${proposalId}:`, errMsg);
      const failed = this.setStatus(this.proposals.get(proposalId)!, "failed");
      failed.lastError = errMsg;
      failed.retryCount += 1;
      if (failed.retryCount >= CodeRepairCortex.MAX_RETRIES) {
        const rejected = this.setStatus(failed, "rejected");
        this.proposals.set(proposalId, rejected);
        console.log(
          `[CodeRepairCortex] 提案 ${proposalId} 已达最大重试次数，转 rejected`,
        );
      } else {
        this.proposals.set(proposalId, failed);
      }
      this.schedulePersist();
    }
  }

  // ---- 阶段实现：isolating ---------------------------------------------

  /**
   * 隔离问题：读取嫌疑文件内容 + 错误堆栈，打包到 isolatedContext。
   */
  private async isolate(proposal: RepairProposal): Promise<Record<string, string>> {
    const ctx: Record<string, string> = {};
    if (proposal.errorMessage) {
      ctx["__error__"] = proposal.errorMessage;
    }
    if (proposal.suspectFiles.length === 0) {
      // 无嫌疑文件时，从错误堆栈中提取 .ts 文件路径
      proposal.suspectFiles = this.extractFilePathsFromStack(
        proposal.errorMessage ?? "",
      );
    }
    // 读取每个嫌疑文件（限制每个 8KB，防止过大）
    for (const relPath of proposal.suspectFiles.slice(0, 10)) {
      const check = normalizeAndCheckPath(relPath, this.serverRoot);
      if (!check.ok) {
        ctx[relPath] = `[路径不允许读取：${check.reason}]`;
        continue;
      }
      try {
        const abs = resolve(this.serverRoot, check.normalized);
        const content = await readFile(abs, "utf8");
        ctx[check.normalized] =
          content.length > 8192
            ? content.slice(0, 8192) + "\n... [truncated]"
            : content;
      } catch (e) {
        ctx[relPath] = `[读取失败：${e instanceof Error ? e.message : String(e)}]`;
      }
    }
    return ctx;
  }

  private extractFilePathsFromStack(stack: string): string[] {
    const paths = new Set<string>();
    const re = /((?:src|server)[\/\\][\w\-./\\]+\.ts):(\d+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(stack)) !== null) {
      // 归一化：去掉开头的 server/ 前缀
      let p = m[1].replace(/\\/g, "/");
      p = p.replace(/^server\//, "");
      paths.add(p);
    }
    return Array.from(paths).slice(0, 10);
  }

  // ---- 阶段实现：analyzing ---------------------------------------------

  private async analyzeRootCause(
    proposal: RepairProposal,
    isolated: Record<string, string>,
  ): Promise<{ rootCause: string; refinedSuspects: string[] }> {
    if (!this.llm) {
      throw new Error("LLM 未注册");
    }
    const systemPrompt = `你是代码根因分析专家。基于 bug 信号 + 已隔离的文件内容，分析问题根因。
严格输出 JSON：{"rootCause": "...", "refinedSuspects": ["src/path/to/file.ts"]}
- rootCause：3-5 句话说明根因
- refinedSuspects：根因相关的文件路径列表（相对 server/ 根）
不要输出任何 JSON 之外的内容。`;

    const fileBlock = Object.entries(isolated)
      .map(([path, content]) => `--- ${path} ---\n${content}`)
      .join("\n\n");

    const userPrompt = `Bug 信号：
  source: ${proposal.source}
  title: ${proposal.title}
  errorMessage:
${proposal.errorMessage ?? "(无)"}

嫌疑文件内容：
${fileBlock}

分析根因并精炼嫌疑文件列表。`;

    const llmResp = await this.callLlmWithTimeout(systemPrompt, userPrompt, {
      maxTokens: 1500,
      temperature: 0.2,
    });
    const parsed = extractJsonFromLlm(llmResp) as
      | { rootCause?: string; refinedSuspects?: string[] }
      | null;
    if (!parsed || typeof parsed.rootCause !== "string") {
      throw new Error("LLM 根因分析输出无法解析");
    }
    return {
      rootCause: parsed.rootCause,
      refinedSuspects: Array.isArray(parsed.refinedSuspects)
        ? parsed.refinedSuspects.filter((s) => typeof s === "string")
        : [],
    };
  }

  // ---- 阶段实现：patching ----------------------------------------------

  private async generatePatch(
    proposal: RepairProposal,
  ): Promise<{ ok: boolean; patch?: string; explanation?: string; error?: string }> {
    if (!this.llm) {
      return { ok: false, error: "LLM 未注册" };
    }
    const systemPrompt = `你是代码修复专家。基于根因分析生成 unified diff patch。

【重要约束】
1. 输出 unified diff 格式（git diff 风格），例如：
--- a/src/ws/handlers/foo.ts
+++ b/src/ws/handlers/foo.ts
@@ -10,7 +10,7 @@
 旧行
-被删除的行
+新增的行
 旧行

2. 只能修改以下目录内的文件：
${ALLOWED_DIR_PREFIXES.map((p) => "   - " + p).join("\n")}

3. 禁止修改以下文件：
${Array.from(DENY_FILES).map((f) => "   - " + f).join("\n")}

4. 禁止在 patch 中写入以下危险代码：
   - child_process.exec / eval / new Function
   - require() 动态模块加载
   - 覆盖 process.env 中的 KEY 类变量

5. 修复要最小化：只改必要的几行，不要重写整个文件。

严格输出 JSON：
{"patch": "unified diff 字符串", "explanation": "1-2 句话说明改动"}
不要输出 JSON 之外的任何内容。`;

    const fileBlock = Object.entries(proposal.isolatedContext ?? {})
      .map(([path, content]) => `--- ${path} ---\n${content}`)
      .join("\n\n");

    const userPrompt = `Bug 标题：${proposal.title}

根因分析：
${proposal.rootCause ?? "(无)"}

嫌疑文件内容：
${fileBlock}

生成 unified diff patch。`;

    const llmResp = await this.callLlmWithTimeout(systemPrompt, userPrompt, {
      maxTokens: 3000,
      temperature: 0.1,
    });
    const parsed = extractJsonFromLlm(llmResp) as
      | { patch?: string; explanation?: string }
      | null;
    if (!parsed || typeof parsed.patch !== "string" || !parsed.patch.trim()) {
      return { ok: false, error: "LLM 未输出有效 patch" };
    }
    return {
      ok: true,
      patch: parsed.patch,
      explanation: typeof parsed.explanation === "string" ? parsed.explanation : undefined,
    };
  }

  /** 校验 patch 中所有文件路径是否在 ALLOWED 范围内 */
  private validatePatchPaths(patch: string): {
    ok: boolean;
    reason?: string;
  } {
    const paths = new Set<string>();
    const re = /^[+-]{3}\s+(?:a\/|b\/)?(\S+)/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(patch)) !== null) {
      // 跳过 /dev/null（新建文件场景，但本 cortex 不支持新建，仍校验）
      if (m[1] === "/dev/null") continue;
      paths.add(m[1]);
    }
    for (const p of paths) {
      const check = normalizeAndCheckPath(p, this.serverRoot);
      if (!check.ok) {
        return { ok: false, reason: `${p}: ${check.reason}` };
      }
    }
    return { ok: true };
  }

  // ---- 阶段实现：applying（patch 应用 + 备份 + 回滚） -------------------

  /**
   * 创建备份目录，把所有 suspectFiles 备份过去。
   * 备份目录路径：data/self-healing/<repairId>/backup/
   */
  private async createBackup(proposal: RepairProposal): Promise<string> {
    const backupDir = join(this.sessionsRoot, proposal.id, "backup");
    await mkdir(backupDir, { recursive: true });
    for (const relPath of proposal.suspectFiles) {
      const check = normalizeAndCheckPath(relPath, this.serverRoot);
      if (!check.ok) continue;
      const src = resolve(this.serverRoot, check.normalized);
      const dst = join(backupDir, check.normalized.replace(/\//g, "__"));
      try {
        await access(src);
        await cp(src, dst);
      } catch {
        // 文件可能不存在（新建场景，本 cortex 暂不支持），跳过
      }
    }
    return backupDir;
  }

  /**
   * 应用 unified diff patch 到源码。
   * 实现简化版：解析每个 hunk，对每个文件做 in-place 替换。
   * 不调系统 patch 命令（Windows 上不可靠），用 JS 实现。
   */
  private async applyPatch(patch: string): Promise<void> {
    const files = this.parsePatchIntoFileHunks(patch);
    for (const file of files) {
      const check = normalizeAndCheckPath(file.path, this.serverRoot);
      if (!check.ok) {
        throw new Error(`拒绝应用 patch 到不允许的路径：${file.path}（${check.reason}）`);
      }
      const abs = resolve(this.serverRoot, check.normalized);
      let original: string;
      try {
        original = await readFile(abs, "utf8");
      } catch (e) {
        throw new Error(`读取文件失败 ${file.path}：${e instanceof Error ? e.message : String(e)}`);
      }
      const lines = original.split(/\r?\n/);
      const result = this.applyHunksToFile(lines, file.hunks);
      if (result.ok) {
        await writeFile(abs, result.lines.join("\n"), "utf8");
      } else {
        throw new Error(`应用 hunk 失败 ${file.path}：${result.reason}`);
      }
    }
  }

  /**
   * 把 unified diff 解析为 [{path, hunks}] 结构。
   * 简化实现：只支持标准 git diff 输出。
   */
  private parsePatchIntoFileHunks(patch: string): Array<{
    path: string;
    hunks: Array<{
      oldStart: number;
      oldLength: number;
      newStart: number;
      newLength: number;
      lines: Array<{ kind: "context" | "del" | "add"; text: string }>;
    }>;
  }> {
    const files: Array<{
      path: string;
      hunks: Array<{
        oldStart: number;
        oldLength: number;
        newStart: number;
        newLength: number;
        lines: Array<{ kind: "context" | "del" | "add"; text: string }>;
      }>;
    }> = [];
    let curFile: (typeof files)[number] | null = null;
    let curHunk: (typeof files)[number]["hunks"][number] | null = null;

    const lines = patch.split(/\r?\n/);
    for (const line of lines) {
      // 文件头：--- a/... 或 +++ b/...
      const plusMatch = line.match(/^\+\+\+\s+(?:b\/)?(\S+)/);
      if (plusMatch) {
        // 以 +++ 行作为文件标识（--- 行常带 a/ 前缀，统一用 +++ 提取）
        if (curFile) files.push(curFile);
        curFile = { path: plusMatch[1], hunks: [] };
        curHunk = null;
        continue;
      }
      // hunk 头：@@ -10,7 +10,7 @@
      const hunkMatch = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
      if (hunkMatch) {
        if (!curFile) {
          // 没有 +++ 头就出现 hunk，异常
          continue;
        }
        curHunk = {
          oldStart: parseInt(hunkMatch[1], 10),
          oldLength: hunkMatch[2] ? parseInt(hunkMatch[2], 10) : 1,
          newStart: parseInt(hunkMatch[3], 10),
          newLength: hunkMatch[4] ? parseInt(hunkMatch[4], 10) : 1,
          lines: [],
        };
        curFile.hunks.push(curHunk);
        continue;
      }
      // hunk 内容行：以 ' '（context）、'-'（del）、'+'（add）开头
      if (curHunk && (line.startsWith(" ") || line.startsWith("-") || line.startsWith("+"))) {
        const kind: "context" | "del" | "add" =
          line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "context";
        curHunk.lines.push({ kind, text: line.slice(1) });
      }
    }
    if (curFile) files.push(curFile);
    return files;
  }

  /**
   * 应用 hunks 到 lines 数组。
   * 简化实现：按 oldStart 顺序逐个 hunk 替换。
   */
  private applyHunksToFile(
    lines: string[],
    hunks: Array<{
      oldStart: number;
      lines: Array<{ kind: "context" | "del" | "add"; text: string }>;
    }>,
  ): { ok: boolean; lines: string[]; reason?: string } {
    // 复制一份，避免修改原数组
    let result = [...lines];
    // hunks 按 oldStart 降序处理（避免替换影响后续索引）
    const sorted = [...hunks].sort((a, b) => b.oldStart - a.oldStart);
    for (const hunk of sorted) {
      // 0-based 索引
      const startIdx = hunk.oldStart - 1;
      // 找到 hunk 中第一个非 add 行（context/del）在 result 中的位置
      // 简化策略：直接按 oldStart 替换连续的 del+context，再插入 add
      const contextAndDel = hunk.lines.filter((l) => l.kind !== "add");
      const adds = hunk.lines.filter((l) => l.kind === "add");
      // 校验 context/del 行是否匹配
      for (let i = 0; i < contextAndDel.length; i++) {
        const expected = contextAndDel[i].text;
        const actual = result[startIdx + i] ?? "";
        if (actual !== expected && actual.trim() !== expected.trim()) {
          return {
            ok: false,
            lines,
            reason: `hunk 在第 ${startIdx + i + 1} 行不匹配：期望 "${expected}"，实际 "${actual}"`,
          };
        }
      }
      // 替换：删除 contextAndDel.length 行，插入 adds + 保留 context 行
      const newLines: string[] = [];
      let ci = 0; // contextAndDel 索引
      let ai = 0; // adds 索引
      // 按 hunk.lines 原顺序重建
      for (const h of hunk.lines) {
        if (h.kind === "add") {
          newLines.push(h.text);
        } else {
          // context：保留原行；del：跳过
          if (h.kind === "context") {
            newLines.push(result[startIdx + ci] ?? h.text);
          }
          ci++;
        }
        if (h.kind === "add") ai++;
      }
      // 替换 [startIdx, startIdx + contextAndDel.length) 为 newLines
      result = [
        ...result.slice(0, startIdx),
        ...newLines,
        ...result.slice(startIdx + contextAndDel.length),
      ];
    }
    return { ok: true, lines: result };
  }

  /**
   * 从备份目录还原所有文件。
   */
  private async rollbackFromBackup(backupDir: string): Promise<void> {
    if (!existsSync(backupDir)) return;
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(backupDir);
    for (const f of files) {
      const src = join(backupDir, f);
      // 还原路径：把 __ 替换回 /
      const relPath = f.replace(/__/g, "/");
      const check = normalizeAndCheckPath(relPath, this.serverRoot);
      if (!check.ok) {
        console.warn(`[CodeRepairCortex] 回滚跳过非法路径：${relPath}`);
        continue;
      }
      const dst = resolve(this.serverRoot, check.normalized);
      try {
        await cp(src, dst);
        console.log(`[CodeRepairCortex] 已回滚：${check.normalized}`);
      } catch (e) {
        console.error(`[CodeRepairCortex] 回滚失败 ${relPath}:`, e);
      }
    }
  }

  // ---- LLM 调用辅助 ----------------------------------------------------

  private async callLlmWithTimeout(
    systemPrompt: string,
    userPrompt: string,
    opts: { maxTokens?: number; temperature?: number },
  ): Promise<string> {
    if (!this.llm) throw new Error("LLM 未注册");
    return await Promise.race([
      this.llm.complete(systemPrompt, userPrompt, opts),
      new Promise<string>((_, reject) => {
        setTimeout(
          () => reject(new Error("LLM 调用超时")),
          CodeRepairCortex.LLM_TIMEOUT_MS,
        );
      }),
    ]);
  }

  // ---- 状态机辅助 ------------------------------------------------------

  private setStatus(
    proposal: RepairProposal,
    status: RepairStatus,
  ): RepairProposal {
    return {
      ...proposal,
      status,
      updatedAt: new Date().toISOString(),
    };
  }

  // ---- 持久化 ----------------------------------------------------------

  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.flush().catch((err) => {
        console.error("[CodeRepairCortex] persist 异常:", err);
      });
    }, 1000);
  }

  private async flush(): Promise<void> {
    const envelope: PersistEnvelope = {
      version: 1,
      proposals: Array.from(this.proposals.values()),
    };
    try {
      await mkdir(dirname(this.persistPath), { recursive: true });
      await writeFile(this.persistPath, JSON.stringify(envelope, null, 2), "utf8");
    } catch (err) {
      console.error("[CodeRepairCortex] flush 失败:", err);
    }
  }

  private async load(): Promise<void> {
    try {
      const raw = await readFile(this.persistPath, "utf8");
      const envelope = JSON.parse(raw) as PersistEnvelope;
      if (envelope && Array.isArray(envelope.proposals)) {
        for (const p of envelope.proposals) {
          this.proposals.set(p.id, p);
        }
        console.log(
          `[CodeRepairCortex] 已加载 ${envelope.proposals.length} 个修复提案`,
        );
      }
    } catch {
      // 文件不存在或解析失败：首次启动
    }
  }
}
