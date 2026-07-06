/**
 * image.generate 工具意图元数据 —— 用于 tool-search BM25 排序调权。
 *
 * 与 `intent-metadata.ts` 中 `DEFAULT_TOOL_INTENT_RULES` 同结构；
 * 通过 {@link registerCapabilityModuleIntentRules} 在启动时合并到全局规则表。
 */
import type { ToolIntentRule } from "../../tool-search/intent-metadata.js";

export const IMAGE_GEN_INTENT_RULES: ToolIntentRule[] = [
  {
    exact: "image.generate",
    metadata: {
      aliases: [
        "image", "picture", "photo", "draw", "paint", "generate image",
        "text to image", "txt2img", "diffusion", "kolors", "flux",
        "画图", "画一张", "画个", "做张图", "生成图片", "配图", "插图",
        "头像", "logo", "icon",
      ],
      negativeAliases: [
        "phone call", "calendar reminder", "wallet transfer",
        "desktop screenshot", "smart home light",
      ],
      examples: [
        "画一只坐在窗台上的猫",
        "给我画个 logo，蓝色科技风",
        "生成一张配图，柔和光晕",
        "draw a watercolor landscape",
      ],
      negativeExamples: [
        "截屏当前桌面",
        "给我打个电话",
        "把灯关了",
      ],
    },
  },
];
