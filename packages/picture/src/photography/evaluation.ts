/**
 * 照片评估服务,移植自 photography_agent.evaluation。
 * 各项评分启发式与 Python 版保持一致:
 * - 曝光:灰度均值(90-170 理想,130 最佳)
 * - 清晰度:边缘响应方差(Python 用 FIND_EDGES,此处用 8 邻域拉普拉斯方差近似)
 * - 构图:宽高比启发式(3:2=90,4:3/16:9=85,方图=75)
 * - 主体:中心区域与边缘区域平均亮度差
 * - 综合:构图30% + 曝光25% + 清晰度25% + 主体20%
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import type { EvaluationResult } from '../models.js';

/** 摄像头帧捕获抽象(并入方可替换为手机/网络摄像头) */
export interface CameraCapture {
  captureFrame(outputPath?: string): Promise<string>;
  release?(): void;
}

/** 无摄像头环境的兜底实现:以指定图片作为"帧" */
export class FileFallbackCapture implements CameraCapture {
  constructor(private readonly frameSource: string) {}

  async captureFrame(outputPath?: string): Promise<string> {
    if (!outputPath) {
      return this.frameSource;
    }
    await fs.copyFile(this.frameSource, outputPath);
    return outputPath;
  }
}

export class EvaluationService {
  private camera: CameraCapture | null;

  constructor(camera: CameraCapture | null = null) {
    this.camera = camera;
  }

  setCamera(camera: CameraCapture): void {
    this.camera = camera;
  }

  getCamera(): CameraCapture | null {
    return this.camera;
  }

