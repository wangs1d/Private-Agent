/**
 * 验证「服务重启后自动恢复未完成的自主任务」真实效果。
 *
 * 流程：
 *  1. 用临时持久化文件创建 5 个不同状态的任务（executing/pending/paused/awaiting_approval/done）
 *  2. 落盘后重置单例并重新加载 —— 模拟服务重启
 *  3. 复刻 AgentCore.resumeAutonomousTasks 的恢复逻辑（只恢复 pending/planning/executing/verifying）
 *  4. mock LLM provider 直接返回「任务完成」，断言：
 *     - executing / pending 任务被恢复并跑到 done（断点子任务续跑）
 *     - paused / awaiting_approval / done 任务不被恢复、保持原状态
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── 1. 指向临时持久化文件（必须在模块加载前设置，store 构造时读取）──
const tmpDir = mkdtempSync(join(tmpdir(), "agent-task-resume-"));
const persistFile = join(tmpDir, "agent-tasks.json");
process.env.AGENT_TASK_PERSIST_FILE = persistFile;

const { getAgentTaskStore, resetAgentTaskStoreForTests } = await import(
  "../src/services/agent-task-store.js"
);
const { AgentTaskOrchestrator } = await import("../src/services/agent-task-orchestrator.js");
const typeExternal = await import("../src/external-model/types.js");
const typeTools = await import("../src/tools/tool-registry.js");

const nowIso = new Date().toISOString();

// ── 2. 写入 5 个不同状态的任务（模拟重启前的持久化快照）──
const store = getAgentTaskStore();

const tExec = store.create({
  actorId: "verify-user",
  sessionId: "verify-session",
  goal: "恢复测试A：执行中任务（带已完成的断点子任务）",
  maxRounds: 5,
  tags: ["verify"],
});
store.update(tExec.id, (t) => {
  t.status = "executing";
  t.currentRound = 3;
  t.subtasks = [
    { id: "s1", description: "第一步（重启前已完成）", status: "done", attempts: 1, maxAttempts: 3, createdAt: nowIso, completedAt: nowIso },
    { id: "s2", description: "第二步（重启前进行中）", status: "in_progress", attempts: 1, maxAttempts: 3, createdAt: nowIso, startedAt: nowIso },
    { id: "s3", description: "第三步（重启前未开始）", status: "pending", attempts: 0, maxAttempts: 3, createdAt: nowIso },
  ];
});

const tPending = store.create({
  actorId: "verify-user",
  sessionId: "verify-session",
  goal: "恢复测试B：排队未开始任务",
  maxRounds: 5,
  tags: ["verify"],
});

const tPaused = store.create({
  actorId: "verify-user",
  sessionId: "verify-session",
  goal: "恢复测试C：用户主动暂停任务（不应恢复）",
  maxRounds: 5,
  tags: ["verify"],
});
store.update(tPaused.id, (t) => {
  t.status = "paused";
});

const tApproval = store.create({
  actorId: "verify-user",
  sessionId: "verify-session",
  goal: "恢复测试D：等待人工审批任务（不应恢复）",
  maxRounds: 5,
  tags: ["verify"],
});
store.update(tApproval.id, (t) => {
  t.status = "awaiting_approval";
  t.requiresApproval = true;
});

const tDone = store.create({
  actorId: "verify-user",
  sessionId: "verify-session",
  goal: "恢复测试E：已完成任务（不应恢复）",
  maxRounds: 5,
  tags: ["verify"],
});
store.update(tDone.id, (t) => {
  t.status = "done";
  t.completedAt = nowIso;
});

await store.flush();
console.log(`[1/4] 已写入 5 个任务到 ${persistFile}`);
for (const [label, id] of [["executing", tExec.id], ["pending", tPending.id], ["paused", tPaused.id], ["awaiting_approval", tApproval.id], ["done", tDone.id]]) {
  const t = store.get(id)!;
  console.log(`      ${label.padEnd(18)} ${id}  status=${t.status}  subtasks=${t.subtasks.length}`);
}

// ── 3. 模拟服务重启：重置单例 → 重新加载持久化文件 ──
resetAgentTaskStoreForTests();
const reloaded = getAgentTaskStore();
await reloaded.load();
console.log(`[2/4] 模拟重启完成，已从磁盘加载 ${reloaded.list().length} 个任务`);

// ── 4. 复刻 AgentCore.resumeAutonomousTasks 的恢复逻辑 ──
// mock provider：直接返回「任务完成」，让状态机一次跑到 done
const mockProvider = {
  id: "mock-resume-verify",
  displayLabel: "MockResumeVerify",
  isEnabled: () => true,
  streamCompletion: async (
    _sessionId: string,
    _userTurn: unknown,
    onDelta: (d: string) => void,
  ): Promise<string> => {
    onDelta("子任务完成\n任务完成");
    return "子任务完成\n任务完成";
  },
} as unknown as typeExternal.ExternalChatProvider;

const mockToolRegistry = {
  execute: async () => ({ ok: true, result: {} }),
} as unknown as typeTools.ToolRegistry;

const orchestrator = new AgentTaskOrchestrator({ provider: mockProvider, toolRegistry: mockToolRegistry });

const runnable = reloaded
  .list()
  .filter(
    (t) =>
      t.status === "pending" ||
      t.status === "planning" ||
      t.status === "executing" ||
      t.status === "verifying",
  );

const restoredIds: string[] = [];
for (const t of runnable) {
  const ok = orchestrator.resumeTask(t.id, {
    onProgress: (e) => console.log(`      [progress] ${e.taskId.slice(-8)} ${e.type} ${e.message}`),
  });
  if (ok) restoredIds.push(t.id);
}
console.log(`[3/4] 恢复候选 ${runnable.length} 个，实际启动 ${restoredIds.length} 个`);

// ── 5. 等待主循环跑完（最多 10s）──
async function waitForStatus(id: string, terminal: string[], timeoutMs: number): Promise<string> {
  const start = Date.now();
  for (;;) {
    const t = reloaded.get(id);
    if (t && terminal.includes(t.status)) return t.status;
    if (Date.now() - start > timeoutMs) return reloaded.get(id)?.status ?? "missing";
    await new Promise((r) => setTimeout(r, 100));
  }
}

const statusExec = await waitForStatus(tExec.id, ["done", "failed"], 10_000);
const statusPending = await waitForStatus(tPending.id, ["done", "failed"], 10_000);

console.log(`[4/4] 断言结果：`);
const tExecFinal = reloaded.get(tExec.id)!;
const tPendingFinal = reloaded.get(tPending.id)!;
const tPausedFinal = reloaded.get(tPaused.id)!;
const tApprovalFinal = reloaded.get(tApproval.id)!;
const tDoneFinal = reloaded.get(tDone.id)!;

const checks: Array<{ name: string; pass: boolean; detail: string }> = [
  {
    name: "executing 任务被恢复并完成",
    pass: restoredIds.includes(tExec.id) && statusExec === "done",
    detail: `final=${statusExec}`,
  },
  {
    name: "executing 断点子任务续跑完成（s2/s3 → done）",
    pass: tExecFinal.subtasks.every((s) => s.status === "done"),
    detail: `subtasks=${tExecFinal.subtasks.map((s) => `${s.id}:${s.status}`).join(",")}`,
  },
  {
    name: "pending 任务被恢复并完成",
    pass: restoredIds.includes(tPending.id) && statusPending === "done",
    detail: `final=${statusPending}`,
  },
  {
    name: "paused 任务不被自动恢复",
    pass: !restoredIds.includes(tPaused.id) && tPausedFinal.status === "paused",
    detail: `final=${tPausedFinal.status}`,
  },
  {
    name: "awaiting_approval 任务不被自动恢复",
    pass: !restoredIds.includes(tApproval.id) && tApprovalFinal.status === "awaiting_approval",
    detail: `final=${tApprovalFinal.status}`,
  },
  {
    name: "done 任务不受影响",
    pass: !restoredIds.includes(tDone.id) && tDoneFinal.status === "done",
    detail: `final=${tDoneFinal.status}`,
  },
  {
    name: "恢复数量 = 2",
    pass: restoredIds.length === 2,
    detail: `restored=${restoredIds.length}`,
  },
];

let allPass = true;
for (const c of checks) {
  console.log(`      ${c.pass ? "PASS" : "FAIL"}  ${c.name}  (${c.detail})`);
  if (!c.pass) allPass = false;
}

// ── 清理 ──
try {
  rmSync(tmpDir, { recursive: true, force: true });
} catch {
  /* ignore */
}

if (!allPass) {
  console.error("[verify-task-resume] 存在失败项");
  process.exit(1);
}
console.log("[verify-task-resume] 全部通过：重启后自动恢复自主任务逻辑符合预期");
