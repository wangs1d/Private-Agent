// ProactivityHub —— 主动性多元化模块（类型定义）
//
// 设计：主动性解耦为独立模块。ProactivityHub 负责"何时、为何、以何种行为模式
// 主动发起"；话术质量交给现有 ProactionCortex speak 闭环（不重造）。

/** 主动意图类型（多元触发源） */
export type ProactiveIntentKind =
  | "task_celebration" // 任务完成恭喜（复杂任务完成 / 用户待办闭环）
  | "interest_share"   // 兴趣分享（用户喜欢的话题 / agent 自己的视角）
  | "interest_alert"   // 兴趣话题热议推送（后台盯用户关注话题，热搜命中→主动告知）
  | "greeting"         // 时段问候（早安 / 久别重逢）
  | "overwork_care"    // 过劳关怀干预（连续加班 → 调日程 + 放音乐 + 说话）
  | "care"             // 对话内情绪关怀（迁移自 agent-core 对话钩子）
  | "followup"         // 对话内待办跟进（迁移自 agent-core 对话钩子）
  // ── C 端生活管家场景（Task 20 统一频控注册）──
  | "weather_alert"    // 恶劣天气预警联动（暴雨/高温/寒潮等 + 当日有日程 → 合并提醒）
  | "life_reminder"    // 生活提醒（重要日子/预算超支/节律喝水睡觉运动等）
  | "monthly_report";  // 月度报告（消费月报等，确定性数据拼接 + 单次 LLM 总结）

/** 主动行为模式：主动性不只表现为"发消息" */
export type ProactiveBehaviorMode =
  | "speak"   // 发布 LifeSignal → 现有 ProactionCortex 话术闭环
  | "act"     // 静默后台执行工具（actArgs），可附 speak 信号告知
  | "advise"; // 建议注入下一轮对话（advice store），不打扰

/** act 模式的单个执行步骤 */
export type ProactiveActStep = {
  tool: string;
  args: Record<string, unknown>;
  /**
   * 引用前面第 N 步（下标）的结果填充 args（当前支持 media.search → media.play 链：
   * 取搜索结果第一条曲目填入 trackId/trackName/artist/durationSec）。
   */
  fromStep?: number;
};

/** 一次主动意图 */
export type ProactiveIntent = {
  actorId: string;
  kind: ProactiveIntentKind;
  importance: "high" | "medium" | "low";
  /** 信号标题（喂给 ProactionCortex 的 LifeSignal.title） */
  title: string;
  /** 上下文：用户原话 / 任务目标 / 画像兴趣等（LifeSignal.summary） */
  summary: string;
  mode: ProactiveBehaviorMode;
  /** act 模式：直接后台执行的工具调用（白名单内，按序执行） */
  actArgs?: ProactiveActStep[];
  source:
    | "conversation"
    | "task"
    | "rhythm"
    | "profile"
    | "time"
    | "epitome"
    | "interest_watch"
    // ── C 端生活管家场景触发源 ──
    | "weather"       // 天气预警联动（晨报/天气服务检测）
    | "finance"       // 消费管家（自动入账/预算超支/月报）
    | "relationship"  // 人情关系（重要日子扫描/祝福草稿）
    | "health";       // 健康关怀（节律提醒等）
};

// ─── 通用主动性层（Jarvis 式：感知 → LLM 自主决策 → 通用执行） ───

/**
 * 通用感知观察 —— 任何源产出的统一格式。
 * 感知是可插拔的通用流：对话轮、日程变化、节律（连续工作/深夜）、任务事件、
 * 桌面 presence、情绪信号……全部汇成 Observation，供 InitiativeEngine 消费。
 */
export type Observation = {
  actorId: string;
  /** 观察类型（如 conversation_turn / schedule_upcoming / rhythm_overwork / task_completed / loop_closed / desktop_presence） */
  type: string;
  /** 自然语言描述（LLM 直接可读） */
  content: string;
  /** 显著性：high=值得立即注意；medium=普通事件；low=背景噪声 */
  salience: "high" | "medium" | "low";
  /** 观察时刻（ms 时间戳） */
  observedAt: number;
  metadata?: Record<string, unknown>;
};

/**
 * InitiativeEngine（LLM 主动性决策）的输出。
 * LLM 拿到观察窗口 + 用户画像 + 频控余量，自主判断：
 * 是否主动、以何种模式（speak/act/advise/none）、具体做什么（行动计划）。
 */
export type InitiativeDecision = {
  /** none = 本轮不主动（大多数时候的答案——克制是主动性的前提） */
  mode: ProactiveBehaviorMode | "none";
  /** 主动性分类标签（频控冷却维度，LLM 自定义，如 schedule_care / mood_support） */
  kind: string;
  importance: "high" | "medium" | "low";
  /** 为什么主动（一句话，审计/日志用） */
  rationale: string;
  /** speak/advise 的话术提示（告诉闭环 LLM 该聊什么、什么口吻） */
  messageHint: string;
  /** act 模式的行动计划：LLM 自主选择的工具调用（黑名单安全门拦截危险操作） */
  actions: Array<{ tool: string; args: Record<string, unknown> }>;
};

/** 触发源标记 */
export type ProactiveTriggerSource = ProactiveIntent["source"];

/** 频控判定结果 */
export type FrequencyVerdict = {
  allowed: boolean;
  reason: string;
};