  /** 评估单张照片,返回多维度打分与改进建议 */
  async evaluate(photoPath: string, photoId?: string): Promise<EvaluationResult> {
    const { data, info } = await sharp(photoPath)
      .removeAlpha()
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const width = info.width;
    const height = info.height;
    const pixelCount = width * height;

    let totalSum = 0;
    for (let i = 0; i < pixelCount; i += 1) {
      totalSum += data[i]!;
    }
    const meanBrightness = totalSum / pixelCount;

    // 8 邻域拉普拉斯方差(内部像素)
    let lapSum = 0;
    let lapSumSq = 0;
    let lapCount = 0;
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const idx = y * width + x;
        const lap = 8 * data[idx]!
          - data[idx - 1]! - data[idx + 1]!
          - data[idx - width]! - data[idx + width]!
          - data[idx - width - 1]! - data[idx - width + 1]!
          - data[idx + width - 1]! - data[idx + width + 1]!;
        lapSum += lap;
        lapSumSq += lap * lap;
        lapCount += 1;
      }
    }
    const sharpnessVar = lapCount > 0 ? lapSumSq / lapCount - (lapSum / lapCount) ** 2 : 0;

    // 主体:中心 50% 区域与边缘区域的平均亮度差
    const x0 = Math.floor(width / 4);
    const y0 = Math.floor(height / 4);
    const x1 = Math.ceil((width * 3) / 4);
    const y1 = Math.ceil((height * 3) / 4);
    let centerSum = 0;
    let centerCount = 0;
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        centerSum += data[y * width + x]!;
        centerCount += 1;
      }
    }
    const centerMean = centerCount > 0 ? centerSum / centerCount : meanBrightness;
    const borderCount = pixelCount - centerCount;
    const edgeMean = borderCount > 0 ? (totalSum - centerSum) / borderCount : meanBrightness;
    const brightnessDiff = Math.abs(centerMean - edgeMean);

    const exposure = EvaluationService.exposureScore(meanBrightness);
    const sharpness = EvaluationService.sharpnessScore(sharpnessVar);
    const composition = EvaluationService.compositionScore(width, height);
    const subject = EvaluationService.subjectScore(brightnessDiff);
    const overall = Math.round(composition * 0.3 + exposure * 0.25 + sharpness * 0.25 + subject * 0.2);

    return {
      photoId: photoId ?? path.basename(photoPath),
      compositionScore: composition,
      exposureScore: exposure,
      sharpnessScore: sharpness,
      subjectScore: subject,
      overallScore: overall,
      suggestions: EvaluationService.generateSuggestions(composition, exposure, sharpness, subject, meanBrightness),
    };
  }

  /** 批量评估并标记最高分为推荐 */
  async evaluateBatch(photoPaths: string[], photoIds?: Array<string | null>): Promise<{
    results: Array<EvaluationResult & { recommended: boolean }>;
    bestIndex: number;
    averageScore: number;
  }> {
    const ids = photoIds ?? photoPaths.map(() => undefined);
    const results: EvaluationResult[] = [];
    for (const [index, photoPath] of photoPaths.entries()) {
      results.push(await this.evaluate(photoPath, ids[index] ?? undefined));
    }
    const sorted = [...results].sort((a, b) => b.overallScore - a.overallScore);
    const serialized = sorted.map((result, index) => ({ ...result, recommended: index === 0 }));
    const averageScore = results.length > 0
      ? results.reduce((sum, result) => sum + result.overallScore, 0) / results.length
      : 0;
    return { results: serialized, bestIndex: 0, averageScore };
  }

  /** 从评估结果中选最高分,同分取先出现者 */
  static selectBest(results: EvaluationResult[]): { best: EvaluationResult; index: number } {
    if (results.length === 0) {
      throw new Error('评估结果列表不能为空');
    }
    let index = 0;
    for (let i = 1; i < results.length; i += 1) {
      if (results[i]!.overallScore > results[index]!.overallScore) {
        index = i;
      }
    }
    return { best: results[index]!, index };
  }

  static exposureScore(mean: number): number {
    if (mean < 30 || mean > 225) {
      const score = mean < 30
        ? 49 - ((30 - Math.max(mean, 0)) / 30) * 29
        : 49 - ((mean - 225) / 30) * 29;
      return Math.round(Math.max(20, Math.min(49, score)));
    }
    if (mean >= 90 && mean <= 170) {
      const deviation = Math.abs(mean - 130) / 40;
      return Math.round(100 - deviation * 20);
    }
    if (mean < 90) {
      return Math.round(50 + ((mean - 30) / 60) * 30);
    }
    return Math.round(80 - ((mean - 170) / 55) * 30);
  }

  static sharpnessScore(variance: number): number {
    if (variance > 500) {
      return Math.round(Math.min(100, 85 + ((variance - 500) / 500) * 15));
    }
    if (variance >= 200) {
      return Math.round(70 + ((variance - 200) / 300) * 15);
    }
    if (variance >= 50) {
      return Math.round(50 + ((variance - 50) / 150) * 20);
    }
    return Math.round(20 + (variance / 50) * 30);
  }

  static compositionScore(width: number, height: number): number {
    if (width <= 0 || height <= 0) {
      return 70;
    }
    const ratio = width / height;
    const r = Math.max(ratio, 1 / ratio);
    if (Math.abs(r - 1.5) <= 0.1) {
      return 90;
    }
    if (Math.abs(r - 1.33) <= 0.1 || Math.abs(r - 1.78) <= 0.1) {
      return 85;
    }
    if (Math.abs(r - 1.0) <= 0.05) {
      return 75;
    }
    return 70;
  }

  static subjectScore(brightnessDiff: number): number {
    if (brightnessDiff > 30) {
      return Math.round(Math.min(100, 80 + ((brightnessDiff - 30) / 70) * 20));
    }
    if (brightnessDiff >= 10) {
      return Math.round(60 + ((brightnessDiff - 10) / 20) * 20);
    }
    return Math.round(40 + (brightnessDiff / 10) * 20);
  }

  static generateSuggestions(
    composition: number,
    exposure: number,
    sharpness: number,
    subject: number,
    meanBrightness: number,
  ): string[] {
    const suggestions: string[] = [];
    if (exposure < 60) {
      if (meanBrightness < 90) {
        suggestions.push('画面偏暗,建议增加曝光补偿或使用大光圈');
      } else if (meanBrightness > 170) {
        suggestions.push('画面偏亮,建议减少曝光补偿或缩小光圈');
      }
    }
    if (sharpness < 60) {
      suggestions.push('画面不够清晰,建议使用更高快门速度或三脚架');
    }
    if (composition < 75) {
      suggestions.push('构图可优化,尝试三分法构图,将主体置于交叉点');
    }
    if (subject < 60) {
      suggestions.push('主体不够突出,尝试靠近主体或使用更大光圈虚化背景');
    }
    if (suggestions.length === 0 && composition > 80 && exposure > 80 && sharpness > 80 && subject > 80) {
      suggestions.push('整体表现优秀,保持当前拍摄方式');
    }
    return suggestions;
  }

  /** 实时反馈:评估指定帧并生成改进提示 */
  async liveFeedback(framePath: string, targetParams?: Record<string, unknown> | null): Promise<{
    evaluation: EvaluationResult;
    hints: string[];
    targetParams?: Record<string, unknown> | null;
  }> {
    const evaluation = await this.evaluate(framePath);
    const { data, info } = await sharp(framePath).removeAlpha().grayscale().raw().toBuffer({ resolveWithObject: true });
    let total = 0;
    for (let i = 0; i < data.length; i += 1) {
      total += data[i]!;
    }
    const meanBrightness = total / (info.width * info.height);
    const hints: string[] = [];
    if (evaluation.exposureScore < 70) {
      if (meanBrightness < 90) {
        hints.push('画面偏暗,建议增加曝光');
      } else if (meanBrightness > 170) {
        hints.push('画面偏亮,建议减少曝光');
      } else {
        hints.push('曝光正常');
      }
    }
    if (evaluation.sharpnessScore < 70) {
      hints.push('画面不够清晰,建议稳定相机或提高快门');
    }
    if (evaluation.compositionScore < 75) {
      hints.push('构图可优化,建议使用三分法');
    }
    if (evaluation.subjectScore < 70) {
      hints.push('主体不够突出,建议靠近或虚化背景');
    }
    if (
      evaluation.compositionScore >= 80 && evaluation.exposureScore >= 80
      && evaluation.sharpnessScore >= 80 && evaluation.subjectScore >= 80
    ) {
      hints.push('取景良好,保持当前状态');
    }
    return { evaluation, hints, targetParams: targetParams ?? null };
  }

  /** 抓拍一帧并评估 */
  async captureAndEvaluate(photoId?: string): Promise<{ framePath: string; result: EvaluationResult }> {
    if (!this.camera) {
      throw new Error('未配置摄像头,请先 setCamera');
    }
    const framePath = await this.camera.captureFrame();
    const result = await this.evaluate(framePath, photoId);
    return { framePath, result };
  }

  /** 抓拍一帧 + 实时反馈 */
  async captureAndFeedback(targetParams?: Record<string, unknown>): Promise<{
    framePath: string;
    evaluation: EvaluationResult;
    hints: string[];
    targetParams?: Record<string, unknown>;
  }> {
    if (!this.camera) {
      throw new Error('未配置摄像头,请先 setCamera');
    }
    const framePath = await this.camera.captureFrame();
    const feedback = await this.liveFeedback(framePath, targetParams);
    return { framePath, evaluation: feedback.evaluation, hints: feedback.hints, targetParams: targetParams ?? undefined };
  }
}
