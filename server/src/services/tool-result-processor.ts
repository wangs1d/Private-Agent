import {
  createContentSummary,
  formatContentSummaryForChat,
  formatContentSummaryForPlainText,
  shouldSummarizeContent,
} from "../services/content-summary-service.js";
import { humanizeAssistantText } from "./assistant-humanizer.js";
import { classifyRenderHint } from "./render-hint-service.js";
import { formatAgentResultForChat } from "./agent-result-formatter.js";

const CONTENT_LENGTH_THRESHOLD = 800;

/** 提取 LLM 输出的 [RENDER_HINT:xxx] 标记，剥离后返回 hint 和清洗后的文本 */
function extractLlmRenderHint(text: string): { rawHint: string | null; cleanText: string } {
  const match = text.trimStart().match(/^\[RENDER_HINT:(\w+)\]\s*/);
  if (!match) return { rawHint: null, cleanText: text };
  return { rawHint: match[1], cleanText: text.slice(match[0].length).trim() };
}

/** 注入前端 [RENDER_AS:xxx] 标记 */
function wrapRenderAs(name: string, text: string): string {
  return `[RENDER_AS:${name}]\n${text}`;
}

/** 从单行文本中提取 URL */
function extractUrlFromText(text: string): string | undefined {
  const m = text.match(/https?:\/\/\S+/);
  return m ? m[0].replace(/[)}\]。，,]+$/, "") : undefined;
}

export interface ToolResultProcessorOptions {
  enabled?: boolean;
  threshold?: number;
}

export class ToolResultProcessor {
  private options: Required<ToolResultProcessorOptions>;

  constructor(options: ToolResultProcessorOptions = {}) {
    this.options = {
      enabled: options.enabled ?? true,
      threshold: options.threshold ?? CONTENT_LENGTH_THRESHOLD,
    };
  }

