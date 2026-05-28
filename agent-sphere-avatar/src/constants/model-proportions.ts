/** 参考深灰金属球形机器人 — 拉丝金属质感 + 4耳 + 大黑玻璃穹顶 */
export const MODEL = {
  bodyRadius: 0.5,
  /** 前部大黑玻璃穹顶 */
  domeRadius: 0.58,
  domeZ: 0.72,
  domePhiLength: 0.52,
  /** 两侧大耳朵 */
  sideEarX: 0.94,
  sideEarRadius: 0.12,
  sideEarLength: 0.20,
  sideEarY: 0,
  /** 顶部前后小耳朵 */
  topEarY: 0.88,
  topEarFrontX: 0.28,
  topEarBackX: -0.28,
  topEarRadius: 0.08,
  topEarLength: 0.14,
  /** 深灰拉丝金属壳 */
  shellColor: "#6a6a6e",
  shellRoughness: 0.52,
  shellMetalness: 0.68,
  shellClearcoat: 0.15,
  /** 内嵌呼吸灯缝线 */
  seamEmissive: "#99a4b8",
} as const;

export type SceneMode = "demo" | "embed" | "overlay";
