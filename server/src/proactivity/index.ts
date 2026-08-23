// ProactivityHub —— 主动性多元化模块（统一导出）
export type {
  ProactiveIntent,
  ProactiveIntentKind,
  ProactiveBehaviorMode,
  ProactiveActStep,
  ProactiveTriggerSource,
  FrequencyVerdict,
} from "./proactivity-types.js";
export { FrequencyGovernor } from "./frequency-governor.js";
export { AdviceStore, type AdviceItem } from "./advice-store.js";
export { ProactivityHub, type ProactivityHubDeps, parseFirstTrack } from "./proactivity-hub.js";
export {
  detectConversationProactiveHook,
  buildConversationIntent,
  type ConversationProactiveHook,
  type ConversationProactiveHookKind,
} from "./triggers/conversation-triggers.js";
export {
  buildCelebrationIntent,
  buildLoopCompletedIntent,
} from "./triggers/celebration-trigger.js";
export {
  buildShareIntent,
  pickShareTopic,
  type ShareProfileInput,
} from "./triggers/share-trigger.js";
export {
  judgeGreeting,
  buildGreetingIntent,
  type GreetingKind,
  type GreetingJudgement,
} from "./triggers/greeting-trigger.js";
export {
  buildOverworkIntent,
  tomorrowEveningRunAt,
  type OverworkRhythmPayload,
} from "./triggers/overwork-trigger.js";