  processAssistantText(
    text: string,
    opts?: { plainTextMode?: boolean; userText?: string; toolName?: string },
  ): string {
    if (!this.options.enabled) {
      return humanizeAssistantText(text, { userText: opts?.userText });
    }

    // 人性化助手：下方所有分支统一走它，避免重复写 `{ userText }` 参数
    const humanize = (t: string) => humanizeAssistantText(t, { userText: opts?.userText });

    // === 0. 检查 LLM 声明的 [RENDER_HINT:xxx]（优先级最高）===
    const { rawHint: llmHint, cleanText: textAfterLlmHint } = extractLlmRenderHint(text);
    let workingText = textAfterLlmHint;
    if (llmHint) {
      console.log(`[ToolResultProcessor] LLM declared render_hint: ${llmHint}`);
      switch (llmHint) {
        case "structured":
          return wrapRenderAs("structured", humanize(workingText));
        case "brief":
          return wrapRenderAs("brief", humanize(workingText));
        case "card":
          return formatAgentResultForChat(workingText, opts?.toolName) ?? humanize(workingText);
        case "plain":
          return humanize(workingText);
      }
      // 未知 hint → fall through 走规则判断
    }

    const trimmed = workingText.trim();
    if (!trimmed) return text;

    // 已带标记的直接放行（避免二次处理）
    if (
      trimmed.includes("[CONTENT_SUMMARY_V2_START]") ||
      trimmed.includes("[AGENT_RESULT_CARD_START]")
    ) {
      return workingText;
    }

    // === 渲染形态判断中心 ===
    const hint = classifyRenderHint(workingText, {
      toolName: opts?.toolName,
      userText: opts?.userText,
    });

    // 优先级 0：image_text 图片识别/OCR → 注入 [RENDER_AS:image_result]
    if (hint.type === "image_text") {
      console.log(`[ToolResultProcessor] image_text: ${hint.reason}`);
      return wrapRenderAs("image_result", humanize(workingText));
    }

    // 优先级 1：search_result 搜索工具结果 → 专用搜索结果卡片（含 URL 提取）
    if (hint.type === "search_result" && !opts?.plainTextMode) {
      let marked = formatAgentResultForChat(workingText, opts?.toolName);
      if (marked) {
        // 从 item 文本中提取 URL 注入到 JSON
        marked = injectItemUrls(marked);
        console.log(`[ToolResultProcessor] search_result: ${hint.reason}`);
        return marked;
      }
    }

    // 优先级 2：result_card 简短汇报
    if (hint.type === "result_card" && !opts?.plainTextMode) {
      let marked = formatAgentResultForChat(workingText, opts?.toolName);
      if (marked) {
        // 同样注入 item 级 url（媒体卡片依赖它渲染缩略图/跳转）
        marked = injectItemUrls(marked);
        console.log(`[ToolResultProcessor] result_card: ${hint.reason}`);
        return marked;
      }
    }

    // 优先级 3+：brief 简报增强 → 注入 [RENDER_AS:brief]
    if (hint.type === "brief") {
      console.log(`[ToolResultProcessor] brief: ${hint.reason}`);
      return wrapRenderAs("brief", humanize(workingText));
    }

    // 优先级 3：summary_card 长内容折叠
    if (hint.type === "summary_card") {
      console.log(
        `[ToolResultProcessor] Processing text, length: ${workingText.length}, threshold: ${this.options.threshold}, plainTextMode: ${!!opts?.plainTextMode}`,
      );

      if (shouldSummarizeContent(workingText, this.options.threshold)) {
        const summary = createContentSummary(workingText, {
          maxLength: this.options.threshold,
          forceSummary: false,
        });

        if (summary) {
          console.log(
            `[ToolResultProcessor] Created summary: ${summary.title}, points: ${summary.briefPoints.length}`,
          );
          const formatted = opts?.plainTextMode
            ? formatContentSummaryForPlainText(summary)
            : formatContentSummaryForChat(summary);
          console.log(
            `[ToolResultProcessor] Formatted output length: ${formatted.length}`,
          );
          return humanize(formatted);
        }
      }
    }

    // 优先级 4：long_text 长内容（非搜索工具）
    if (hint.type === "long_text") {
      console.log(`[ToolResultProcessor] long_text: ${hint.reason}`);
      // 意图触发的 long_text → 注入 [RENDER_AS:structured]
      if (hint.intent) {
        return wrapRenderAs("structured", humanize(workingText));
      }
      return humanize(workingText);
    }

    // 优先级 5：plain 普通正文
    return humanize(workingText);
  }
}

/**
 * 从 `[AGENT_RESULT_CARD_START]` 标记的 JSON 中，
 * 给每个 item 提取文本中的 URL 并注入 `url` 字段。
 */
function injectItemUrls(marked: string): string {
  const startTag = "[AGENT_RESULT_CARD_START]";
  const endTag = "[AGENT_RESULT_CARD_END]";
  const startIdx = marked.indexOf(startTag);
  const endIdx = marked.indexOf(endTag);
  if (startIdx < 0 || endIdx <= startIdx) return marked;

  const jsonStr = marked.slice(startIdx + startTag.length, endIdx).trim();
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(jsonStr);
  } catch {
    return marked;
  }

  const items = payload.items as Array<Record<string, string>> | undefined;
  if (!items) return marked;

  for (const item of items) {
    if (!item.url && item.text) {
      const url = extractUrlFromText(item.text);
      if (url) item.url = url;
    }
  }
  payload.items = items;

  return `${startTag}${JSON.stringify(payload, null, 2)}${endTag}`;
}

let _instance: ToolResultProcessor | null = null;

export function getToolResultProcessor(): ToolResultProcessor {
  if (!_instance) {
    _instance = new ToolResultProcessor();
  }
  return _instance;
}

/**
 * 视频抓取媒体标记注入：
 * 当本轮回复的工具是 `video.grab` 且结果带可播放视频流时，
 * 在回复文本上附加 `[RENDER_AS:video]` + `[VIDEO_MEDIA_START]` 媒体标记。
 * 前端解析该标记后，用后端视频代理路由真实内联播放视频（媒体 URL 经代理避免跨域/防盗链）。
 *
 * 设计：
 *   - 不依赖 LLM 是否在正文里回显视频地址——直接取工具结果里的 videoUrl，确定性注入
 *   - 文本本身已有 RENDER_AS 标记时不重复包裹，只追加媒体块
 *   - 无视频流（反爬/需登录）时原样返回，前端按普通文本展示播放页链接
 */
