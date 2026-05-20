/**
 * Agent World：场景、世界点数、技能商店/自由市场、A2A 外包、斗地主、炸金花等子域代码入口。
 * HTTP 路由在 `routes/`，进程内工具在 `tools/`，核心服务在 `services/`。
 */
export {
  AGENT_WORLD_CREDIT_REASONS,
  WorldService,
  INITIAL_AGENT_WORLD_CREDITS,
  mockSkillPrice,
} from "./services/world-service.js";
export type {
  AgentWorldCreditReason,
  CreditAuditEntry,
  WorldMutationOptions,
  WorldRevisionEvent,
  WorldServiceEvolutionHooks,
  WorldState,
} from "./services/world-service.js";
export type { CreditAuditSummaryEntry } from "./services/world-service.js";
export { A2aOutsourcingService } from "./services/a2a-outsourcing-service.js";
export type {
  A2aContractMutationResult,
  A2aContractStatus,
  A2aListFilter,
  A2aOutsourcingContract,
} from "./services/a2a-outsourcing-service.js";
export { DoudizhuService } from "./services/doudizhu-service.js";
export type { DoudizhuTableStatus, DoudizhuTableSummary } from "./services/doudizhu-service.js";
export { ZhaJinHuaService, ZJH_MAX_SEATS, ZJH_MIN_PLAYERS } from "./services/zhajinhua-service.js";
export type { ZjhTableStatus, ZjhTableSummary } from "./services/zhajinhua-service.js";
export { GomokuService } from "./services/gomoku-service.js";
export type { GomokuTableStatus, GomokuTableSummary, GomokuSnapshot } from "./services/gomoku-service.js";
export { SocialFeedService } from "./services/social-feed-service.js";
export type { SocialCommentRow, SocialMediaType, SocialPostRow, SocialReportRow } from "./services/social-feed-service.js";
export {
  createSocialMediaReadStream,
  defaultSocialMediaRoot,
  isServerSocialMediaUrl,
} from "./services/social-feed-service.js";
export { loadPersistedCommunitySkills, persistUploadedCommunitySkill, validateCommunitySkillCandidate } from "./services/community-skill-store.js";
export { reconcileWorldA2aEscrows } from "./services/world-a2a-reconcile.js";
export type { A2aReconcileAdjustment } from "./services/world-a2a-reconcile.js";
export { restorePurchasedSkillsFromWorldState } from "./services/world-skill-restore.js";
export { skillMarketListingsForSession } from "./services/world-skill-listings.js";
export { registerWorldRoutes } from "./routes/world.js";
export { registerWorldFreeMarketRoutes } from "./routes/world-free-market.js";
export { registerWorldDoudizhuRoutes } from "./routes/world-doudizhu.js";
export { registerWorldZhajinhuaRoutes } from "./routes/world-zhajinhua.js";
export { registerWorldGomokuRoutes } from "./routes/world-gomoku.js";
export { registerWorldSocialRoutes } from "./routes/world-social.js";
export { registerWorldFreeMarketTools } from "./tools/world-free-market-tools.js";
export { registerWorldDoudizhuTools } from "./tools/world-doudizhu-tools.js";
export { registerWorldZhajinhuaTools } from "./tools/world-zhajinhua-tools.js";
export { registerWorldGomokuTools } from "./tools/world-gomoku-tools.js";
export { registerWorldSocialTools } from "./tools/world-social-tools.js";
export { registerWorldOpenRegistryTools } from "./tools/world-open-registry-tools.js";
export { registerWorldRoomTools } from "./tools/world-room-tools.js";
export { replyIfWorldRegistrationRequired } from "./config/world-registration-gate.js";
export { allowAgentWorldPlaceholderRegister } from "./config/world-register-placeholder.js";
export { allowWorldHttpMutations, replyIfWorldHttpMutationsForbidden } from "./config/world-http-mutations.js";
export { AgentWorldClientEventType, AgentWorldServerEventType } from "./protocol-world.js";
export {
  UNIFIED_LAYER_MANIFEST,
  UNIFIED_PROTOCOL_VERSION,
  UnifiedClientEventType,
  UnifiedServerEventType,
  unifiedCapabilitiesClientSchema,
  unifiedGovernanceProbeSchema,
  unifiedHumanDirectiveSchema,
  unifiedMemoryGetSchema,
  unifiedMemoryPatchSchema,
  unifiedQuotaAdjustSchema,
  resolveUnifiedMemoryActorId,
} from "./protocol-unified.js";
export type { UnifiedLayerId } from "./protocol-unified.js";
export {
  canViewWorldPartition,
  WorldPartitionWsRegistry,
} from "./services/world-partition-ws-registry.js";
export type { PartitionPairingLike, WsSendLike } from "./services/world-partition-ws-registry.js";
export {
  AGENT_WORLD_FULL_TOOL_SYSTEM_SUFFIX,
  DOUDIZHU_CHAT_TOOLS,
  DOUDIZHU_TOOL_SYSTEM_SUFFIX,
  GOMOKU_CHAT_TOOLS,
  USER_AGENT_TOOL_SYSTEM_SUFFIX,
  USER_FACING_AGENT_WORLD_CHAT_TOOLS,
} from "./doudizhu-chat-tools.js";
export * from "./schemas.js";
export type {
  AuditServiceLike,
  CommunitySkillPersistMetadata,
  HttpRouteDepsLike,
  SkillManagerLike,
  SkillManifestLike,
  SkillMetadataValidatorLike,
  SkillPermissionLike,
  SkillValidationErrorLike,
  ToolContextLike,
  ToolRegistryLike,
  WsConnectionRegistryLike,
} from "./host-types.js";
