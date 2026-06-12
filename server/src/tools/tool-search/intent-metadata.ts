import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

export type ToolIntentMetadata = {
  aliases?: string[];
  negativeAliases?: string[];
  examples?: string[];
  negativeExamples?: string[];
};

type ToolIntentRule = {
  exact?: string;
  prefix?: string;
  metadata: ToolIntentMetadata;
};

type ToolIntentMetadataFile = {
  rules?: ToolIntentRule[];
};

const DEFAULT_TOOL_INTENT_RULES: ToolIntentRule[] = [
  {
    prefix: "shopping.",
    metadata: {
      aliases: ["shopping", "buy", "compare prices", "product recommendation", "购物", "比价", "推荐商品"],
      negativeAliases: ["phone call", "desktop movement", "weather lookup"],
      examples: ["compare prices for headphones", "recommend a power bank for travel"],
      negativeExamples: ["call me later", "move the desktop avatar"],
    },
  },
  {
    exact: "shopping.suggest",
    metadata: {
      aliases: ["buy product", "shopping advice", "买东西", "商品推荐"],
      examples: ["help me pick a laptop under budget"],
      negativeExamples: ["what time is it now"],
    },
  },
  {
    prefix: "budget.",
    metadata: {
      aliases: ["budget", "cost estimate", "expense planning", "预算", "花费"],
      negativeAliases: ["desktop screenshot", "phone reminder"],
      examples: ["estimate my trip budget"],
    },
  },
  {
    prefix: "weather.",
    metadata: {
      aliases: ["weather", "forecast", "temperature", "天气", "气温"],
      negativeAliases: ["shopping", "wallet transfer", "desktop automation"],
      examples: ["what's the weather in Beijing today"],
      negativeExamples: ["compare the price of a phone"],
    },
  },
  {
    prefix: "wallet.",
    metadata: {
      aliases: ["wallet", "balance", "transfer", "payment", "账单", "转账", "余额"],
      negativeAliases: ["weather", "screenshot", "call me"],
      examples: ["check my wallet balance"],
      negativeExamples: ["take a screenshot"],
    },
  },
  {
    prefix: "phone.",
    metadata: {
      aliases: ["phone", "call", "message", "ring", "电话", "短信"],
      negativeAliases: ["shopping", "price compare", "weather"],
      examples: ["call me to remind me", "send me a phone reminder"],
      negativeExamples: ["recommend a headset"],
    },
  },
  {
    prefix: "calendar.",
    metadata: {
      aliases: ["calendar", "schedule", "todo", "reminder", "日程", "提醒", "待办"],
      negativeAliases: ["shopping", "desktop control"],
      examples: ["remind me tomorrow at 10am"],
      negativeExamples: ["read this webpage"],
    },
  },
  {
    prefix: "desktop.visual.",
    metadata: {
      aliases: ["desktop", "screenshot", "screen", "automation", "computer control", "桌面", "截图", "自动化"],
      negativeAliases: ["weather", "shopping recommendation", "wallet balance"],
      examples: ["take a screenshot", "open the browser and click the search box"],
      negativeExamples: ["what's today's weather"],
    },
  },
  {
    prefix: "embodiment.",
    metadata: {
      aliases: ["move", "roam", "avatar", "window", "移动", "漫游", "化身"],
      negativeAliases: ["price compare", "weather", "wallet bill"],
      examples: ["move a bit to the left"],
      negativeExamples: ["compare product prices"],
    },
  },
  {
    prefix: "browser.",
    metadata: {
      aliases: ["browser", "web page", "cookie", "page read", "浏览器", "网页"],
      negativeAliases: ["phone reminder", "weather only"],
      examples: ["read this webpage"],
      negativeExamples: ["call me later"],
    },
  },
  {
    prefix: "mcp.",
    metadata: {
      aliases: ["external tool", "integration", "file read", "platform tool", "外部工具", "平台工具"],
      negativeAliases: ["local time", "simple weather"],
      examples: ["use the external platform tool to read a file"],
    },
  },
];

const DEFAULT_METADATA_PATH = resolve(process.cwd(), "data", "tool-intent-metadata.json");
const RELOAD_INTERVAL_MS = 5_000;

let cachedRules = DEFAULT_TOOL_INTENT_RULES;
let cachedPath = "";
let cachedMtimeMs = -1;
let lastCheckedAt = 0;
let lastLoadedAt = 0;
let lastLoadError: string | null = null;

export type ToolIntentMetadataState = {
  path: string;
  exists: boolean;
  usingDefaultRules: boolean;
  ruleCount: number;
  mtimeMs: number | null;
  lastCheckedAt: number;
  lastLoadedAt: number;
  lastLoadError: string | null;
};

