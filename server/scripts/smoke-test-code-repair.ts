// CodeRepairCortex smoke test
//
// 验证内容：
//   1. 状态机流转：pending → isolating → analyzing → patching → testing → applying → fixed
//   2. patch 真实应用到源码文件
//   3. 备份目录创建
//   4. 路径安全闸门：DENY 文件被拒，ALLOWED 文件通过
//   5. 持久化文件写入
//
// 使用 mock LLM + mock TestRunner，不依赖真实外部服务。

import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile, readFile, access } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { CodeRepairCortex } from "../src/brain/code-repair-cortex.js";
import type {
  CodeRepairLlmLike,
  RepairTestRunnerLike,
} from "../src/brain/code-repair-cortex.js";
import type { BugSignal } from "../src/brain/types.js";

// ---- 测试辅助 --------------------------------------------------------

function log(msg: string): void {
  console.log(`[smoke] ${msg}`);
}

function pass(msg: string): void {
  console.log(`[smoke] ✓ ${msg}`);
}

function fail(msg: string): void {
  console.error(`[smoke] ✗ ${msg}`);
  process.exitCode = 1;
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`超时 ${label}（${ms}ms）`)), ms),
    ),
  ]);
}

// ---- 测试场景 1：完整修复闭环 ---------------------------------------

