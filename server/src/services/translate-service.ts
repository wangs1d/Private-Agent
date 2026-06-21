/**
 * 翻译服务：调用本地 PaddleOCR HTTP 服务提取图片中的文字，再调用翻译器做翻译。
 *
 * 翻译器优先级（由 TRANSLATE_PROVIDER 控制）：
 *   - "auto"（默认）：如果配置了 MOONSHOT_API_KEY / OPENAI_API_KEY，则走 OpenAI 兼容 LLM；
 *                    否则（或 LLM 失败时）回退到免 key 的公网 MyMemory 翻译 API。
 *   - "llm"        ：强制走 LLM，失败直接报错。
 *   - "free"       ：强制走 MyMemory 翻译 API。
 *
 * 注意：本服务**绝不**把图片发送给 LLM，翻译阶段只处理 OCR 提取出的纯文本。
 *      PaddleOCR 负责图像→文字（OCR 是专门模型，不是视觉 LLM），翻译阶段只对文本做翻译。
 *
 * 环境变量：
 *   PADDLE_OCR_BASE_URL      PaddleOCR 服务地址，默认 http://127.0.0.1:8765
 *   PADDLE_OCR_TIMEOUT_MS    单次 OCR 超时（毫秒），默认 20000
 *   TRANSLATE_PROVIDER       auto | llm | free，默认 auto
 *   TRANSLATE_FREE_API       默认 https://api.mymemory.translated.net/get
 *   TRANSLATE_LLM_TIMEOUT_MS LLM 翻译超时，默认 8000
 *   TRANSLATE_FREE_TIMEOUT_MS 公网 API 超时，默认 5000
 *
 * 该服务依赖 `desktop-visual/desktop_visual/paddle_ocr_server.py` 启动的 PaddleOCR HTTP 服务。
 * PaddleOCR 项目：https://github.com/PaddlePaddle/PaddleOCR
 */
import OpenAI from "openai";

import { createExternalChatProviderFromEnv } from "../external-model/index.js";
import type { ExternalChatProvider } from "../external-model/types.js";

const log = {
  warn: (...args: unknown[]) => console.warn("[translate-service]", ...args),
  info: (...args: unknown[]) => console.log("[translate-service]", ...args),
  error: (...args: unknown[]) => console.error("[translate-service]", ...args),
};

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return fallback;
  return n;
}

export type TranslateRequest = {
  /** 截图的 base64 字符串（不含 data:image/...;base64, 前缀） */
  imageBase64: string;
  /** 截图 MIME 类型，默认 image/png */
  mimeType?: string;
  /** 源语言，可选；为空时 PaddleOCR 自动检测 */
  sourceLang?: string;
  /** 目标语言，默认 zh（中文） */
  targetLang?: string;
};

export type TranslateOcrLine = {
  text: string;
  confidence: number;
  box: number[][];
};

export type TranslateResult = {
  ok: boolean;
  /** 识别出的原文 */
  sourceText: string;
  /** 翻译结果 */
  translatedText: string;
  /** 目标语言 */
  targetLang: string;
  /** 原文每行带坐标信息 */
  lines: TranslateOcrLine[];
  /** 截图宽高 */
  width?: number;
  height?: number;
  /** 错误信息（ok=false 时） */
  error?: string;
  /** 翻译方式标识 */
  translatedBy: "llm" | "free" | "none";
};

export class TranslateService {
  private readonly paddleBaseUrl: string;
  private readonly paddleTimeoutMs: number;
  private readonly providerMode: "auto" | "llm" | "free";
  private readonly freeApiBase: string;
  private readonly llmTimeoutMs: number;
  private readonly freeTimeoutMs: number;
  /** 翻译用的 OpenAI 客户端（独立于主聊天 provider，便于直接调用 chat/completions） */
  private readonly translationClient: OpenAI | null;
  private readonly translationModel: string;
  private readonly externalProvider: ExternalChatProvider | null;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.paddleBaseUrl =
      env.PADDLE_OCR_BASE_URL?.trim() || "http://127.0.0.1:8765";
    this.paddleTimeoutMs = parsePositiveInt(env.PADDLE_OCR_TIMEOUT_MS, 20_000);

