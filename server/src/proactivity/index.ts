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
// ─── 统一主动性管道（docs/proactivity-architecture.md）───
export type {
  ProactiveProposal,
  ProactiveImportance,
  PresenceState,
  ProposalVerdict,
  ProactiveOutcome,
  DeliveryChannel,
  ArbitrationDecision,
} from "./pipeline-types.js";
export { arbitrate, isQuietHourNow, nextQuietEnd, type ArbiterContext } from "./arbiter.js";
export { PresenceService } from "./presence-service.js";
export { ProposalStore } from "./proposal-store.js";
export { ProactiveDeliveryService, type DeliveryResult } from "./delivery-service.js";
export {
  MobilePushService,
  JPushProvider,
  BarkProvider,
  WebhookPushProvider,
  type PushInput,
  type PushAttemptResult,
  type PushProvider,
  type PushTokenEntry,
} from "./mobile-push-service.js";
export { OutcomeStore, type OutcomeRecord } from "./outcome-store.js";
export {
  AgentActivityStore,
  type AgentActivity,
  type AgentActivityStatus,
  type RecordActivityInput,
} from "./activity-store.js";
export { UpcomingScheduleWatcher } from "./upcoming-schedule-watcher.js";
export { ProactivePipeline, type ProactivePipelineDeps } from "./proactive-pipeline.js";
export { readJson, writeJson } from "./persist-file.js";