async function testFullRepairLoop(): Promise<void> {
  log("=== 测试 1：完整修复闭环 ===");

  // 准备测试沙箱目录
  const sandbox = resolve("data", "self-healing-sandbox");
  const serverRoot = sandbox;
  const sessionsRoot = join(sandbox, "sessions");
  const persistPath = join(sandbox, "proposals.json");

  // 清理上次的测试数据
  await rm(sandbox, { recursive: true, force: true }).catch(() => {});
  await mkdir(sandbox, { recursive: true });
  await mkdir(join(serverRoot, "src", "ws", "handlers"), { recursive: true });

  // 在 src/ws/handlers/ 下创建一个有 bug 的文件
  const bugFilePath = join(serverRoot, "src/ws/handlers/test-bug.ts");
  const bugFileContent = `// 测试用的有 bug 文件
export function handleChat(msg: string): string {
  return undefined as unknown as string;
}
`;
  await writeFile(bugFilePath, bugFileContent, "utf8");
  log(`已创建测试文件：${bugFilePath}`);

  // ---- mock LLM ----
  // 返回预制的根因分析 + patch
  // 注意判断顺序：generatePatch 的 systemPrompt 也包含"根因分析"（在"基于根因分析生成"中），
  // 所以必须先检查"代码修复专家"再检查"根因分析专家"（更独特的字符串）
  let llmCallCount = 0;
  const mockLlm: CodeRepairLlmLike = {
    async complete(systemPrompt, userPrompt, opts) {
      llmCallCount += 1;
      void opts;
      // patch 生成（先判断，因为 systemPrompt 里"代码修复专家"更独特）
      if (systemPrompt.includes("代码修复专家")) {
        const patch = `--- a/src/ws/handlers/test-bug.ts
+++ b/src/ws/handlers/test-bug.ts
@@ -1,4 +1,4 @@
 // 测试用的有 bug 文件
 export function handleChat(msg: string): string {
-  return undefined as unknown as string;
+  return msg || "";
 }
`;
        return JSON.stringify({
          patch,
          explanation: "把 undefined 改为返回空字符串或消息本身",
        });
      }
      // 根因分析
      if (systemPrompt.includes("根因分析专家")) {
        return JSON.stringify({
          rootCause:
            "handleChat 函数返回 undefined，应该返回有效字符串。建议改成返回空字符串或默认值。",
          refinedSuspects: ["src/ws/handlers/test-bug.ts"],
        });
      }
      return "{}";
    },
  };

  // ---- mock TestRunner ----
  // 直接返回 ok=true，不实际跑 tsc
  const mockTestRunner: RepairTestRunnerLike = {
    async runTests(opts) {
      void opts;
      return {
        ok: true,
        output: "=== tsc --noEmit ===\n0 errors\n=== test ===\nall passed",
        durationMs: 100,
      };
    },
  };

  // 实例化 CodeRepairCortex
  const cortex = new CodeRepairCortex({
    serverRoot,
    persistPath,
    sessionsRoot,
  });
  cortex.registerLlm(mockLlm);
  cortex.registerTestRunner(mockTestRunner);

  log("启动 CodeRepairCortex...");
  await cortex.start();

  // 报告 bug 信号
  const signal: BugSignal = {
    source: "user_report",
    title: "handleChat 返回 undefined",
    errorMessage: "TypeError: Cannot read property of undefined",
    suspectFiles: ["src/ws/handlers/test-bug.ts"],
  };
  log(`报告 bug 信号：${signal.title}`);
  const proposal = await cortex.reportBug(signal);
  log(`提案已创建：id=${proposal.id}, status=${proposal.status}`);

  // 等待修复闭环完成（最多 10s）
  let finalProposal = proposal;
  try {
    await withTimeout(
      (async () => {
        while (
          finalProposal.status === "pending" ||
          finalProposal.status === "isolating" ||
          finalProposal.status === "analyzing" ||
          finalProposal.status === "patching" ||
          finalProposal.status === "testing" ||
          finalProposal.status === "applying"
        ) {
          await new Promise((r) => setTimeout(r, 200));
          const updated = cortex.getRepair(proposal.id);
          if (updated) finalProposal = updated;
        }
      })(),
      10_000,
      "等待修复闭环",
    );
  } catch (err) {
    fail(`修复闭环超时：${err instanceof Error ? err.message : String(err)}`);
    log(`当前状态：${finalProposal.status}`);
    log(`lastError：${finalProposal.lastError ?? "(无)"}`);
    await cortex.stop();
    return;
  }

  // ---- 验证结果 ----
  log("---- 验证结果 ----");

  // 1. 状态为 fixed
  if (finalProposal.status === "fixed") {
    pass(`状态为 fixed`);
  } else {
    fail(`状态应为 fixed，实际 ${finalProposal.status}`);
    log(`lastError: ${finalProposal.lastError ?? "(无)"}`);
    log(`testOutput: ${finalProposal.testOutput ?? "(无)"}`);
  }

  // 2. LLM 被调用过 2 次（根因分析 + patch 生成）
  if (llmCallCount === 2) {
    pass(`LLM 调用 ${llmCallCount} 次（预期 2）`);
  } else {
    fail(`LLM 调用次数应为 2，实际 ${llmCallCount}`);
  }

  // 3. rootCause 已写入
  if (finalProposal.rootCause && finalProposal.rootCause.length > 0) {
    pass(`rootCause 已写入：${finalProposal.rootCause.slice(0, 60)}...`);
  } else {
    fail(`rootCause 为空`);
  }

  // 4. patch 已写入
  if (finalProposal.patch && finalProposal.patch.length > 0) {
    pass(`patch 已写入（${finalProposal.patch.length} 字符）`);
  } else {
    fail(`patch 为空`);
  }

  // 5. 测试通过
  if (finalProposal.testPassed === true) {
    pass(`testPassed = true`);
  } else {
    fail(`testPassed 应为 true`);
  }

  // 6. backup 目录已创建
  if (finalProposal.backupDir && existsSync(finalProposal.backupDir)) {
    pass(`backup 目录已创建：${finalProposal.backupDir}`);
  } else {
    fail(`backup 目录未创建`);
  }

  // 7. 源码文件已被实际修改
  const modifiedContent = await readFile(bugFilePath, "utf8");
  if (modifiedContent.includes('return msg || ""')) {
    pass(`源码已修改：undefined → msg || ""`);
  } else {
    fail(`源码未被修改，实际内容：\n${modifiedContent}`);
  }

  // 8. 备份文件存在（包含原始内容）
  if (finalProposal.backupDir) {
    const backupFile = join(
      finalProposal.backupDir,
      "src__ws__handlers__test-bug.ts",
    );
    if (existsSync(backupFile)) {
      const backupContent = await readFile(backupFile, "utf8");
      if (backupContent.includes("undefined as unknown as string")) {
        pass(`备份文件包含原始内容`);
      } else {
        fail(`备份文件内容不正确：\n${backupContent}`);
      }
    } else {
      fail(`备份文件不存在：${backupFile}`);
    }
  }

  // 9. 持久化文件已写入（含本次提案，状态为 fixed）
  // 注：可能含历史残留提案（之前跑过的），只验证本次提案存在且状态正确
  // 注：schedulePersist 是 1s debounce 的，需要等一下再读
  await new Promise((r) => setTimeout(r, 1500));
  if (existsSync(persistPath)) {
    const persistContent = await readFile(persistPath, "utf8");
    const envelope = JSON.parse(persistContent);
    const thisProposal = envelope.proposals?.find(
      (p: { id: string }) => p.id === finalProposal.id,
    );
    if (thisProposal && thisProposal.status === "fixed") {
      pass(`持久化文件已写入，本次提案 ${finalProposal.id.slice(0, 16)}... 状态 = fixed`);
    } else {
      fail(
        `持久化文件中未找到本次提案或状态不对（id=${finalProposal.id}，找到 ${thisProposal?.status ?? "none"})`,
      );
    }
  } else {
    fail(`持久化文件未创建`);
  }

  await cortex.stop();
  log("测试 1 完成\n");
}

// ---- 测试场景 2：路径安全闸门（DENY 文件被拒） ------------------------

