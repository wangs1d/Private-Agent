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

    const trimmed = text.trim();
    if (!trimmed) return text;

    // 已带标记的直接放行（避免二次处理）
    if (
      trimmed.includes("[CONTENT_SUMMARY_V2_START]") ||
      trimmed.includes("[AGENT_RESULT_CARD_START]")
    ) {
      return text;
    }

    // === 渲染形态判断中心 ===
    // 三层优先级：result_card（小卡片）> summary_card（摘要卡）> plain（正文）
    const hint = classifyRenderHint(text, {
      toolName: opts?.toolName,
      userText: opts?.userText,
    });

    // 优先级 1：result_card 简短汇报（仅在富文本模式生效，纯文本端不展示卡片）
    if (hint.type === "result_card" && !opts?.plainTextMode) {
      const marked = formatAgentResultForChat(text, opts?.toolName);
      if (marked) {
        console.log(
          `[ToolResultProcessor] result_card: ${hint.reason}`,
        );
        return marked;
      }
      // 解析失败（items < 2）→ 降级 plain
    }

    // 优先级 2：summary_card 长内容折叠
    if (hint.type === "summary_card") {
      console.log(
        `[ToolResultProcessor] Processing text, length: ${text.length}, threshold: ${this.options.threshold}, plainTextMode: ${!!opts?.plainTextMode}`,
      );

      if (shouldSummarizeContent(text, this.options.threshold)) {
        const summary = createContentSummary(text, {
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

    // 优先级 3：plain 普通正文
    return humanizeAssistantText(text, { userText: opts?.userText });
  }
}

let _instance: ToolResultProcessor | null = null;

export function getToolResultProcessor(): ToolResultProcessor {
  if (!_instance) {
    _instance = new ToolResultProcessor();
  }
  return _instance;
}
