import type { VisionFrame, VisionSourceKind } from "../external-model/types.js";

const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

function envInt(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export type VisionWireInput = {
  sourceKind: VisionSourceKind;
  sourceId?: string;
  mimeType: string;
  dataBase64: string;
  capturedAt?: string;
};

/**
 * 校验 WebSocket 传入的视觉帧：MIME、数量、解码后体积。
 * @throws Error 带可读 message，供 HTTP/WS 返回 400
 */
export function sanitizeVisionFramesFromWire(frames: VisionWireInput[] | undefined): VisionFrame[] | undefined {
  if (!frames?.length) return undefined;
  const maxFrames = Math.min(16, envInt("AGENT_VISION_MAX_FRAMES", 4));
  const maxBytes = Math.min(12 * 1024 * 1024, envInt("AGENT_VISION_MAX_BYTES_PER_FRAME", 4 * 1024 * 1024));
  if (frames.length > maxFrames) {
    throw new Error(`VISION_TOO_MANY_FRAMES: 最多 ${maxFrames} 帧`);
  }
  const out: VisionFrame[] = [];
  for (const f of frames) {
    const mime = f.mimeType.trim().toLowerCase();
    if (!ALLOWED_MIME.has(mime)) {
      throw new Error(`VISION_UNSUPPORTED_MIME: ${mime}`);
    }
    let buf: Buffer;
    try {
      buf = Buffer.from(f.dataBase64, "base64");
    } catch {
      throw new Error("VISION_INVALID_BASE64");
    }
    if (!buf.length) {
      throw new Error("VISION_EMPTY_IMAGE");
    }
    if (buf.length > maxBytes) {
      throw new Error(`VISION_IMAGE_TOO_LARGE: 单帧超过 ${maxBytes} 字节`);
    }
    out.push({
      sourceKind: f.sourceKind,
      ...(f.sourceId?.trim() ? { sourceId: f.sourceId.trim().slice(0, 160) } : {}),
      mimeType: mime,
      dataBase64: buf.toString("base64"),
      ...(f.capturedAt?.trim() ? { capturedAt: f.capturedAt.trim().slice(0, 64) } : {}),
    });
  }
  return out;
}
