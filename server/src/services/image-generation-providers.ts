/**
 * 图像生成 provider 抽象 + 具体实现。
 *
 * 与 TTS / ASR 体系同模式：抽象接口 + 多个 provider，按优先级链路回退。
 * 当前实现：
 *   - {@link OpenAICompatibleImageProvider}：OpenAI 兼容 images/generations 端点
 *     （key 复用对话 OPENAI_API_KEY；端点不支持 images 接口时优雅报错）
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
 * OpenAI 兼容 image generation provider。
 *
 * 端点：`POST {baseUrl}/images/generations`，鉴权 `Authorization: Bearer ${apiKey}`。
 * key 复用对话渠道（OPENAI_API_KEY）；端点可经 IMAGE_GEN_BASE_URL 覆盖，
 * 模型可经 IMAGE_GEN_MODEL 覆盖（默认 dall-e-3）。
 */
export class OpenAICompatibleImageProvider implements ImageGenerationProvider {
  readonly name = "openai-compatible";
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor() {
    this.apiKey = process.env.OPENAI_API_KEY ?? "";
    this.baseUrl = (
      process.env.IMAGE_GEN_BASE_URL?.trim() ||
      process.env.OPENAI_BASE_URL?.trim() ||
      "https://api.openai.com/v1"
    ).replace(/\/+$/, "");
  }

  isEnabled(): boolean {
    return this.apiKey.length > 0;
  }

  async generate(req: ImageGenerateRequest): Promise<ImageGenerationResult> {
    if (!this.isEnabled()) {
      throw new Error("OPENAI_API_KEY 未配置");
    }
    const model = req.model ?? process.env.IMAGE_GEN_MODEL?.trim() ?? "dall-e-3";
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
        size: imageSize,
        n: batchSize,
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`图像生成失败：HTTP ${res.status} ${txt.slice(0, 200)}`);
    }

    const data = (await res.json()) as {
      data?: Array<{ url?: string; revised_prompt?: string }>;
      images?: Array<{ url?: string; revised_prompt?: string }>;
    };
    // 兼容两种返回格式（OpenAI 标准 data[] / 部分聚合云 images[]）
    const images = (data.data ?? data.images ?? []).map((img) => ({
      url: img.url ?? "",
      revisedPrompt: img.revised_prompt,
    })).filter((img) => img.url.length > 0);

    if (images.length === 0) {
      throw new Error("图像生成返回空图片列表");
    }

    return { model, images };
  }
}
