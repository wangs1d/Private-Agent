/**
 * 批图能力:引擎抽象 + sharp 实现 + 服务层。
 * 移植自 photography_agent.batch(engine/service),场景预设与
 * 预设/习惯 0.7:0.3 融合权重保持一致,引擎换成 sharp。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { computeImageStats } from '../analysis/color.js';
import type { BatchPreset, ImageStats } from '../models.js';
import { applyBeauty, BEAUTY_KEYS, BEAUTY_STYLES } from './beauty.js';
import type { BeautyAdjustments, BeautyStyle } from './beauty.js';
import { ImageProcessingService } from './service.js';
import type { ImageAdjustments } from './service.js';

export type BatchAdjustments = Record<string, number | string>;

/** 传统影调键(走 sharp 全局管线) */
const TONE_KEYS = new Set(['brightness', 'contrast', 'saturation', 'sharpness', 'temperature']);
/** 美颜专属键(出现任一即走美颜管线) */
const BEAUTY_ONLY_KEYS = new Set<string>(BEAUTY_KEYS.filter((key) => key !== 'contrast' && key !== 'saturation'));
/** 引擎可消费的全部数值键 */
const NUMERIC_KEYS = new Set<string>([...TONE_KEYS, ...BEAUTY_KEYS]);

export interface BeautyStyleOption extends BeautyStyle {
  id: string;
}

/** 列出可用美颜风格(供工具/接口层展示) */
export function listBeautyStyles(): BeautyStyleOption[] {
  return Object.entries(BEAUTY_STYLES).map(([id, style]) => ({ id, ...style }));
}

/** 批图引擎抽象,支持运行时替换 */
export interface BatchEngine {
  apply(input: string, adjustments: BatchAdjustments, outputPath?: string): Promise<string>;
  applyBatch(inputs: string[], adjustments: BatchAdjustments, outputDir?: string): Promise<string[]>;
}

/** 基于 sharp 的批图引擎,仅消费数值型调整参数 */
export class SharpBatchEngine implements BatchEngine {
  private readonly processing: ImageProcessingService;

  constructor(processing?: ImageProcessingService) {
    this.processing = processing ?? new ImageProcessingService();
  }

  async apply(input: string, adjustments: BatchAdjustments, outputPath?: string): Promise<string> {
    const target = outputPath ?? path.join(path.dirname(input), `processed_${path.basename(input, path.extname(input))}.webp`);
    const numeric: Record<string, number> = {};
    for (const [key, value] of Object.entries(adjustments)) {
      if (NUMERIC_KEYS.has(key) && typeof value === 'number') {
        numeric[key] = value;
      }
    }
    const hasBeautyOps = Object.keys(numeric).some((key) => BEAUTY_ONLY_KEYS.has(key));
    if (hasBeautyOps) {
      // 美颜管线:传统键并入(exposure←brightness / warmth←temperature)
      const beauty: BeautyAdjustments = {
        exposure: numeric['exposure'] ?? numeric['brightness'],
        contrast: numeric['contrast'],
        saturation: numeric['saturation'],
        warmth: numeric['warmth'] ?? numeric['temperature'],
        vibrance: numeric['vibrance'],
        clarity: numeric['clarity'],
        skinSmooth: numeric['skinSmooth'],
        skinBrighten: numeric['skinBrighten'],
        whiten: numeric['whiten'],
        rosy: numeric['rosy'],
        fade: numeric['fade'],
      };
      await applyBeauty(input, beauty, target);
    } else {
      await this.processing.adjust(input, numeric as ImageAdjustments, target);
    }
    return target;
  }

  async applyBatch(inputs: string[], adjustments: BatchAdjustments, outputDir?: string): Promise<string[]> {
    const outputs: string[] = [];
    for (const input of inputs) {
      const target = outputDir
        ? path.join(outputDir, `processed_${path.basename(input, path.extname(input))}.webp`)
        : undefined;
      outputs.push(await this.apply(input, adjustments, target));
    }
    return outputs;
  }
}

