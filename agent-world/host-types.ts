import type { A2aOutsourcingService } from "./services/a2a-outsourcing-service.js";
import type { DoudizhuService } from "./services/doudizhu-service.js";
import type { ZhaJinHuaService } from "./services/zhajinhua-service.js";
import type { GomokuService } from "./services/gomoku-service.js";
import type { SocialFeedService } from "./services/social-feed-service.js";
import type { WorldService } from "./services/world-service.js";

export type SkillPermissionLike = string;

export type SkillManifestLike = {
  name: string;
  displayName: string;
  description: string;
  version: string;
  tags?: string[];
  icon?: string;
  kind?: string;
  author?: string;
  permissions?: SkillPermissionLike[];
};

/** 与社区技能上传 / 落盘 JSON 一致的结构（不依赖宿主 skills 模块的具体类型）。 */
export type CommunitySkillPersistMetadata = {
  name: string;
  version: string;
  displayName: string;
  description: string;
  author?: string;
  license?: string;
  tags?: string[];
  icon?: string;
  kind?: "builtin" | "community";
  parameters: unknown[];
  outputSchema?: Record<string, string>;
  permissions: unknown[];
  timeoutMs?: number;
  maxRetries?: number;
  dependencies?: string[];
  minAgentVersion?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type SkillValidationErrorLike = {
  field: string;
  message: string;
  code?: string;
};

/** 宿主注入：元数据校验（实现可委托给 SkillValidator.validateMetadata）。 */
export type SkillMetadataValidatorLike = {
  validateMetadata(metadata: unknown): SkillValidationErrorLike[];
};

export type SkillManagerLike = {
  list(enabledOnly?: boolean): SkillManifestLike[];
  get(skillName: string): SkillManifestLike | null;
  setEnabled(skillName: string, enabled: boolean): void;
  grantPermissions(skillName: string, permissions: SkillPermissionLike[]): void;
  loadFromFile?(skillPath: string, options?: { autoEnable?: boolean }): Promise<void>;
};

export type ToolContextLike = {
  sessionId: string;
  userId?: string;
};

export type ToolRegistryLike = {
  register(
    name: string,
    handler: (input: Record<string, unknown>, context: ToolContextLike) => Promise<Record<string, unknown>>,
  ): void;
};

export type AuditServiceLike = {
  record(event: Record<string, unknown>): Promise<void>;
};

export type WsConnectionRegistryLike = {
  trySend(sessionId: string, data: string): boolean;
};

export type HttpRouteDepsLike = {
  worldService: WorldService;
  a2aOutsourcingService: A2aOutsourcingService;
  doudizhuService: DoudizhuService;
  zhaJinHuaService: ZhaJinHuaService;
  gomokuService: GomokuService;
  socialFeedService: SocialFeedService;
  skillManager: SkillManagerLike;
  skillMetadataValidator: SkillMetadataValidatorLike;
};