async function testDenyPathBlocked(): Promise<void> {
  log("=== 测试 2：路径安全闸门 ===");

  const sandbox = resolve("data", "self-healing-sandbox-deny");
  const serverRoot = sandbox;
  await rm(sandbox, { recursive: true, force: true }).catch(() => {});
  await mkdir(join(serverRoot, "src", "brain"), { recursive: true });

  // 创建一个 limbic-cortex.ts 文件（在 DENY 列表中）
  const denyFilePath = join(serverRoot, "src/brain/limbic-cortex.ts");
  await writeFile(
    denyFilePath,
    "export const DENY = true;\n",
    "utf8",
  );
  log(`已创建 DENY 测试文件：${denyFilePath}`);

  // ---- mock LLM ----
  // 返回一个试图修改 limbic-cortex.ts 的 patch
  // 注意判断顺序：先检查"代码修复专家"再检查"根因分析专家"
  const mockLlm: CodeRepairLlmLike = {
    async complete(systemPrompt, userPrompt, opts) {
      void opts;
      void userPrompt;
      // patch 生成（先判断）
      if (systemPrompt.includes("代码修复专家")) {
        return JSON.stringify({
          patch: `--- a/src/brain/limbic-cortex.ts
+++ b/src/brain/limbic-cortex.ts
@@ -1 +1 @@
-export const DENY = true;
+export const DENY = false;
`,
          explanation: "试图修改安全闸门",
        });
      }
      // 根因分析
      if (systemPrompt.includes("根因分析专家")) {
        return JSON.stringify({
          rootCause: "测试 DENY 闸门",
          refinedSuspects: ["src/brain/limbic-cortex.ts"],
        });
      }
      return "{}";
    },
  };

  const mockTestRunner: RepairTestRunnerLike = {
    async runTests() {
      return { ok: true, output: "", durationMs: 1 };
    },
  };

  const cortex = new CodeRepairCortex({
    serverRoot,
    persistPath: join(sandbox, "proposals.json"),
    sessionsRoot: join(sandbox, "sessions"),
  });
  cortex.registerLlm(mockLlm);
  cortex.registerTestRunner(mockTestRunner);
  await cortex.start();

  const signal: BugSignal = {
    source: "user_report",
    title: "测试 DENY 闸门",
    suspectFiles: ["src/brain/limbic-cortex.ts"],
  };
  const proposal = await cortex.reportBug(signal);

  // 等待闭环完成或失败
  let finalProposal = proposal;
  try {
    await withTimeout(
      (async () => {
        while (
          finalProposal.status === "pending" ||
          finalProposal.status === "isolating" ||
          finalProposal.status === "analyzing" ||
          finalProposal.status === "patching" ||
          finalProposal.status === "testing" ||
          finalProposal.status === "applying"
        ) {
          await new Promise((r) => setTimeout(r, 200));
          const updated = cortex.getRepair(proposal.id);
          if (updated) finalProposal = updated;
        }
      })(),
      10_000,
      "等待 DENY 闸门触发",
    );
  } catch (err) {
    fail(`等待超时：${err instanceof Error ? err.message : String(err)}`);
    await cortex.stop();
    return;
  }

  log(`最终状态：${finalProposal.status}`);
  log(`lastError：${finalProposal.lastError ?? "(无)"}`);

  // 验证：状态应为 failed（路径校验失败抛错）
  if (finalProposal.status === "failed" || finalProposal.status === "rejected") {
    pass(`DENY 路径被拒绝（状态 = ${finalProposal.status}）`);
  } else {
    fail(`DENY 路径未被拒绝，状态 = ${finalProposal.status}`);
  }

  // 验证 lastError 提到了路径拒绝
  if (finalProposal.lastError?.includes("DENY") || finalProposal.lastError?.includes("不允许")) {
    pass(`lastError 提到 DENY/不允许`);
  } else {
    fail(`lastError 未提到 DENY：${finalProposal.lastError}`);
  }

  // 验证源码文件未被修改
  const content = await readFile(denyFilePath, "utf8");
  if (content.includes("DENY = true")) {
    pass(`DENY 文件未被修改`);
  } else {
    fail(`DENY 文件被修改了！内容：\n${content}`);
  }

  await cortex.stop();
  log("测试 2 完成\n");
}

// ---- 主入口 ----------------------------------------------------------

async function main(): Promise<void> {
  console.log("====================================");
  console.log("  CodeRepairCortex Smoke Test");
  console.log("====================================\n");

  await testFullRepairLoop();
  await testDenyPathBlocked();

  console.log("\n====================================");
  console.log("  Smoke Test 完成");
  console.log("====================================");
}

main().catch((err) => {
  console.error("[smoke] 未捕获异常:", err);
  process.exit(1);
});
