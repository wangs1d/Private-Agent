// ProactivityHub —— 任务完成恭喜触发器
//
// 两个来源：
//  1. 复杂任务完成（agent-task-orchestrator 的 task_completed，此前只走 WS 回调，
//     主动决策层看不到——本模块接线修复该断点）
//  2. 用户待办闭环（SessionEpitome closeCompletedLoops 检测到用户完成了
//     之前聊过的事，此前被静默丢弃——本模块接线修复该断点）
import type { ProactiveIntent } from "../proactivity-types.js";

/** 复杂任务完成 → 恭喜意图 */
export function buildCelebrationIntent(actorId: string, goal: string): ProactiveIntent {
  const goalText = goal.trim().slice(0, 80) || "刚完成的任务";
  return {
    actorId,
    kind: "task_celebration",
    importance: "medium",
    title: "用户的后台任务完成了，值得主动恭喜一下",
    summary: `Agent 后台复杂任务已完成，目标：${goalText}。像朋友一样简短恭喜，别汇报式。`,
    mode: "speak",
    source: "task",
  };
}

/** 用户待办闭环（用户自己完成了之前聊的事）→ 恭喜意图 */
export function buildLoopCompletedIntent(actorId: string, loopText: string): ProactiveIntent {
  const text = loopText.trim().slice(0, 80) || "之前聊过的一件事";
  return {
    actorId,
    kind: "task_celebration",
    importance: "medium",
    title: "用户完成了之前聊过的一件事，值得主动恭喜",
    summary: `从对话检测到用户完成了之前的待办：${text}。可以自然地带一句恭喜/肯定，别啰嗦。`,
    mode: "speak",
    source: "epitome",
  };
}
