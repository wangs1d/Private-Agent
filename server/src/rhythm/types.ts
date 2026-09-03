/**
 * 生活节律引擎（Task 20）类型契约。
 *
 * 定位：节律画像的唯一所有者（Single Source of Truth）+ 两个可插拔边界：
 *   ① 传感器边界（进）：RhythmSensor 从既有数据源拉取观察
 *   ② 消费方边界（出）：RhythmConsumer 订阅画像变更后各自落权
 * 引擎自身不做消息路由、不做"现在该不该打扰"的决策——后者仍归
 * ProactiveContactPolicy / Fatigue / ProactionCortex 等现有决策链。
 *
 * 建模原则：统计为骨架（中位数/EWMA/星期分布），置信度门槛 + 渐进调整；
 * LLM 解释层（insights 的人话润色）留给后续阶段，当前 insight 全部纯统计生成。
 */

/** 节律维度。新增维度 = 新增一个 RhythmDimensionModel 实现并注册，引擎无感知 */
export type RhythmDimension = "sleep" | "focus" | "overtime" | "receptivity";

/** 传感器产出的单条观察。value 语义由 dimension 约定（见各模型器注释） */
export type RhythmObservation = {
  dimension: RhythmDimension;
  /** 观察发生时间（ISO） */
  at: string;
  /** 主值：sleep=入睡小时(十进制)；focus=活跃小时；overtime/receptivity=0/1 布尔 */
  value: number;
  /** 辅值：sleep 为醒来小时；其余维度不用 */
  value2?: number;
  /** 观察子类型（如 "sleep_sample" / "desktop_active" / "contact_outcome"） */
  kind?: string;
  /** 权重（默认 1） */
  weight?: number;
  /** 产生该观察的传感器 id */
  source: string;
  /** 可选备注（透传给 insight evidence） */
  note?: string;
};

// ---- 各维度状态 ----

export type SleepSample = {
  /** 样本日期 YYYY-MM-DD（去重键） */
  date: string;
  /** 入睡时刻（十进制小时，如 23.5） */
  startHour: number;
  /** 醒来时刻（十进制小时） */
  endHour: number;
};

export type SleepDimensionState = {
  samples: SleepSample[];
  /** 中位数入睡/醒来小时；样本不足为 null */
  windowStartHour: number | null;
  windowEndHour: number | null;
  sampleCount: number;
  /** 近 3 个样本 vs 之前样本的入睡中位数偏移（分钟，正=变晚） */
  trendMinutes: number;
};

export type FocusPeakBlock = {
  startHour: number;
  endHour: number;
  /** 0..1 归一化强度 */
  score: number;
};

export type FocusDimensionState = {
  /** 24 槽衰减累计活跃强度（每槽 0..~∞，内部值，不对外承诺尺度） */
  hourHistogram: number[];
  peakBlocks: FocusPeakBlock[];
  totalWeight: number;
};

export type OvertimeDayBit = {
  /** 本地日 YYYY-MM-DD（去重键，重复分析同日不叠加） */
  date: string;
  /** 0..6（周日=0） */
  weekday: number;
  /** 该日最后一次活跃是否 ≥ 晚归阈值 */
  late: 0 | 1;
};

export type OvertimeDimensionState = {
  /** 最近若干天的晚归位序列（按日去重，跨星期保留） */
  recentDays: OvertimeDayBit[];
  /** 派生值：0..6 各星期"晚归概率"（该星期最近若干晚归日占比，0..1） */
  byWeekday: number[];
  /** 派生值：0..6 各星期累计观察天数 */
  weekdayDays: number[];
  totalDays: number;
};

export type ReceptivityDimensionState = {
  /** 24 槽触达接受度 EWMA（0..1） */
  byHour: number[];
  /** 7 槽星期接受度 EWMA（0..1） */
  byWeekday: number[];
  attempts: number;
};

export type RhythmDimensionStates = {
  sleep: SleepDimensionState;
  focus: FocusDimensionState;
  overtime: OvertimeDimensionState;
  receptivity: ReceptivityDimensionState;
};

// ---- 洞察 / 提醒槽位 ----

export type RhythmInsightKind = "trend" | "anomaly" | "observation" | "suggestion";

export type RhythmInsight = {
  id: string;
  generatedAt: string;
  dimension: RhythmDimension;
  kind: RhythmInsightKind;
  text: string;
  evidence: string[];
  confidence: number;
  /** 是否值得主动关怀（强度门槛在 insights 构建器内把关）；消费方仍受自身频控约束 */
  notifiable: boolean;
};

/** 单个节律提醒任务的槽位状态（出口 A 的记账本） */
export type ReminderSlotState = {
  taskId: string;
  /** 当前调度时刻（十进制小时，任务时区） */
  hour: number;
  /** 引擎见过的初始时刻（渐进调整的锚点） */
  originalHour: number;
  /** 接受度 EWMA（0..1）；无反馈数据为 null */
  acceptanceEwma: number | null;
  attempts: number;
  lastAdjustedAt: string | null;
  lastAdjustDirection: "earlier" | "later" | null;
  /** 用户手动固定（用户改过时间/明确说别动），引擎永不调整 */
  pinnedByUser: boolean;
};

export type RhythmProfile = {
  schemaVersion: 1;
  actorId: string;
  createdAt: string;
  updatedAt: string;
  /** 最近一次夜间分析日（YYYY-MM-DD，去重键） */
  lastAnalyzedDay: string | null;
  dimensions: RhythmDimensionStates;
  reminderSlots: Record<string, ReminderSlotState>;
  /** 最近一次关怀 candidate 发布（按维度限频用） */
  lastCandidateAt: Partial<Record<RhythmDimension, string>>;
  insights: RhythmInsight[];
};

export type RhythmProfileUpdate = {
  actorId: string;
  changedDimensions: RhythmDimension[];
  /** 各维度模型置信度（0..1），消费方据此决定是否动作 */
  confidences: Record<RhythmDimension, number>;
  insights: RhythmInsight[];
  profile: RhythmProfile;
};

// ---- 可插拔边界 ----

/** 传感器：从既有数据源拉取观察（夜间批处理时 collect） */
export type RhythmSensor = {
  id: string;
  dimensions: RhythmDimension[];
  collect(actorId: string, since: Date): RhythmObservation[] | Promise<RhythmObservation[]>;
};

/** 模型器：纯统计，ingest 返回新状态；confidence 不足时消费方应静默跳过 */
export type RhythmDimensionModel<S = unknown> = {
  dimension: RhythmDimension;
  ingest(
    prev: S | null,
    observations: RhythmObservation[],
    ctx: { now: Date },
  ): S;
  confidence(state: S): number;
};

export type RhythmConsumer = (update: RhythmProfileUpdate) => void | Promise<void>;

export type ReminderFeedbackOutcome = "accepted" | "dismissed" | "snoozed" | "ignored" | "replied";