export function attachVideoMediaMarker(
  text: string,
  toolName: string | undefined,
  toolResult: Record<string, unknown> | undefined,
): string {
  if (toolName !== "video.grab" || !toolResult) return text;
  const videoUrl = String(toolResult.videoUrl ?? "").trim();
  if (!videoUrl) return text;

  const playPageUrl = String(toolResult.playPageUrl ?? "").trim();
  const payload: Record<string, unknown> = {
    mediaType: "video",
    mediaUrl: buildProxyMediaUrl(videoUrl, playPageUrl),
  };
  const thumbnailUrl = String(toolResult.thumbnailUrl ?? "").trim();
  if (thumbnailUrl) payload.thumbnailUrl = buildProxyMediaUrl(thumbnailUrl, playPageUrl);
  if (playPageUrl) payload.pageUrl = playPageUrl;
  const title = String(toolResult.title ?? "").trim();
  if (title) payload.title = title;
  const author = String(toolResult.author ?? "").trim();
  if (author) payload.author = author;
  const duration = Number(toolResult.durationSeconds);
  if (Number.isFinite(duration) && duration > 0) payload.durationSeconds = duration;
  if (Array.isArray(toolResult.notes)) {
    const notes = toolResult.notes.map(String).filter((n) => n.trim());
    if (notes.length) payload.notes = notes;
  }

  const block = `[VIDEO_MEDIA_START]\n${JSON.stringify(payload)}\n[VIDEO_MEDIA_END]`;
  if (/^\[RENDER_AS:\w+\]/.test(text.trimStart())) {
    return `${text.trimEnd()}\n\n${block}`;
  }
  return `[RENDER_AS:video]\n${text.trim()}\n\n${block}`;
}

/** 把上游原始媒体地址包装为后端代理 URL（避免前端跨域与防盗链问题） */
function buildProxyMediaUrl(rawUrl: string, referer?: string): string {
  const base = `/agent/media/proxy?url=${encodeURIComponent(rawUrl)}`;
  if (referer) return `${base}&referer=${encodeURIComponent(referer)}`;
  return base;
}

/**
 * 媒体搜索（search_images / search_videos）确定性卡片注入。
 *
 * 为什么需要：媒体搜索工具结果里含 thumbnailUrl/mediaUrl（图片已转存为服务端
 * 本地 PNG），但 LLM 输出文本时不一定回显这些地址，导致前端 media 卡片拿不到
 * 缩略图、照片永远显示不出来。这里直接取工具结果 items，确定性生成
 * `[AGENT_RESULT_CARD_START]` media 卡片，不依赖 LLM 转发。
 */
