import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type InputFilterDecision = {
  accepted: boolean;
  reason: "valid" | "small_talk" | "duplicate" | "empty" | "noise";
  normalizedText: string;
};

export type TaskStackEntry = {
  taskId: string;
  title: string;
  status: "active" | "paused" | "completed";
  contextSummary: string;
  createdAt: string;
  updatedAt: string;
};

type SessionTaskState = {
  activeTaskId: string | null;
  tasks: TaskStackEntry[];
  recentInputs: string[];
};

type PersistedTaskState = {
  sessions: Record<string, SessionTaskState>;
};

export type TaskSyncResult = {
  task: TaskStackEntry;
  resumed: boolean;
};

export type TaskTurnDisposition =
  | { action: "none" }
  | { action: "pause"; reason: string }
  | { action: "complete"; reason: string };

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeInput(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function tokenize(text: string): string[] {
  return normalizeInput(text)
    .toLowerCase()
    .split(/[\s,.;:!?，。；：！？、/\\|()[\]{}<>]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function overlapScore(left: string, right: string): number {
  const a = new Set(tokenize(left));
  const b = new Set(tokenize(right));
  if (a.size === 0 || b.size === 0) return 0;
  let hits = 0;
  for (const token of a) {
    if (b.has(token)) hits += 1;
  }
  return hits / Math.max(Math.min(a.size, b.size), 1);
}

function looksLikeNoise(text: string): boolean {
  return /^[\s.,!?~\-_=+*/\\|()[\]{}<>:;'"`]+$/.test(text);
}

function looksLikeSmallTalk(text: string): boolean {
  return /^(你好|好的|嗯|哦|收到|谢谢|ok|okay|thanks|早安|晚安)[!,.? ]*$/i.test(text);
}

function shouldPauseFromUserText(text: string): boolean {
  return /(先放一边|先暂停|暂停一下|等等再说|回头再做|晚点再弄|稍后继续|先不做了|先搁置)/i.test(text);
}

function shouldCompleteFromUserText(text: string): boolean {
  return /(搞定了|完成了|结束了|这个任务做完了|就这样吧|不用继续了|可以收尾了|已经处理好了)/i.test(text);
}

function shouldCompleteFromAssistantText(text: string): boolean {
  return /(已完成|已经完成|处理完成|任务完成|执行完成|已经为你.*(完成|处理好)|全部完成)/i.test(text);
}

function shouldPauseFromAssistantText(text: string): boolean {
  return /(已先暂停|先为你挂起|等待你确认后继续|后续可继续|你随时可以继续这个任务)/i.test(text);
}

export class ShortTermMemoryGatewayService {
  private readonly filePath: string;
  private data: PersistedTaskState = { sessions: {} };
  private persistChain: Promise<void> = Promise.resolve();

  constructor(filePath?: string) {
    this.filePath =
      filePath ?? process.env.AGENT_SHORT_TERM_STACK_FILE?.trim() ?? join(process.cwd(), "data", "short-term-task-stack.json");
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as PersistedTaskState;
      if (parsed?.sessions && typeof parsed.sessions === "object") {
        this.data = parsed;
      }
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? String((error as NodeJS.ErrnoException).code)
          : "";
      if (code !== "ENOENT") throw error;
    }
  }

  filterInput(sessionId: string, input: string): InputFilterDecision {
    const normalizedText = normalizeInput(input);
    if (!normalizedText) {
      return { accepted: false, reason: "empty", normalizedText };
    }
    if (looksLikeNoise(normalizedText)) {
      return { accepted: false, reason: "noise", normalizedText };
    }
    if (looksLikeSmallTalk(normalizedText)) {
      return { accepted: false, reason: "small_talk", normalizedText };
    }

    const state = this.getSessionState(sessionId);
    if (state.recentInputs.includes(normalizedText.toLowerCase())) {
      return { accepted: false, reason: "duplicate", normalizedText };
    }

    state.recentInputs.push(normalizedText.toLowerCase());
    state.recentInputs = state.recentInputs.slice(-12);
    this.schedulePersist();
    return { accepted: true, reason: "valid", normalizedText };
  }

  activateTask(sessionId: string, title: string, contextSummary: string): TaskStackEntry {
    const state = this.getSessionState(sessionId);
    const previousActive = state.tasks.find((task) => task.taskId === state.activeTaskId);
    if (previousActive && previousActive.status === "active") {
      previousActive.status = "paused";
      previousActive.updatedAt = nowIso();
    }

    const task: TaskStackEntry = {
      taskId: `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      title,
      status: "active",
      contextSummary,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    state.tasks.unshift(task);
    state.tasks = state.tasks.slice(0, 20);
    state.activeTaskId = task.taskId;
    this.schedulePersist();
    return task;
  }

  syncTaskForTurn(sessionId: string, input: string): TaskSyncResult {
    const normalizedInput = normalizeInput(input);
    const state = this.getSessionState(sessionId);
    const active = state.tasks.find((task) => task.taskId === state.activeTaskId) ?? null;

    if (active) {
      const activeScore = Math.max(
        overlapScore(`${active.title} ${active.contextSummary}`, normalizedInput),
        normalizedInput.toLowerCase().includes(active.title.toLowerCase()) ? 0.9 : 0,
      );
      if (activeScore >= 0.35) {
        active.contextSummary = normalizedInput.slice(0, 180);
        active.updatedAt = nowIso();
        this.schedulePersist();
        return { task: active, resumed: false };
      }
    }

    const pausedMatch = state.tasks
      .filter((task) => task.status === "paused")
      .map((task) => ({
        task,
        score: Math.max(
          overlapScore(`${task.title} ${task.contextSummary}`, normalizedInput),
          normalizedInput.toLowerCase().includes(task.title.toLowerCase()) ? 0.9 : 0,
        ),
      }))
      .sort((a, b) => b.score - a.score)[0];

    if (pausedMatch && pausedMatch.score >= 0.45) {
      const resumed = this.resumeTask(sessionId, pausedMatch.task.taskId);
      if (resumed) {
        resumed.contextSummary = normalizedInput.slice(0, 180);
        resumed.updatedAt = nowIso();
        this.schedulePersist();
        return { task: resumed, resumed: true };
      }
    }

    return {
      task: this.activateTask(sessionId, normalizedInput.slice(0, 36), normalizedInput.slice(0, 180)),
      resumed: false,
    };
  }

  pauseActiveTask(sessionId: string, contextSummary?: string): void {
    const state = this.getSessionState(sessionId);
    const active = state.tasks.find((task) => task.taskId === state.activeTaskId);
    if (!active) return;
    active.status = "paused";
    if (contextSummary?.trim()) active.contextSummary = contextSummary.trim();
    active.updatedAt = nowIso();
    state.activeTaskId = null;
    this.schedulePersist();
  }

  resumeTask(sessionId: string, taskId: string): TaskStackEntry | null {
    const state = this.getSessionState(sessionId);
    const next = state.tasks.find((task) => task.taskId === taskId);
    if (!next) return null;
    const active = state.tasks.find((task) => task.taskId === state.activeTaskId);
    if (active && active.taskId !== taskId) {
      active.status = "paused";
      active.updatedAt = nowIso();
    }
    next.status = "active";
    next.updatedAt = nowIso();
    state.activeTaskId = next.taskId;
    this.schedulePersist();
    return next;
  }

  completeTask(sessionId: string, taskId: string): void {
    const state = this.getSessionState(sessionId);
    const task = state.tasks.find((item) => item.taskId === taskId);
    if (!task) return;
    task.status = "completed";
    task.updatedAt = nowIso();
    if (state.activeTaskId === taskId) state.activeTaskId = null;
    this.schedulePersist();
  }

  reconcileTaskAfterTurn(sessionId: string, userText: string, assistantText: string): TaskTurnDisposition {
    const state = this.getSessionState(sessionId);
    const active = state.tasks.find((task) => task.taskId === state.activeTaskId) ?? null;
    if (!active) return { action: "none" };

    const normalizedUser = normalizeInput(userText);
    const normalizedAssistant = normalizeInput(assistantText);

    if (shouldCompleteFromUserText(normalizedUser) || shouldCompleteFromAssistantText(normalizedAssistant)) {
      this.completeTask(sessionId, active.taskId);
      return { action: "complete", reason: "turn_completed" };
    }

    if (shouldPauseFromUserText(normalizedUser) || shouldPauseFromAssistantText(normalizedAssistant)) {
      this.pauseActiveTask(sessionId, normalizedUser.slice(0, 180) || active.contextSummary);
      return { action: "pause", reason: "turn_paused" };
    }

    return { action: "none" };
  }

  getTaskState(sessionId: string): SessionTaskState {
    const state = this.getSessionState(sessionId);
    return {
      activeTaskId: state.activeTaskId,
      tasks: [...state.tasks],
      recentInputs: [...state.recentInputs],
    };
  }

  buildPromptContext(sessionId: string, currentInput?: string): string | undefined {
    const state = this.getTaskState(sessionId);
    const active = state.tasks.find((task) => task.taskId === state.activeTaskId) ?? null;
    const paused = state.tasks.filter((task) => task.status === "paused").slice(0, 3);
    const completed = state.tasks.filter((task) => task.status === "completed").slice(0, 2);
    const lines: string[] = [];

    if (active) {
      lines.push(`current-focus: ${active.title}`);
      lines.push(`important focus-summary: ${active.contextSummary}`);
    }
    if (paused.length > 0) {
      lines.push(`suspended-tasks: ${paused.map((task) => `${task.title} | ${task.contextSummary}`).join(" || ")}`);
    }
    if (completed.length > 0) {
      lines.push(`recently-completed: ${completed.map((task) => task.title).join(" | ")}`);
    }
    if (currentInput?.trim()) {
      lines.push(`incoming-turn: ${normalizeInput(currentInput).slice(0, 180)}`);
    }

    const { coreLines, compressedLines } = this.compressContext(lines);
    const merged = [...coreLines, ...compressedLines].slice(0, 8);
    if (merged.length === 0) return undefined;
    return ["STM task stack:", ...merged.map((line) => `- ${line}`)].join("\n");
  }

  buildRecallQuery(sessionId: string, currentInput: string): string {
    const state = this.getSessionState(sessionId);
    const active = state.tasks.find((task) => task.taskId === state.activeTaskId) ?? null;
    const paused = state.tasks.filter((task) => task.status === "paused").slice(0, 2);
    const parts = [normalizeInput(currentInput)];

    if (active) {
      parts.push(`current task ${active.title}`);
      parts.push(active.contextSummary);
    }
    if (paused.length > 0) {
      parts.push(`suspended tasks ${paused.map((task) => task.title).join(" ")}`);
    }
    return parts.filter(Boolean).join(" | ");
  }

  compressContext(lines: string[]): { coreLines: string[]; compressedLines: string[] } {
    const coreLines = lines.filter((line) => /重要|必须|务必|偏好|禁忌|记住|SOP|步骤|流程/.test(line)).slice(0, 8);
    const compressedLines = lines
      .filter((line) => !coreLines.includes(line))
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .slice(-10);
    return { coreLines, compressedLines };
  }

  private getSessionState(sessionId: string): SessionTaskState {
    if (!this.data.sessions[sessionId]) {
      this.data.sessions[sessionId] = {
        activeTaskId: null,
        tasks: [],
        recentInputs: [],
      };
    }
    return this.data.sessions[sessionId]!;
  }

  private schedulePersist(): void {
    this.persistChain = this.persistChain.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(this.filePath, `${JSON.stringify(this.data, null, 2)}\n`, "utf8");
    });
  }
}

let singleton: ShortTermMemoryGatewayService | null = null;

export function getShortTermMemoryGatewayService(): ShortTermMemoryGatewayService | null {
  return singleton;
}

export async function initShortTermMemoryGatewayService(): Promise<ShortTermMemoryGatewayService> {
  if (singleton) return singleton;
  const service = new ShortTermMemoryGatewayService();
  await service.load();
  singleton = service;
  return service;
}
