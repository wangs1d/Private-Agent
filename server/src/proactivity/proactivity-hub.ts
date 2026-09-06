// ProactivityHub —— 主动性多元化模块（核心编排器）
//
// 职责（与 ProactionCortex 分工）：
//  - 本模块：决定「何时、为何、以何种行为模式（speak/act/advise）主动发起」
//  - ProactionCortex（复用，不重造）：speak 模式的话术决策与生成
//    （value/disturb 双轨 → e2e LLM → executeProactiveDecision 投递）
//
// ─── 通用主动性架构（Jarvis 式：感知 → LLM 自主决策 → 通用执行） ───
//
//  1. 感知（PerceptionFeed，通用层）：任何源（对话轮 / 日程 / 节律 / 任务 /
//     桌面 presence / 情绪……）都推成统一 Observation，滚动窗口保留。
//     感知归 body 与装配层，hub 只做聚合。
//
//  2. 决策（双路径）：
//     - 快路径（规则，零 LLM）：高置信确定性场景——任务完成必恭喜、
//       待办闭环必恭喜、过劳必干预、时段问候。规则命中直接触发。
//     - 通用路径（InitiativeEngine，LLM 自主）：规则写不完的场景。
//       周期 tick 时消费新观察 → 有料才调 LLM → LLM 自主判断
//       是否主动 / 什么模式 / 具体做什么（含工具调用行动计划）。
//
//  3. 执行（三模式 + 通用 act）：
//     - speak → LifeSignalHub（现有闭环接管话术）
//     - act → 黑名单安全门（危险操作永不自动执行）+ 通用工具执行
//       （LLM 自主选工具，不再限定白名单——与对话中调工具同级安全）
//     - advise → 改由 fast speak 车道以主动对话形式投递（不再注入对话 prompt）
//
//  4. 护栏：FrequencyGovernor 前置频控（每日预算 + 分 kind 冷却 + 静默时段），
//     ProactionCortex disturb/repeat_suppress 保留为第二道防线。
import type {
  InitiativeDecision,
  Observation,
  ProactiveActStep,
  ProactiveBehaviorMode,
  ProactiveIntent,
} from "./proactivity-types.js";
import {
  deriveActValue,
  deriveRiskFromSteps,
  evaluateActionUtility,
  isUtilityEvalEnabled,
  type ActionUtilityBranch,
  type AuthorizationLevel,
} from "./action-utility.js";
import {
  CONFIRMATION_TTL_MS,
  PendingConfirmationStore,
  type PendingConfirmation,
} from "./pending-confirmation-store.js";
import { SilenceLog, type SilenceLogEntry, type SilenceSearchOptions } from "./silence-log.js";
import { FrequencyGovernor } from "./frequency-governor.js";
import { PerceptionFeed } from "./perception-feed.js";
import { InitiativeEngine, type LlmCompleteFn } from "./initiative-engine.js";
import { InitiativeDecisionCache } from "./initiative-decision-cache.js";
import { learnExemplar, type TriggerExemplarKind } from "./semantic-trigger-matcher.js";
import {
  buildConversationIntent,
} from "./triggers/conversation-triggers.js";
import {
  buildCelebrationIntent,
  buildLoopCompletedIntent,
} from "./triggers/celebration-trigger.js";
import { buildShareIntent, pickShareTopic, type ShareProfileInput } from "./triggers/share-trigger.js";
import { buildGreetingIntent, judgeGreeting } from "./triggers/greeting-trigger.js";
import type { InterestHit } from "./interest-watcher.js";
import {
  buildOverworkIntent,
  type OverworkRhythmPayload,
} from "./triggers/overwork-trigger.js";

/** 最小依赖接口（便于测试 mock 与模块解耦） */
export interface ProactivityHubDeps {
  /** 发布 LifeSignal（speak 模式入口，LifeSignalHubService.publish 的薄包装） */
  publishSignal: (signal: {
    actorId: string;
    kind: string;
    title: string;
    summary: string;
    importance: "low" | "medium" | "high" | "critical";
    tags: string[];
    evidence: string[];
    metadata?: Record<string, unknown>;
  }) => void;
  /** 执行工具（act 模式，ToolRegistry.execute 的薄包装） */
  executeTool: (
    tool: string,
    args: Record<string, unknown>,
    actorId: string,
  ) => Promise<{ ok: boolean; result: Record<string, unknown> }>;
  /** 用户画像（兴趣分享触发源；OnlineLearningCortex.getProfile 的薄包装） */
  getProfile?: (actorId: string) => ShareProfileInput | null;
  /**
   * 用户画像文本（通用路径 LLM 决策输入；UserProfileStore 画像 markdown 的薄包装）。
   * 与 getProfile 不同：这里要完整画像文本（偏好/习惯/话题），LLM 直接可读。
   * 支持 async（磁盘读取）。
   */
  getProfileText?: (actorId: string) => Promise<string | null> | string | null;
  /**
   * 最近一次用户交互时间戳 ms；null=从未交互（不主动冷启动）。
   * 可选：未注入时 hub 用自身 observeConversationTurn 记录的时间兜底。
   */
  getLastInteractionAt?: (actorId: string) => number | null;
  /**
   * 用户活跃事件回调（装配层可选接线：喂 body RhythmCore 做节律感知，
   * source 如 "conversation"）。fire-and-forget，不阻塞对话链路。
   */
  onUserActivity?: (actorId: string, source: string) => void;
  /** LLM 完成函数（InitiativeEngine 通用路径；externalChat.streamCompletion 的薄包装） */
  llmComplete?: LlmCompleteFn;
  /** 可用工具清单（act 行动计划的选择范围；toolRegistry.listMetadata 的薄包装） */
  listTools?: () => Array<{ name: string; description: string }>;
  /**
   * 按查询选相关工具（selectRelevantTools 的薄包装）。
   * 注入时通用路径只喂 top-K 相关工具（+核心执行面保底）而非全量清单，
   * act 质量不降（相关工具带完整描述）而 prompt token 大幅下降。
   */
  searchTools?: (query: string, limit: number) => Array<{ name: string; description: string }>;
  /** 今日日程快照（通用路径感知源；scheduleTaskService 的薄包装），返回自然语言文本 */
  getScheduleSnapshot?: (actorId: string) => string | null;
  /** 测试注入：自定义频控器（默认 new FrequencyGovernor()） */
  frequencyGovernor?: FrequencyGovernor;
  /**
   * 负反馈抑制表（Task 20 统一频控框架）：用户「别再提醒我这个」类负反馈的
   * 持久化抑制。注入后 hub 在频控判定前先查抑制（用户意愿优先于时间冷却）。
   */
  suppressionStore?: {
    isSuppressed: (
      actorId: string,
      kind: string,
      text?: string,
    ) => { suppressed: boolean; reason: string };
  };
  /**
   * 沉默日志（方案 B/C）：act 三分支判 silence 的留痕，与管道 silenced 共用
   * 同一实例（装配层注入）。未注入时 hub 内建内存态（测试/降级）。
   */
  silenceLog?: SilenceLog;
  /**
   * 挂起确认存储（ask_first）：装配层注入与管道共享的同一实例（落盘可重启恢复）。
   * 未注入时 hub 内建内存态。
   */
  pendingConfirmations?: PendingConfirmationStore;
}

