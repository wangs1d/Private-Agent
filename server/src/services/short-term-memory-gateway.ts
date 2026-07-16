import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

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
  conversationMemory?: SessionConversationMemory;
};

type PersistedTaskState = {
  sessions: Record<string, SessionTaskState>;
};

type SessionConversationMemory = {
  activeTopic: string | null;
  currentMission: string | null;
  carryForward: string[];
  preferences: string[];
  facts: string[];
  openLoops: string[];
  agentCommitments: string[];
  lastUpdated: string;
};

export type TaskSyncResult = {
  task: TaskStackEntry;
  resumed: boolean;
};

export type TaskTurnDisposition =
  | { action: "none" }
  | { action: "pause"; reason: string }
  | { action: "complete"; reason: string };

const MEMORY_LIST_LIMIT = 6;
const ASSISTANT_COMMITMENT_RE =
  /我会|我将|已经帮你|已为你|我先|稍后|接下来|我去|我帮你|i will|i'll|i can/i;
const USER_PREFERENCE_RE = /喜欢|讨厌|偏好|习惯|不要|别|禁忌|生日|纪念日|remember|prefer/i;
const USER_FACT_RE = /我是|我在做|我最近在|我的项目|我正在|我计划|我住在|我需要/i;
const REQUEST_RE = /请|帮我|需要|想要|分析|总结|提醒|安排|继续|修复|优化|看看|做一个/i;

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

