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

    // === 0. 检查 LLM 声明的 [RENDER_HINT:xxx]（优先级最高）===
    const { rawHint: llmHint, cleanText: textAfterLlmHint } = extractLlmRenderHint(text);
    let workingText = textAfterLlmHint;
    if (llmHint) {
      console.log(`[ToolResultProcessor] LLM declared render_hint: ${llmHint}`);
      switch (llmHint) {
        case "structured":
          return wrapRenderAs("structured", humanizeAssistantText(workingText, { userText: opts?.userText }));
        case "brief":
          return wrapRenderAs("brief", humanizeAssistantText(workingText, { userText: opts?.userText }));
        case "card":
          return formatAgentResultForChat(workingText, opts?.toolName) ?? humanizeAssistantText(workingText, { userText: opts?.userText });
        case "plain":
          return humanizeAssistantText(workingText, { userText: opts?.userText });
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
      return wrapRenderAs("image_result", humanizeAssistantText(workingText, { userText: opts?.userText }));
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
      return wrapRenderAs("brief", humanizeAssistantText(workingText, { userText: opts?.userText }));
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
          return humanizeAssistantText(formatted, { userText: opts?.userText });
        }
      }
    }

    // 优先级 4：long_text 长内容（非搜索工具）
    if (hint.type === "long_text") {
      console.log(`[ToolResultProcessor] long_text: ${hint.reason}`);
      // 意图触发的 long_text → 注入 [RENDER_AS:structured]
      if (hint.intent) {
        return wrapRenderAs("structured", humanizeAssistantText(workingText, { userText: opts?.userText }));
      }
      return humanizeAssistantText(workingText, { userText: opts?.userText });
    }

    // 优先级 5：plain 普通正文
    return humanizeAssistantText(workingText, { userText: opts?.userText });
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
    if (!title && !thumbnailUrl && !mediaUrl && !pageUrl) continue;
    cardItems.push({
      type: isVideo ? "video" : "image",
      title,
      // 缩略图优先本地 PNG，其次媒体地址（前端会走代理解析）
      thumbnailUrl: thumbnailUrl || mediaUrl || pageUrl,
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