/**
 * 指导拍照服务,移植自 photography_agent.guidance。
 * 提供镜头/场景/构图/动作指引与取景偏差实时反馈。
 */
import type { CompositionGuide, GuidanceResult, LensParams, PoseGuide } from '../models.js';

const LENS_PRESETS: Record<string, [number, number, number]> = {
  full_body: [35, 2.8, 3.0],
  half_body: [50, 2.0, 1.5],
  closeup: [85, 1.8, 1.0],
  headshot: [135, 2.0, 0.8],
  landscape: [24, 8.0, 10.0],
  street: [35, 4.0, 3.0],
  night: [35, 1.4, 5.0],
};

const TARGET_LABELS: Record<string, string> = {
  full_body: '全身人像',
  half_body: '半身人像',
  closeup: '面部特写',
  headshot: '大头照',
  landscape: '风光',
  street: '街拍',
  night: '夜景',
};

const SCENE_PRESETS: Record<string, [string, string, string, string]> = {
  outdoor_portrait: ['与人物平视高度', '平视略仰', '侧逆光45度', '人物置于黄金分割点,背景虚化突出主体'],
  indoor_portrait: ['与人物平视高度', '平视', '正面柔光', '利用室内窗户或灯光做主光,避免顶光'],
  landscape: ['三脚架低位或高位', '俯视或平视', '顺光或侧光', '前景中景远景层次分明,地平线置于三分线'],
  street: ['胸前高度抓拍', '平视', '自然光', '利用街道线条引导视线,捕捉人物自然状态'],
  night: ['稳定高位或低位', '仰视取景', '利用环境灯光', '主体居中,利用霓虹灯光做背景,注意高光不过曝'],
  studio: ['与人物平视高度', '平视', '主辅双灯布光', '纯色背景,主光45度侧布,辅光补阴影'],
};

const SCENE_DEFAULT: [string, string, string, string] = ['与主体平视高度', '平视', '顺光或侧光', '保持画面简洁,突出主体'];

const COMPOSITION_PRESETS: Record<string, [string, string]> = {
  thirds: ['画面横竖各三等分,主体置于三分线交点', '将人物眼睛或主体放在上三分线交点,画面更平衡'],
  diagonal: ['主体沿画面斜对角线分布', '利用对角线增加画面动感与延伸感'],
  golden_ratio: ['画面按黄金比例划分,主体置于黄金螺旋焦点', '主体置于黄金分割点,构图更具美感'],
  center: ['主体位于画面正中心,左右对称', '正面人像或对称场景适用,保持画面稳定'],
  leading_lines: ['利用环境线条引导视线至主体', '寻找道路、栏杆、河流等线条指向主体'],
};

const POSE_PRESETS: Record<string, PoseGuide> = {
  natural_standing: {
    poseName: 'natural_standing',
    bodyOrientation: '侧身45度',
    handPlacement: '一手自然下垂一手轻触头发',
    expression: '微笑',
    skeletonDescription: '重心落后脚身体微转',
    textAdvice: '放松肩膀自然呼吸',
  },
  walking: {
    poseName: 'walking',
    bodyOrientation: '侧身',
    handPlacement: '自然摆臂',
    expression: '忽略镜头',
    skeletonDescription: '迈步中重心前移',
    textAdvice: '不要看镜头保持行走',
  },
  sitting: {
    poseName: 'sitting',
    bodyOrientation: '正面斜倾',
    handPlacement: '双手放膝上',
    expression: '自然',
    skeletonDescription: '背部挺直不驼背',
    textAdvice: '放松腿部',
  },
  leaning: {
    poseName: 'leaning',
    bodyOrientation: '侧身靠墙',
    handPlacement: '一手插袋',
    expression: '微笑',
    skeletonDescription: '重心偏向倚靠物',
    textAdvice: '放松身体',
  },
  hands_on_hips: {
    poseName: 'hands_on_hips',
    bodyOrientation: '正面',
    handPlacement: '双手叉腰',
    expression: '自信',
    skeletonDescription: '挺胸收腹',
    textAdvice: '下巴微抬',
  },
};

const POSITION_RANK: Record<string, number> = { left: 0, center: 1, right: 2 };

export interface DeviationCheckResult {
  deviations: string[];
  adjustments: string[];
}

export class GuidanceService {
  /** 根据拍摄目标返回镜头参数建议 */
  guideLens(shootingTarget: string): LensParams {
    const preset = LENS_PRESETS[shootingTarget];
    if (!preset) {
      throw new Error(`未知的拍摄目标: ${shootingTarget}`);
    }
    const [focalLength, aperture, shootingDistance] = preset;
    const label = TARGET_LABELS[shootingTarget] ?? shootingTarget;
    return { focalLength, aperture, shootingDistance, notes: `${label}推荐参数` };
  }

  /** 生成镜头参考画面可视化描述 */
  renderLensReference(lens: LensParams): Record<string, unknown> {
    return {
      reference_type: 'lens',
      focal_length: lens.focalLength,
      aperture: lens.aperture,
      visualization: GuidanceService.lensVisualization(lens.focalLength),
      depth_of_field: GuidanceService.depthOfField(lens.aperture),
    };
  }