    const providerRaw = (env.TRANSLATE_PROVIDER ?? "auto").trim().toLowerCase();
    this.providerMode = providerRaw === "llm" || providerRaw === "free" ? providerRaw : "auto";
    this.freeApiBase = (env.TRANSLATE_FREE_API ?? "https://api.mymemory.translated.net/get").trim();
    this.llmTimeoutMs = parsePositiveInt(env.TRANSLATE_LLM_TIMEOUT_MS, 8_000);
    this.freeTimeoutMs = parsePositiveInt(env.TRANSLATE_FREE_TIMEOUT_MS, 5_000);

    // 翻译模型：优先使用 MOONSHOT（与外部 Chat provider 共享），其次 OpenAI，最后回退到 ExternalChatProvider
    const moonshotKey = env.MOONSHOT_API_KEY?.trim();
    const openaiKey = env.OPENAI_API_KEY?.trim();
    if (moonshotKey) {
      this.translationClient = new OpenAI({
        apiKey: moonshotKey,
        baseURL: (env.MOONSHOT_BASE_URL ?? "https://api.moonshot.ai/v1").trim(),
      });
      this.translationModel = (env.MOONSHOT_MODEL ?? "kimi-k2.5").trim();
    } else if (openaiKey) {
      this.translationClient = new OpenAI({
        apiKey: openaiKey,
        baseURL: (env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").trim(),
      });
      this.translationModel = (env.OPENAI_MODEL ?? "gpt-4o-mini").trim();
    } else {
      this.translationClient = null;
      this.translationModel = "";
    }
    this.externalProvider = createExternalChatProviderFromEnv();
  }

  isPaddleAvailable(): boolean {
    return Boolean(this.paddleBaseUrl);
  }

  /**
   * 主入口：图片 → PaddleOCR 识别 → 翻译。
   * 翻译阶段按 TRANSLATE_PROVIDER 决定走 LLM 还是免 key 公网 API。
   */
  async translate(req: TranslateRequest): Promise<TranslateResult> {
    const targetLang = (req.targetLang ?? "zh").trim() || "zh";
    const ocr = await this.callPaddleOcr(req);
    if (!ocr.ok) {
      return {
        ok: false,
        sourceText: "",
        translatedText: "",
        targetLang,
        lines: [],
        error: ocr.error ?? "OCR 失败",
        translatedBy: "none",
      };
    }
    const sourceText = ocr.text ?? "";
    if (!sourceText.trim()) {
      return {
        ok: true,
        sourceText: "",
        translatedText: "",
        targetLang,
        lines: ocr.lines,
        width: ocr.width,
        height: ocr.height,
        translatedBy: "none",
      };
    }
    const translated = await this.callTranslate(sourceText, targetLang, req.sourceLang);
    return {
      ok: true,
      sourceText,
      translatedText: translated.text,
      targetLang,
      lines: ocr.lines,
      width: ocr.width,
      height: ocr.height,
      translatedBy: translated.ok ? translated.by : "none",
      error: translated.ok ? undefined : translated.error,
    };
  }