/** 兼容别名：ask_first 挂起的确认条目（hub 行动级 + 管道提案级） */
export type PendingActionConfirmation = PendingConfirmation;
export { CONFIRMATION_TTL_MS };

/**
 * act 模式危险工具黑名单（正则，工具名匹配即拒绝自动执行）。
 * 通用路径不再限定白名单——LLM 自主选工具，与对话中调工具同级安全；
 * 但删除/破坏/系统级操作永不自动执行（自动化只做好事，不做不可逆的事）。
 */
const ACT_TOOL_DENY_RE =
  /delete|remove|drop|format|wipe|uninstall|shutdown|reboot|restart|run_shell|run_automation|kill/i;
/** act 单次行动计划步数上限 */
const ACT_MAX_STEPS = 5;
/** 核心执行面工具（searchTools 注入时保底并入，主动性最常用的 act 工具族） */
const CORE_ACT_TOOL_RE = /^(media\.|calendar\.|clock\.|voice\.speak|weather\.)/;
/** 通用路径喂给 LLM 的工具数上限（top-K 相关 + 核心保底） */
const MAX_PROMPT_TOOLS = 18;
/** tick 间隔（env 可调，默认 30 分钟） */
function readTickIntervalMs(): number {
  const raw = process.env.PROACTIVITY_TICK_MS;
  if (!raw) return 30 * 60 * 1000;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 60_000 ? n : 30 * 60 * 1000;
}
/** 通用路径最近主动行为记忆条数（防重复） */
const RECENT_INITIATIVES_LIMIT = 8;
/** 对话后主动评估去抖（默认 90s：聊完歇一会儿再决定要不要补一句，模拟人类节奏） */
const INITIATIVE_DEBOUNCE_DEFAULT_MS = 90_000;

function readInitiativeDebounceMs(): number {
  const raw = process.env.PROACTIVITY_INITIATIVE_DEBOUNCE_MS;
  if (!raw) return INITIATIVE_DEBOUNCE_DEFAULT_MS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : INITIATIVE_DEBOUNCE_DEFAULT_MS;
}

/** 读布尔 env（默认 fallback） */
function readEnvBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return raw === "1" || raw.toLowerCase() === "true";
}

/**
 * 触发源 → 授权档（act 三分支的授权维度输入，确定性映射）：
 *   conversation = 用户原话触发（显式）；其余既有触发源由用户配置/长期偏好驱动
 *   （隐式）；initiative 是用户显式开启的 LLM 主动性（env 开关 = 授权可逆自选
 *   动作）；未知来源一律无授权（涉第三方必 ask_first）。
 */
const SOURCE_AUTHORIZATION: Record<string, AuthorizationLevel> = {
  conversation: "explicit",
  task: "implicit",
  rhythm: "implicit",
  profile: "implicit",
  time: "implicit",
  epitome: "implicit",
  interest_watch: "implicit",
  weather: "implicit",
  finance: "implicit",
  relationship: "implicit",
  health: "implicit",
  initiative: "implicit",
};

function authorizationForSource(source: string): AuthorizationLevel {
  return SOURCE_AUTHORIZATION[source] ?? "none";
}

/** 从 media.search 结果解析第一条曲目（兼容数组 / {tracks:[]} / {result:{tracks:[]}} 结构） */
export function parseFirstTrack(
  result: Record<string, unknown> | undefined,
): { trackId: string; trackName?: string; artist?: string; durationSec?: number } | null {
  if (!result) return null;
  let tracks: unknown = result.tracks ?? result.result;
  if (tracks && typeof tracks === "object" && !Array.isArray(tracks)) {
    tracks = (tracks as Record<string, unknown>).tracks ?? tracks;
  }
  if (!Array.isArray(tracks) || tracks.length === 0) return null;
  const first = tracks[0] as Record<string, unknown>;
  const id = first?.id ?? first?.trackId ?? first?.songId;
  if (id === undefined || id === null || id === "") return null;
  return {
    trackId: String(id),
    trackName: typeof first.name === "string" ? first.name : undefined,
    artist: typeof first.artist === "string" ? first.artist : undefined,
    durationSec: typeof first.durationSec === "number" ? first.durationSec : undefined,
  };
}

