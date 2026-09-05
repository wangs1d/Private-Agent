/**
 * 图片生成服务:Provider 抽象 + OpenAI 兼容实现(fetch,零额外依赖)。
 *
 * 兼容 OpenAI Images API 的服务均可接入(自建网关、DashScope 兼容模式等),
 * API Key / Base URL 缺省时回退到环境变量 OPENAI_API_KEY / OPENAI_BASE_URL。
 * 生成的图片统一落盘(自动转 webp 或保留 png),返回本地路径供图库入库。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

export interface ImageGenerationRequest {
  prompt: string;
  model?: string;
  /** 如 "1024x1024"、"1792x1024" */
  size?: string;
  /** OpenAI: "standard" | "hd"(dall-e-3)或 "low"|"medium"|"high"|"auto"(gpt-image-1) */
  quality?: string;
  /** "vivid" | "natural"(dall-e-3) */
  style?: string;
  /** 生成张数,1-4 */
  n?: number;
  /** 保存目录,默认 .generated */
  outputDir?: string;
  /** 输出文件名前缀 */
  fileNamePrefix?: string;
  /** 是否转存为 webp(默认 true,减小体积;false 保留原始 png) */
  toWebp?: boolean;
}

export interface GeneratedImage {
  outputPath: string;
  width: number;
  height: number;
  format: string;
  fileSize: number;
  /** 生成服务返回的修订版提示词(部分模型会返回) */
  revisedPrompt?: string | null;
}

export interface ImageProviderGenerateOptions {
  prompt: string;
  model?: string;
  size?: string;
  quality?: string;
  style?: string;
  n?: number;
}

export interface ImageProvider {
  readonly id: string;
  generateImage(options: ImageProviderGenerateOptions): Promise<Array<{ data: Buffer; revisedPrompt?: string | null }>>;
}

interface OpenAIImageApiResponse {
  data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }>;
  error?: { message?: string };
}

export class OpenAIImageProvider implements ImageProvider {
  readonly id = 'openai';

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly defaultModel: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: { apiKey?: string; baseUrl?: string; model?: string; fetchImpl?: typeof fetch } = {}) {
    this.apiKey = options.apiKey ?? process.env.OPENAI_API_KEY ?? '';
    this.baseUrl = (options.baseUrl ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.defaultModel = options.model ?? 'gpt-image-1';
    if (!this.apiKey) {
      throw new Error('缺少图片生成 API Key,请传入或设置 OPENAI_API_KEY');
    }
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async generateImage(options: ImageProviderGenerateOptions): Promise<Array<{ data: Buffer; revisedPrompt?: string | null }>> {
    const model = options.model ?? this.defaultModel;
    const body: Record<string, unknown> = {
      model,
      prompt: options.prompt,
      n: options.n ?? 1,
      size: options.size ?? '1024x1024',
    };
    if (options.quality) {
      body.quality = options.quality;
    }
    if (options.style) {
      body.style = options.style;
    }
    // dall-e 系列需显式要求返回 b64;gpt-image-1 固定返回 b64
    if (model.startsWith('dall-e')) {
      body.response_format = 'b64_json';
    }

    const response = await this.fetchImpl(`${this.baseUrl}/images/generations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    const payload = (await response.json()) as OpenAIImageApiResponse;
    if (!response.ok || payload.error) {
      throw new Error(`图片生成失败(${response.status}): ${payload.error?.message ?? response.statusText}`);
    }
    const items = payload.data ?? [];
    if (items.length === 0) {
      throw new Error('图片生成返回为空');
    }
    const results: Array<{ data: Buffer; revisedPrompt?: string | null }> = [];
    for (const item of items) {
      if (item.b64_json) {
        results.push({ data: Buffer.from(item.b64_json, 'base64'), revisedPrompt: item.revised_prompt ?? null });
      } else if (item.url) {
        const imageResponse = await this.fetchImpl(item.url);
        if (!imageResponse.ok) {
          throw new Error(`下载生成图片失败(${imageResponse.status})`);
        }
        results.push({ data: Buffer.from(await imageResponse.arrayBuffer()), revisedPrompt: item.revised_prompt ?? null });
      } else {
        throw new Error('图片生成返回缺少 b64_json 与 url');
      }
    }
    return results;
  }
}

export class ImageGenerationService {
  private readonly providers = new Map<string, ImageProvider>();
  private defaultProviderId: string | null = null;

  registerProvider(provider: ImageProvider, isDefault = false): void {
    this.providers.set(provider.id, provider);
    if (isDefault || !this.defaultProviderId) {
      this.defaultProviderId = provider.id;
    }
  }

  hasProvider(id?: string): boolean {
    return this.providers.has(id ?? this.defaultProviderId ?? '');
  }

  getProvider(id?: string): ImageProvider {
    const target = id ?? this.defaultProviderId;
    if (!target || !this.providers.has(target)) {
      throw new Error(`图片生成 Provider 不可用: ${target ?? '(未注册)'}`);
    }
    return this.providers.get(target)!;
  }

  /** 生成图片并落盘,返回本地文件信息列表 */
  async generate(request: ImageGenerationRequest): Promise<GeneratedImage[]> {
    const provider = this.getProvider();
    const outputDir = request.outputDir ?? '.generated';
    await fs.mkdir(outputDir, { recursive: true });
    const prefix = request.fileNamePrefix ?? `gen_${Date.now()}`;
    const outputs = await provider.generateImage({
      prompt: request.prompt,
      model: request.model,
      size: request.size,
      quality: request.quality,
      style: request.style,
      n: request.n,
    });
    const results: GeneratedImage[] = [];
    for (const [index, output] of outputs.entries()) {
      const targetPath = path.join(outputDir, `${prefix}_${index}.webp`);
      let pipeline = sharp(output.data);
      if (request.toWebp !== false) {
        pipeline = pipeline.webp({ quality: 90 });
      } else {
        pipeline = pipeline.png();
      }
      const info = await pipeline.toFile(targetPath);
      results.push({
        outputPath: targetPath,
        width: info.width,
        height: info.height,
        format: info.format ?? 'webp',
        fileSize: info.size,
        revisedPrompt: output.revisedPrompt ?? null,
      });
    }
    return results;
  }
}