/** 内置场景 → 调整参数映射(移植自 Python 版 SCENE_PRESETS) */
export const SCENE_PRESETS: Record<string, Record<string, number>> = {
  outdoor_portrait: { brightness: 5, contrast: 10, saturation: 5, temperature: 3 },
  half_body_portrait: { brightness: 3, contrast: 8, saturation: 5, temperature: 0 },
  landscape: { brightness: 5, contrast: 15, saturation: 20, temperature: -3 },
  street: { contrast: 12, saturation: -5, temperature: -2 },
  night: { brightness: 8, contrast: 10, saturation: 10, temperature: -5, sharpness: 10 },
  // 人像美颜场景:走美颜管线(参数面向女性用户高频自拍/人像场景)
  beauty_portrait: { skinSmooth: 55, skinBrighten: 22, whiten: 14, rosy: 18, vibrance: 10, clarity: 8 },
  selfie: { skinSmooth: 60, skinBrighten: 26, whiten: 20, rosy: 14, fade: 4 },
  default: { brightness: 0, contrast: 5, saturation: 0 },
};

const PRESET_WEIGHT = 0.7;
const HABIT_WEIGHT = 0.3;

export interface ProcessPhotosResult {
  outputPaths: string[];
  appliedAdjustments: Record<string, number>;
  count: number;
  sceneType?: string | null;
}

export interface BeforeAfterStats extends ImageStats {
  path: string;
  width: number;
  height: number;
}

export interface BeforeAfterComparison {
  original: BeforeAfterStats;
  processed: BeforeAfterStats;
  brightnessDiff: number;
  colorDiff: [number, number, number];
}

export class BatchService {
  private engine: BatchEngine;
  readonly outputDir: string;
  private readonly batchPresets = new Map<string, BatchPreset>();

  constructor(engine?: BatchEngine, outputDir = '.batch_output') {
    this.engine = engine ?? new SharpBatchEngine();
    this.outputDir = outputDir;
  }

  setEngine(engine: BatchEngine): void {
    this.engine = engine;
  }

  getEngine(): BatchEngine {
    return this.engine;
  }

  private async ensureOutputDir(): Promise<void> {
    await fs.mkdir(this.outputDir, { recursive: true });
  }

  /** 根据场景类型匹配预设,可选与用户习惯按 0.7:0.3 加权融合 */
  matchPreset(sceneType?: string | null, userHabit?: { batchStyleAvg?: Record<string, number> } | null): Record<string, number> {
    const preset = sceneType
      ? { ...SCENE_PRESETS[sceneType] ?? SCENE_PRESETS.default! }
      : { ...SCENE_PRESETS.default! };
    if (userHabit && userHabit.batchStyleAvg) {
      return BatchService.blend(preset, userHabit.batchStyleAvg);
    }
    return preset;
  }

  /** 预设与习惯按 0.7:0.3 加权融合,仅一边存在的键直接保留 */
  static blend(preset: Record<string, number>, habit: Record<string, number>): Record<string, number> {
    const result: Record<string, number> = {};
    for (const key of new Set([...Object.keys(preset), ...Object.keys(habit)])) {
      const inPreset = preset[key];
      const inHabit = habit[key];
      if (inPreset !== undefined && inHabit !== undefined) {
        result[key] = Math.round(inPreset * PRESET_WEIGHT + inHabit * HABIT_WEIGHT);
      } else if (inPreset !== undefined) {
        result[key] = inPreset;
      } else {
        result[key] = inHabit!;
      }
    }
    return result;
  }

  async processPhotos(options: {
    photoPaths: string[];
    sceneType?: string | null;
    /** 美颜风格 id(BEAUTY_STYLES 的键),与 adjustments 可叠加 */
    style?: string | null;
    adjustments?: Record<string, number>;
    userHabit?: { batchStyleAvg?: Record<string, number> } | null;
  }): Promise<ProcessPhotosResult> {
    await this.ensureOutputDir();
    const { photoPaths, sceneType, style } = options;
    let applied: Record<string, number>;
    let effectiveScene: string | null | undefined;
    if (options.adjustments || style) {
      applied = {
        ...(style ? BEAUTY_STYLES[style]?.adjustments ?? {} : {}),
        ...options.adjustments,
      };
      effectiveScene = sceneType ?? style;
    } else {
      applied = this.matchPreset(sceneType, options.userHabit);
      effectiveScene = sceneType ?? 'default';
    }
    const outputPaths = await this.engine.applyBatch(photoPaths, applied, this.outputDir);
    return {
      outputPaths,
      appliedAdjustments: applied,
      count: outputPaths.length,
      sceneType: effectiveScene,
    };
  }

