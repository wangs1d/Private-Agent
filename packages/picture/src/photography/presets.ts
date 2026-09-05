/**
 * 场景预设库,移植自 photography_agent.presets。
 * 内置五个场景预设(户外人像/半身人像/风光/街拍/夜景),
 * 支持自定义预设的保存/查询/删除/应用。
 */
import type { CompositionGuide, LensParams, PoseGuide, ScenePreset } from '../models.js';

const BUILTIN_SPECS: Array<Omit<ScenePreset, 'isBuiltin'>> = [
  {
    id: 'builtin_outdoor_portrait',
    name: '户外人像',
    sceneType: 'outdoor_portrait',
    lens: { focalLength: 85, aperture: 1.8, shootingDistance: 2.0 },
    composition: {
      rule: 'thirds',
      overlayDescription: '人物置于左侧或右侧三分之一线',
      textAdvice: '将人物眼睛放在上三分线',
    },
    pose: {
      poseName: '自然站姿',
      bodyOrientation: '侧身45度',
      handPlacement: '一手自然下垂一手轻触头发',
      expression: '微笑',
      skeletonDescription: '重心落在后脚,身体微转',
      textAdvice: '放松肩膀,自然呼吸',
    },
    batchStyle: { brightness: 5, contrast: 10, saturation: 5, temperature: 3, skin_tone: 'warm' },
    tags: [],
  },
  {
    id: 'builtin_half_body_portrait',
    name: '半身人像',
    sceneType: 'half_body_portrait',
    lens: { focalLength: 50, aperture: 2.0, shootingDistance: 1.5 },
    composition: {
      rule: 'center',
      overlayDescription: '人物居中',
      textAdvice: '面部位于画面上三分之一',
    },
    pose: {
      poseName: '半身构图',
      bodyOrientation: '正面',
      handPlacement: '双手交叠于腰前',
      expression: '自然',
      skeletonDescription: '挺胸收腹',
      textAdvice: '下巴微收',
    },
    batchStyle: { brightness: 3, contrast: 8, saturation: 5, skin_tone: 'natural' },
    tags: [],
  },
  {
    id: 'builtin_landscape',
    name: '风光',
    sceneType: 'landscape',
    lens: { focalLength: 24, aperture: 8.0, shootingDistance: 10.0 },
    composition: {
      rule: 'thirds',
      overlayDescription: '地平线置于上或下三分线',
      textAdvice: '前景中景远景层次分明',
    },
    pose: null,
    batchStyle: { brightness: 5, contrast: 15, saturation: 20, temperature: -3 },
    tags: [],
  },
  {
    id: 'builtin_street',
    name: '街拍',
    sceneType: 'street',
    lens: { focalLength: 35, aperture: 4.0, shootingDistance: 3.0 },
    composition: {
      rule: 'leading_lines',
      overlayDescription: '利用街道线条引导视线',
      textAdvice: '捕捉人物自然行走状态',
    },
    pose: {
      poseName: '行走',
      bodyOrientation: '侧身',
      handPlacement: '自然摆臂',
      expression: '忽略镜头',
      skeletonDescription: '迈步中',
      textAdvice: '不要看镜头',
    },
    batchStyle: { contrast: 12, saturation: -5, temperature: -2 },
    tags: [],
  },
  {
    id: 'builtin_night',
    name: '夜景',
    sceneType: 'night',
    lens: { focalLength: 35, aperture: 1.4, shootingDistance: 5.0 },
    composition: {
      rule: 'center',
      overlayDescription: '主体居中,利用灯光做背景',
      textAdvice: '注意高光不要过曝',
    },
    pose: null,
    batchStyle: { brightness: 8, contrast: 10, saturation: 10, temperature: -5, noise_reduction: 30 },
    tags: [],
  },
];

export class PresetService {
  private readonly presets = new Map<string, ScenePreset>();

  constructor() {
    for (const spec of BUILTIN_SPECS) {
      this.presets.set(spec.id, { ...spec, isBuiltin: true });
    }
  }

  getPreset(presetId: string): ScenePreset | null {
    return this.presets.get(presetId) ?? null;
  }

  listPresets(options: { sceneType?: string; builtinOnly?: boolean; customOnly?: boolean } = {}): ScenePreset[] {
    const result: ScenePreset[] = [];
    for (const preset of this.presets.values()) {
      if (options.sceneType !== undefined && preset.sceneType !== options.sceneType) {
        continue;
      }
      if (options.builtinOnly && options.customOnly) {
        return [];
      }
      if (options.builtinOnly && !preset.isBuiltin) {
        continue;
      }
      if (options.customOnly && preset.isBuiltin) {
        continue;
      }
      result.push(preset);
    }
    return result;
  }

  savePreset(
    name: string,
    sceneType: string,
    lens: LensParams,
    composition: CompositionGuide,
    pose: PoseGuide | null,
    batchStyle: Record<string, number | string>,
    tags: string[] = [],
  ): ScenePreset {
    const preset: ScenePreset = {
      id: crypto.randomUUID().replaceAll('-', ''),
      name,
      sceneType,
      lens,
      composition,
      pose,
      batchStyle,
      tags,
      isBuiltin: false,
    };
    this.presets.set(preset.id, preset);
    return preset;
  }

  /** 删除自定义预设;内置预设不可删除 */
  deletePreset(presetId: string): boolean {
    const preset = this.presets.get(presetId);
    if (!preset) {
      throw new Error(`预设不存在: ${presetId}`);
    }
    if (preset.isBuiltin) {
      throw new Error(`内置预设不可删除: ${presetId}`);
    }
    this.presets.delete(presetId);
    return true;
  }

  /** 加载预设并返回完整参数 */
  applyPreset(presetId: string): ScenePreset {
    const preset = this.presets.get(presetId);
    if (!preset) {
      throw new Error(`预设不存在: ${presetId}`);
    }
    return preset;
  }
}