export function attachMediaSearchMarker(
  text: string,
  toolName: string | undefined,
  toolResult: Record<string, unknown> | undefined,
): string {
  if (toolName !== "search_images" && toolName !== "search_videos") return text;
  if (!toolResult) return text;
  const rawItems = Array.isArray(toolResult.items) ? toolResult.items : [];
  if (rawItems.length === 0) return text;

  const isVideo = toolName === "search_videos";
  const cardItems: Array<Record<string, unknown>> = [];
  for (const raw of rawItems.slice(0, 6)) {
    const it = (raw ?? {}) as Record<string, unknown>;
    const title = String(it.title ?? "").trim();
    const thumbnailUrl = String(it.thumbnailUrl ?? "").trim();
    const mediaUrl = String(it.mediaUrl ?? "").trim();
    const pageUrl = String(it.pageUrl ?? "").trim();
    const source = String(it.source ?? "").trim();
    // 丢弃没有任何可加载媒体地址的无效项（空缩略图/空媒体地址），
    // 保证渲染出来的媒体卡片每个都能看到图，不夹带"占了位置的空白项"。
    const hasMedia = !!(thumbnailUrl || mediaUrl);
    if (!hasMedia) continue;
    cardItems.push({
      type: isVideo ? "video" : "image",
      title: title || source || (isVideo ? "相关视频" : "图片结果"),
      // 缩略图优先本地 PNG，其次媒体地址（前端会走代理解析）
      thumbnailUrl: thumbnailUrl || mediaUrl || "",
      mediaType: isVideo ? "video" : "image",
      pageUrl,
      source,
    });
  }
  if (cardItems.length === 0) return text;

  // 已带卡片/折叠标记则不重复注入
  if (
    text.includes("[AGENT_RESULT_CARD_START]") ||
    text.includes("[CONTENT_SUMMARY_V2_START]")
  ) {
    return text;
  }

  const payload: Record<string, unknown> = {
    cardType: "media",
    title: isVideo ? "相关视频" : "相关图片",
    items: cardItems,
    footer: `共 ${cardItems.length} 条${isVideo ? "视频" : "图片"}结果，点击可查看原图`,
  };
  const block = `[AGENT_RESULT_CARD_START]\n${JSON.stringify(payload, null, 2)}\n[AGENT_RESULT_CARD_END]`;
  return `${block}\n\n${text.trim()}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 结构化媒体卡片（Coze 式架构：脱离 LLM 文本，独立下发）
// ─────────────────────────────────────────────────────────────────────────────

/** 单条媒体卡片条目（前端直接渲染为缩略图+来源）。 */
export type MediaCardItem = {
  type: "image" | "video";
  title: string;
  /** 缩略图 URL（优先本地 PNG，其次媒体地址） */
  thumbnailUrl: string;
  /** 媒体地址 */
  mediaUrl?: string;
  /** 来源页 URL */
  pageUrl?: string;
  /** 来源名称 */
  source?: string;
  /**
   * 对比分组维度标题（如「水屋」「沙屋」）。为空表示不分组，
   * 前端按普通图廊渲染；非空时按此字段分组、左右两侧分栏展示。
   */
  groupTitle?: string;
  /** 对比侧：A=左侧（sideA）/ B=右侧（sideB） */
  side?: "A" | "B";
  /** 侧标签（如「马尔代夫」「印尼」），用于左右分栏表头 */
  sideLabel?: string;
};

/**
 * 从工具执行结果中提取结构化媒体卡片数据。
 *
 * 与 `attachMediaSearchMarker`（嵌入文本）不同，本函数返回纯数据结构，
 * 由 `chat.assistant_done` 作为独立 `mediaCards` 字段下发，前端直接渲染。
 * LLM 只负责"要不要搜图"，不负责"图片怎么展示"。
 *
 * 支持的工具：search_images, search_images_batch, search_videos
 * 返回空数组 = 无媒体卡片（不阻塞前端渲染）。
 *
 * 对比分组：search_images_batch 返回的 items 带 compareSide/compareLabel/
 * compareGroup 元数据，这里透传为 groupTitle / side / sideLabel，
 * 前端据此按维度分组、左右两侧分栏渲染。
 */
export function extractMediaCards(
  toolName: string | undefined,
  toolResult: Record<string, unknown> | undefined,
): MediaCardItem[] {
  if (
    toolName !== "search_images" &&
    toolName !== "search_images_batch" &&
    toolName !== "search_videos"
  ) {
    return [];
  }
  if (!toolResult) return [];

  const rawItems = Array.isArray(toolResult.items) ? toolResult.items : [];
  // 分组结构（search_images_batch）存在时优先按分组平铺（保留顺序与元数据）
  const rawGrouped = Array.isArray(toolResult.mediaGroups)
    ? (toolResult.mediaGroups as Array<Record<string, unknown>>)
    : [];
  const sources: Array<Record<string, unknown>> =
    rawGrouped.length > 0
      ? rawGrouped.flatMap((g) => {
          const groupTitle = String(g.title ?? "").trim();
          const sideA = String(g.sideA ?? "").trim();
          const sideB = String(g.sideB ?? "").trim();
          const merged: Array<Record<string, unknown>> = [];
          for (const item of asItems(g.itemsA)) {
            merged.push({
              ...item,
              ...(groupTitle ? { compareGroup: groupTitle } : {}),
              ...(sideA ? { compareLabel: sideA } : {}),
              compareSide: "A",
            });
          }
          for (const item of asItems(g.itemsB)) {
            merged.push({
              ...item,
              ...(groupTitle ? { compareGroup: groupTitle } : {}),
              ...(sideB ? { compareLabel: sideB } : {}),
              compareSide: "B",
            });
          }
          return merged;
        })
      : (rawItems as Array<Record<string, unknown>>);
  if (sources.length === 0) return [];

  const isVideo = toolName === "search_videos";
  const cards: MediaCardItem[] = [];
  // 硬上限 8：单 call 不再无限堆图，超过部分直接截断。
  // LLM 需要更多时应该拆成多个 query 并行搜，由 renderBlocks 自然交错。
  for (const it of sources.slice(0, 8)) {
    const title = String(it.title ?? "").trim();
    const thumbnailUrl = String(it.thumbnailUrl ?? "").trim();
    const mediaUrl = String(it.mediaUrl ?? "").trim();
    const pageUrl = String(it.pageUrl ?? "").trim();
    const source = String(it.source ?? "").trim();
    const groupTitle = String(it.compareGroup ?? "").trim();
    const sideRaw = String(it.compareSide ?? "").trim();
    const side = sideRaw === "A" || sideRaw === "B" ? sideRaw : undefined;
    const sideLabel = String(it.compareLabel ?? "").trim();
    // 媒体卡片必须是"能看到图/能打开视频"的真实条目：
    // 若没有任何可加载的媒体地址（缩略图/媒体地址都为空），该条对用户无意义，
    // 直接丢弃，避免前端出现"占了位置但 thumbnailUrl 为空"的无效项。
    const hasMedia = !!(
      thumbnailUrl ||
      mediaUrl ||
      (isVideo && pageUrl && /youtu|bilibili|video/i.test(pageUrl))
    );
    if (!hasMedia) continue;
    cards.push({
      type: isVideo ? "video" : "image",
      title: title || source || "图片结果",
      thumbnailUrl: thumbnailUrl || mediaUrl || "",
      mediaUrl: mediaUrl || undefined,
      pageUrl: pageUrl || undefined,
      source: source || undefined,
      ...(groupTitle ? { groupTitle } : {}),
      ...(side ? { side } : {}),
      ...(sideLabel ? { sideLabel } : {}),
    });
  }
  // 过滤出至少有一个可展示缩略图的干净列表（双重保险：上面已按 hasMedia 过滤）
  return cards.filter((c) => !!c.thumbnailUrl);
}

/**
 * 媒体卡片去重（同一张图不重复展示）：按可展示地址（thumbnailUrl || mediaUrl）
 * 归一化去重，保留首次出现。多轮工具结果聚合时（search_images_batch 各维度、
 * 多次 search_images 调用）常出现相同图片被多次返回，这里统一收敛。
 */
export function dedupMediaCards(cards: MediaCardItem[]): MediaCardItem[] {
  const seen = new Set<string>();
  const out: MediaCardItem[] = [];
  for (const c of cards) {
    const key = (c.thumbnailUrl || c.mediaUrl || "").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

/** 安全地把未知值转成对象数组（flatMap 用）。 */
function asItems(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value as Array<Record<string, unknown>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// 交错渲染块（renderBlocks）：文字段落与媒体分组按正文顺序交错，替代"照片一次性铺在开头"
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 单个渲染块：纯文字段落 或 一组媒体卡片。
 *
 * 设计初衷（2026-08-20）：用户要求「需要照片时，一段文字介绍后放一张照片」，
 * 而不是把全部照片一次性铺在最前面。因此服务端在 `chat.assistant_done` 里
 * 额外下发 `renderBlocks`：把 LLM 正文按「分组关键词在正文中的出现位置」切成
 * 文字段，把对应媒体分组插到该文字段之后，前端按块顺序渲染即可得到
 * 「文字→照片→文字→照片」的自然阅读节奏。全程由代码确定性完成，不依赖 prompt。
 */
export type RenderBlock =
  | { type: "text"; text: string }
  | {
      type: "media";
      groupTitle?: string;
      sideA?: string;
      sideB?: string;
      cards: MediaCardItem[];
    };

/**
 * 把最终正文 + 媒体卡片列表构建成交错渲染块数组。
 *
 * 算法（位置锚定，代码层确定性）：
 * 1. 按 groupTitle 把 mediaCards 分成若干组（保留首次出现顺序）；
 * 2. 对每个分组，在正文中寻找「锚点」——精确命中（标题/两侧标签，含标题子串
 *    与同义词扩展）优先，未命中再用「标题 ↔ 句段」字符级 LCS 相似度做模糊锚定；
 * 3. 按锚点位置升序切分正文：每个锚点之前的文字成为一个 text 块，
 *    紧跟其后的 media 块承载该组照片 → 天然形成「说到这个维度→看它的图」；
 * 4. 正文尾部残段作为最后一个 text 块；未命中任何锚点的分组追加到末尾兜底。
 *
 * @param finalText 最终回复正文（已剥离媒体标记后的干净文本）
 * @param mediaCards 结构化媒体卡片列表（含 groupTitle/side/sideLabel 元数据）
 * @returns 有序渲染块数组；无媒体时只返回一个 text 块（若正文非空）
 */

/**
 * 对比维度同义词表：分组维度标题在正文里用了同义/近义说法时扩大锚定命中面。
 * key=维度标题片段，value=正文里可能出现的同义说法。
 */
const DIMENSION_SYNONYMS: Record<string, string[]> = {
  持久度: ["持久", "持妆", "保持", "维持", "留色", "褪色", "坚持", "耐用"],
  价格: ["价钱", "售价", "价位", "多少钱", "便宜", "贵", "性价比", "花费"],
  色号: ["颜色", "色调", "色彩", "肤色", "涂上", "上色"],
  防水: ["防泼水", "防雨", "防汗", "防水性", "泼水", "不进水"],
  质地: ["质感", "肤感", "触感", "妆感", "细腻", "清爽"],
  包装: ["外观", "瓶身", "设计", "颜值", "容器", "外型"],
  效果: ["妆效", "上脸", "使用效果", "功效", "实际效果", "表现"],
  成分: ["配方", "成分表", "原料", "添加"],
  容量: ["含量", "规格", "大小", "尺寸", "毫升"],
  舒适度: ["舒适", "贴合", "柔软", "亲肤", "透气"],
};

/** 生成锚点候选词：标题精确词 + 全子串（覆盖「颜色持久度」→「持久」等拆词）+ 同义词。 */
function expandAnchorKeywords(title: string): string[] {
  const t = String(title ?? "").trim();
  if (t.length < 2) return [];
  const out = new Set<string>([t]);
  for (let i = 0; i < t.length; i++) {
    for (let j = i + 2; j <= t.length && j - i <= 6; j++) {
      out.add(t.slice(i, j));
    }
  }
  for (const [dim, syns] of Object.entries(DIMENSION_SYNONYMS)) {
    if (t.includes(dim)) {
      for (const s of syns) out.add(s);
    }
  }
  return [...out].filter((k) => k.length >= 2);
}

/** 字符级最长公共子序列相似度（0~1），用于段落到分组的模糊匹配。 */
function lcsSimilarity(a: string, b: string): number {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return 0;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[n][m] / Math.max(n, 1);
}

type TextSeg = { text: string; start: number };

/** 把正文按句子/段落切分，并记录每段在全文中的起始偏移。 */
function splitTextSegments(text: string): TextSeg[] {
  const out: TextSeg[] = [];
  const re = /[^。！？!?\n]+[。！？!?\n]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[0];
    const trimmed = raw.trim();
    if (trimmed.length < 2) continue;
    const start = text.indexOf(trimmed, m.index);
    out.push({ text: trimmed, start: start >= 0 ? start : m.index });
  }
  return out;
}

export function buildInterleavedRenderBlocks(
  finalText: string,
  mediaCards: MediaCardItem[],
): RenderBlock[] {
  if (mediaCards.length === 0) {
    const t = String(finalText ?? "").trim();
    return t ? [{ type: "text", text: t }] : [];
  }

  // 1) 按 groupTitle 分组（空标题=普通单组搜索，归入 "" 组）
  const groups: Array<{ title: string; cards: MediaCardItem[] }> = [];
  const idxByTitle = new Map<string, number>();
  for (const card of mediaCards) {
    const title = (card.groupTitle ?? "").trim();
    let gi = idxByTitle.get(title);
    if (gi === undefined) {
      gi = groups.length;
      groups.push({ title, cards: [] });
      idxByTitle.set(title, gi);
    }
    groups[gi].cards.push(card);
  }

  // 从分组构建媒体块（提取 sideA/sideB）：两处重复，提取为内联 lambda
  const makeMediaBlock = (g: { title: string; cards: MediaCardItem[] }): RenderBlock => {
    const sideA = g.cards.find((c) => c.side === "A")?.sideLabel;
    const sideB = g.cards.find((c) => c.side === "B")?.sideLabel;
    return {
      type: "media",
      ...(g.title ? { groupTitle: g.title } : {}),
      ...(sideA ? { sideA } : {}),
      ...(sideB ? { sideB } : {}),
      cards: g.cards,
    };
  };

  const text = String(finalText ?? "");

  // 1.5) 普适拆分：单 search_images（groupTitle 为空）一张大图墙 → 切成多簇，按正文段落对齐
  //
  // 背景：用户多次反馈「图片全堆在一起，不分段落交错」的根本原因是
  // 单次 search_images 返回 N 张图全部进同一 "" group，renderBlocks 只能锚到
  // 一个位置 → 一大坨全堆在文本末尾。这里把「单组且组内 ≥3 张」的情况
  // 自动按正文段落数拆成多个子组，让「文字→几张图→文字→几张图」自然形成。
  //
  // 拆分原则：
  //   - 取正文段数 N（≥1），目标每簇 2-3 张；
  //   - 若图比段多（cards.length > N*3），把超出的并入最后一簇（不强行打散），
  //     避免出现「1 张图一簇」的过度碎片化；
  //   - 子组的 groupTitle 保持空（仍走普通图廊渲染），不伪造维度标题。
  const segmentsForSplit = splitTextSegments(text);
  if (
    groups.length === 1 &&
    groups[0].title === "" &&
    groups[0].cards.length >= 3 &&
    segmentsForSplit.length >= 1
  ) {
    const flat = groups[0].cards;
    // 目标簇数：min(段落数, ceil(图数 / 每簇目标 3))，最少 2 簇才有交错效果
    const targetClusters = Math.max(
      2,
      Math.min(segmentsForSplit.length, Math.ceil(flat.length / 3)),
    );
    if (targetClusters >= 2) {
      // 等分切成 targetClusters 簇
      const split: Array<{ title: string; cards: MediaCardItem[] }> = [];
      const per = Math.ceil(flat.length / targetClusters);
      for (let i = 0; i < targetClusters; i++) {
        const slice = flat.slice(i * per, (i + 1) * per);
        if (slice.length === 0) break;
        split.push({ title: "", cards: slice });
      }
      // 用拆分结果替换 groups，后续走原锚定逻辑
      groups.length = 0;
      groups.push(...split);
    }
  }

  // 2) 为每个分组计算锚点（锚定媒体组应插入的正文位置）
  //    策略（代码层确定性，不依赖 prompt）：
  //    a) 精确命中：分组标题/两侧标签（含标题子串与同义词）在正文的最早出现位置；
  //    b) 模糊命中：无精确命中时，用「分组标题 ↔ 句段」的字符级 LCS 相似度，
  //       把媒体组锚定到最相关句段之后（覆盖换说法/意译场景）。
  type Anchor = { gi: number; pos: number; end: number };
  const anchors: Anchor[] = [];
  const segments = splitTextSegments(text);
  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi];
    // a) 精确 + 标题子串 + 同义词候选（标题）；两侧标签保持精确匹配
    const candidates = new Set<string>();
    if (g.title) {
      for (const k of expandAnchorKeywords(g.title)) candidates.add(k);
    }
    for (const c of g.cards) {
      const sl = (c.sideLabel ?? "").trim();
      if (sl.length >= 2) candidates.add(sl);
    }
    let best: Anchor | null = null;
    for (const kw of candidates) {
      const pos = text.indexOf(kw);
      if (pos >= 0 && (best === null || pos < best.pos)) {
        best = { gi, pos, end: pos + kw.length };
      }
    }
    // b) 模糊命中：仅当没有精确命中且标题足够长时
    if (!best && g.title && g.title.length >= 2 && segments.length > 0) {
      let bestScore = 0;
      let bestSeg: TextSeg | null = null;
      for (const seg of segments) {
        const s = lcsSimilarity(g.title, seg.text);
        if (s > bestScore) {
          bestScore = s;
          bestSeg = seg;
        }
      }
      if (bestSeg && bestScore >= 0.5) {
        best = { gi, pos: bestSeg.start, end: bestSeg.start + bestSeg.text.length };
      }
    }
    if (best) anchors.push(best);
  }

  // 2.5) 兜底锚定：没有标题/两侧标签可命中的分组（典型：1.5 节拆分出来的空 title 子组）
  //       按数组顺序均匀分布到正文各句段**末尾**，避免「全堆末尾」。
  //       只对尚未有 anchor 的 group 起作用。
  //       注意：anchor 必须定位到句段末尾（pos=end=段尾），这样第 4 步切分时
  //       上一条媒体块到本 anchor 之间的整段文字会完整成为 text 块、
  //       媒体块则紧跟该段之后 → 正确形成「文字→图→文字→图」。若锚到段首，
  //       相邻锚点之间文字会被砍空，媒体块一个接一个堆叠，视觉上退回「全堆一起」。
  const anchoredGis = new Set(anchors.map((a) => a.gi));
  if (segments.length > 0) {
    const titleLessGis: number[] = [];
    for (let gi = 0; gi < groups.length; gi++) {
      if (!anchoredGis.has(gi)) titleLessGis.push(gi);
    }
    if (titleLessGis.length > 0) {
      // 把 N 个无锚点组均匀分到 N 个句段：第 i 组 → 第 floor(i * segCount / N) 段末
      for (let i = 0; i < titleLessGis.length; i++) {
        const gi = titleLessGis[i];
        const segIdx = Math.min(
          segments.length - 1,
          Math.floor((i * segments.length) / titleLessGis.length),
        );
        const seg = segments[segIdx];
        const end = seg.start + seg.text.length;
        anchors.push({ gi, pos: end, end });
      }
    }
  }
  // 3) 锚点按位置升序
  anchors.sort((a, b) => a.pos - b.pos);
  const usedGis = new Set<number>();

  // 4) 切分正文并交错插入媒体块
  const blocks: RenderBlock[] = [];
  let cursor = 0;
  for (const anchor of anchors) {
    usedGis.add(anchor.gi);
    const seg = text.slice(cursor, anchor.pos).trim();
    if (seg) blocks.push({ type: "text", text: seg });
    blocks.push(makeMediaBlock(groups[anchor.gi]));
    cursor = Math.max(cursor, anchor.end);
  }
  const tail = text.slice(cursor).trim();
  if (tail) blocks.push({ type: "text", text: tail });

  // 5) 未命中锚点的分组追加到末尾兜底
  for (let gi = 0; gi < groups.length; gi++) {
    if (usedGis.has(gi)) continue;
    blocks.push(makeMediaBlock(groups[gi]));
  }

  return blocks;
}