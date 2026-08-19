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

type TurnFocusKind = "task_followup" | "meta_debug" | "emotion_pause" | "topic_switch" | "new_task";

type TurnFocusResolution = {
  kind: TurnFocusKind;
  includeTaskScopedMemory: boolean;
  preserveRecentContext: boolean;
  reason: string;
};

const MEMORY_LIST_LIMIT = 6;
const ASSISTANT_COMMITMENT_RE =
  /我会|我将|已经帮你|已为你|我先|稍后|接下来|我去|我帮你|i will|i'll|i can/i;
const USER_PREFERENCE_RE = /喜欢|讨厌|偏好|习惯|不要|别|禁忌|生日|纪念日|remember|prefer/i;
const USER_FACT_RE = /我是|我在做|我最近在|我的项目|我正在|我计划|我住在|我需要/i;
const REQUEST_RE = /请|帮我|需要|想要|分析|总结|提醒|安排|继续|修复|优化|看看|做一个/i;
const CONTINUITY_TURN_RE =
  /^(?:这个|那个|这块|那块|它|他|她|他们|这些|那些|这里|那里|刚才那个|上面那个|继续|接着|往下|然后呢|再说说|展开|细说|具体点|详细点|怎么做|怎么办|咋办|改一下|修一下|优化一下|继续做|继续看|继续修|继续优化|this|that|it|they|continue|go on|next|then|fix it|improve it)(?:[。！？?!,.，\s]*|呢|啊|吧|哈|嘛|呀)*$/i;

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

function isContinuityTurn(text: string): boolean {
  const normalized = normalizeInput(text);
  if (!normalized) return false;
  if (CONTINUITY_TURN_RE.test(normalized)) return true;
  if (normalized.length <= 12 && /^(?:这|那|它|他|她|继续|接着|然后|再|改|修|看|做|this|that|it|next|then)/i.test(normalized)) {
    return true;
  }
  return false;
}

function hasMetaAgentDebugSignal(text: string): boolean {
  const normalized = normalizeInput(text);
  if (!normalized) return false;
  return /agent|assistant|bot|模型|大模型|助手|智能体|回复|对话|话题|串台|跑题|切换话题|回复对象|上下文|记忆|短期记忆|焦点|归因|提示词|prompt|system|调试|路由|旧任务|上一轮|上次对话|旧话题/i.test(
    normalized,
  );
}

function hasEmotionPauseSignal(text: string): boolean {
  const normalized = normalizeInput(text);
  if (!normalized) return false;
  return /好累|累呀|累了|心累|疲惫|烦死|烦了|崩溃|不想弄|先不想|歇一下|缓一下|太折腾|太难受|受不了了|tired|exhausted|overwhelmed/i.test(
    normalized,
  );
}

function isShortAffectiveTurn(text: string): boolean {
  const normalized = normalizeInput(text);
  if (!normalized) return false;
  return normalized.length <= 24 && hasEmotionPauseSignal(normalized);
}

