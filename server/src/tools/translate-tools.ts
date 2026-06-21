/**
 * 翻译工具：Agent 可以在聊天中调用本工具对图片做 OCR + 翻译。
 *
 * - translate.translate_image：传入图片 base64，返回 OCR 原文与目标语言译文
 */
import { getTranslateService } from "../services/translate-service.js";
import type { ToolRegistry } from "./tool-registry.js";

export function registerTranslateTools(toolRegistry: ToolRegistry): void {
  toolRegistry.register("translate.translate_image", async (input) => {
    const imageBase64 = String(input.imageBase64 ?? "").trim();
    if (!imageBase64) {
      return { ok: false, error: "缺少 imageBase64" };
    }
    const targetLang = String(input.targetLang ?? "zh").trim() || "zh";
    const sourceLang = input.sourceLang ? String(input.sourceLang).trim() || undefined : undefined;
    const mimeType = String(input.mimeType ?? "image/png").trim() || "image/png";
    const svc = getTranslateService();
    const r = await svc.translate({ imageBase64, mimeType, sourceLang, targetLang });
    if (!r.ok) {
      return { ok: false, error: r.error ?? "翻译失败" };
    }
    return {
      ok: true,
      sourceText: r.sourceText,
      translatedText: r.translatedText,
      targetLang: r.targetLang,
      translatedBy: r.translatedBy,
      lineCount: r.lines.length,
      lines: r.lines.map((ln) => ({ text: ln.text, confidence: ln.confidence })),
      width: r.width,
      height: r.height,
      summary: r.sourceText
        ? `已识别 ${r.lines.length} 行原文并翻译为${r.targetLang}。`
        : "图片中未识别到文字。",
    };
  });
}
