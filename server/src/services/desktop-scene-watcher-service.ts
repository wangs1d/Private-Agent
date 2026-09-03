/**
 * 桌面情境感知（SceneWatcher）—— 零 token 场景检测层。
 *
 * 输入：desktop.event（focus_change / window_open / scene_tick），payload 含
 * title + process，全部为本地结构化信号，不经过任何 LLM/VLM。
 *
 * 场景判定规则（纯代码）：
 * - meeting   会议：专用会议进程（腾讯会议/Zoom）任意窗口；或 Teams/钉钉/飞书
 *             等协作进程的会议标题窗口；或标题含「会议/Meeting」的任意窗口
 * - document  文档：窗口标题含可识别文档名（pdf/docx/txt/md 等）
 * - shopping  商品页：浏览器进程 + 标题命中电商域名/品牌关键词
 *
 * 状态机（按 actor 维护）：
 * - 会议：window_open 的会议窗口立即开会话（后台挂机也算）；前台确认
 *   （scene_tick/focus_change 持续 meetingConfirmMs）也可开会话。
 *   结束：window_open 方式开的会话由对应窗口 window_close 结束；
 *   前台方式开的会话在前台离开超过 meetingEndGraceMs 后结束。
 * - 文档/商品页：前台停留超过确认时长 + 冷却期内未触发过 → 触发一次。
 *
 * 所有回调的执行方（handler）由装配层注入；本类只做检测与节流，
 * 不做任何 IO，不调用任何模型。
 */

export type DesktopSceneKind = "meeting" | "document" | "shopping";

export type DesktopSceneInfo = {
  scene: DesktopSceneKind;
  /** 原始窗口标题 */
  title: string;
  process: string;
  /** 分类命中的关键词（会议词/电商词），供日志与调试 */
  matchedKey: string;
};

export type DesktopSceneDocumentInfo = DesktopSceneInfo & {
  /** 从标题提取到的完整路径（能提取到才有） */
  filePath: string | null;
  /** 从标题提取到的文件名（xxx.pdf 等） */
  fileName: string | null;
};

export type DesktopSceneMeetingSession = {
  title: string;
  process: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
};

export type DesktopSceneWatcherConfig = {
  /** 前台会议/文档/商品页需持续确认的时长（scene_tick 心跳约 30s 一次） */
  meetingConfirmMs: number;
  documentConfirmMs: number;
  shoppingConfirmMs: number;
  /** 前台方式开的会议，前台离开多久后判定结束 */
  meetingEndGraceMs: number;
  /** 同一文档/商品页的触发冷却 */
  documentCooldownMs: number;
  shoppingCooldownMs: number;
  /** 冷却表最大条目数（超出清最旧） */
  maxCooldownEntries: number;
};

export const DEFAULT_SCENE_WATCHER_CONFIG: DesktopSceneWatcherConfig = {
  meetingConfirmMs: 35_000,
  documentConfirmMs: 60_000,
  shoppingConfirmMs: 45_000,
  meetingEndGraceMs: 120_000,
  documentCooldownMs: 6 * 60 * 60_000,
  shoppingCooldownMs: 6 * 60 * 60_000,
  maxCooldownEntries: 200,
};

// ─── 分类规则表 ────────────────────────────────────────────────────────────

/** 专用会议进程：主窗口存在即视为在开会 */
const MEETING_DEDICATED_PROCESSES = ["wemeetapp", "zoom", "tencentmeeting"];

/** 协作类进程：需要窗口标题佐证才是会议 */
const MEETING_COLLAB_PROCESSES = ["teams", "ms-teams", "dingtalk", "feishu", "lark"];

/** 会议标题关键词（含协作进程窗口与任意未知进程的会议窗口） */
const MEETING_TITLE_KEYWORDS = [
  "会议", "meeting", "视频会议", "语音通话", "视频通话", "会议中",
];

/** 浏览器进程关键词（商品页只能在浏览器里） */
const BROWSER_PROCESS_KEYWORDS = [
  "chrome", "msedge", "edge", "firefox", "browser", "360se", "360chrome",
  "qqbrowser", "opera", "brave", "vivaldi", "sogou_explorer", "ucbrowser",
  "maxthon", "hao123",
];

/** 电商标题关键词（浏览器窗口标题通常含商品名+站点名） */
const SHOPPING_TITLE_KEYWORDS = [
  "淘宝", "天猫", "京东", "拼多多", "闲鱼", "苏宁", "唯品会", "得物", "亚马逊",
  "当当", "阿里巴巴", "1688",
  "taobao", "tmall", "jd.com", "pinduoduo", "yangkeduo", "amazon",
  "vip.com", "dewu", "1688.com",
];

