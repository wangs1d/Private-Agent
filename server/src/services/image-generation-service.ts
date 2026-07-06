import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";

import type { ImageGenerationProvider, ImageGenerationResult } from "./image-generation-providers.js";
import { SiliconFlowImageProvider } from "./image-generation-providers.js";

/**
 * 图像生成服务：调用 LLM 提供商（硅基流动 / OpenAI DALL-E）的 text-to-image 接口
 * 生成图片，下载到本地 `data/images/{actorId}/{imageId}.png` 后返回可访问 URL。
 *
 * 设计要点：
 *   - 与社交动态 / 语音消息独立目录，便于按能力域管理
 *   - 提供商走优先级链路：硅基流动（中文友好）→ OpenAI DALL-E（兜底）
 *   - 图片下载到本地，避免上游链接 24h 过期问题
 *   - HTTP 拉流走 `/agent/images/:actorId/:fileName`（与 voice-messages 同模式）
 */
export class ImageGenerationService {
  private readonly storageRoot: string;
  private readonly providers: ImageGenerationProvider[] = [];

  constructor(opts: {
    storageRoot?: string;
    providers?: ImageGenerationProvider[];
  } = {}) {
    this.storageRoot = opts.storageRoot ?? join(process.cwd(), "data", "images");
    // 默认装载硅基流动 provider（如未配置 key 则跳过）
    const siliconflow = new SiliconFlowImageProvider();
    if (siliconflow.isEnabled()) this.providers.push(siliconflow);
    // 允许外部注入额外 provider（如 OpenAI DALL-E）
    if (opts.providers) this.providers.push(...opts.providers);
  }

  isEnabled(): boolean {
    return this.providers.length > 0;
  }

  /**
   * 合成图片并落盘。
   *
   * @returns 成功返回 `{ ok, imageUrl, model, seed? }`；
   *          失败返回 `{ ok: false, error }`。
   */
  async generate(
    prompt: string,
    actorId: string,
    options: {
      model?: string;
      imageSize?: string;
      batchSize?: number;
    } = {},
  ): Promise<{ ok: true; imageUrl: string; model: string; seed?: number; revisedPrompt?: string } | { ok: false; error: string }> {
    if (!this.isEnabled()) {
      return { ok: false, error: "图像生成未配置：请在服务端设置 SILICONFLOW_API_KEY 或 OPENAI_API_KEY" };
    }
    if (!prompt.trim()) {
      return { ok: false, error: "prompt 不能为空" };
    }

    // 按优先级尝试 provider
    let lastError = "所有图像生成 provider 都失败";
    for (const provider of this.providers) {
      try {
        const result: ImageGenerationResult = await provider.generate({
          prompt,
          model: options.model,
          imageSize: options.imageSize,
          batchSize: options.batchSize ?? 1,
        });
        // 下载第一张图到本地
        const localUrl = await this.downloadAndStore(result.images[0].url, actorId);
        return {
          ok: true,
          imageUrl: localUrl,
          model: result.model,
          seed: result.images[0].seed,
          revisedPrompt: result.images[0].revisedPrompt,
        };
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        console.warn(`[ImageGenerationService] provider ${provider.name} failed: ${lastError}`);
        // 继续尝试下一个 provider
      }
    }
    return { ok: false, error: lastError };
  }

  /** 把远程图片下载到本地，返回可访问的相对路径。 */
  private async downloadAndStore(remoteUrl: string, actorId: string): Promise<string> {
    // actorId 限制为 [a-zA-Z0-9_-]，避免路径穿越
    const safeActorId = actorId.replace(/[^a-zA-Z0-9_-]/g, "_") || "anonymous";
    const dir = join(this.storageRoot, safeActorId);
    await mkdir(dir, { recursive: true });

    const imageId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
    const fileName = `${imageId}.png`;
    const fullPath = join(dir, fileName);

    // 拉远程图（硅基流动 / OpenAI 都返回公网 URL），30s 超时防止挂起
    const res = await fetch(remoteUrl, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) {
      throw new Error(`下载图像失败：HTTP ${res.status} ${res.statusText}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    await writeFile(fullPath, buf);

    // 返回相对路径，供客户端拼接 base URL 拉流
    return `/agent/images/${safeActorId}/${fileName}`;
  }

  /** 静态拉流时校验路径并返回绝对路径；不通过返回 null。 */
  resolveFilePath(actorId: string, fileName: string): string | null {
    const safeActorId = actorId.replace(/[^a-zA-Z0-9_-]/g, "_") || "anonymous";
    // 文件名严格校验：时间戳-uuid8.png
    if (!/^\d+-[a-f0-9]{8}\.png$/.test(fileName)) return null;
    const full = join(this.storageRoot, safeActorId, fileName);
    // 路径穿越防护
    const normalized = full.normalize();
    const baseDir = join(this.storageRoot, safeActorId).normalize();
    if (!normalized.startsWith(baseDir)) return null;
    return full;
  }

  /** 静态拉流时检查文件是否存在。 */
  async fileExists(path: string): Promise<boolean> {
    try {
      const s = await stat(path);
      return s.isFile();
    } catch {
      return false;
    }
  }

  /** 提供给 HTTP 路由用：返回 readable stream。 */
  createReadStream(path: string) {
    return createReadStream(path);
  }
}
