/**
 * 各模块共享的数据模型。
 *
 * Photo/ScenePreset/BatchPreset/UserHabit/EvaluationResult/GuidanceResult
 * 移植自 picture 项目 photography_agent.models,字段转为 camelCase;
 * ImageAsset/ImageParseResult 为本包新增的图像能力模型。
 */

export interface LensParams {
  /** 焦段 mm */
  focalLength: number;
  /** 光圈 f 值 */
  aperture: number;
  /** 拍摄距离 米 */
  shootingDistance: number;
  notes?: string | null;
}

export interface CompositionGuide {
  /** 构图法则: "thirds" | "diagonal" | "golden_ratio" | "center" | "leading_lines" */
  rule: string;
  overlayDescription: string;
  textAdvice: string;
}

export interface PoseGuide {
  poseName: string;
  bodyOrientation: string;
  handPlacement: string;
  expression?: string | null;
  skeletonDescription: string;
  textAdvice: string;
}

export interface ScenePreset {
  id: string;
  name: string;
  sceneType: string;
  lens: LensParams;
  composition: CompositionGuide;
  pose?: PoseGuide | null;
  /** 批图风格参数: brightness/contrast/saturation/temperature/skin_tone 等 */
  batchStyle: Record<string, number | string>;
  tags: string[];
  isBuiltin: boolean;
}

export interface BatchPreset {
  id: string;
  name: string;
  sceneType: string;
  /** 调整参数: brightness/contrast/saturation/sharpness/temperature 等 */
  adjustments: Record<string, number>;
  tags: string[];
}

export interface UserHabit {
  userId: string;
  preferredFocalLengths: number[];
  preferredCompositionRules: string[];
  preferredSceneTypes: string[];
  /** 批图风格偏差均值 */
  batchStyleAvg: Record<string, number>;
  updatedAt: string;
}

export interface EvaluationResult {
  photoId: string;
  /** 以下评分均为 0-100 */
  compositionScore: number;
  exposureScore: number;
  sharpnessScore: number;
  subjectScore: number;
  overallScore: number;
  suggestions: string[];
}

export interface GuidanceResult {
  lens?: LensParams | null;
  composition?: CompositionGuide | null;
  pose?: PoseGuide | null;
  /** 场景叠加层数据 */
  sceneOverlay?: Record<string, unknown> | null;
  realTimeHints: string[];
}

/** 图库资产:在 Python 版 Photo 基础上扩展了哈希/格式/缩略图等存储管理字段 */
export interface ImageAsset {
  id: string;
  /** 存储目录内的资产文件路径 */
  filePath: string;
  /** 原始文件名 */
  fileName: string;
  width: number;
  height: number;
  format?: string | null;
  fileSize?: number | null;
  /** 内容哈希,用于去重 */
  sha256?: string | null;
  /** EXIF 数据,key/value 均为字符串 */
  exif: Record<string, string>;
  /** 拍摄时间 ISO 字符串,无法解析时为 null */
  takenAt?: string | null;
  tags: string[];
  sceneType?: string | null;
  /** 评分 0-100 */
  rating?: number | null;
  /** 尺寸名 -> 缩略图路径 */
  thumbnails?: Record<string, string>;
  createdAt: string;
}

export interface ImageStats {
  /** 灰度均值 0-255 */
  avgBrightness: number;
  /** RGB 各通道均值 */
  avgColor: [number, number, number];
  /** 主导色 */
  dominant: [number, number, number];
}

export interface ImageParseResult {
  fileName?: string | null;
  filePath?: string | null;
  format?: string | null;
  space?: string | null;
  hasAlpha: boolean;
  width: number;
  height: number;
  fileSize?: number | null;
  sha256?: string | null;
  exif: Record<string, string>;
  /** 从 EXIF DateTimeOriginal 解析,ISO 字符串或 null */
  takenAt?: string | null;
  orientation?: number | null;
  stats: ImageStats;
  /** 基于宽高比/尺寸/亮度的自动标签 */
  autoTags: string[];
}

export function nowIso(): string {
  return new Date().toISOString();
}