/** 文档扩展名（与 Python 侧 document_reader.SUPPORTED_EXTS 对齐的常用子集） */
const DOC_TITLE_EXT_PATTERN =
  /([A-Za-z]:\\[^<>:"/|?*\r\n]+?|[^\\/|<>:"?*\r\n]+?)\.(pdf|docx|pptx|txt|md|csv|log|json)\b/i;

export type ClassifiedScene =
  | { kind: "meeting"; matchedKey: string }
  | { kind: "document"; matchedKey: string; filePath: string | null; fileName: string | null }
  | { kind: "shopping"; matchedKey: string }
  | { kind: null };

/** 把「进程名 + 窗口标题」分类为场景；不属于三类时 kind=null。纯函数。 */
export function classifyWindow(process: string, title: string): ClassifiedScene {
  const p = (process || "").toLowerCase();
  const t = (title || "").trim();

  // ── meeting ──
  if (t) {
    const lowerTitle = t.toLowerCase();
    if (MEETING_DEDICATED_PROCESSES.some((k) => p.includes(k))) {
      return { kind: "meeting", matchedKey: `process:${p}` };
    }
    const titleWord = MEETING_TITLE_KEYWORDS.find((k) => lowerTitle.includes(k));
    if (titleWord) {
      return { kind: "meeting", matchedKey: `title:${titleWord}` };
    }
    if (
      MEETING_COLLAB_PROCESSES.some((k) => p.includes(k)) &&
      MEETING_TITLE_KEYWORDS.some((k) => lowerTitle.includes(k))
    ) {
      // 标题词已命中，上面已返回；此处冗余防御（保持结构清晰）
      return { kind: "meeting", matchedKey: `collab:${p}` };
    }
  }

  if (!t) return { kind: null };

  // ── document ──
  const docMatch = t.match(DOC_TITLE_EXT_PATTERN);
  if (docMatch) {
    const raw = docMatch[1].trim().replace(/^["']+|["']+$/g, "");
    const ext = `.${docMatch[2].toLowerCase()}`;
    if (/^[A-Za-z]:\\/.test(raw)) {
      return {
        kind: "document",
        matchedKey: `doc:${raw}${ext}`,
        filePath: raw + ext,
        fileName: `${raw.split("\\").pop()}${ext}`,
      };
    }
    return {
      kind: "document",
      matchedKey: `doc:${raw}${ext}`,
      filePath: null,
      fileName: raw + ext,
    };
  }

  // ── shopping ──
  const lowerTitle = t.toLowerCase();
  const isBrowser = BROWSER_PROCESS_KEYWORDS.some((k) => p.includes(k));
  if (isBrowser) {
    const shopWord = SHOPPING_TITLE_KEYWORDS.find((k) => lowerTitle.includes(k));
    if (shopWord) {
      return { kind: "shopping", matchedKey: `shop:${shopWord}` };
    }
  }

  return { kind: null };
}

// ─── 状态机 ────────────────────────────────────────────────────────────────

type ForegroundStreak = {
  kind: DesktopSceneKind | null;
  matchedKey: string;
  title: string;
  process: string;
  since: number;
};

type ActorState = {
  /** 前台场景连续段（focus_change/scene_tick 更新） */
  streak: ForegroundStreak | null;
  /** 活动会议会话 */
  meeting: {
    title: string;
    process: string;
    startedAt: number;
    startedVia: "window" | "foreground";
    /** window 方式：记录会议窗口 hwnd 集合 */
    hwnds: Set<number>;
    /** foreground 方式：前台离开的起始时刻 */
    exitSince: number | null;
  } | null;
  /** 触发冷却表：key → 上次触发时刻 */
  lastFired: Map<string, number>;
};

export type DesktopSceneWatcherOptions = {
  onMeetingStarted?: (actorId: string, info: DesktopSceneInfo) => void;
  onMeetingEnded?: (actorId: string, session: DesktopSceneMeetingSession) => void;
  onDocumentDetected?: (actorId: string, info: DesktopSceneDocumentInfo) => void;
  onProductPageDetected?: (actorId: string, info: DesktopSceneInfo) => void;
  config?: Partial<DesktopSceneWatcherConfig>;
  /** 可注入时钟（测试用） */
  now?: () => number;
  /** 检测日志（默认 console.error 精简输出） */
  log?: (message: string) => void;
};

const HANDLED_EVENTS = new Set(["focus_change", "window_open", "scene_tick"]);

export class DesktopSceneWatcherService {
  private readonly config: DesktopSceneWatcherConfig;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly actors = new Map<string, ActorState>();

  constructor(private readonly opts: DesktopSceneWatcherOptions = {}) {
    this.config = { ...DEFAULT_SCENE_WATCHER_CONFIG, ...opts.config };
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.log ?? ((m) => console.error(`[DesktopSceneWatcher] ${m}`));
  }

  /**
   * 处理一条 desktop.event。只消费 focus_change / window_open / scene_tick；
   * 其他事件（window_close 单独参与会议结束判断，但由 handleWindowClose 进入）
   * 直接忽略。返回是否触发过回调（供测试断言）。
   */
  handleDesktopEvent(
    actorId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): boolean {
    if (!HANDLED_EVENTS.has(eventType)) return false;
    const title = String(payload.title ?? "");
    const process = String(payload.process ?? "");
    const now = this.now();

    if (eventType === "window_open") {
      return this.handleWindowOpen(actorId, title, process, payload.hwnd, now);
    }
    return this.handleForeground(actorId, title, process, now);
  }

  /** window_close：仅用于结束 window 方式开启的会议会话。 */
  handleWindowClose(actorId: string, payload: Record<string, unknown>): boolean {
    const state = this.actors.get(actorId);
    const meeting = state?.meeting;
    if (!state || !meeting || meeting.startedVia !== "window") return false;
    const hwndNum = Number(payload.hwnd);
    if (Number.isFinite(hwndNum) && hwndNum > 0) {
      meeting.hwnds.delete(hwndNum);
      if (meeting.hwnds.size > 0) return false; // 还有其他会议窗口
    }
    this.endMeeting(actorId, meeting, this.now());
    return true;
  }

  // ── 前台场景（focus_change / scene_tick 共用语义） ──
  private handleForeground(actorId: string, title: string, process: string, now: number): boolean {
    const state = this.actorState(actorId);
    const classified = classifyWindow(process, title);
    const kind = classified.kind;

    // 1) 会议会话维护（前台离开只在 foreground 方式下参与判定）
    if (state.meeting) {
      if (kind === "meeting") {
        state.meeting.exitSince = null;
      } else if (state.meeting.startedVia === "foreground") {
        if (state.meeting.exitSince === null) {
          state.meeting.exitSince = now;
        } else if (now - state.meeting.exitSince >= this.config.meetingEndGraceMs) {
          this.endMeeting(actorId, state.meeting, now);
        }
      }
    }

    // 2) 前台连续段更新
    const streak = state.streak;
    const sameStreak =
      streak !== null &&
      streak.kind === kind &&
      (kind === null || streak.matchedKey === (classified as { matchedKey: string }).matchedKey);
    if (!sameStreak) {
      state.streak = {
        kind,
        matchedKey: kind ? (classified as { matchedKey: string }).matchedKey : "",
        title,
        process,
        since: now,
      };
    } else if (streak) {
      streak.title = title;
      streak.process = process;
    }

    // 3) 场景触发
    let fired = false;
    const current = state.streak;
    if (!current || !current.kind) return false;
    const sustainedMs = now - current.since;

    if (current.kind === "meeting") {
      if (
        !state.meeting &&
        sustainedMs >= this.config.meetingConfirmMs
      ) {
        this.startMeeting(actorId, current.title, current.process, now, "foreground", new Set());
        fired = true;
      }
      return fired;
    }

    if (current.kind === "document") {
      if (sustainedMs >= this.config.documentConfirmMs) {
        fired = this.maybeFireWithCooldown(
          actorId,
          `doc:${current.matchedKey}`,
          this.config.documentCooldownMs,
          () => {
            if (typeof this.opts.onDocumentDetected !== "function") return false;
            this.opts.onDocumentDetected(actorId, {
              scene: "document",
              title: current.title,
              process: current.process,
              matchedKey: current.matchedKey,
              filePath: (classified as { filePath?: string | null }).filePath ?? null,
              fileName: (classified as { fileName?: string | null }).fileName ?? null,
            });
            return true;
          },
        );
      }
      return fired;
    }

    // shopping
    if (sustainedMs >= this.config.shoppingConfirmMs) {
      fired = this.maybeFireWithCooldown(
        actorId,
        `shop:${current.matchedKey}`,
        this.config.shoppingCooldownMs,
        () => {
          if (typeof this.opts.onProductPageDetected !== "function") return false;
          this.opts.onProductPageDetected(actorId, {
            scene: "shopping",
            title: current.title,
            process: current.process,
            matchedKey: current.matchedKey,
          });
          return true;
        },
      );
    }
    return fired;
  }

  // ── window_open：专用会议进程/会议标题窗口 → 立即开会话 ──
  private handleWindowOpen(
    actorId: string,
    title: string,
    process: string,
    hwnd: unknown,
    now: number,
  ): boolean {
    const state = this.actorState(actorId);
    if (state.meeting) {
      const hwndNum = Number(hwnd);
      if (Number.isFinite(hwndNum) && hwndNum > 0) state.meeting.hwnds.add(hwndNum);
      return false;
    }
    const classified = classifyWindow(process, title);
    if (classified.kind !== "meeting") return false;
    // window_open 只信「强信号」：专用会议进程，或标题直接是会议词
    const strong =
      classified.matchedKey.startsWith("process:") ||
      classified.matchedKey.startsWith("title:") ||
      classified.matchedKey.startsWith("collab:");
    if (!strong) return false;

    const hwnds = new Set<number>();
    const hwndNum = Number(hwnd);
    if (Number.isFinite(hwndNum) && hwndNum > 0) hwnds.add(hwndNum);
    this.startMeeting(actorId, title, process, now, "window", hwnds);
    return true;
  }

  private startMeeting(
    actorId: string,
    title: string,
    process: string,
    now: number,
    via: "window" | "foreground",
    hwnds: Set<number>,
  ): void {
    const state = this.actorState(actorId);
    state.meeting = {
      title,
      process,
      startedAt: now,
      startedVia: via,
      hwnds,
      exitSince: null,
    };
    this.log(`${actorId}: meeting started (${via}) title=${title.slice(0, 60)}`);
    this.opts.onMeetingStarted?.(actorId, {
      scene: "meeting",
      title,
      process,
      matchedKey: via,
    });
  }

  private endMeeting(actorId: string, meeting: NonNullable<ActorState["meeting"]>, now: number): void {
    const session: DesktopSceneMeetingSession = {
      title: meeting.title,
      process: meeting.process,
      startedAt: meeting.startedAt,
      endedAt: now,
      durationMs: Math.max(0, now - meeting.startedAt),
    };
    const state = this.actors.get(actorId);
    if (state) state.meeting = null;
    this.log(
      `${actorId}: meeting ended durationMs=${session.durationMs}`,
    );
    this.opts.onMeetingEnded?.(actorId, session);
  }

  /** 冷却检查 + 触发；fired() 返回是否真的执行了回调（回调可能返回 void）。 */
  private maybeFireWithCooldown(
    actorId: string,
    key: string,
    cooldownMs: number,
    fire: () => boolean,
  ): boolean {
    const state = this.actorState(actorId);
    const last = state.lastFired.get(key);
    const now = this.now();
    if (last !== undefined && now - last < cooldownMs) return false;
    state.lastFired.set(key, now);
    if (state.lastFired.size > this.config.maxCooldownEntries) {
      // 淘汰最旧的一半，避免长期运行泄漏
      const entries = [...state.lastFired.entries()].sort((a, b) => a[1] - b[1]);
      for (const [k] of entries.slice(0, Math.floor(entries.length / 2))) {
        state.lastFired.delete(k);
      }
    }
    const executed = fire();
    if (!executed) {
      // 回调未配置：回滚冷却，避免装配层补挂 handler 后被冷却挡住
      if (last === undefined) state.lastFired.delete(key);
      else state.lastFired.set(key, last);
      return false;
    }
    return true;
  }

  private actorState(actorId: string): ActorState {
    let state = this.actors.get(actorId);
    if (!state) {
      state = {
        streak: null,
        meeting: null,
        lastFired: new Map<string, number>(),
      };
      this.actors.set(actorId, state);
    }
    return state;
  }

  /** 测试/调试：重置某 actor 状态 */
  resetActor(actorId: string): void {
    this.actors.delete(actorId);
  }
}

/** 特性开关：DESKTOP_SCENE_WATCHER_ENABLED=1 时启用（默认关闭，情境监测需用户显式同意）。 */
export function isDesktopSceneWatcherEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.DESKTOP_SCENE_WATCHER_ENABLED ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}