  /**
   * 调用 PaddleOCR HTTP 服务。
   */
  private async callPaddleOcr(req: TranslateRequest): Promise<{
    ok: boolean;
    text?: string;
    lines: TranslateOcrLine[];
    width?: number;
    height?: number;
    error?: string;
  }> {
    const url = `${this.paddleBaseUrl.replace(/\/+$/, "")}/ocr`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.paddleTimeoutMs);
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imageBase64: req.imageBase64,
          mimeType: req.mimeType ?? "image/png",
          lang: req.sourceLang ?? null,
          mergeLines: true,
        }),
        signal: controller.signal,
      });
      if (!resp.ok) {
        const errText = await resp.text().catch(() => "");
        return {
          ok: false,
          lines: [],
          error: `PaddleOCR HTTP ${resp.status}: ${errText.slice(0, 200) || resp.statusText}`,
        };
      }
      const data = (await resp.json()) as {
        ok?: boolean;
        text?: string;
        lines?: Array<{ text?: string; confidence?: number; box?: number[][] }>;
        width?: number;
        height?: number;
        error?: string;
      };
      if (!data.ok) {
        return {
          ok: false,
          lines: [],
          error: data.error ?? "PaddleOCR 返回 ok=false",
        };
      }
      const lines: TranslateOcrLine[] = Array.isArray(data.lines)
        ? data.lines.map((ln) => ({
            text: String(ln.text ?? ""),
            confidence: Number(ln.confidence ?? 0),
            box: Array.isArray(ln.box) ? (ln.box as number[][]) : [],
          }))
        : [];
      return {
        ok: true,
        text: String(data.text ?? ""),
        lines,
        width: typeof data.width === "number" ? data.width : undefined,
        height: typeof data.height === "number" ? data.height : undefined,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.warn({ err: msg, url }, "PaddleOCR 调用失败");
      return {
        ok: false,
        lines: [],
        error:
          msg.includes("aborted") || msg.includes("abort")
            ? `PaddleOCR 调用超时（${this.paddleTimeoutMs}ms），请确认服务已启动：${url}`
            : `PaddleOCR 调用失败: ${msg}`,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 翻译编排：按 TRANSLATE_PROVIDER 选择翻译器
   *  - "free"  → 直接走公网 MyMemory
   *  - "llm"   → 直接走 LLM（无 LLM 时报错）
   *  - "auto"  → 先 LLM，失败再公网 API
   */
  private async callTranslate(
    sourceText: string,
    targetLang: string,
    sourceLang?: string,
  ): Promise<{ ok: boolean; by: "llm" | "free" | "none"; text: string; error?: string }> {
    if (this.providerMode === "free") {
      const r = await this.callFreeApiTranslate(sourceText, targetLang, sourceLang);
      return { ok: r.ok, by: r.ok ? "free" : "none", text: r.text, error: r.error };
    }
    if (this.providerMode === "llm") {
      const r = await this.callLlmTranslate(sourceText, targetLang);
      return { ok: r.ok, by: r.ok ? "llm" : "none", text: r.text, error: r.error };
    }
    // auto: 先 LLM，再 free
    const llm = await this.callLlmTranslate(sourceText, targetLang);
    if (llm.ok) {
      return { ok: true, by: "llm", text: llm.text };
    }
    log.warn({ err: llm.error }, "LLM 翻译失败，回退到公网 MyMemory");
    const free = await this.callFreeApiTranslate(sourceText, targetLang, sourceLang);
    return { ok: free.ok, by: free.ok ? "free" : "none", text: free.text, error: free.error };
  }

  /**
   * 调用 LLM 做翻译（仅处理文本，不发图给视觉模型）。
   * 优先 OpenAI 兼容客户端（同步 chat/completions），回退到 ExternalChatProvider。
   */
  private async callLlmTranslate(
    sourceText: string,
    targetLang: string,
  ): Promise<{ ok: boolean; text: string; error?: string }> {
    if (this.translationClient) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.llmTimeoutMs);
      try {
        const completion = await this.translationClient.chat.completions.create({
          model: this.translationModel,
          temperature: 0.2,
          max_tokens: 1024,
          messages: [
            {
              role: "system",
              content: this.translateSystemPrompt(),
            },
            { role: "user", content: this.buildTranslatePrompt(sourceText, targetLang) },
          ],
        });
        const out = completion.choices?.[0]?.message?.content?.trim() ?? "";
        return { ok: true, text: out };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log.warn({ err: msg }, "OpenAI 兼容翻译接口失败");
        return { ok: false, text: "", error: msg };
      } finally {
        clearTimeout(timer);
      }
    }
    if (this.externalProvider?.isEnabled()) {
      try {
        let collected = "";
        await this.externalProvider.streamCompletion(
          `translate-${Date.now()}`,
          { text: this.buildTranslatePrompt(sourceText, targetLang) },
          (delta) => {
            collected += delta;
          },
          undefined,
          { ephemeralTurn: true, systemPromptOverride: this.translateSystemPrompt() },
        );
        return { ok: true, text: collected.trim() };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false, text: "", error: msg };
      }
    }
    return { ok: false, text: "", error: "未配置翻译模型（请设置 MOONSHOT_API_KEY 或 OPENAI_API_KEY，或将 TRANSLATE_PROVIDER 设为 free）" };
  }

  /**
   * 免 key 公网翻译 API：MyMemory（GET /get?langpair=<src>|<target>&q=<text>）。
   * 无需注册、无需 API Key，匿名用户每天 5000 字符额度。
   * 文档：https://mymemory.translated.net/doc/spec.php
   *
   * 注意：
   *   - MyMemory 不支持 `auto` 源语言；需明确指定源语言。
   *   - 默认源语言为 `en`（屏幕翻译最常见场景）。可在请求里通过 sourceLang 覆盖。
   *   - 长文本自动切分为 ≤ 480 字符片段以避免超限。
   */
  private async callFreeApiTranslate(
    sourceText: string,
    targetLang: string,
    sourceLang?: string,
  ): Promise<{ ok: boolean; text: string; error?: string }> {
    const base = this.freeApiBase.replace(/\/+$/, "");
    const src = this.normalizeLangCode(sourceLang?.trim() || "en");
    const tgt = this.normalizeLangCode(targetLang);
    const langpair = `${src}|${tgt}`;

    // 长文本切分（按段落/换行）
    const chunks = this.splitForFreeApi(sourceText, 480);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.freeTimeoutMs * chunks.length);
    const out: string[] = [];
    try {
      for (const chunk of chunks) {
        const url = `${base}?q=${encodeURIComponent(chunk)}&langpair=${encodeURIComponent(langpair)}&de=privategpai@gmail.com`;
        const resp = await fetch(url, { method: "GET", signal: controller.signal });
        if (!resp.ok) {
          return {
            ok: false,
            text: "",
            error: `MyMemory HTTP ${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 200)}`,
          };
        }
        const data = (await resp.json()) as {
          responseData?: { translatedText?: string };
          responseStatus?: number | string;
          responseDetails?: string;
        };
        const t = data?.responseData?.translatedText;
        if (typeof t !== "string" || !t) {
          return {
            ok: false,
            text: "",
            error: `MyMemory 无翻译结果（status=${data?.responseStatus}，${data?.responseDetails ?? ""}）`,
          };
        }
        out.push(t);
      }
      return { ok: true, text: out.join("\n").trim() };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        text: "",
        error: msg.includes("aborted") || msg.includes("abort")
          ? `MyMemory 调用超时（${this.freeTimeoutMs * chunks.length}ms）`
          : `MyMemory 调用失败: ${msg}`,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private splitForFreeApi(text: string, maxLen: number): string[] {
    if (text.length <= maxLen) return [text];
    const lines = text.split(/\n+/);
    const chunks: string[] = [];
    let buf = "";
    for (const line of lines) {
      if (line.length > maxLen) {
        // 单行过长，硬切
        if (buf) {
          chunks.push(buf);
          buf = "";
        }
        for (let i = 0; i < line.length; i += maxLen) {
          chunks.push(line.slice(i, i + maxLen));
        }
        continue;
      }
      if ((buf + "\n" + line).length > maxLen) {
        chunks.push(buf);
        buf = line;
      } else {
        buf = buf ? buf + "\n" + line : line;
      }
    }
    if (buf) chunks.push(buf);
    return chunks.length > 0 ? chunks : [text];
  }

  private normalizeLangCode(code: string): string {
    const lower = code.toLowerCase();
    const map: Record<string, string> = {
      "zh-cn": "zh-CN",
      "zh-tw": "zh-TW",
      "zh-hk": "zh-HK",
    };
    return map[lower] ?? lower;
  }

  private translateSystemPrompt(): string {
    return "你是一个高效的翻译助手。只输出目标语言的译文，不要添加解释、注释或额外对话。" +
      "如果原文是混合语言，请整体翻译到目标语言并保持自然通顺；专有名词可保留原文。";
  }

  private buildTranslatePrompt(sourceText: string, targetLang: string): string {
    const langName = this.langDisplayName(targetLang);
    return `请将下列文字翻译为${langName}（${targetLang}）：\n\n${sourceText}`;
  }

  private langDisplayName(code: string): string {
    const map: Record<string, string> = {
      zh: "中文（简体）",
      "zh-CN": "中文（简体）",
      "zh-TW": "中文（繁体）",
      en: "英语",
      ja: "日语",
      ko: "韩语",
      fr: "法语",
      de: "德语",
      es: "西班牙语",
      ru: "俄语",
      pt: "葡萄牙语",
      it: "意大利语",
      ar: "阿拉伯语",
      th: "泰语",
      vi: "越南语",
    };
    return map[code] || code;
  }
}

/** 进程级单例；服务启动时构造一次复用 */
let _instance: TranslateService | null = null;
export function getTranslateService(env: NodeJS.ProcessEnv = process.env): TranslateService {
  if (!_instance) _instance = new TranslateService(env);
  return _instance;
}

/** 允许在测试时替换单例 */
export function __setTranslateServiceForTest(svc: TranslateService | null): void {
  _instance = svc;
}
