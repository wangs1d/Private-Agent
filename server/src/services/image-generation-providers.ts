/**
 * 图像生成 provider 抽象 + 具体实现。
 *
 * 与 TTS / ASR 体系同模式：抽象接口 + 多个 provider，按优先级链路回退。
 * 当前实现：
 *   - {@link SiliconFlowImageProvider}：硅基流动 Kwai-Kolors / FLUX.1-schnell（默认）
 *   - 后续可补 OpenAI DALL-E 3 / Stability AI 等
 */

export interface ImageGenerateRequest {
  prompt: string;
  model?: string;
  imageSize?: string;
  batchSize?: number;
}

export interface ImageGenerationResult {
  model: string;
  images: Array<{
    url: string;
    revisedPrompt?: string;
    seed?: number;
  }>;
}

export interface ImageGenerationProvider {
  readonly name: string;
  isEnabled(): boolean;
  generate(req: ImageGenerateRequest): Promise<ImageGenerationResult>;
}

/**
 * 硅基流动 image generation provider。
 *
 * 端点：`POST {SILICONFLOW_BASE_URL}/images/generations`
 * 鉴权：`Authorization: Bearer ${SILICONFLOW_API_KEY}`
 *
 * 模型推荐：
 *   - `Kwai-Kolors/Kolors`（默认，中文友好）
 *   - `black-forest-labs/FLUX.1-schnell`（速度快，2 步出图）
 *   - `stabilityai/stable-diffusion-3-5-large`（高质量）
 *
 * 注意硅基流动的 image_size 接受 `1024x1024` / `768x1024` / `1024x768` / `512x512` 等。
 */
export class SiliconFlowImageProvider implements ImageGenerationProvider {
  readonly name = "siliconflow";
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor() {
    this.apiKey = process.env.SILICONFLOW_API_KEY ?? "";
    this.baseUrl = process.env.SILICONFLOW_BASE_URL ?? "https://api.siliconflow.cn/v1";
  }

  isEnabled(): boolean {
    return this.apiKey.length > 0;
  }

  async generate(req: ImageGenerateRequest): Promise<ImageGenerationResult> {
    if (!this.isEnabled()) {
      throw new Error("SILICONFLOW_API_KEY 未配置");
    }
    const model = req.model ?? "Kwai-Kolors/Kolors";
    const imageSize = req.imageSize ?? "1024x1024";
    const batchSize = Math.max(1, Math.min(4, req.batchSize ?? 1));

    const res = await fetch(`${this.baseUrl}/images/generations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model,
        prompt: req.prompt,
        image_size: imageSize,
        batch_size: batchSize,
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`硅基流动图像生成失败：HTTP ${res.status} ${txt.slice(0, 200)}`);
    }

    const data = (await res.json()) as {
      images?: Array<{ url?: string; revised_prompt?: string }>;
      data?: Array<{ url?: string; revised_prompt?: string }>;
    };
    // 兼容两种返回格式
    const images = (data.images ?? data.data ?? []).map((img) => ({
      url: img.url ?? "",
      revisedPrompt: img.revised_prompt,
    })).filter((img) => img.url.length > 0);

    if (images.length === 0) {
      throw new Error("硅基流动返回空图片列表");
    }

    return { model, images };
  }
}

/**
 * 预留：OpenAI DALL-E 3 provider（后续补）。
 * 端点：`POST https://api.openai.com/v1/images/generations`
 */
// export class OpenAIImageProvider implements ImageGenerationProvider { ... }
