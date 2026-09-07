/**
 * Feature Catalog —— 能力分类统一层 公共出口。
 */

export type {
  LifeDomain,
  ActionKind,
  TriggerKind,
  RiskLevel,
  FeatureClass,
  FeatureSurface,
  UnifiedFeature,
} from "./types.js";
export {
  LIFE_DOMAINS,
  LIFE_DOMAIN_LABELS,
  LIFE_DOMAIN_DESCRIPTIONS,
} from "./types.js";
export {
  classifyFeatureByName,
  classifyMcpTool,
  isClassifiedByRule,
  buildCatalogIntentRules,
  FALLBACK_CLASS,
} from "./class-map.js";
export { FeatureCatalog } from "./feature-catalog.js";