  async processSingle(photoPath: string, adjustments: Record<string, number>): Promise<string> {
    return this.engine.apply(photoPath, adjustments);
  }

  static async imageStats(imagePath: string): Promise<BeforeAfterStats> {
    // 先读入 Buffer 再交给 sharp,避免 Windows 上路径读取的句柄滞留
    const buffer = await fs.readFile(imagePath);
    const metadata = await sharp(buffer).metadata();
    const imageStats = await computeImageStats(buffer);
    return {
      path: imagePath,
      width: metadata.width ?? 0,
      height: metadata.height ?? 0,
      ...imageStats,
    };
  }

  /** 前后对比:宽高、平均亮度、平均颜色及差异 */
  async compareBeforeAfter(originalPath: string, processedPath: string): Promise<BeforeAfterComparison> {
    const [original, processed] = await Promise.all([
      BatchService.imageStats(originalPath),
      BatchService.imageStats(processedPath),
    ]);
    return {
      original,
      processed,
      brightnessDiff: processed.avgBrightness - original.avgBrightness,
      colorDiff: [
        processed.avgColor[0] - original.avgColor[0],
        processed.avgColor[1] - original.avgColor[1],
        processed.avgColor[2] - original.avgColor[2],
      ],
    };
  }

  /** 一步处理并对比 */
  async processAndCompare(photoPath: string, adjustments: Record<string, number>): Promise<{
    originalPath: string;
    processedPath: string;
    adjustments: Record<string, number>;
    comparison: BeforeAfterComparison;
  }> {
    const processedPath = await this.processSingle(photoPath, adjustments);
    const comparison = await this.compareBeforeAfter(photoPath, processedPath);
    return { originalPath: photoPath, processedPath, adjustments, comparison };
  }

  /** 在基础预设上叠加微调(overrides 覆盖同名键) */
  async fineTune(photoPath: string, baseAdjustments: Record<string, number>, overrides: Record<string, number>): Promise<string> {
    return this.processSingle(photoPath, { ...baseAdjustments, ...overrides });
  }

  /** 重新应用批图预设(可选微调) */
  async reapplyPreset(photoPath: string, presetId: string, overrides?: Record<string, number>): Promise<string> {
    const preset = this.batchPresets.get(presetId);
    if (!preset) {
      throw new Error(`批图预设不存在: ${presetId}`);
    }
    const adjustments = { ...preset.adjustments, ...overrides };
    return this.processSingle(photoPath, adjustments);
  }

  createBatchPreset(
    name: string,
    sceneType: string,
    adjustments: Record<string, number>,
    tags: string[] = [],
  ): BatchPreset {
    const preset: BatchPreset = {
      id: crypto.randomUUID().replaceAll('-', ''),
      name,
      sceneType,
      adjustments: { ...adjustments },
      tags: [...tags],
    };
    this.batchPresets.set(preset.id, preset);
    return preset;
  }

  updateBatchPreset(
    presetId: string,
    patch: { name?: string; adjustments?: Record<string, number>; tags?: string[] } = {},
  ): BatchPreset {
    const preset = this.batchPresets.get(presetId);
    if (!preset) {
      throw new Error(`批图预设不存在: ${presetId}`);
    }
    if (patch.name !== undefined) {
      preset.name = patch.name;
    }
    if (patch.adjustments !== undefined) {
      preset.adjustments = { ...patch.adjustments };
    }
    if (patch.tags !== undefined) {
      preset.tags = [...patch.tags];
    }
    return preset;
  }

  deleteBatchPreset(presetId: string): boolean {
    if (!this.batchPresets.has(presetId)) {
      throw new Error(`批图预设不存在: ${presetId}`);
    }
    this.batchPresets.delete(presetId);
    return true;
  }

  getBatchPreset(presetId: string): BatchPreset | null {
    return this.batchPresets.get(presetId) ?? null;
  }

  listBatchPresets(sceneType?: string): BatchPreset[] {
    const all = [...this.batchPresets.values()];
    if (!sceneType) {
      return all;
    }
    return all.filter((preset) => preset.sceneType === sceneType);
  }
}
