/**
 * 工具类别定义 + 两层路由（Level 1: 分类 → Level 2: 类内搜索）。
 *
 * 设计：
 *   - Level 1：query embedding 与 17 个类别向量余弦 → top-1 类别
 *   - 若 top-1 与 top-2 余弦差距 < 0.1 → 并行搜两个类别后 RRF 合并
 *   - 无 embedding 时降级为类别级 BM25（alias 丰富，命中率远高于单工具级）
 *   - 类别向量 = 该类工具 embedding 的加权平均（权重 = sqrt(description_len)）
 *   - 多归属工具同时出现在主/副类别中
 */

import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { Bm25Index } from "./bm25.js";
import { ToolEmbeddingIndex, preNormalizeVector, filterByDynamicThreshold, type DynamicThreshold } from "./tool-embedding-index.js";

// ===== 类别定义 =====

export type ToolCategoryDef = {
  /** 类别唯一标识，同时也是 prefix 之一 */
  name: string;
  /** 匹配该类别工具的 registryName 前缀（用 . 结尾做 startsWith） */
  prefixes: string[];
  /** 中英文 alias + 同义表达 + 常见场景句，用于 BM25 降级分类 */
  aliases: string[];
  /**
   * 多归属：除 prefix 匹配外，额外归属到此类的工具注册名。
   * 例如 phone.call_user 既有 "phone" 类，也作为 "reminder" 副类（"打电话提醒我"）。
   */
  secondaryTools: string[];
};

export const TOOL_CATEGORIES: ToolCategoryDef[] = [
  {
    name: "phone",
    prefixes: ["phone."],
    aliases: ["电话", "手机", "打电话", "拨号", "通话", "短信", "call", "phone", "dial", "ring", "联系", "呼叫", "来电"],
    secondaryTools: [],
  },
  {
    name: "voice",
    prefixes: ["voice."],
    aliases: [
      "语音", "说话", "播报", "朗读", "念", "读出来", "说出来", "发声",
      "语音合成", "合成语音", "配音", "语音消息", "录音", "音频",
      "转写", "听", "asr", "tts", "voice", "speak", "speech", "audio",
    ],
    secondaryTools: [],
  },
  {
    name: "desktop",
    prefixes: ["desktop."],
    aliases: ["桌面操作", "自动化", "脚本", "shell", "命令", "执行", "电脑", "快捷键", "桌面控制", "计算机", "desktop", "automation", "automate", "run"],
    secondaryTools: ["browser.session.list"],
  },
  {
    name: "browser",
    prefixes: ["browser."],
    aliases: ["浏览器", "网页", "cookie", "页面", "网址", "浏览", "browser", "web", "page", "navigation", "标签", "tab"],
    secondaryTools: ["fetch_web", "search_web"],
  },
  {
    name: "calendar",
    prefixes: ["calendar."],
    aliases: ["日历", "日程", "会议", "待办", "提醒", "calendar", "schedule", "event", "appointment", "meeting"],
    secondaryTools: ["reminder.plan"],
  },
  {
    name: "reminder",
    prefixes: ["reminder."],
    aliases: ["提醒", "闹钟", "timer", "remind", "alert", "通知", "通知我"],
    secondaryTools: ["phone.call_user"],
  },
  {
    name: "weather",
    prefixes: ["weather."],
    aliases: ["天气", "气温", "预报", "weather", "temperature", "forecast", "下雨", "晴", "阴"],
    secondaryTools: [],
  },
  {
    name: "wallet",
    prefixes: ["wallet."],
    aliases: ["钱包", "余额", "转账", "支付", "消费", "wallet", "balance", "transaction", "交易", "账单", "金额"],
    secondaryTools: ["budget.calculate"],
  },
  {
    name: "embodiment",
    prefixes: ["embodiment."],
    aliases: ["桌面", "窗口", "角色", "移动", "位置", "漫游", "化身", "虚拟形象", "挪动", "放置", "embodiment", "window", "roam", "character", "avatar"],
    secondaryTools: [],
  },
  {
    name: "agent",
    prefixes: ["agent."],
    aliases: ["agent", "智能体", "好友", "消息", "发送", "peer", "link", "friend", "request", "社交"],
    secondaryTools: [],
  },
  {
    name: "clock",
    prefixes: ["clock."],
    aliases: ["时间", "日期", "时钟", "时区", "clock", "time", "date", "timestamp", "现在几点", "今天"],
    secondaryTools: [],
  },
  {
    name: "shopping",
    prefixes: ["shopping."],
    aliases: ["购物", "买东西", "比价", "推荐", "shopping", "buy", "purchase", "推荐商品", "买什么"],
    secondaryTools: [],
  },
  {
    name: "world",
    prefixes: ["world."],
    aliases: ["世界", "注册", "agent", "world", "register", "registry", "open", "global"],
    secondaryTools: [],
  },
  {
    name: "aip",
    prefixes: ["aip."],
    aliases: ["AIP", "智能协议", "协议", "分发", "协议处理", "aip", "dispatch", "protocol"],
    secondaryTools: [],
  },
  {
    name: "self",
    prefixes: ["self."],
    aliases: ["自己", "技能", "能力", "self", "skill", "capability", "自定义", "我装载了"],
    secondaryTools: [],
  },
  {
    name: "budget",
    prefixes: ["budget."],
    aliases: ["预算", "算钱", "费用", "花销", "budget", "calculate", "计算", "省钱"],
    secondaryTools: [],
  },
  {
    name: "search",
    prefixes: ["search_web", "fetch_web"],
    aliases: ["搜索", "查询", "网页", "内容", "search", "web", "fetch", "读网页", "搜一下", "查一下"],
    secondaryTools: [],
  },
  {
    name: "misc",
    prefixes: [],
    aliases: ["其他", "杂项", "misc", "other", "工具"],
    secondaryTools: [],
  },
];