export class ProactivityHub {
  private readonly governor: FrequencyGovernor;
  /** 沉默日志（act 三分支 silence 留痕；与管道共享实例由装配层注入） */
  private readonly silenceLog: SilenceLog;
  /** 挂起确认存储（ask_first；与管道共享实例由装配层注入，可落盘恢复） */
  private readonly confirmations: PendingConfirmationStore;
  /** 管道级确认回调（装配层在管道构造后接线：批准 → onProposalApproved + 回执） */
  private pipelineConfirmationResolver:
    | ((entry: PendingConfirmation, approved: boolean) => Promise<{ executed: boolean } | null> | { executed: boolean } | null)
    | null = null;
  /** 通用感知层：所有源的统一观察流 */
  private readonly feed = new PerceptionFeed();
  /** 通用路径：LLM 自主决策引擎（llmComplete 未注入时禁用，静默只用快路径） */
  private readonly engine: InitiativeEngine;
  /** 通用路径总开关：默认开（fast 规则车道保留；LLM 通用路径需接入外部模型才实际生效） */
  private readonly llmInitiativeEnabled: boolean;
  /** act 审计：最近发起的自主工具执行（安全可查，最多保留近 N 条） */
  private readonly actAudit = new Map<string, Array<{ at: number; tool: string; args: Record<string, unknown> }>>();
  private readonly ACT_AUDIT_LIMIT = 20;
  /** 负向决策缓存：同观察指纹近期已判 none 时跳过 LLM（省 token） */
  private readonly decisionCache = new InitiativeDecisionCache();
  /** 已见过的 actor（tick 只对交互过的用户生效，不冷启动打扰） */
  private readonly knownActors = new Set<string>();
  /** 最近一次对话交互时刻（observeConversationTurn 维护；greeting 判定的兜底数据源） */
  private readonly lastInteractionAt = new Map<string, number>();
  /** 最近已发起的主动行为（防 LLM 通用路径重复同类主动） */
  private readonly recentInitiatives = new Map<string, string[]>();
  /** 上次 tick 拉到的日程快照（去重：日程没变不重复推观察） */
  private readonly lastScheduleSnapshot = new Map<string, string>();
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  /** 对话后去抖评估定时器（每 actor 一个，新对话轮重置） */
  private readonly initiativeDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly initiativeDebounceMs = readInitiativeDebounceMs();
  private started = false;

  constructor(private readonly deps: ProactivityHubDeps) {
    this.governor = deps.frequencyGovernor ?? new FrequencyGovernor();
    this.silenceLog = deps.silenceLog ?? new SilenceLog();
    this.confirmations = deps.pendingConfirmations ?? new PendingConfirmationStore();
    this.engine = new InitiativeEngine(deps.llmComplete ?? null);
    this.llmInitiativeEnabled = readEnvBool("PROACTIVITY_LLM_INITIATIVE", true);
  }

  /**
   * 接线管道级确认回调（装配层在管道构造后调用）：hub 的确认解析入口对
   * origin=pipeline 的条目委托本回调（批准 → 管道 onProposalApproved + 回执）。
   */
  setPipelineConfirmationResolver(
    fn: (entry: PendingConfirmation, approved: boolean) => Promise<{ executed: boolean } | null> | { executed: boolean } | null,
  ): void {
    this.pipelineConfirmationResolver = fn;
  }

  // ---- 已知 actor 持久化（重启恢复主动性资格：否则重启后 agent 永不主动） ----

  /** 恢复已知 actor 及其最近交互时刻（ProactivePipeline 从 data/proactivity/known-actors.json 调用） */
  restoreActors(entries: Array<{ actorId: string; lastInteractionAt: number }>): void {
    for (const e of entries) {
      this.knownActors.add(e.actorId);
      this.lastInteractionAt.set(e.actorId, e.lastInteractionAt);
    }
  }

  /** 导出已知 actor 状态（落盘用） */
  exportActors(): Array<{ actorId: string; lastInteractionAt: number }> {
    return [...this.lastInteractionAt].map(([actorId, lastInteractionAt]) => ({ actorId, lastInteractionAt }));
  }

  /** 暴露感知流（诊断/测试用） */
  getFeed(): PerceptionFeed {
    return this.feed;
  }

  // ---- 生命周期 ----

  start(): void {
    if (this.started) return;
    this.started = true;
    const intervalMs = readTickIntervalMs();
    this.tickTimer = setInterval(() => {
      void this.tickAll().catch((err) => {
        console.log(`[ProactivityHub] tick 失败（忽略）: ${err}`);
      });
    }, intervalMs);
    // 不阻塞进程退出
    if (typeof this.tickTimer.unref === "function") this.tickTimer.unref();
    const engineOn = this.llmInitiativeEnabled
      ? this.engine.isEnabled()
        ? "+LLM 通用路径（对话后去抖评估 + 周期 tick）"
        : "（LLM 通用路径开关已开，但外部模型未配置——实际仅规则快路径；请检查 server/.env 的 MOONSHOT_API_KEY / MINIMAX_API_KEY / OPENAI_API_KEY）"
      : "（LLM 通用路径已手动关闭，仅规则快路径）";
    console.log(
      `[ProactivityHub] 已启动（tick=${Math.round(intervalMs / 60000)}min，每日预算=${this.governor.getBudget()}${engineOn}）`,
    );
  }