function isTaskSeekingTurn(text: string): boolean {
  const normalized = normalizeInput(text);
  if (!normalized) return false;
  if (REQUEST_RE.test(normalized)) return true;
  if (normalized.length >= 18) return true;
  return false;
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

function firstSentence(text: string, maxLen = 160): string {
  const normalized = normalizeInput(text);
  if (!normalized) return "";
  const sentence = normalized.split(/[。！？!?\n]/)[0]?.trim() || normalized;
  return sentence.length > maxLen ? `${sentence.slice(0, maxLen - 3).trimEnd()}...` : sentence;
}

function pushUnique(target: string[], value: string, limit = MEMORY_LIST_LIMIT): void {
  const normalized = normalizeInput(value);
  if (!normalized) return;
  const deduped = target.filter((item) => normalizeInput(item) !== normalized);
  deduped.unshift(normalized);
  target.splice(0, target.length, ...deduped.slice(0, limit));
}

function createEmptyConversationMemory(): SessionConversationMemory {
  return {
    activeTopic: null,
    currentMission: null,
    carryForward: [],
    preferences: [],
    facts: [],
    openLoops: [],
    agentCommitments: [],
    lastUpdated: nowIso(),
  };
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
    if (!active) {
      this.observeConversationTurn(sessionId, userText, assistantText, { action: "none" });
      return { action: "none" };
    }

    const normalizedUser = normalizeInput(userText);
    const normalizedAssistant = normalizeInput(assistantText);

    if (shouldCompleteFromUserText(normalizedUser) || shouldCompleteFromAssistantText(normalizedAssistant)) {
      this.completeTask(sessionId, active.taskId);
      const disposition = { action: "complete", reason: "turn_completed" } as const;
      this.observeConversationTurn(sessionId, userText, assistantText, disposition);
      return disposition;
    }

    if (shouldPauseFromUserText(normalizedUser) || shouldPauseFromAssistantText(normalizedAssistant)) {
      this.pauseActiveTask(sessionId, normalizedUser.slice(0, 180) || active.contextSummary);
      const disposition = { action: "pause", reason: "turn_paused" } as const;
      this.observeConversationTurn(sessionId, userText, assistantText, disposition);
      return disposition;
    }

    const disposition = { action: "none" } as const;
    this.observeConversationTurn(sessionId, userText, assistantText, disposition);
    return disposition;
  }

  getTaskState(sessionId: string): SessionTaskState {
    const state = this.getSessionState(sessionId);
    return {
      activeTaskId: state.activeTaskId,
      tasks: [...state.tasks],
      conversationMemory: {
        ...state.conversationMemory!,
        currentMission: state.conversationMemory!.currentMission,
        carryForward: [...state.conversationMemory!.carryForward],
        preferences: [...state.conversationMemory!.preferences],
        facts: [...state.conversationMemory!.facts],
        openLoops: [...state.conversationMemory!.openLoops],
        agentCommitments: [...state.conversationMemory!.agentCommitments],
      },
    };
  }

  buildPromptContext(sessionId: string, currentInput?: string): string | undefined {
    const state = this.getTaskState(sessionId);
    const active = state.tasks.find((task) => task.taskId === state.activeTaskId) ?? null;
    const paused = state.tasks.filter((task) => task.status === "paused").slice(0, 3);
    const completed = state.tasks.filter((task) => task.status === "completed").slice(0, 2);
    const lines: string[] = [];
    const memory = state.conversationMemory;
    const includeTaskScopedMemory = this.shouldInjectTaskScopedMemory(currentInput, active, memory);

    if (active && includeTaskScopedMemory) {
      lines.push(`current-focus: ${active.title}`);
      lines.push(`important focus-summary: ${active.contextSummary}`);
    }
    if (paused.length > 0 && includeTaskScopedMemory) {
      lines.push(`suspended-tasks: ${paused.map((task) => `${task.title} | ${task.contextSummary}`).join(" || ")}`);
    }
    if (completed.length > 0 && includeTaskScopedMemory) {
      lines.push(`recently-completed: ${completed.map((task) => task.title).join(" | ")}`);
    }
    if (memory?.activeTopic) {
      lines.push(`conversation-topic: ${memory.activeTopic}`);
    }
    if (memory?.currentMission && includeTaskScopedMemory) {
      lines.push(`current-mission: ${memory.currentMission}`);
    }
    if (memory?.preferences.length) {
      lines.push(`session-preferences: ${memory.preferences.join(" || ")}`);
    }
    if (memory?.facts.length) {
      lines.push(`session-facts: ${memory.facts.join(" || ")}`);
    }
    if (memory?.openLoops.length && includeTaskScopedMemory) {
      lines.push(`open-loops: ${memory.openLoops.join(" || ")}`);
    }
    if (memory?.agentCommitments.length && includeTaskScopedMemory) {
      lines.push(`agent-commitments: ${memory.agentCommitments.join(" || ")}`);
    }
    if (memory?.carryForward.length && includeTaskScopedMemory) {
      lines.push(`recent-context: ${memory.carryForward.join(" || ")}`);
    }
    if (currentInput?.trim()) {
      lines.push(`incoming-turn: ${normalizeInput(currentInput).slice(0, 180)}`);
    }

    const { coreLines, compressedLines } = this.compressContext(lines);
    const merged = [...coreLines, ...compressedLines].slice(0, 12);
    if (merged.length === 0) return undefined;
    return ["STM project memory:", ...merged.map((line) => `- ${line}`)].join("\n");
  }

  buildRecallQuery(sessionId: string, currentInput: string): string {
    const state = this.getSessionState(sessionId);
    const active = state.tasks.find((task) => task.taskId === state.activeTaskId) ?? null;
    const paused = state.tasks.filter((task) => task.status === "paused").slice(0, 2);
    const parts = [normalizeInput(currentInput)];
    const includeTaskScopedMemory = this.shouldInjectTaskScopedMemory(currentInput, active, state.conversationMemory);

    if (active && includeTaskScopedMemory) {
      parts.push(`current task ${active.title}`);
      parts.push(active.contextSummary);
    }
    if (paused.length > 0 && includeTaskScopedMemory) {
      parts.push(`suspended tasks ${paused.map((task) => task.title).join(" ")}`);
    }
    if (state.conversationMemory?.activeTopic) {
      parts.push(`current topic ${state.conversationMemory.activeTopic}`);
    }
    if (state.conversationMemory?.currentMission && includeTaskScopedMemory) {
      parts.push(`current mission ${state.conversationMemory.currentMission}`);
    }
    if (state.conversationMemory?.openLoops.length && includeTaskScopedMemory) {
      parts.push(`open loops ${state.conversationMemory.openLoops.slice(0, 2).join(" ")}`);
    }
    if (state.conversationMemory?.preferences.length) {
      parts.push(`user preferences ${state.conversationMemory.preferences.slice(0, 2).join(" ")}`);
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
        conversationMemory: createEmptyConversationMemory(),
      };
    }
    if (!this.data.sessions[sessionId]!.conversationMemory) {
      this.data.sessions[sessionId]!.conversationMemory = createEmptyConversationMemory();
    }
    return this.data.sessions[sessionId]!;
  }

  private observeConversationTurn(
    sessionId: string,
    userText: string,
    assistantText: string,
    disposition: TaskTurnDisposition,
  ): void {
    const state = this.getSessionState(sessionId);
    const memory = state.conversationMemory ?? createEmptyConversationMemory();
    state.conversationMemory = memory;

    const userSentence = firstSentence(userText);
    const assistantSentence = firstSentence(assistantText);
    const active = state.tasks.find((task) => task.taskId === state.activeTaskId) ?? null;

    memory.activeTopic =
      active?.title || this.inferTopicFromUserText(userText) || memory.activeTopic || null;
    memory.currentMission = this.inferMissionFromTurn(userText, assistantText, active, memory.currentMission);

    if (USER_PREFERENCE_RE.test(userText)) {
      pushUnique(memory.preferences, userSentence);
    }
    if (USER_FACT_RE.test(userText)) {
      pushUnique(memory.facts, userSentence);
    }
    if (assistantSentence) {
      pushUnique(memory.carryForward, `assistant: ${assistantSentence}`, 4);
    }
    if (userSentence) {
      pushUnique(memory.carryForward, `user: ${userSentence}`, 4);
    }

    if (ASSISTANT_COMMITMENT_RE.test(assistantText)) {
      pushUnique(memory.agentCommitments, assistantSentence);
      if (disposition.action !== "complete") {
        pushUnique(memory.openLoops, assistantSentence);
      }
    }

    if (active && disposition.action !== "complete") {
      pushUnique(memory.openLoops, `${active.title} | ${active.contextSummary}`);
    } else if (!active && REQUEST_RE.test(userText) && disposition.action === "none") {
      pushUnique(memory.openLoops, userSentence);
    }

    if (disposition.action === "complete") {
      this.removeMatching(memory.openLoops, userText, assistantText, active?.title);
      this.removeMatching(memory.agentCommitments, userText, assistantText, active?.title);
    }

    if (disposition.action === "pause" && active) {
      pushUnique(memory.openLoops, `${active.title} | ${active.contextSummary}`);
    }

    memory.lastUpdated = nowIso();
    this.schedulePersist();
  }

  private inferTopicFromUserText(userText: string): string | null {
    const normalized = normalizeInput(userText);
    if (!normalized) return null;
    if (normalized.length <= 48) return normalized;
    return firstSentence(normalized, 48);
  }

  private shouldInjectTaskScopedMemory(
    currentInput: string | undefined,
    active: TaskStackEntry | null,
    memory: SessionConversationMemory | undefined,
  ): boolean {
    const normalized = normalizeInput(currentInput ?? "");
    if (!normalized) return true;
    if (isTaskSeekingTurn(normalized)) return true;

    const anchors = [
      active ? `${active.title} ${active.contextSummary}` : "",
      memory?.currentMission ?? "",
      memory?.openLoops[0] ?? "",
    ].filter(Boolean);

    for (const anchor of anchors) {
      if (overlapScore(anchor, normalized) >= 0.25) {
        return true;
      }
    }

    return false;
  }

  private inferMissionFromTurn(
    userText: string,
    assistantText: string,
    active: TaskStackEntry | null,
    previousMission: string | null,
  ): string | null {
    if (active) {
      return `${active.title} | ${active.contextSummary}`.slice(0, 180);
    }

    const userSentence = firstSentence(userText, 180);
    if (REQUEST_RE.test(userText) && userSentence) {
      return userSentence;
    }

    const assistantSentence = firstSentence(assistantText, 180);
    if (ASSISTANT_COMMITMENT_RE.test(assistantText) && assistantSentence) {
      return assistantSentence;
    }

    return previousMission;
  }

  private removeMatching(target: string[], ...candidates: Array<string | null | undefined>): void {
    const tokens = new Set(
      candidates
        .flatMap((value) => tokenize(value ?? ""))
        .filter((token) => token.length >= 2),
    );
    if (tokens.size === 0) return;
    const filtered = target.filter((line) => {
      const lineTokens = tokenize(line);
      return !lineTokens.some((token) => tokens.has(token));
    });
    target.splice(0, target.length, ...filtered);
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