// ===== 类别信息（构建时填充） =====

export type ToolCategoryInfo = {
  /** 该类别下所有工具注册名（主归属 + 多归属） */
  toolNames: string[];
  /** 类别 BM25 搜索文本（alias + 工具名 + 描述摘要） */
  searchText: string;
};

// ===== 类别 BM25 降级分类器 =====

let _categoryBm25: Bm25Index | null = null;
let _categoryBm25Docs: Array<{ id: string; text: string }> | null = null;

function getCategoryBm25Docs(defs: ToolCategoryDef[]): Array<{ id: string; text: string }> {
  if (_categoryBm25Docs) return _categoryBm25Docs;
  _categoryBm25Docs = defs.map((cat) => ({
    id: cat.name,
    // 类别 BM25 文本 = 所有 alias + prefix + secondaryTool 名
    text: [
      ...cat.aliases,
      ...cat.aliases.map((a) => a.toLowerCase()),
      ...cat.prefixes,
      ...cat.secondaryTools,
    ]
      .filter(Boolean)
      .join(" "),
  }));
  return _categoryBm25Docs;
}

export function getCategoryBm25Index(defs: ToolCategoryDef[] = TOOL_CATEGORIES): Bm25Index {
  if (!_categoryBm25) {
    _categoryBm25 = new Bm25Index(getCategoryBm25Docs(defs));
  }
  return _categoryBm25;
}

/** 清空类别 BM25 缓存（仅测试用） */
export function invalidateCategoryBm25(): void {
  _categoryBm25 = null;
  _categoryBm25Docs = null;
}

// ===== 类别向量构建 =====

/**
 * 构建类别向量索引。
 *
 * 每个类别的向量 = 该类工具 embedding 的加权平均（权重 = sqrt(description.length)）。
 * 长描述的工具更代表类别语义，但平方根防止个别工具主导。
 *
 * @param categoryDefs  类别定义
 * @param getToolVector 工具名 → 归一化向量（null 表示未缓存）
 * @param getEntry      工具名 → entry（用于取 description 长度）
 * @returns categoryIndex + 类别元数据
 */
