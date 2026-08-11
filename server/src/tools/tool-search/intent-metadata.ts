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

export type { ToolIntentRule };

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
    prefix: "voice.",
    metadata: {
      aliases: [
        "voice", "speak", "tts", "text to speech", "speech synthesis",
        "audio generation", "voice message", "朗读", "播报", "说话",
        "语音", "语音合成", "语音播报", "语音消息", "配音", "合成语音",
        "音频生成", "念给我听", "读给我听", "发语音",
      ],
      negativeAliases: ["shopping", "desktop screenshot", "wallet transfer"],
      examples: [
        "念给我听", "用语音告诉我", "发一条语音消息", "读一下这段话",
        "你能做语音合成吗", "帮我把这句话播报出来",
      ],
      negativeExamples: ["推荐一款耳机", "现在几点了"],
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
      aliases: ["desktop", "screenshot", "screen", "computer control", "桌面", "截图"],
      // 注意：这里不放 "automation"/"自动化"——desktop.run_automation 才是该语义的目标工具，
      // 避免 desktop.visual.*（如 screenshot/run_task）因通用 alias 抢走 top1。
      negativeAliases: ["weather", "shopping recommendation", "wallet balance"],
      examples: ["take a screenshot", "open the browser and click the search box"],
      negativeExamples: ["what's today's weather"],
    },
  },
  {
    exact: "desktop.visual.screenshot",
    metadata: {
      negativeAliases: [
        "automation task script",
        "run automation",
        "自动化任务脚本",
        "UIA pattern",
        "原生控件操作",
      ],
      negativeExamples: [
        "运行桌面自动化任务脚本",
        "用 UIA 操作 Windows 原生控件",
        "执行 run_automation 任务",
      ],
    },
  },
  {
    exact: "desktop.run_automation",
    metadata: {
      aliases: [
        "run automation script",
        "execute desktop automation task",
        "UIA native control operation",
        "运行桌面自动化任务脚本",
        "桌面控件原子操作",
        "UIA pattern 直接调用",
        "免抢焦点的桌面操作",
      ],
      negativeAliases: [
        "take a screenshot",
        "open the browser",
        "screenshot capture",
        "截屏",
        "打开浏览器",
        "全屏截图",
      ],
      examples: [
        "运行桌面自动化任务脚本",
        "用 UIA 操作 Windows 原生控件",
        "执行 run_automation 任务",
      ],
      negativeExamples: [
        "截一张桌面截图",
        "打开浏览器到百度",
      ],
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
    exact: "embodiment.window_place",
    metadata: {
      aliases: [
        "put window at position",
        "place avatar window at coordinates",
        "set window to specified position",
        "桌面角色窗口放到指定位置",
        "球形窗口精准定位",
        "把化身放到屏幕某个位置",
        "窗口精调",
      ],
      negativeAliases: [
        "random wander",
        "roam freely",
        "无目标随机漫游",
        "随便走走",
      ],
      examples: [
        "把桌面角色窗口放到右下角",
        "把球形化身窗口定位到屏幕中央",
        "把悬浮窗放到指定坐标",
        "move my avatar window to (0.5, 0.5)",
      ],
      negativeExamples: [
        "让桌面角色随便走走",
        "让窗口随机换个位置",
        "roam around the screen",
      ],
    },
  },
  {
    exact: "embodiment.roam",
    metadata: {
      aliases: ["3D 场景随机漫游", "无目标漫游", "随机走动", "自由漫游", "random roam", "free move", "漫游移动", "到处走走"],
      negativeAliases: ["放到指定位置", "定位", "坐标", "place at", "position"],
      examples: ["在 3D 场景里随机漫游", "让角色到处走走", "无目标移动"],
      negativeExamples: ["把窗口放到指定位置", "移动到坐标 (1,2,3)"],
    },
  },
  {
    exact: "embodiment.move",
    metadata: {
      aliases: ["移动到坐标", "场景内移动", "移动到指定位置", "move to coordinates", "scene move"],
      negativeAliases: ["随机漫游", "random roam", "无目标"],
      examples: ["移动到场景坐标 (1,2,3)", "移动到指定位置"],
      negativeExamples: ["随机漫游", "到处走走"],
    },
  },
  {
    exact: "embodiment.window_roam",
    metadata: {
      aliases: ["random window roam", "no-target window move", "随便换个位置", "随机挪一下窗口"],
      examples: ["让窗口随机换到别处", "no specific target, just move"],
      negativeExamples: [
        "把窗口放到指定位置",
        "定位到屏幕中央",
        "place the avatar at a specific position",
      ],
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

/**
 * 由 capability-modules 注入的额外规则。
 *
 * 启动时 {@link registerAllCapabilityModules} 调一次 `setExtraIntentRules`，
 * 把所有能力模块的 intent rules 合并进来。
 * 与磁盘配置文件不同，这部分是代码层静态规则，不需要热加载。
 */
let extraIntentRules: ToolIntentRule[] = [];

/**
 * 注入能力模块的意图规则。
 *
 * @param rules 来自 `capability-modules/index.ts` 的 `getAllCapabilityModuleIntentRules`
 */
export function setExtraIntentRules(rules: ToolIntentRule[]): void {
  extraIntentRules = rules.map(normalizeRule).filter((r): r is ToolIntentRule => r != null);
}

/** 取出所有规则（磁盘配置 + 能力模块注入），优先级：磁盘 > 能力模块 > DEFAULT。 */
function getEffectiveRules(): ToolIntentRule[] {
  const diskRules = loadIntentRulesFromDisk();
  if (extraIntentRules.length === 0) return diskRules;
  // disk 与 extra 都可能覆盖同一工具名，按出现顺序后者覆盖前者。
  // 这里把 extra 追加在 disk 后面，让 catalog.ts 的 getToolIntentMetadata 合并时
  // 把两边的 aliases / examples 都聚合（它本身就是 mergeUnique 的）。
  return [...diskRules, ...extraIntentRules];
}

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
  const rules = getEffectiveRules();
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