  static lensVisualization(focalLength: number): string {
    if (focalLength <= 24) {
      return `${focalLength}mm 广角,适合风光与建筑,视野开阔空间感强`;
    }
    if (focalLength <= 35) {
      return `${focalLength}mm 广角中焦,适合环境人像与街拍,兼顾主体与背景`;
    }
    if (focalLength <= 50) {
      return `${focalLength}mm 标准焦段,接近人眼视角,适合半身人像`;
    }
    if (focalLength <= 85) {
      return `${focalLength}mm 中焦,适合半身人像,背景虚化明显`;
    }
    if (focalLength <= 135) {
      return `${focalLength}mm 中长焦,适合特写人像,空间压缩感强`;
    }
    return `${focalLength}mm 长焦,适合远距离特写与大头照,背景虚化强烈`;
  }

  static depthOfField(aperture: number): string {
    if (aperture <= 2.0) {
      return '浅景深,背景虚化';
    }
    if (aperture >= 8.0) {
      return '大景深,全景清晰';
    }
    return '中等景深';
  }

  /** 场景选择可视化叠加层 */
  guideSceneSelection(sceneType: string): Record<string, unknown> {
    const [cameraPosition, shootingAngle, lightDirection, overlayDescription] =
      SCENE_PRESETS[sceneType] ?? SCENE_DEFAULT;
    return {
      overlay_type: 'scene',
      scene_type: sceneType,
      camera_position: cameraPosition,
      shooting_angle: shootingAngle,
      light_direction: lightDirection,
      overlay_description: overlayDescription,
    };
  }

  guideComposition(rule = 'thirds'): CompositionGuide {
    const preset = COMPOSITION_PRESETS[rule];
    if (!preset) {
      throw new Error(`未知的构图法则: ${rule}`);
    }
    const [overlayDescription, textAdvice] = preset;
    return { rule, overlayDescription, textAdvice };
  }

  guidePose(poseName: string): PoseGuide {
    const pose = POSE_PRESETS[poseName];
    if (!pose) {
      throw new Error(`未知的动作: ${poseName}`);
    }
    return { ...pose };
  }

  listPoses(): string[] {
    return Object.keys(POSE_PRESETS);
  }

  /** 检测取景偏差:距离/主体位置/地平线角度/亮度 */
  checkDeviation(
    currentParams: Record<string, number | string>,
    targetParams: Record<string, number | string>,
  ): DeviationCheckResult {
    const deviations: string[] = [];
    const adjustments: string[] = [];

    const distanceCurrent = currentParams['distance'];
    const distanceTarget = targetParams['distance'];
    if (typeof distanceCurrent === 'number' && typeof distanceTarget === 'number') {
      if (Math.abs(distanceCurrent - distanceTarget) > 0.5) {
        deviations.push(`距离偏差${distanceCurrent}m,目标${distanceTarget}m`);
        adjustments.push(distanceCurrent > distanceTarget ? '向前移动靠近主体' : '向后退远离主体');
      }
    }

    const positionCurrent = currentParams['subject_position'];
    const positionTarget = targetParams['subject_position'];
    if (typeof positionCurrent === 'string' && typeof positionTarget === 'string' && positionCurrent !== positionTarget) {
      deviations.push('主体位置偏移');
      const curRank = POSITION_RANK[positionCurrent];
      const tgtRank = POSITION_RANK[positionTarget];
      if (curRank !== undefined && tgtRank !== undefined) {
        adjustments.push(tgtRank > curRank ? '向右调整主体位置' : '向左调整主体位置');
      } else {
        adjustments.push(`调整主体位置至${positionTarget}`);
      }
    }

    const angleCurrent = currentParams['horizon_angle'];
    const angleTarget = targetParams['horizon_angle'];
    if (typeof angleCurrent === 'number' && typeof angleTarget === 'number') {
      if (Math.abs(angleCurrent - angleTarget) > 5) {
        deviations.push(`地平线倾斜${Math.abs(angleCurrent - angleTarget)}度`);
        adjustments.push('调整相机水平');
      }
    }

    const brightnessCurrent = currentParams['brightness'];
    const brightnessTarget = targetParams['brightness'];
    if (typeof brightnessCurrent === 'number' && typeof brightnessTarget === 'number') {
      if (Math.abs(brightnessCurrent - brightnessTarget) > 20) {
        deviations.push('亮度偏差');
        adjustments.push(brightnessCurrent > brightnessTarget ? '减少曝光' : '增加曝光');
      }
    }

    return { deviations, adjustments };
  }

  realTimeFeedback(
    currentParams: Record<string, number | string>,
    targetParams: Record<string, number | string>,
  ): string[] {
    return [...this.checkDeviation(currentParams, targetParams).adjustments];
  }

  /** 一站式指导:镜头 + 场景 + 构图 + 动作 */
  fullGuidance(options: {
    shootingTarget: string;
    sceneType?: string;
    compositionRule?: string;
    poseName?: string;
  }): GuidanceResult {
    const lens = this.guideLens(options.shootingTarget);
    const sceneOverlay = options.sceneType ? this.guideSceneSelection(options.sceneType) : null;
    const composition = this.guideComposition(options.compositionRule ?? 'thirds');
    const pose = options.poseName ? this.guidePose(options.poseName) : null;
    return { lens, composition, pose, sceneOverlay, realTimeHints: [] };
  }
}