export function buildCategoryVectors(
  categoryDefs: ToolCategoryDef[],
  getToolVector: (name: string) => Float32Array | null,
  getEntry: (name: string) => { embeddingInput: string; searchText: string } | null,
): { categoryIndex: ToolEmbeddingIndex; categories: Map<string, ToolCategoryInfo> } {
  const categoryIndex = new ToolEmbeddingIndex();
  const categories = new Map<string, ToolCategoryInfo>();

  // 先收集每个 category 的 tool -> name 映射
  const catToTools = new Map<string, Set<string>>();
  for (const cat of categoryDefs) {
    catToTools.set(cat.name, new Set());
  }
  // 也收集 multi-homing 的副类
  for (const cat of categoryDefs) {
    for (const sec of cat.secondaryTools) {
      const set = catToTools.get(cat.name);
      if (set) set.add(sec);
    }
  }

  // 构建类别向量
  for (const cat of categoryDefs) {
    const toolNames = catToTools.get(cat.name);
    if (!toolNames) continue;

    // 从所有工具中找 prefix 匹配的
    // 注意：这里我们不知道全量工具列表，所以 category 向量由 buildDeferredCatalog 传入
    // 我们只做向量平均，不在这里做 prefix 匹配
    // 实际上类别向量构建由 buildDeferredCatalog 从 entries 中收集完成
    categories.set(cat.name, {
      toolNames: [],
      searchText: cat.aliases.join(" "),
    });
  }

  return { categoryIndex, categories };
}

/**
 * 从实际 entry 列表填充类别索引（由 buildDeferredCatalog 调用）。
 *
 * 流程：
 *   1. 遍历所有 entry → 按 prefix 分配到类别
 *   2. 对每个类别，收集 tool vector → 加权平均 → 灌入 categoryIndex
 *   3. 记录类别 → 工具名映射
 */
export function populateCategoryIndex(
  categoryDefs: ToolCategoryDef[],
  entries: Array<{ registryName: string; embeddingInput: string; searchText: string }>,
  getToolVector: (name: string) => Float32Array | null,
): { categoryIndex: ToolEmbeddingIndex; categories: Map<string, ToolCategoryInfo> } {
  const categoryIndex = new ToolEmbeddingIndex();
  const categories = new Map<string, ToolCategoryInfo>();
  const catToNames = new Map<string, string[]>();

  for (const cat of categoryDefs) {
    // 按 prefix 匹配
    const matched: string[] = [];
    for (const entry of entries) {
      if (cat.prefixes.some((p) => entry.registryName.startsWith(p))) {
        matched.push(entry.registryName);
      }
    }
    // 多归属
    for (const sec of cat.secondaryTools) {
      if (entries.some((e) => e.registryName === sec) && !matched.includes(sec)) {
        matched.push(sec);
      }
    }
    catToNames.set(cat.name, matched);
  }

  // 将未匹配到的归入 misc
  const miscNames = entries
    .map((e) => e.registryName)
    .filter((name) => {
      for (const [, names] of catToNames) {
        if (names.includes(name)) return false;
      }
      return true;
    });
  const miscCat = categoryDefs.find((c) => c.name === "misc");
  if (miscCat && miscNames.length > 0) {
    catToNames.set("misc", miscNames);
  }

  // 构建向量和元数据
  for (const cat of categoryDefs) {
    const names = catToNames.get(cat.name) ?? [];
    const vectors: Float32Array[] = [];
    for (const name of names) {
      const vec = getToolVector(name);
      if (vec) vectors.push(vec);
    }

    if (vectors.length > 0) {
      // 加权平均：权重 = sqrt(description.length) → 取 entry 的 embeddingInput 长度
      const weighted = new Float32Array(vectors[0]!.length);
      let totalWeight = 0;
      for (const name of names) {
        const vec = getToolVector(name);
        if (!vec) continue;
        const entry = entries.find((e) => e.registryName === name);
        const weight = Math.sqrt(entry?.embeddingInput?.length ?? 100);
        for (let i = 0; i < weighted.length; i++) weighted[i] += vec[i]! * weight;
        totalWeight += weight;
      }
      if (totalWeight > 0) {
        for (let i = 0; i < weighted.length; i++) weighted[i] /= totalWeight;
        // 归一化后灌入索引
        const rawArr = Array.from(weighted);
        categoryIndex.ingest(cat.name, rawArr);
      }
    }

    categories.set(cat.name, {
      toolNames: names,
      searchText: cat.aliases.join(" "),
    });
  }

  return { categoryIndex, categories };
}

