/**
 * PictureKit:统一门面与装配入口(对齐 picture 项目的 create_agent)。
 * 调用 createPictureKit 即可获得配置好全部服务与工具的实例。
 */
import { ImageAnalysisService } from './analysis/service.js';
import { ImageGenerationService, OpenAIImageProvider } from './generation/service.js';
import type { ImageProvider } from './generation/service.js';
import { BatchService, SharpBatchEngine } from './processing/batch.js';
import { ImageProcessingService } from './processing/service.js';
import { AgentInterface } from './registry.js';
import { HabitService } from './photography/habit.js';
import { GuidanceService } from './photography/guidance.js';
import { GalleryService } from './photography/gallery.js';
import { PresetService } from './photography/presets.js';
import { EvaluationService } from './photography/evaluation.js';
import { ImageStore } from './storage/manager.js';
import { ThumbnailService } from './thumbnails/service.js';
import { registerPictureTools } from './tools.js';
import path from 'node:path';

export interface PictureKitOptions {
  /** 存储根目录(assets/thumbs/index.json),默认 .picture_data */
  rootDir?: string;
  /** 批图输出目录,默认 .batch_output */
  batchOutputDir?: string;
  /** 生成图输出目录,默认 <rootDir>/generated */
  generatedDir?: string;
  generation?: {
    provider?: ImageProvider;
    apiKey?: string;
    baseUrl?: string;
    model?: string;
  };
}

export interface PictureKit {
  readonly options: Required<Omit<PictureKitOptions, 'generation'>>;
  readonly store: ImageStore;
  readonly analysis: ImageAnalysisService;
  readonly processing: ImageProcessingService;
  readonly thumbnails: ThumbnailService;
  readonly generation: ImageGenerationService;
  readonly gallery: GalleryService;
  readonly presets: PresetService;
  readonly guidance: GuidanceService;
  readonly batch: BatchService;
  readonly habit: HabitService;
  readonly evaluation: EvaluationService;
  readonly registry: AgentInterface;
  listTools(): ReturnType<AgentInterface['listTools']>;
  invoke(...args: Parameters<AgentInterface['invoke']>): ReturnType<AgentInterface['invoke']>;
  invokeRaw(...args: Parameters<AgentInterface['invokeRaw']>): ReturnType<AgentInterface['invokeRaw']>;
}

export async function createPictureKit(options: PictureKitOptions = {}): Promise<PictureKit> {
  const rootDir = options.rootDir ?? '.picture_data';
  const generatedDir = options.generatedDir ?? path.join(rootDir, 'generated');

  const store = new ImageStore({ rootDir });
  await store.init();

  const analysis = new ImageAnalysisService();
  const processing = new ImageProcessingService();
  const batch = new BatchService(new SharpBatchEngine(processing), options.batchOutputDir ?? '.batch_output');
  const generation = new ImageGenerationService();

  if (options.generation?.provider) {
    generation.registerProvider(options.generation.provider, true);
  } else if (options.generation?.apiKey || process.env.OPENAI_API_KEY) {
    generation.registerProvider(new OpenAIImageProvider({
      apiKey: options.generation?.apiKey,
      baseUrl: options.generation?.baseUrl,
      model: options.generation?.model,
    }), true);
  }

  const registry = new AgentInterface();
  const kit: PictureKit = {
    options: { rootDir, batchOutputDir: options.batchOutputDir ?? '.batch_output', generatedDir },
    store,
    analysis,
    processing,
    thumbnails: store.thumbnails,
    generation,
    gallery: new GalleryService(store),
    presets: new PresetService(),
    guidance: new GuidanceService(),
    batch,
    habit: new HabitService(),
    evaluation: new EvaluationService(),
    registry,
    listTools: () => registry.listTools(),
    invoke: (request) => registry.invoke(request),
    invokeRaw: (toolName, args) => registry.invokeRaw(toolName, args),
  };

  // 工具 handler 内部通过闭包引用 kit,注册时 kit 已构造完成
  registerPictureTools(registry, { kit, generation, generatedDir });

  return kit;
}
