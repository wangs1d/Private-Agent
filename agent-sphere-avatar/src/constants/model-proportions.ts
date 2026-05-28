/** 参照 3D 打印实体原型的比例与材质参数 */
export const MODEL = {
  bodyRadius: 1,
  /** 前部大开口曲屏 — 约占正面 58% */
  eyeRadius: 0.62,
  eyeZ: 0.78,
  eyePhiLength: 0.48,
  eyeDisplayPhiLength: 0.44,
  eyeBezelRadius: 0.82,
  /** 两侧短圆柱耳 */
  earX: 0.96,
  earRadius: 0.07,
  earLength: 0.12,
  /** 哑光 PLA 白 */
  shellColor: "#f2f0eb",
  shellRoughness: 0.38,
  shellMetalness: 0.02,
  shellClearcoat: 0.35,
  /** 内嵌呼吸灯 */
  seamEmissive: "#eef6ff",
} as const;

export type SceneMode = "demo" | "embed" | "overlay";