// ===== Level 1 路由 =====

/**
 * 路由到类别（Level 1）。
 *
 * 优先 embedding 路由（余弦相似度），无 embedding 时降级 BM25。
 *
 * @param query         用户 query
 * @param queryVector   query 的 embedding 向量（可能为 null）
 * @param categoryIndex 类别向量索引
 * @param categoryBm25  类别 BM25 索引
 * @param categories    类别元数据
 * @returns 路由到的类别名列表（1 或 2 个）
 */
export function routeToCategory(
  query: string,
  queryVector: Float32Array | null,
  categoryIndex: ToolEmbeddingIndex,
  categoryBm25: Bm25Index,
  categories: Map<string, ToolCategoryInfo>,
): string[] {
  if (categoryIndex.size > 0 && queryVector) {
    return routeByEmbedding(queryVector, categoryIndex);
  }
  return routeByBm25(query, categoryBm25, categories);
}

/**
 * Embedding 路由：余弦相似度 → top-1（差距 < 0.1 时 top-2）。
 */
function routeByEmbedding(
  queryVector: Float32Array | number[],
  categoryIndex: ToolEmbeddingIndex,
): string[] {
  const all = categoryIndex.rankAll(queryVector);
  if (all.length === 0) return [];

  const top1 = all[0]!;
  const top2 = all[1];

  // 如果 top-1 与 top-2 差距 < 0.1，并行搜两个
  if (top2 && top1.score - top2.score < 0.1) {
    return [top1.id, top2.id];
  }
  return [top1.id];
}

/**
 * BM25 降级路由：类别级 BM25 搜索（alias 丰富，命中率远高于单工具级）。
 *
 * 容错策略（与 embedding 路由对齐）：
 *   - top-1 与 top-2 分数接近（< 0.15）→ 返回两个类别并行搜，降低错判风险
 *   - 无任何类别命中 → 返回空数组，调用方降级为全量搜索，避免把工具排除在外
 */
function routeByBm25(
  query: string,
  categoryBm25: Bm25Index,
  categories: Map<string, ToolCategoryInfo>,
): string[] {
  const hits = categoryBm25.search(query, 3);
  const valid = hits.filter((h) => categories.has(h.id));
  if (valid.length === 0) return [];

  const top1 = valid[0]!;
  const top2 = valid[1];
  // top-1 与 top-2 差距 < 0.15 → 并行搜两个类别（BM25 分数尺度与 cosine 不同，阈值放宽）
  if (top2 && top1.score - top2.score < 0.15) {
    return [top1.id, top2.id];
  }
  return [top1.id];
}

/**
 * 获取某个类别下的工具名列表（含多归属）。
 */
export function getCategoryToolNames(
  categoryName: string,
  categories: Map<string, ToolCategoryInfo>,
): string[] {
  return categories.get(categoryName)?.toolNames ?? [];
}

/**
 * 获取某个 entry 的归属类别名列表。
 */
export function getEntryCategoryNames(
  registryName: string,
  categoryDefs: ToolCategoryDef[],
): string[] {
  const result: string[] = [];
  for (const cat of categoryDefs) {
    if (cat.prefixes.some((p) => registryName.startsWith(p))) {
      result.push(cat.name);
    }
    if (cat.secondaryTools.includes(registryName) && !result.includes(cat.name)) {
      result.push(cat.name);
    }
  }
  return result;
}