  stop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    for (const timer of this.initiativeDebounceTimers.values()) clearTimeout(timer);
    this.initiativeDebounceTimers.clear();
    this.started = false;
  }

  // ---- 对外入口（各模块薄接线点，全部 fire-and-forget 不阻塞调用方） ----

  /**
   * 对话轮实时采集（agent-core 每轮接线调用）。
   * 完全后台化：只把对话内容/活跃推入感知流（供后台理解用户动态 + 喂节律感知），
   * 不在此同步触发任何主动行为，也不进入对话 prompt。
   * 是否主动由后台零 LLM 规则判（runConversationRuleJudge）在下一事件循环解耦决定。
   */
  observeConversationTurn(actorId: string, text: string): void {
    this.knownActors.add(actorId);
    this.lastInteractionAt.set(actorId, Date.now());
    // 感知流：对话轮是最高频观察（低显著，供后台判断用户在忙什么 + 喂节律）
    this.feed.pushObservation(
      actorId,
      "conversation_turn",
      `用户说：${text.slice(0, 120)}`,
      "low",
    );
    // 用户活跃事件 → 装配层可选消费（如喂 RhythmCore 做节律感知）
    this.noteUserActivity(actorId, "conversation");
    // 后台零 LLM 规则判：解耦到下一事件循环（fire-and-forget），不阻塞主回复、不进 prompt。
    setImmediate(() => {
      void this.runConversationRuleJudge(actorId, text).catch((err) => {
        console.log(`[ProactivityHub] 对话规则判断失败（忽略）: ${err}`);
      });
    });
    // 对话后去抖即时评估（对话轮是最有决策依据的观察，比 30min tick 新鲜得多——
    // 否则 agent「明明刚聊完却半小时无反应」）。频控/负向缓存/预算短路照常兜底。
    this.scheduleDebouncedInitiative(actorId);
  }

  /**
   * 对话后的主动评估去抖：静默 PROACTIVITY_INITIATIVE_DEBOUNCE_MS（默认 90s，0=禁用）
   * 后做一次通用路径评估；连续对话不断重置（等用户真正停下才评估，不打断对话流）。
   * 评估会消费感知流窗口，周期 tick 不会对同批观察重复调 LLM。
   */
  private scheduleDebouncedInitiative(actorId: string): void {
    if (!this.llmInitiativeEnabled || !this.engine.isEnabled() || this.initiativeDebounceMs <= 0) {
      return;
    }
    const prev = this.initiativeDebounceTimers.get(actorId);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => {
      this.initiativeDebounceTimers.delete(actorId);
      void this.evaluateInitiative(actorId, new Date(), this.lastInteractionAt.get(actorId) ?? null).catch(
        (err) => {
          console.log(`[ProactivityHub] 对话后主动评估失败（忽略）: ${err}`);
        },
      );
    }, this.initiativeDebounceMs);
    if (typeof timer.unref === "function") timer.unref();
    this.initiativeDebounceTimers.set(actorId, timer);
  }

  /**
   * 用户活跃事件（装配层接线：桌面 presence / 设备变化等）。
   * 推入感知流 + 转发装配层回调（RhythmCore 喂数据）。
   */
  noteUserActivity(actorId: string, source: string): void {
    this.knownActors.add(actorId);
    this.feed.pushObservation(actorId, "user_activity", `用户活跃（来源：${source}）`, "low");
    try {
      this.deps.onUserActivity?.(actorId, source);
    } catch {
      /* 活动回调失败不影响主链路 */
    }
  }

  /** 复杂任务完成（agent-task-orchestrator task_completed 接线） */
  onAgentTaskCompleted(actorId: string, goal: string): void {
    this.knownActors.add(actorId);
    this.feed.pushObservation(actorId, "task_completed", `复杂任务完成：${goal.slice(0, 120)}`, "high");
    // 快路径：任务完成必恭喜（确定性场景，零 LLM）
    void this.route(buildCelebrationIntent(actorId, goal)).catch((err) => {
      console.log(`[ProactivityHub] 任务恭喜触发失败（忽略）: ${err}`);
    });
  }

  /** 用户待办闭环（session-epitome 完成检测接线） */
  onUserLoopCompleted(actorId: string, loopText: string): void {
    this.knownActors.add(actorId);
    this.feed.pushObservation(actorId, "loop_closed", `用户待办完成：${loopText.slice(0, 120)}`, "high");
    // 快路径：待办闭环必恭喜（确定性场景，零 LLM）
    void this.route(buildLoopCompletedIntent(actorId, loopText)).catch((err) => {
      console.log(`[ProactivityHub] 待办闭环恭喜失败（忽略）: ${err}`);
    });
  }

  /** body 节律信号（body.rhythm.* 订阅接线） */
  onRhythmSignal(actorId: string, kind: string, payload?: unknown): void {
    this.knownActors.add(actorId);
    if (kind !== "body.rhythm.overwork_detected") return;
    const p = payload as OverworkRhythmPayload | undefined;
    this.feed.pushObservation(
      actorId,
      "rhythm_overwork",
      `过劳信号：连续工作 ${p?.continuousWorkHours ?? "?"}h，深夜活跃 ${p?.lateNightActiveCount ?? 0} 次`,
      "high",
      Date.now(),
      { ...(p ?? {}) },
    );
    // 快路径：过劳必干预（确定性场景，零 LLM，act+speak 复合）
    void this.route(buildOverworkIntent(actorId, p)).catch((err) => {
      console.log(`[ProactivityHub] 过劳干预失败（忽略）: ${err}`);
    });
  }

  /**
   * 用户兴趣话题热议推送（InterestWatcher 后台轮询命中接线）。
   * 例：用户长期关注「刘浩存」，热搜出现她的新动态 → 主动 tell。
   * 走 speak 闭环（ProactionCortex 话术生成），频控由 FrequencyGovernor
   * interest_alert 冷却（4h）+ 每日预算兜底；同兴趣指纹去重在 watcher 层已完成。
   */
  onInterestAlert(actorId: string, name: string, hit: InterestHit): void {
    this.knownActors.add(actorId);
    this.feed.pushObservation(
      actorId,
      "interest_hot",
      `用户关注的「${name}」上了「${hit.platform}」热点：${hit.title}`,
      "medium",
      Date.now(),
      { interest: name, title: hit.title, platform: hit.platform, url: hit.url ?? "" },
    );
    const hotNote = hit.hot ? `（热度${hit.hot}）` : "";
    void this.route({
      actorId,
      kind: "interest_alert",
      importance: "medium",
      title: `你关注的「${name}」有新动态`,
      summary:
        `用户长期关注「${name}」。刚才发现「${hit.platform}」热榜上有 TA 的动态：` +
        `${hit.title}${hotNote}${hit.url ? `（来源：${hit.url}）` : ""}。` +
        `像朋友想起对方一直在意的东西一样，用一两句自然提起即可，分享你的看法或轻问一句，别写成资讯播报。`,
      mode: "speak",
      source: "interest_watch",
    }).catch((err) => {
      console.log(`[ProactivityHub] 兴趣热议推送失败（忽略）: ${err}`);
    });
  }

  /**
   * 外部场景接线：提交一条主动意图（C 端生活管家场景通用入口）。
   * 走与内部快路径完全相同的 route()（负反馈抑制 → 频控 → speak/act/advise），
   * fire-and-forget 不阻塞调用方。供消费管家（预算超支/月报）、人情关系
   * （重要日子）、健康关怀（节律提醒）、天气预警等外部服务接入。
   */
  submitIntent(intent: ProactiveIntent): void {
    this.knownActors.add(intent.actorId);
    void this.route(intent).catch((err) => {
      console.log(`[ProactivityHub] submitIntent 失败（忽略）kind=${intent.kind}: ${err}`);
    });
  }

  /** 周期 tick（问候快路径 + 通用 LLM 路径；测试可直调） */
  async onTick(actorId: string, now: Date = new Date()): Promise<void> {
    // 快路径 1：问候（时段判定 + 24h 冷却兜底）
    const lastInteraction =
      this.deps.getLastInteractionAt?.(actorId) ?? this.lastInteractionAt.get(actorId) ?? null;
    const greeting = judgeGreeting(lastInteraction, now);
    if (greeting) {
      await this.route(buildGreetingIntent(actorId, greeting));
      return; // 同一 tick 不叠加，单次主动最克制
    }
    // 通用路径：感知流增量消费 → 有新观察才调 LLM 自主决策。
    // 默认开启（PROACTIVITY_LLM_INITIATIVE=0 可退回纯规则）；llmComplete 未接入
    // 时引擎自动禁用（evaluateInitiative 内 isEnabled 兜底），等效快路径独占。
    if (this.llmInitiativeEnabled) {
      await this.evaluateInitiative(actorId, now, lastInteraction);
    }
  }

  // ---- 通用路径：LLM 自主决策 ----

  /**
   * 消费感知流新观察，交给 InitiativeEngine 自主判断。
   * 无新观察 / LLM 未接入 / 决策为 none 时静默返回（零打扰零浪费）。
   */
  private async evaluateInitiative(
    actorId: string,
    now: Date,
    lastInteractionAt: number | null,
  ): Promise<void> {
    // 预算前置短路：预算耗尽时任何决策都会被频控拦截（canTrigger 规则 1 无重要性豁免），
    // 直接跳过本轮 LLM 评估。放在 consumeWindow 之前——观察不消费，预算跨零点
    // 重置后仍可被下一 tick 评估，不丢感知。
    if (this.governor.dailyCountOf(actorId, now) >= this.governor.getBudget()) {
      console.log(`[ProactivityHub] 预算耗尽，跳过通用路径评估 actor=${actorId}`);
      return;
    }
    // 日程感知：拉今日快照，有变化才推观察（LLM 看到日程自主判断要不要做什么）
    const snapshot = this.deps.getScheduleSnapshot?.(actorId) ?? null;
    if (snapshot && snapshot !== this.lastScheduleSnapshot.get(actorId)) {
      this.lastScheduleSnapshot.set(actorId, snapshot);
      this.feed.pushObservation(actorId, "schedule_snapshot", `今日日程：${snapshot}`, "medium", now.getTime());
    }

    const observations = this.feed.consumeWindow(actorId);
    if (observations.length === 0) return;
    if (!this.engine.isEnabled() || lastInteractionAt == null) return; // LLM 未接入/从未交互：只用快路径

    // 负向决策缓存：近期同观察指纹已判 none（无高显著事件）→ 跳过 LLM（省 token）
    const fingerprint = this.decisionCache.fingerprintObservations(observations);
    const hasHighSalience = observations.some((o) => o.salience === "high");
    if (this.decisionCache.shouldSkip(actorId, fingerprint, hasHighSalience)) {
      console.log(`[ProactivityHub] 决策缓存命中（近期同场景已判不主动，跳过 LLM）actor=${actorId}`);
      return;
    }

    let profileText: string | undefined;
    try {
      const raw = await this.deps.getProfileText?.(actorId);
      // 画像全文可能较长（markdown），截断喂 LLM（默认模板空壳也会被这里压短）
      profileText = raw ? raw.slice(0, 600) : undefined;
    } catch {
      /* 画像读取失败不影响决策 */
    }
    let availableTools: Array<{ name: string; description: string }> | undefined;
    try {
      const all = this.deps.listTools?.();
      if (all) availableTools = this.selectPromptTools(observations, all);
    } catch {
      /* 工具清单读取失败：LLM 无 act 依据，仍可 speak/advise */
    }
    const budgetNote = `今日已用 ${this.governor.dailyCountOf(actorId, now)}/${this.governor.getBudget()} 次`;

    const decision = await this.engine.evaluate({
      actorId,
      observations,
      recentContext: this.feed.recent(actorId, 10).filter(
        (o) => !observations.includes(o),
      ),
      profileText,
      lastInteractionAt,
      recentInitiatives: this.recentInitiatives.get(actorId),
      budgetNote,
      availableTools,
      now,
    });
    if (!decision || decision.mode === "none") {
      console.log(
        `[ProactivityHub] 通用路径判定不主动 actor=${actorId} observations=${observations.length}` +
          `${decision ? ` reason=${decision.rationale.slice(0, 60)}` : ""}`,
      );
      this.decisionCache.recordNone(actorId, fingerprint);
      return;
    }
    this.teachMatcherFromDecision(observations, decision);
    await this.routeDecision(actorId, decision, "initiative", fingerprint);
  }

  /**
   * 通用路径的工具选择：searchTools 注入时只喂 top-K 相关工具 + 核心执行面保底；
   * 未注入时退化为全量清单（行为兼容）。质量不降（相关工具带完整描述），
   * token 大幅下降（全量 60+ → ≤18）。
   */
  private selectPromptTools(
    observations: Observation[],
    all: Array<{ name: string; description: string }>,
  ): Array<{ name: string; description: string }> {
    const search = this.deps.searchTools;
    if (!search) return all;
    try {
      const query = observations
        .map((o) => o.content)
        .join("；")
        .slice(0, 200);
      const relevant = search(query, 12);
      // 核心执行面保底：日历/媒体/语音/时钟——主动性最常用的 act 工具族
      const core = all.filter((t) => CORE_ACT_TOOL_RE.test(t.name));
      const seen = new Set<string>();
      const merged: Array<{ name: string; description: string }> = [];
      for (const t of [...core, ...relevant]) {
        if (seen.has(t.name)) continue;
        seen.add(t.name);
        merged.push(t);
        if (merged.length >= MAX_PROMPT_TOOLS) break;
      }
      return merged;
    } catch {
      return all; // 选择失败退化为全量（宁可多 token 不丢 act 能力）
    }
  }

  /**
   * 决策蒸馏：LLM 在对话观察上做出主动决策 → 把原话固化为快路径范例。
   * 只学正例（LLM 认为「值得主动」的文本），语义泛化层随真实使用扩充召回；
   * 零额外 token——决策已发生，学习是免费的副产品。
   */
  private teachMatcherFromDecision(
    observations: Observation[],
    decision: InitiativeDecision,
  ): void {
    const kind = decision.kind.toLowerCase();
    const exemplarKind: TriggerExemplarKind | null = /mood|care|emotion|support|comfort|fatigue|tired|overwork/.test(
      kind,
    )
      ? "care"
      : /follow|track|remind|todo|task|schedule|wait|prep/.test(kind)
        ? "followup"
        : null;
    if (!exemplarKind) return;
    for (const o of observations) {
      if (o.type !== "conversation_turn") continue;
      const text = o.content.replace(/^用户说：/, "").trim();
      if (learnExemplar(exemplarKind, text)) {
        console.log(
          `[ProactivityHub] 决策蒸馏：新增 ${exemplarKind} 范例「${text.slice(0, 30)}」`,
        );
      }
    }
  }

  /**
   * 把 LLM 决策路由到三种行为模式（抑制 → 频控 → speak/act/advise）。
   * observationFingerprint：本次评估的观察窗口指纹——决策被抑制/频控拦截时记入
   * 负向决策缓存（同样的观察喂给 LLM 大概率还是同样的决策、同样的拦截，省 token）。
   */
  private async routeDecision(
    actorId: string,
    decision: InitiativeDecision,
    source: string,
    observationFingerprint?: string,
  ): Promise<void> {
    // 负反馈抑制检查（用户意愿优先于时间冷却）：kind 级或关键词级命中即放弃
    const suppression = this.deps.suppressionStore?.isSuppressed(
      actorId,
      decision.kind,
      `${decision.rationale} ${decision.messageHint}`,
    );
    if (suppression?.suppressed) {
      console.log(
        `[ProactivityHub] 负反馈抑制拦截（通用）kind=${decision.kind} actor=${actorId} reason=${suppression.reason}`,
      );
      this.rememberBlockedDecision(actorId, observationFingerprint);
      return;
    }
    const verdict = this.governor.canTrigger(actorId, decision.kind, decision.importance);
    if (!verdict.allowed) {
      console.log(
        `[ProactivityHub] 频控拦截（通用）kind=${decision.kind} actor=${actorId} reason=${verdict.reason}`,
      );
      this.rememberBlockedDecision(actorId, observationFingerprint);
      return;
    }
    this.governor.record(actorId, decision.kind);
    const rationale = decision.rationale || decision.messageHint || "主动行为";
    this.rememberInitiative(actorId, `${decision.kind}: ${rationale}`);

    switch (decision.mode as ProactiveBehaviorMode) {
      case "speak":
        this.emitSpeakSignal({
          actorId,
          kind: decision.kind,
          importance: decision.importance,
          title: rationale.slice(0, 60),
          summary: decision.messageHint || rationale,
          source,
        } as ProactiveIntent);
        break;
      case "act":
        await this.runActPlan({
          actorId,
          kind: decision.kind,
          importance: decision.importance,
          steps: decision.actions.map((a) => ({ tool: a.tool, args: a.args })),
          rationale,
          messageHint: decision.messageHint,
          source,
        });
        break;
      case "advise":
        // advise 不再注入对话 prompt，改由 fast speak 车道以主动对话形式投递。
        this.emitSpeakSignal({
          actorId,
          kind: decision.kind,
          importance: decision.importance,
          title: rationale.slice(0, 60),
          summary: decision.messageHint || rationale,
          source,
        } as ProactiveIntent);
        break;
    }
  }

  /** 记录已发起的主动行为（防 LLM 重复同类主动） */
  private rememberInitiative(actorId: string, line: string): void {
    const list = this.recentInitiatives.get(actorId) ?? [];
    list.push(line.slice(0, 120));
    if (list.length > RECENT_INITIATIVES_LIMIT) list.shift();
    this.recentInitiatives.set(actorId, list);
  }

  /**
   * LLM 判了主动但被抑制/频控拦截 → 记入负向决策缓存：同样的观察窗口再到达时
   * 免重复 LLM 调用（结果大概率仍是同样的拦截）。高显著观察仍不跳过
   * （shouldSkip 护栏），静默时段/预算类拦截由各自机制承担恢复。
   */
  private rememberBlockedDecision(actorId: string, observationFingerprint?: string): void {
    if (!observationFingerprint) return;
    this.decisionCache.recordBlocked(actorId, observationFingerprint);
  }

  // ---- 内部实现 ----

  private async tickAll(now: Date = new Date()): Promise<void> {
    for (const actorId of this.knownActors) {
      try {
        await this.onTick(actorId, now);
      } catch (err) {
        console.log(`[ProactivityHub] onTick(${actorId}) 失败（忽略）: ${err}`);
      }
    }
  }

  /**
   * 后台零 LLM 规则判：拿到对话内容后，用纯规则（关键词/语义泛化）判断是否有
   * 值得主动承接的线索（care/followup），命中则经频控后主动 speak。
   * 不调用 LLM、不进对话 prompt，模拟人类自发性（得到信息→判断→决定→触发）。
   */
  private async runConversationRuleJudge(actorId: string, text: string): Promise<void> {
    // buildConversationIntent 内部已做钩子粗筛（零 LLM），未命中返回 null。
    const intent = buildConversationIntent(actorId, text, "");
    if (intent) await this.route(intent);
  }

  /** 快路径核心：意图 → 抑制 → 频控 → 按行为模式分发 */
  private async route(intent: ProactiveIntent): Promise<void> {
    // 负反馈抑制检查（用户意愿优先于时间冷却）：kind 级或关键词级命中即放弃
    const suppression = this.deps.suppressionStore?.isSuppressed(
      intent.actorId,
      intent.kind,
      `${intent.title} ${intent.summary}`,
    );
    if (suppression?.suppressed) {
      console.log(
        `[ProactivityHub] 负反馈抑制拦截 kind=${intent.kind} actor=${intent.actorId} reason=${suppression.reason}`,
      );
      return;
    }
    const verdict = this.governor.canTrigger(intent.actorId, intent.kind, intent.importance);
    if (!verdict.allowed) {
      console.log(`[ProactivityHub] 频控拦截 kind=${intent.kind} actor=${intent.actorId} reason=${verdict.reason}`);
      return;
    }
    this.governor.record(intent.actorId, intent.kind);
    this.rememberInitiative(intent.actorId, `${intent.kind}: ${intent.title}`);

    switch (intent.mode as ProactiveBehaviorMode) {
      case "speak":
        this.emitSpeakSignal(intent);
        break;
      case "act":
        // 三分支执行语义（方案 C）：效用评估 → 静默执行 / 先问 / 沉默
        await this.runActPlan({
          actorId: intent.actorId,
          kind: intent.kind,
          importance: intent.importance,
          steps: intent.actArgs ?? [],
          rationale: intent.title,
          messageHint: intent.summary,
          source: intent.source,
        });
        break;
      case "advise":
        // advise 不再注入对话 prompt（会污染对话），改由 fast speak 车道以主动对话形式投递。
        this.emitSpeakSignal(intent);
        break;
    }
  }

  /** speak 模式：发布 LifeSignal → 现有 ProactionCortex 闭环接管 */
  private emitSpeakSignal(intent: ProactiveIntent): void {
    try {
      this.deps.publishSignal({
        actorId: intent.actorId,
        kind: intent.kind,
        title: intent.title,
        summary: intent.summary,
        importance: intent.importance,
        tags: [intent.kind, "proactivity"],
        evidence: [`source=${intent.source}`, intent.summary.slice(0, 96)],
        metadata: {
          source: intent.source,
          proactivityKind: intent.kind,
        },
      });
      console.log(
        `[ProactivityHub] speak 信号已发布 kind=${intent.kind} importance=${intent.importance} actor=${intent.actorId}`,
      );
    } catch (err) {
      console.log(`[ProactivityHub] speak 信号发布失败（忽略）: ${err}`);
    }
  }

  // ─── 方案 C：三分支执行语义（execute_silently / ask_first / silence）───

  /**
   * 行动计划统一入口：先过 Action Utility 评估（零 LLM 确定性规则）再执行。
   *   execute_silently —— 可逆 + 已授权 + 高净效用：直接执行不通知（act 审计留痕）
   *   ask_first        —— 不可逆 / 高金融 / 无授权涉第三方：挂起计划，发确认请求等用户回复
   *   silence          —— 净效用为负：什么都不做，但记入沉默日志（可反问追溯）
   * PROACTIVITY_UTILITY_EVAL=0 时整体回退升级前行为：直接执行 + speak 告知。
   */
  private async runActPlan(input: {
    actorId: string;
    kind: string;
    importance: "high" | "medium" | "low";
    steps: Array<{ tool: string; args: Record<string, unknown> }>;
    rationale: string;
    messageHint: string;
    source: string;
  }): Promise<ActionUtilityBranch> {
    if (input.steps.length === 0) return "silence"; // 空计划无可执行内容

    // 回退开关：跳过效用评估，恢复「直接执行 + 事后告知」的升级前语义
    if (!isUtilityEvalEnabled()) {
      await this.executeActs(input.actorId, input.steps);
      this.emitSpeakSignal({
        actorId: input.actorId,
        kind: input.kind,
        importance: input.importance,
        title: `我刚才顺手做了点事：${input.rationale.slice(0, 40)}`,
        summary: `行动计划：${input.steps.map((s) => s.tool).join(" → ")}。${input.messageHint}`,
        mode: "speak",
        source: input.source,
      } as ProactiveIntent);
      return "execute_silently";
    }

    const result = evaluateActionUtility({
      kind: input.kind,
      title: input.rationale,
      risk: deriveRiskFromSteps(input.steps),
      authorization: authorizationForSource(input.source),
      value: deriveActValue(input.importance),
    });

    if (result.branch === "execute_silently") {
      await this.executeActs(input.actorId, input.steps);
      console.log(
        `[ProactivityHub] act 静默执行 kind=${input.kind} tools=${input.steps.map((s) => s.tool).join(",")} netUtility=${result.netUtility}`,
      );
      return result.branch;
    }
    if (result.branch === "ask_first") {
      const planSummary = input.steps.map((s) => s.tool).join(" → ");
      const pending = this.confirmations.register({
        actorId: input.actorId,
        kind: input.kind,
        steps: input.steps,
        rationale: input.rationale,
        createdAt: Date.now(),
        expiresAt: Date.now() + CONFIRMATION_TTL_MS,
        origin: "hub",
      });
      // 暂停执行，确认请求即本次主动消息；回复「可以」走 resolveConfirmation 推进
      this.emitSpeakSignal({
        actorId: input.actorId,
        kind: input.kind,
        importance: input.importance,
        title: `需要确认：${input.rationale.slice(0, 40)}`,
        summary:
          `我准备执行：${planSummary}。${input.messageHint} ` +
          `${result.reason.startsWith("unauthorized_third_party") ? "这件事会影响第三方，" : ""}可以吗？`,
        mode: "speak",
        source: input.source,
      } as ProactiveIntent);
      console.log(
        `[ProactivityHub] act 待确认（ask_first）kind=${input.kind} confirmId=${pending.confirmId} reason=${result.reason}`,
      );
      return result.branch;
    }
    // silence：什么都不做但记录决策（方案 B 沉默日志，支持反问追溯）
    this.silenceLog.record({
      at: Date.now(),
      actorId: input.actorId,
      kind: input.kind,
      title: input.rationale.slice(0, 60),
      source: input.source,
      scope: "action",
      netUtility: result.netUtility,
      riskScore: result.riskScore,
      valueScore: result.valueScore,
      reason: result.reason,
    });
    console.log(
      `[ProactivityHub] act 沉默 kind=${input.kind} netUtility=${result.netUtility} reason=${result.reason}`,
    );
    return result.branch;
  }

  /** 待确认条目列表（hub 行动级 + 管道提案级；对话工具/诊断接口读取，过期自动剔除） */
  listPendingConfirmations(actorId: string): PendingActionConfirmation[] {
    return this.confirmations.list(actorId);
  }

  /**
   * 用户回复推进挂起的确认：approved=true 执行计划；false/超时作废。
   * confirmId 省略时取该 actor 最新一条（语音回复「可以」的单活跃假设）。
   *   origin=hub      → 执行工具步骤（黑名单安全门兜底）+ 结果 speak 反馈
   *   origin=pipeline → 委托 setPipelineConfirmationResolver 注入的管道回调
   */
  async resolveConfirmation(
    actorId: string,
    approved: boolean,
    confirmId?: string,
  ): Promise<{ ok: boolean; executed: boolean; confirmId?: string; error?: string }> {
    this.confirmations.pruneExpired();
    let entry: PendingConfirmation | undefined;
    if (confirmId) {
      const found = this.confirmations.get(confirmId);
      if (found && found.actorId === actorId) entry = found;
    } else {
      const mine = this.confirmations.list(actorId);
      entry = mine[mine.length - 1];
    }
    if (!entry) return { ok: false, executed: false, error: "没有待确认的行动计划" };
    this.confirmations.take(entry.confirmId);

    if (!approved) return { ok: true, executed: false, confirmId: entry.confirmId };

    if (entry.origin === "pipeline") {
      const result = await this.pipelineConfirmationResolver?.(entry, true);
      return { ok: true, executed: result?.executed ?? false, confirmId: entry.confirmId };
    }

    const results = await this.executeActs(actorId, entry.steps);
    this.emitConfirmationFeedback(actorId, entry, results);
    return { ok: true, executed: results.some((r) => r.ok), confirmId: entry.confirmId };
  }

  /** 确认后的执行结果反馈（用户显式参与过的动作必须闭环告知；静默分支不受影响） */
  private emitConfirmationFeedback(
    actorId: string,
    entry: PendingConfirmation,
    results: Array<{ tool: string; ok: boolean }>,
  ): void {
    const tools = entry.steps.map((s) => s.tool).join(" → ");
    const okCount = results.filter((r) => r.ok).length;
    let summary: string;
    if (results.length === 0 || okCount === 0) {
      summary = `你确认的操作（${tools}）未能执行：安全策略拦截或执行失败。`;
    } else if (okCount < results.length) {
      summary = `已按你的确认部分完成（${okCount}/${results.length}）：${tools}。失败部分我不再自动重试。`;
    } else {
      summary = `已按你的确认完成：${tools}。`;
    }
    this.emitSpeakSignal({
      actorId,
      kind: entry.kind,
      importance: okCount === results.length ? "low" : "medium",
      title: okCount === 0 ? "确认的操作未执行" : "确认的操作已完成",
      summary,
      mode: "speak",
      source: "task",
    } as ProactiveIntent);
  }

  /** 沉默决策检索（「你上周为什么没提醒我 XX」反问链路） */
  searchSilences(opts: SilenceSearchOptions): SilenceLogEntry[] {
    return this.silenceLog.search(opts);
  }

  /**
   * act 模式：按序静默执行工具（黑名单安全门 + 步数上限，失败仅日志不抛出）。
   * 通用路径与快路径共用；LLM 自主选的工具只要不踩黑名单即可执行。
   * 返回每个已尝试步骤的结果（确认闭环据此向用户反馈；blocked=安全门拦截）。
   */
  private async executeActs(
    actorId: string,
    steps: Array<{ tool: string; args: Record<string, unknown> }>,
  ): Promise<Array<{ tool: string; ok: boolean; blocked?: boolean }>> {
    const results: Array<Record<string, unknown>> = [];
    const outcomes: Array<{ tool: string; ok: boolean; blocked?: boolean }> = [];
    for (const step of steps.slice(0, ACT_MAX_STEPS)) {
      if (ACT_TOOL_DENY_RE.test(step.tool)) {
        console.log(`[ProactivityHub] act 步骤被安全门拦截（危险操作）: ${step.tool}`);
        outcomes.push({ tool: step.tool, ok: false, blocked: true });
        continue;
      }
      const args = this.resolveStepArgs(step as ProactiveActStep, results);
      try {
        const ret = await this.deps.executeTool(step.tool, args, actorId);
        results.push(ret?.result ?? {});
        outcomes.push({ tool: step.tool, ok: ret?.ok === true });
        console.log(
          `[ProactivityHub] act 执行 ${ret?.ok ? "成功" : "失败"} tool=${step.tool} actor=${actorId}`,
        );
        // act 审计：记录自主执行（时间/工具/参数），供安全复盘；仅内存保留近 N 条
        this.recordActAudit(actorId, step.tool, args);
        if (!ret?.ok) break; // 前置步骤失败则中断链（如 search 失败不硬播）
      } catch (err) {
        console.log(`[ProactivityHub] act 执行异常 tool=${step.tool}（忽略）: ${err}`);
        outcomes.push({ tool: step.tool, ok: false });
        break;
      }
    }
    return outcomes;
  }

  /** 记录一次自主工具执行（act 审计；内存环形保留近 N 条） */
  private recordActAudit(
    actorId: string,
    tool: string,
    args: Record<string, unknown>,
  ): void {
    const list = this.actAudit.get(actorId) ?? [];
    list.push({ at: Date.now(), tool, args });
    if (list.length > this.ACT_AUDIT_LIMIT) list.splice(0, list.length - this.ACT_AUDIT_LIMIT);
    this.actAudit.set(actorId, list);
  }

  /** 读取 act 审计（诊断/安全复盘用） */
  getActAudit(actorId: string): Array<{ at: number; tool: string; args: Record<string, unknown> }> {
    return this.actAudit.get(actorId) ?? [];
  }

  /** 解析步骤参数：fromStep 引用前序结果（media.search → media.play 链） */
  private resolveStepArgs(
    step: ProactiveActStep,
    previousResults: Array<Record<string, unknown>>,
  ): Record<string, unknown> {
    if (step.fromStep === undefined) return step.args;
    const source = previousResults[step.fromStep];
    if (step.tool === "media.play") {
      const track = parseFirstTrack(source);
      if (!track) return step.args;
      return {
        ...step.args,
        trackId: track.trackId,
        ...(track.trackName !== undefined ? { trackName: track.trackName } : {}),
        ...(track.artist !== undefined ? { artist: track.artist } : {}),
        ...(track.durationSec !== undefined ? { durationSec: track.durationSec } : {}),
      };
    }
    return step.args;
  }
}
