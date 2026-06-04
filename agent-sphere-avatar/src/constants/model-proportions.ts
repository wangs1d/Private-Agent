/**
 * DG2.obj 参考模型比例 — Autodesk 导出，主体半径 5，直径 10
 * 场景内统一缩放到 bodyRadius
 */
export const DG2_SOURCE = {
  bodyRadius: 5,
  bodyCenterY: 1,
  /** 玻璃面中心（OBJ 坐标，Y 轴负向为前面） */
  glassCenter: [0, -4, 0] as const,
  sideEarCenterX: 5.17,
  topEarCenters: [
    [3.088, 2.421, 3.056],
    [-3.056, 2.421, 3.088],
  ] as const,
} as const;

/** 缩放后场景常量（bodyRadius = 0.5 → scale = 0.1） */
export const MODEL = {
  bodyRadius: 0.5,
  /** OBJ → 场景：绕 X 轴 -90°，使玻璃面朝向 +Z（相机） */
  objRotation: [-Math.PI / 2, 0, 0] as const,
  /** 将 OBJ 球心 (0, bodyCenterY, 0) 对齐到视觉原点 */
  objOffset: [0, -DG2_SOURCE.bodyCenterY, 0] as const,
  /** 玻璃面中心（缩放+旋转后，相对视觉原点） */
  glassScreenPosition: [0, 0, 0.5] as const,
  /** 内嵌屏 angular 参数（供光标尺寸参考） */
  screenAngularR: Math.PI / 2.8,
  /** 曲屏内嵌表情 — 球冠半径（略小于外壳，贴在玻璃内侧） */
  screenCapRadius: 0.497,
  /** OLED 表情圆盘半径（与黑色曲屏可视圆一致） */
  screenFaceRadius: 0.34,
  /** 表情可见区域半角（球冠 UV 参考） */
  screenFaceHalfAngle: Math.asin(0.34 / 0.5),
  /** 交互热区半角 */
  screenHitHalfAngle: Math.asin(0.38 / 0.5),
  /** 拉丝钢壳 */
  shellColor: "#9a9aa2",
  shellRoughness: 0.38,
  shellMetalness: 0.82,
  shellClearcoat: 0.22,
  /** 深色玻璃 */
  glassColor: "#080a0e",
  glassRoughness: 0.04,
  glassMetalness: 0.85,
  /** 呼吸灯缝线 */
  seamEmissive: "#a8b8cc",
} as const;

export type SceneMode = "embed" | "overlay";

/** Electron 桌宠 — 固定机位，完整框选 DG2，禁止 3D 空间漫游 */
export const OVERLAY_SCENE = {
  cameraPosition: [0, 1.34, 3.35] as const,
  cameraFov: 26,
  lookAt: [0, 1.32, 0] as const,
  bodyPosition: [0, 1.32, 0] as const,
  modelScale: 1,
} as const;

/** 网页 embed — 相对桌宠缩小展示，DOM 漫游边界与 modelScale 对齐 */
export const EMBED_SCENE = {
  modelScale: 0.25,
  containerW: 110,
  containerH: 110,
} as const;

export function dg2Scale(bodyRadius = MODEL.bodyRadius): number {
  return bodyRadius / DG2_SOURCE.bodyRadius;
}
