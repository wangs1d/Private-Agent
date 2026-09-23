// ProactivityHub —— L0 观察分诊（observation-triage）
//
// 2026-09-23 token 架构优化：通用路径的规则前置闸。
//
// 背景：此前感知窗口里只要有新观察（哪怕全是 conversation_turn/user_activity
// 这类低显著背景噪声）就会调一次 LLM 评估主动性——实测 28 天 9166 次评估
// （约 310 次/天），绝大多数以 none 收场，用户侧"什么主动行为都没看到"，
// token 却持续在烧。分诊原则与 InitiativeEngine 的提示词一致："大多数时候
// 答案是 none"——这句话不该由主模型花 token 说，规则就能先说。
//
// 设计约束：
// - 纯函数、零依赖、零 LLM：hub 在 peekWindow 后、consumeWindow 前调用；
//   skip 时窗口不消费，后续 medium/high 事件到来时一并评估（信号不丢）。
// - 快路径（问候/恭喜/过劳/兴趣热议/未读爆发等确定性场景）不经过本闸，
//   只管 LLM 通用路径的评估前置过滤。
import type { Observation } from "./proactivity-types.js";

export type TriageVerdict = {
  action: "evaluate" | "skip";
  /** skip 时给日志看的原因（evaluate 时为空串） */
  reason: string;
  /** 窗口内是否含 high 显著观察（决定评估时是否带工具清单——act 依据） */
  hasHighSalience: boolean;
  /** 窗口内是否含 medium+ 观察之外的决策价值信号（诊断用） */
  highCount: number;
  mediumCount: number;
};

/**
 * 观察窗口分诊：窗口内没有 medium/high 观察时跳过 LLM 评估。
 *
 * 规则表（按序）：
 *  1. 空窗口 → skip（上游已兜，防御性）；
 *  2. 含 high 显著观察 → evaluate（重要事件必须真评估，也绕过负向决策缓存）；
 *  3. 含 medium 观察（日程快照变化/兴趣热议/外部场景事件等）→ evaluate；
 *  4. 全部观察 salience=low → skip（含规则外的未知类型——salience 是生产方
 *     的显著性声明，声明为 low 就不该触发评估；否则任何模块推自定义低显著
 *     观察都会重新灌开 LLM 洪水）。
 */
export function triageObservations(window: Observation[]): TriageVerdict {
  let highCount = 0;
  let mediumCount = 0;
  for (const o of window) {
    if (o.salience === "high") highCount++;
    else if (o.salience === "medium") mediumCount++;
  }
  const hasHighSalience = highCount > 0;
  if (window.length === 0) {
    return { action: "skip", reason: "empty_window", hasHighSalience, highCount, mediumCount };
  }
  if (hasHighSalience || mediumCount > 0) {
    return { action: "evaluate", reason: "", hasHighSalience, highCount, mediumCount };
  }
  return {
    action: "skip",
    reason: "background_noise_only",
    hasHighSalience,
    highCount,
    mediumCount,
  };
}
