// 目标板与预执行（GoalBoard + ReadyTray）—— 五层主动性架构 L4 的落地。
//
// 两类目标：
//  - track：跟踪型（盯某件事直到状态变化）—— commitment-board / interest-watch
//    等现有服务保持独立，本板负责跨类型的统一台账与生命周期
//  - preexec：预执行型（后台把"用户接下来大概率要的东西"提前备好）——
//    完成后进 ReadyTray，经 goal 信号流 → goal_ready 评估器 → 仲裁挑时机投递。
//    这是"用户还没开口，东西已经在了"的哇时刻来源。
//
// 旗舰预执行场景：
//  1. 晨间简报 —— 见 evaluators/morning_brief（数据全本地，即时拼接）
//  2. 会前准备包 —— 本模块 maybeStartMeetingPrep：会议前 25-40min 后台
//     召回相关记忆/待办，备好材料包（异步，完成后进托盘）
//  3. 承诺守约链 —— 见 evaluators/commitment_chain（ask_first 代催，管道确认回流）
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type GoalStatus = "watching" | "preparing" | "ready" | "done" | "expired";

export type GoalRecord = {
  goalId: string;
  actorId: string;
  /** track=盯一件事；preexec=后台提前备一件事 */
  kind: "track" | "preexec";
  /** 场景类型（morning_brief / meeting_prep / commitment_chain / custom） */
  type: string;
  title: string;
  status: GoalStatus;
  createdAt: number;
  readyAt?: number;
  /** ReadyTray 里的就绪载荷（投递正文等） */
  payload?: Record<string, unknown>;
  /** 保质期：ready 后未投递到该时刻作废 */
  expiresAt?: number;
};

export type GoalBoardDeps = {
  dataPath: string;
  /** goal 流 feeder（内核信号）：goal 状态变化 → 评估器感知 */
  emitGoal: (goal: GoalRecord) => void;
  /** 记忆召回（会前准备包的数据源；可选） */
  recallMemory?: (query: string, limit: number) => Promise<string[]> | string[];
  nowFn?: () => number;
};

let seq = 0;

export class GoalBoard {
  private readonly goals = new Map<string, GoalRecord>();
  private readonly filePath: string;
  private readonly nowFn: () => number;

  constructor(private readonly deps: GoalBoardDeps) {
    this.filePath = join(deps.dataPath, "goals.json");
    this.nowFn = deps.nowFn ?? Date.now;
    this.load();
  }

  create(input: {
    actorId: string;
    kind: GoalRecord["kind"];
    type: string;
    title: string;
    payload?: Record<string, unknown>;
  }): GoalRecord {
    const goal: GoalRecord = {
      goalId: `g_${Date.now().toString(36)}_${(seq++).toString(36)}`,
      actorId: input.actorId,
      kind: input.kind,
      type: input.type,
      title: input.title,
      status: input.kind === "preexec" ? "preparing" : "watching",
      createdAt: this.nowFn(),
      ...(input.payload ? { payload: input.payload } : {}),
    };
    this.goals.set(goal.goalId, goal);
    this.persist();
    this.deps.emitGoal(goal);
    return goal;
  }

  markReady(goalId: string, payload: Record<string, unknown>): GoalRecord | null {
    const goal = this.goals.get(goalId);
    if (!goal || goal.status === "ready" || goal.status === "done") return goal ?? null;
    goal.status = "ready";
    goal.readyAt = this.nowFn();
    goal.payload = { ...goal.payload, ...payload };
    // ready 后 2h 未投递作废（材料过时没有价值）
    goal.expiresAt = goal.readyAt + 2 * 3600_000;
    this.persist();
    this.deps.emitGoal(goal);
    return goal;
  }

  markDone(goalId: string): void {
    const goal = this.goals.get(goalId);
    if (!goal) return;
    goal.status = "done";
    this.persist();
  }

  /** ReadyTray：status=ready 且未过期的目标（晨间简报/心跳回顾拼接展示） */
  readyTray(): GoalRecord[] {
    const now = this.nowFn();
    const ready: GoalRecord[] = [];
    for (const goal of this.goals.values()) {
      if (goal.status === "ready" && (!goal.expiresAt || goal.expiresAt > now)) ready.push(goal);
    }
    return ready;
  }

  list(actorId?: string): GoalRecord[] {
    const all = [...this.goals.values()].sort((a, b) => b.createdAt - a.createdAt);
    return actorId ? all.filter((g) => g.actorId === actorId) : all;
  }

  stats(): { total: number; preparing: number; ready: number; done: number } {
    let preparing = 0;
    let ready = 0;
    let done = 0;
    for (const g of this.goals.values()) {
      if (g.status === "preparing" || g.status === "watching") preparing += 1;
      else if (g.status === "ready") ready += 1;
      else if (g.status === "done") done += 1;
    }
    return { total: this.goals.size, preparing, ready, done };
  }

  /**
   * 旗舰场景 2：会前准备包。下一个会议在 25-40 分钟内且该会议尚未备过 →
   * 建 preexec 目标，后台召回相关记忆/材料，完成后 markReady 进托盘。
   * 幂等：同一 runAt 只备一次（内存去重，重启后会议散场自然失效）。
   */
  maybeStartMeetingPrep(actorId: string, meeting: { title: string; runAtMin: number; runAt?: number }): GoalRecord | null {
    if (meeting.runAtMin < 25 || meeting.runAtMin > 40) return null;
    const prepKey = `meeting_prep:${meeting.runAt ?? meeting.title}`;
    for (const g of this.goals.values()) {
      if (g.type === "meeting_prep" && g.payload?.prepKey === prepKey) return null;
    }
    const goal = this.create({
      actorId,
      kind: "preexec",
      type: "meeting_prep",
      title: `会前准备：${meeting.title}`,
      payload: { prepKey, meetingTitle: meeting.title },
    });
    void this.prepareMeetingMaterials(goal).catch(() => {
      /* 准备失败静默：目标停在 preparing，超时自然过期 */
    });
    return goal;
  }

  private async prepareMeetingMaterials(goal: GoalRecord): Promise<void> {
    const title = String(goal.payload?.meetingTitle ?? goal.title);
    const lines: string[] = [];
    if (this.deps.recallMemory) {
      const items = await this.deps.recallMemory(title, 3);
      for (const item of items) lines.push(item);
    }
    const body =
      lines.length > 0
        ? `关于「${title}」我翻到的上下文：${lines.join("；")}。材料都在手边，随时开工。`
        : `「${title}」的相关背景我先过了一遍，没翻到历史交互。需要补充材料就说一声。`;
    this.markReady(goal.goalId, {
      body,
      bodyKind: "meeting_prep",
      dedupFields: { title: `会前准备：${title}` },
    });
  }

  private load(): void {
    try {
      if (!existsSync(this.filePath)) return;
      const raw = JSON.parse(readFileSync(this.filePath, "utf8")) as GoalRecord[];
      for (const goal of raw) this.goals.set(goal.goalId, goal);
    } catch {
      /* 损坏文件按空板处理 */
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      // 只保留近 7 天的目标（台账瘦身）
      const cutoff = this.nowFn() - 7 * 24 * 3600_000;
      const list = [...this.goals.values()].filter((g) => g.createdAt > cutoff);
      writeFileSync(this.filePath, JSON.stringify(list, null, 1));
    } catch {
      /* 落盘失败忽略 */
    }
  }
}
