// ProactivityHub —— 兴趣分享触发器
//
// 从用户画像（OnlineLearningCortex preferences/topics）挑一个稳定兴趣点，
// 生成分享意图：agent 主动分享与用户兴趣相关的内容，或以自己的视角聊起。
// 话术由 speak 闭环 LLM 自然生成（prompt 已要求朋友口吻），
// agent "自己喜欢的"由 LLM 话术自然带出，不单独建 agent 偏好库。
import type { ProactiveIntent } from "../proactivity-types.js";

/** hub 侧画像读取的最小接口（避免依赖 OnlineLearningCortex 具体类型） */
export interface ShareProfileInput {
  /** 用户偏好条目（key/value + 权重），按 effectiveWeight 降序最佳 */
  preferences?: Array<{ value: string; effectiveWeight: number }>;
  /** 近期关注话题 */
  topics?: string[];
}

/** 兴趣分享冷却期内的最短画像数据要求：至少一个有效兴趣点 */
export function pickShareTopic(profile: ShareProfileInput | null | undefined): string | null {
  if (!profile) return null;
  // 1) 稳定偏好（effectiveWeight >= 0.3：概率性以上引导级别）优先，取权重最高
  const prefs = [...(profile.preferences ?? [])]
    .filter((p) => typeof p.value === "string" && p.value.trim() && p.effectiveWeight >= 0.3)
    .sort((a, b) => b.effectiveWeight - a.effectiveWeight);
  if (prefs.length > 0) return prefs[0].value.trim().slice(0, 40);
  // 2) 退化为近期话题（高频关注也算可靠兴趣信号）
  const topics = (profile.topics ?? []).filter((t) => typeof t === "string" && t.trim());
  if (topics.length > 0) return topics[topics.length - 1].trim().slice(0, 40);
  return null;
}

/** 兴趣分享意图：闲聊式分享，importance=low（打扰最低档） */
export function buildShareIntent(actorId: string, topic: string): ProactiveIntent {
  return {
    actorId,
    kind: "interest_share",
    importance: "low",
    title: "想起用户喜欢的东西，可以主动分享聊两句",
    summary:
      `用户长期关注「${topic}」。像朋友想起对方喜欢的东西一样，主动聊两句：` +
      `可以分享和它相关的新鲜事/你的看法，也可以纯粹以你自己的视角聊聊为什么觉得有意思。` +
      `别写成资讯播报，一两句带出话题即可。`,
    mode: "speak",
    source: "profile",
  };
}
