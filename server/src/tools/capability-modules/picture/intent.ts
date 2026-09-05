/**
 * picture.gallery / picture.beautify 工具意图元数据 —— 用于 tool-search BM25 排序调权。
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
        "修图", "美颜", "磨皮",
      ],
      examples: [
        "看看我的照片",
        "最近拍的照片有哪些",
        "把那张照片打 90 分",
        "给照片加个收藏标签",
      ],
      negativeExamples: ["画一张猫的图", "帮我把照片磨皮"],
    },
  },
  {
    exact: "picture.beautify",
    metadata: {
      aliases: [
        "beautify", "retouch", "beauty", "skin smooth", "whiten", "filter",
        "修图", "美颜", "磨皮", "白皙", "冷白皮", "红润", "气色",
        "批图", "p图", "修一下", "p一下", "日系", "港风", "奶油肌", "滤镜",
      ],
      negativeAliases: [
        "generate image", "draw a picture", "画一张", "生成图片",
      ],
      examples: [
        "帮我把最新的照片美颜一下",
        "这张自拍修成冷白皮",
        "把这几张照片批量磨皮",
        "修成日系清透风格",
      ],
      negativeExamples: ["画一张人像插画", "看看我的照片"],
    },
  },
];
