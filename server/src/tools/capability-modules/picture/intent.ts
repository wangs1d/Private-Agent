/**
 * picture.gallery 工具意图元数据 —— 用于 tool-search BM25 排序调权。
 * 与 `intent-metadata.ts` 中 `DEFAULT_TOOL_INTENT_RULES` 同结构。
 */
import type { ToolIntentRule } from "../../tool-search/intent-metadata.js";

export const PICTURE_INTENT_RULES: ToolIntentRule[] = [
  {
    exact: "picture.gallery",
    metadata: {
      aliases: [
        "gallery", "photo", "photos", "album", "picture library",
        "照片", "相册", "图库", "看看照片", "我的照片", "最近的照片",
        "照片打分", "照片标签", "收藏照片",
      ],
      negativeAliases: [
        "generate image", "draw", "paint", "画图", "画一张",
      ],
      examples: [
        "看看我的照片",
        "最近拍的照片有哪些",
        "把那张照片打 90 分",
        "给照片加个收藏标签",
      ],
      negativeExamples: ["画一张猫的图"],
    },
  },
];
