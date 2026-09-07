/**
 * 习惯学习 → 自动执行闭环 公共出口。
 */

export type {
  HabitAuthorization,
  HabitTrigger,
  HabitAction,
  HabitStats,
  HabitRule,
  HabitLocationSample,
  HabitToolObservation,
  HabitCandidate,
} from "./habit-types.js";
export { HabitRuleStore, newHabitRuleId } from "./habit-rule-store.js";
export { HabitMiner } from "./habit-miner.js";
export { HabitLoopService, type HabitLoopDeps } from "./habit-loop-service.js";
