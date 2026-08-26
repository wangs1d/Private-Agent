/**
 * 视觉能力判定与图片文本化降级（OCR）。
 *
 * 纯文本模型（deepseek-chat / deepseek-reasoner / gpt-3.5 等）无法接收
 * `image_url` 多模态输入，注入会直接导致 OpenAI 兼容 API 报 400。
 * 因此所有「用户图片 → LLM」的注入点都必须先按模型能力分流：
 *  - 视觉模型 → image_url 原样注入，让 LLM 直接看图
 *  - 非视觉模型 → 文本降级（说明照片存在），若 PaddleOCR 服务可用则附上识别文本
 *
 * 该模块独立成文件，供 abstract-chat-provider（主对话）与
 * openai-compatible-tool-loop（工具结果注入）共用，避免两处判断不一致。
 */

const VISION_MODEL_PATTERNS = [
  "gpt-4o", "gpt-4-turbo", "gpt-4-vision", "gpt-4.1",
  "claude-3", "claude-sonnet", "claude-opus", "claude-haiku",
  "qwen-vl", "qwen2-vl", "qwen2.5-vl", "qvq",
  "glm-4v", "glm-4.6v", "glm-4-plus",
  "moonshot-v1", "kimi",
  "gemini", "llava", "internvl",
  "deepseek-vl", "deepseek-vl2",
];

/** 检测模型是否支持视觉（多模态图片输入）。
 *  deepseek-chat / deepseek-reasoner / gpt-3.5 等纯文本模型不支持，
 *  注入 image_url 会导致 API 报错。 */
export function modelSupportsVision(model: string): boolean {
  const m = model.toLowerCase();
  return VISION_MODEL_PATTERNS.some((p) => m.includes(p));
}

async function callPaddleOcr(
  imageBase64: string,
  mimeType: string,
): Promise<{
  ok: boolean;
  lines?: Array<{ text: string; confidence: number; box: number[][] }>;
  width?: number;
  height?: number;
}> {
  const port = process.env.PADDLE_OCR_PORT?.trim() || "8765";
  const url = `http://127.0.0.1:${port}/ocr`;
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imageBase64, mimeType, mergeLines: true }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) return { ok: false };
    const data = (await resp.json()) as {
      ok: boolean;
      text?: string;
      lines?: Array<{ text: string; confidence: number; box: number[][] }>;
      width?: number;
      height?: number;
      error?: string;
    };
    if (!data.ok || !data.lines?.length) return { ok: false };
    return { ok: true, lines: data.lines, width: data.width, height: data.height };
  } catch {
    return { ok: false };
  }
}

/** 非视觉模型的图片替代：识别图片中的文本，返回通用文本描述（不含桌面点击坐标）。
 *  适用于用户上传的截图/文档/聊天记录等含文字图片。失败（无 OCR 服务/无文本）返回 null。 */
export async function ocrImageText(imageBase64: string, mimeType: string): Promise<string | null> {
  const res = await callPaddleOcr(imageBase64, mimeType);
  if (!res.ok || !res.lines?.length) return null;
  const sizeNote = res.width && res.height ? `（${res.width}x${res.height}）` : "";
  const lines = res.lines.map((ln, i) => `${i + 1}. "${ln.text}"`);
  return `图片 OCR 识别文本${sizeNote}，共 ${res.lines.length} 条：\n${lines.join("\n")}`;
}

/** 调用 PaddleOCR 服务识别截图中的文本和位置（desktop.visual 专用，含点击坐标）。 */
export async function ocrScreenshot(imageBase64: string, mimeType: string): Promise<string | null> {
  const res = await callPaddleOcr(imageBase64, mimeType);
  if (!res.ok || !res.lines?.length) return null;
  const sizeNote = res.width && res.height ? `（${res.width}x${res.height}）` : "";
  const lines = res.lines.map((ln, i) => {
    const box = ln.box || [];
    if (box.length >= 2) {
      const xs = box.map((p) => p[0]);
      const ys = box.map((p) => p[1]);
      const cx = Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
      const cy = Math.round(ys.reduce((a, b) => a + b, 0) / ys.length);
      return `${i + 1}. "${ln.text}" → 点击坐标 (${cx}, ${cy}) [置信度: ${ln.confidence}]`;
    }
    return `${i + 1}. "${ln.text}" [置信度: ${ln.confidence}]`;
  });
  return `屏幕 OCR 识别结果${sizeNote}，共 ${res.lines.length} 个文本元素，坐标可用于 desktop.run_input 点击:\n${lines.join("\n")}`;
}