function mergeContextSummary(previous: string, next: string, maxLen = 240): string {
  const prev = normalizeInput(previous);
  const incoming = normalizeInput(next);
  if (!prev) return incoming.slice(0, maxLen);
  if (!incoming || prev === incoming || prev.includes(incoming)) return prev.slice(0, maxLen);
  if (incoming.includes(prev)) return incoming.slice(0, maxLen);
  const merged = `${prev} / latest: ${incoming}`;
  return merged.length <= maxLen ? merged : `${prev.slice(0, 150)} / latest: ${incoming.slice(0, 70)}`;
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
    const focus = this.resolveTurnFocus(normalizedInput, active, state.conversationMemory);

    if (active && focus.includeTaskScopedMemory) {
      const activeScore = Math.max(
        overlapScore(`${active.title} ${active.contextSummary}`, normalizedInput),
        normalizedInput.toLowerCase().includes(active.title.toLowerCase()) ? 0.9 : 0,
      );
      if (activeScore >= 0.35) {
        active.contextSummary = mergeContextSummary(active.contextSummary, normalizedInput);
        active.updatedAt = nowIso();
        this.schedulePersist();
        return { task: active, resumed: false };
      }
      if (isContinuityTurn(normalizedInput)) {
        active.contextSummary = mergeContextSummary(active.contextSummary, normalizedInput);
        active.updatedAt = nowIso();
        this.schedulePersist();
        return { task: active, resumed: false };
      }
    }

    if (focus.includeTaskScopedMemory) {
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
          resumed.contextSummary = mergeContextSummary(resumed.contextSummary, normalizedInput);
          resumed.updatedAt = nowIso();
          this.schedulePersist();
          return { task: resumed, resumed: true };
        }
      }
    }

    if (!focus.includeTaskScopedMemory && active) {
      return { task: active, resumed: false };
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
    const focus = this.resolveTurnFocus(currentInput, active, memory);
    const includeTaskScopedMemory = focus.includeTaskScopedMemory;

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
    // 话题信号：检测当前输入与上一话题是「延续」还是「切换」，
    // 显式告诉 LLM 该基于上下文作答还是只回应本条新话题。
    // 实测（chat 模型）仍必须保留：#30 家具轮在无信号时被上一轮天气工具状态带跑、
    // #20 电影轮串入搬家/出差记忆。
    // 用 active.title + contextSummary 作为话题参照（contextSummary 含完整事实，如"华强科技/出差"）。
    const topicRef = active ? `${active.title} ${active.contextSummary}` : (memory?.activeTopic || null);
    const topicSignal = includeTaskScopedMemory ? this.buildTopicSignal(currentInput, topicRef) : undefined;
    if (topicSignal) {
      lines.push(`important ${topicSignal}`);
    }
    // 延续话题时强制注入最近对话原文（recent-context）：
    // #5 场景「我这次出差要去见哪家公司」被 shouldInjectTaskScopedMemory 判定为不相关，
    // 导致 carryForward 被拦掉、LLM 看不到上一轮用户原文 → 答「没存过」。
    const isTopicFollowUp = topicSignal?.startsWith("topic-followup") === true;
    const recentContext = this.selectRecentContextForFocus(memory?.carryForward ?? [], currentInput, focus);
    if (recentContext.length && (includeTaskScopedMemory || isTopicFollowUp || focus.preserveRecentContext)) {
      lines.push(`recent-context: ${recentContext.join(" || ")}`);
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
    if (currentInput?.trim()) {
      lines.push(`incoming-turn: ${normalizeInput(currentInput).slice(0, 180)}`);
    }

    const { coreLines, compressedLines } = this.compressContext(lines);
    const merged = [...coreLines, ...compressedLines].slice(0, 12);
    if (merged.length === 0) return undefined;
    return ["STM project memory:", ...merged.map((line) => `- ${line}`)].join("\n");
  }

  /**
   * 只读判定当前轮用户输入的话题焦点（不修改任何状态）。
   * 供上层（agent-core）对长期记忆召回做门控：当焦点为 topic_switch
   * （用户已切换话题、无任务延续、无指代）时，应抑制跨会话/旧话题的长期记忆注入，
   * 避免"串台"——把别的会话记忆塞进当前新话题。
   */
  getTurnFocusKind(sessionId: string, currentInput: string): TurnFocusKind {
    const state = this.getSessionState(sessionId);
    const active = state.tasks.find((task) => task.taskId === state.activeTaskId) ?? null;
    return this.resolveTurnFocus(currentInput, active, state.conversationMemory).kind;
  }

  buildRecallQuery(sessionId: string, currentInput: string): string {
    const state = this.getSessionState(sessionId);
    const active = state.tasks.find((task) => task.taskId === state.activeTaskId) ?? null;
    const paused = state.tasks.filter((task) => task.status === "paused").slice(0, 2);
    const parts = [normalizeInput(currentInput)];
    const focus = this.resolveTurnFocus(currentInput, active, state.conversationMemory);
    const includeTaskScopedMemory = focus.includeTaskScopedMemory;

    if (active && includeTaskScopedMemory) {
      parts.push(`current task ${active.title}`);
      parts.push(active.contextSummary);
    }
    if (paused.length > 0 && includeTaskScopedMemory) {
      parts.push(`suspended tasks ${paused.map((task) => task.title).join(" ")}`);
    }
    if (state.conversationMemory?.activeTopic && (includeTaskScopedMemory || focus.preserveRecentContext)) {
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
    const focus = this.resolveTurnFocus(userText, active, memory);
    const effectiveActive = focus.includeTaskScopedMemory ? active : null;

    memory.activeTopic =
      effectiveActive?.title || this.inferTopicFromUserText(userText) || memory.activeTopic || null;
    memory.currentMission = this.inferMissionFromTurn(userText, assistantText, effectiveActive, memory.currentMission);

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

    if (effectiveActive && disposition.action !== "complete") {
      pushUnique(memory.openLoops, `${effectiveActive.title} | ${effectiveActive.contextSummary}`);
    } else if (!effectiveActive && REQUEST_RE.test(userText) && disposition.action === "none") {
      pushUnique(memory.openLoops, userSentence);
    }

    if (disposition.action === "complete") {
      this.removeMatching(memory.openLoops, userText, assistantText, effectiveActive?.title);
      this.removeMatching(memory.agentCommitments, userText, assistantText, effectiveActive?.title);
    }

    if (disposition.action === "pause" && effectiveActive) {
      pushUnique(memory.openLoops, `${effectiveActive.title} | ${effectiveActive.contextSummary}`);
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

  /** 中文 2-gram 词元集：解决中文无空格分词导致的 overlapScore 失效问题。 */
  private zhGrams(text: string): Set<string> {
    const chars = normalizeInput(text);
    const grams = new Set<string>();
    for (let i = 0; i < chars.length - 1; i++) {
      const g = chars.slice(i, i + 2);
      if (/[\u4e00-\u9fff]/.test(g)) grams.add(g);
    }
    return grams;
  }

  /** 中文 2-gram 相似度：衡量当前输入与上一话题的词汇重叠（0~1）。 */
  private topicSimilarity(input: string, topic: string): number {
    const a = this.zhGrams(input);
    const b = this.zhGrams(topic);
    if (a.size === 0 || b.size === 0) return 0;
    let hits = 0;
    for (const g of a) {
      if (b.has(g)) hits += 1;
    }
    return hits / Math.max(Math.min(a.size, b.size), 1);
  }

  /** 回忆/指代信号：询问"之前/上次/说过/记得"的内容，或短追问，都属于延续。 */
  private isRecallOrFollowUp(input: string): boolean {
    if (/之前|上次|说过|刚才|刚刚|前面|还记得|记得|来着|earlier|before|last time|you said|remember/i.test(input)) return true;
    // 事实问句：询问具体事实（公司/人名/名字/吃什么/多少钱/哪个城市等）通常是延续性追问
    if (/哪家|哪家公司|叫什么|姓什么|吃什么|几点|多少钱|多少预算|哪个城市|去哪里|是什么|哪位/i.test(input)) return true;
    if (/^(?:那个|这个|它|他|她|他们|那些|这里|那家|刚才那个|上面那个|continue|go on|then|next)/i.test(input)) return true;
    return false;
  }

  /**
   * 话题信号生成：判断当前输入相对上一话题是「延续」还是「切换」。
   * - 延续（指代/回忆/词汇重叠）：提示 LLM 基于会话上下文作答；
   * - 切换（明显不相关）：提示 LLM 只回应本条新话题，不延续旧话题内容。
   * 这是话题串台的程序层兜底：flash 模型对"平淡陈述句"容易回退到记忆中的旧话题。
   */
  private buildTopicSignal(currentInput: string | undefined, previousTopic: string | null): string | undefined {
    const input = normalizeInput(currentInput ?? "");
    if (!input || !previousTopic) return undefined;

    if (isContinuityTurn(input) || this.isRecallOrFollowUp(input)) {
      const topic = previousTopic.slice(0, 60);
      return `topic-followup: yes | previous-topic: ${topic} | 系统指令（禁止在回复中出现或引用本信号及任何话题标签前缀）：本条延续上一话题，必须基于会话上下文作答；若询问之前提过的事实（公司/人名/计划），直接根据上下文回答，不要说没存过。`;
    }

    const sim = this.topicSimilarity(input, previousTopic);
    if (sim >= 0.2) {
      const topic = previousTopic.slice(0, 60);
      return `topic-followup: yes | previous-topic: ${topic} | 系统指令（禁止在回复中出现或引用本信号及任何话题标签前缀）：本条与上一话题相关，必须基于会话上下文作答；若询问之前提过的事实，直接根据上下文回答。`;
    }

    const topic = previousTopic.slice(0, 60);
    return `topic-switched: yes | previous-topic: ${topic} | 系统指令（禁止在回复中出现或引用本信号及任何话题标签前缀，如"[话题切换]"）：用户已切换话题，本条必须只回应本条消息本身——不要延续上一话题的内容、不要引用上一轮的工具结果或记忆（如搬家/出差/天气），直接干净地作答。`;
  }

  private resolveTurnFocus(
    currentInput: string | undefined,
    active: TaskStackEntry | null,
    memory: SessionConversationMemory | undefined,
  ): TurnFocusResolution {
    const normalized = normalizeInput(currentInput ?? "");
    if (!normalized) {
      return {
        kind: "task_followup",
        includeTaskScopedMemory: true,
        preserveRecentContext: true,
        reason: "empty_input",
      };
    }

    const metaDebug = hasMetaAgentDebugSignal(normalized);
    const emotionPause = hasEmotionPauseSignal(normalized);
    if (metaDebug) {
      return {
        kind: "meta_debug",
        includeTaskScopedMemory: false,
        preserveRecentContext: true,
        reason: emotionPause ? "meta_debug_with_emotion" : "meta_debug_signal",
      };
    }
    if (emotionPause && (isShortAffectiveTurn(normalized) || !isContinuityTurn(normalized))) {
      return {
        kind: "emotion_pause",
        includeTaskScopedMemory: false,
        preserveRecentContext: true,
        reason: "emotion_pause_signal",
      };
    }
    if (isTaskSeekingTurn(normalized)) {
      return {
        kind: active ? "task_followup" : "new_task",
        includeTaskScopedMemory: true,
        preserveRecentContext: true,
        reason: "task_seeking_turn",
      };
    }
    if (isContinuityTurn(normalized) && (active || memory?.currentMission || memory?.openLoops.length)) {
      return {
        kind: "task_followup",
        includeTaskScopedMemory: true,
        preserveRecentContext: true,
        reason: "continuity_turn",
      };
    }

    const anchors = [
      active ? `${active.title} ${active.contextSummary}` : "",
      memory?.currentMission ?? "",
      memory?.openLoops[0] ?? "",
    ].filter(Boolean);

    for (const anchor of anchors) {
      if (overlapScore(anchor, normalized) >= 0.25) {
        return {
          kind: "task_followup",
          includeTaskScopedMemory: true,
          preserveRecentContext: true,
          reason: "anchor_overlap",
        };
      }
    }

    return {
      kind: "topic_switch",
      includeTaskScopedMemory: false,
      preserveRecentContext: false,
      reason: "no_task_anchor",
    };
  }

  private selectRecentContextForFocus(
    carryForward: string[],
    currentInput: string | undefined,
    focus: TurnFocusResolution,
  ): string[] {
    if (carryForward.length === 0) return [];
    if (focus.includeTaskScopedMemory) return carryForward;

    const input = normalizeInput(currentInput ?? "");
    if (focus.kind === "meta_debug") {
      const selected = carryForward.filter(
        (line) => hasMetaAgentDebugSignal(line) || (input && overlapScore(line, input) >= 0.18),
      );
      return (selected.length > 0 ? selected : carryForward.slice(0, 2)).slice(0, 4);
    }

    if (focus.kind === "emotion_pause") {
      const metaContext = carryForward.filter((line) => hasMetaAgentDebugSignal(line));
      return (metaContext.length > 0 ? metaContext : carryForward.slice(0, 2)).slice(0, 4);
    }

    return [];
  }

  private shouldInjectTaskScopedMemory(
    currentInput: string | undefined,
    active: TaskStackEntry | null,
    memory: SessionConversationMemory | undefined,
  ): boolean {
    return this.resolveTurnFocus(currentInput, active, memory).includeTaskScopedMemory;
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