function mergeUnique(parts: Array<string[] | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of parts) {
    for (const item of list ?? []) {
      const trimmed = item.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return out;
}

function normalizeRule(rule: ToolIntentRule): ToolIntentRule | null {
  if (!rule || typeof rule !== "object") return null;
  const exact = typeof rule.exact === "string" && rule.exact.trim() ? rule.exact.trim() : undefined;
  const prefix = typeof rule.prefix === "string" && rule.prefix.trim() ? rule.prefix.trim() : undefined;
  if (!exact && !prefix) return null;
  const metadata = rule.metadata && typeof rule.metadata === "object" ? rule.metadata : {};
  return {
    ...(exact ? { exact } : {}),
    ...(prefix ? { prefix } : {}),
    metadata: {
      aliases: mergeUnique([Array.isArray(metadata.aliases) ? metadata.aliases.filter((v): v is string => typeof v === "string") : undefined]),
      negativeAliases: mergeUnique([Array.isArray(metadata.negativeAliases) ? metadata.negativeAliases.filter((v): v is string => typeof v === "string") : undefined]),
      examples: mergeUnique([Array.isArray(metadata.examples) ? metadata.examples.filter((v): v is string => typeof v === "string") : undefined]),
      negativeExamples: mergeUnique([Array.isArray(metadata.negativeExamples) ? metadata.negativeExamples.filter((v): v is string => typeof v === "string") : undefined]),
    },
  };
}

export function resolveToolIntentMetadataPath(): string {
  const override = process.env.AGENT_TOOL_INTENT_METADATA_PATH?.trim();
  return override ? resolve(override) : DEFAULT_METADATA_PATH;
}

function buildMetadataState(path: string): ToolIntentMetadataState {
  const exists = existsSync(path);
  let mtimeMs: number | null = null;
  if (exists) {
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      mtimeMs = null;
    }
  }
  return {
    path,
    exists,
    usingDefaultRules: cachedRules === DEFAULT_TOOL_INTENT_RULES,
    ruleCount: cachedRules.length,
    mtimeMs,
    lastCheckedAt,
    lastLoadedAt,
    lastLoadError,
  };
}

function loadIntentRulesFromDisk(force = false): ToolIntentRule[] {
  const metadataPath = resolveToolIntentMetadataPath();
  if (!existsSync(metadataPath)) {
    cachedRules = DEFAULT_TOOL_INTENT_RULES;
    cachedPath = metadataPath;
    cachedMtimeMs = -1;
    lastCheckedAt = Date.now();
    lastLoadError = null;
    return DEFAULT_TOOL_INTENT_RULES;
  }

  const stat = statSync(metadataPath);
  const now = Date.now();
  if (
    !force &&
    cachedPath === metadataPath &&
    cachedMtimeMs === stat.mtimeMs &&
    now - lastCheckedAt < RELOAD_INTERVAL_MS
  ) {
    return cachedRules;
  }

  lastCheckedAt = now;
  try {
    const raw = readFileSync(metadataPath, "utf8");
    const parsed = JSON.parse(raw) as ToolIntentMetadataFile;
    const rules = Array.isArray(parsed.rules)
      ? parsed.rules.map(normalizeRule).filter((rule): rule is ToolIntentRule => rule != null)
      : [];
    if (rules.length > 0) {
      cachedRules = rules;
      cachedPath = metadataPath;
      cachedMtimeMs = stat.mtimeMs;
      lastLoadedAt = now;
      lastLoadError = null;
      return cachedRules;
    }
  } catch (error) {
    lastLoadError = error instanceof Error ? error.message : String(error);
    console.warn("[tool-intent-metadata] Failed to load JSON config, using defaults:", error);
  }

  cachedRules = DEFAULT_TOOL_INTENT_RULES;
  cachedPath = metadataPath;
  cachedMtimeMs = stat.mtimeMs;
  lastLoadedAt = now;
  return cachedRules;
}

export function getToolIntentMetadata(toolName: string): ToolIntentMetadata {
  const rules = loadIntentRulesFromDisk();
  const exactMatches = rules
    .filter((rule) => rule.exact === toolName)
    .map((rule) => rule.metadata);
  const prefixMatches = rules
    .filter((rule) => rule.prefix && toolName.startsWith(rule.prefix))
    .map((rule) => rule.metadata);
  const matches = [...prefixMatches, ...exactMatches];
  return {
    aliases: mergeUnique(matches.map((m) => m.aliases)),
    negativeAliases: mergeUnique(matches.map((m) => m.negativeAliases)),
    examples: mergeUnique(matches.map((m) => m.examples)),
    negativeExamples: mergeUnique(matches.map((m) => m.negativeExamples)),
  };
}

export function reloadToolIntentMetadata(): ToolIntentMetadataState {
  loadIntentRulesFromDisk(true);
  return buildMetadataState(resolveToolIntentMetadataPath());
}

export function getToolIntentMetadataState(): ToolIntentMetadataState {
  loadIntentRulesFromDisk();
  return buildMetadataState(resolveToolIntentMetadataPath());
}
