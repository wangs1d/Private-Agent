import {
  createContentSummary,
  formatContentSummaryForChat,
  shouldSummarizeContent,
  type ContentSummary,
} from "../services/content-summary-service.js";

const SUMMARY_ENABLED_TOOLS = new Set([
  "search_web",
  "fetch_web",
  "info.search",
  "info.read_webpage",
  "info.inspect_webpage",
  "info.navigate_site",
]);

const CONTENT_LENGTH_THRESHOLD = 600;

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

  processToolResult(
    toolName: string,
    result: unknown
  ): { processed: boolean; output: string; summary?: ContentSummary } {
    if (!this.options.enabled) {
      return { processed: false, output: this.stringifyResult(result) };
    }

    if (!SUMMARY_ENABLED_TOOLS.has(toolName)) {
      return { processed: false, output: this.stringifyResult(result) };
    }

    const textContent = this.extractTextContent(result);
    
    if (!textContent || !shouldSummarizeContent(textContent, this.options.threshold)) {
      return { processed: false, output: this.stringifyResult(result) };
    }

    const source = this.extractSourceFromResult(result);
    const summary = createContentSummary(textContent, {
      source,
      maxLength: this.options.threshold,
    });

    if (!summary) {
      return { processed: false, output: this.stringifyResult(result) };
    }

    const formattedOutput = formatContentSummaryForChat(summary);

    return { 
      processed: true, 
      output: formattedOutput, 
      summary 
    };
  }

  processAssistantText(text: string): string {
    if (!this.options.enabled) {
      return text;
    }

    const trimmed = text.trim();
    if (!trimmed || trimmed.length < 280) {
      return text;
    }
    if (trimmed.includes("[CONTENT_SUMMARY_V2_START]")) {
      return text;
    }

    console.log(`[ToolResultProcessor] Processing text, length: ${text.length}, threshold: ${this.options.threshold}`);

    if (shouldSummarizeContent(text, this.options.threshold)) {
      const summary = createContentSummary(text, {
        maxLength: this.options.threshold,
        forceSummary: false,
      });

      if (summary) {
        console.log(`[ToolResultProcessor] Created summary: ${summary.title}, points: ${summary.briefPoints.length}`);
        const formatted = formatContentSummaryForChat(summary);
        console.log(`[ToolResultProcessor] Formatted output length: ${formatted.length}`);
        return formatted;
      }
    }

    return text;
  }

  private stringifyResult(result: unknown): string {
    if (typeof result === "string") {
      return result;
    }

    try {
      return JSON.stringify(result, null, 2);
    } catch {
      return String(result);
    }
  }

  private extractTextContent(result: unknown): string | null {
    if (typeof result === "string") {
      return result;
    }

    if (result && typeof result === "object") {
      const obj = result as Record<string, unknown>;

      if (Array.isArray(obj.items)) {
        return obj.items
          .map((item) => {
            if (item && typeof item === "object") {
              const itemObj = item as Record<string, unknown>;
              return [
                itemObj.title,
                itemObj.snippet,
                itemObj.content,
                itemObj.summary,
                itemObj.description,
              ]
                .filter((v): v is string => typeof v === "string")
                .join("\n");
            }
            return String(item ?? "");
          })
          .filter(Boolean)
          .join("\n\n");
      }

      if (obj.content && typeof obj.content === "string") {
        return obj.content;
      }

      if (obj.summary && typeof obj.summary === "string") {
        return obj.summary;
      }

      const textFields = ["text", "body", "description", "snippet"];
      for (const field of textFields) {
        if (obj[field] && typeof obj[field] === "string") {
          return obj[field] as string;
        }
      }
    }

    return null;
  }

  private extractSourceFromResult(result: unknown): string | undefined {
    if (result && typeof result === "object") {
      const obj = result as Record<string, unknown>;
      
      if (obj.url && typeof obj.url === "string") {
        return obj.url;
      }

      if (obj.source && typeof obj.source === "string") {
        return obj.source;
      }

      if (obj.provider && typeof obj.provider === "string") {
        return obj.provider;
      }
    }

    return undefined;
  }
}

let _instance: ToolResultProcessor | null = null;

export function getToolResultProcessor(): ToolResultProcessor {
  if (!_instance) {
    _instance = new ToolResultProcessor();
  }
  return _instance;
}

export function resetToolResultProcessor(): void {
  _instance = null;
}
