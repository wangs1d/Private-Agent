import type { ChatCompletionTool } from "openai/resources/chat/completions";

/**
 * 图片能力(图库/美颜批图)—— ChatCompletionTool schema。
 *
 * 工具: `picture.gallery`(查图库/打标签/评分) 与 `picture.beautify`(一键美颜批图)。
 * 走 deferred(BM25 索引),关键词触发(照片/图库/修图/美颜)时由 tool_discover 拉出。
 */
export const PICTURE_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "picture.gallery",
      description:
        "图库查询与管理。查询用户已入库的照片(本地上传或生成/修图产物)," +
        "支持按标签/场景/评分筛选与分页;也可打标签、评分、设置场景。\n" +
        "适用场景:用户说「看看我的照片」「最近拍的照片」「把这张照片打 90 分」「给照片加个收藏标签」。",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["query", "get", "add_tag", "remove_tag", "set_rating", "set_scene", "stats"],
            description: "具体操作",
          },
          photoId: { type: "string", description: "get/add_tag/remove_tag/set_rating/set_scene:照片 id" },
          tag: { type: "string", description: "add_tag/remove_tag:标签名" },
          rating: { type: "integer", description: "set_rating:评分 0-100" },
          sceneType: { type: "string", description: "set_scene:场景类型(如 selfie/portrait/landscape)" },
          tagFilter: { type: "string", description: "query:按单个标签过滤" },
          page: { type: "integer", description: "query:页码,默认 1" },
          pageSize: { type: "integer", description: "query:每页数量,默认 20,最大 50" },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "picture.beautify",
      description:
        "人像美颜批图(一键修图)。按熟练修图师手法处理照片:频率分离磨皮、皮肤透亮提亮、" +
        "冷白皮、红润气血、日系清透、港风复古等成品风格,修图产物自动存回图库。\n" +
        "适用场景:用户说「帮我把这张照片修一下」「美颜一下」「磨皮」「修成冷白皮」「日系风格」「批图」。\n" +
        "photoIds 不传时默认处理图库中最新的一张。",
      parameters: {
        type: "object",
        properties: {
          photoIds: {
            type: "array",
            items: { type: "string" },
            description: "要美颜的照片 id 列表(来自 picture.gallery);不传默认最新一张",
          },
          style: {
            type: "string",
            enum: ["natural", "creamy", "cool_white", "japanese", "hongkong"],
            description:
              "美颜风格:natural 自然美颜 / creamy 奶油肌 / cool_white 冷白皮 / japanese 日系清透 / hongkong 港风复古。" +
              "未传时默认 natural。",
          },
          sceneType: {
            type: "string",
            enum: ["beauty_portrait", "selfie"],
            description: "或直接用人像美颜场景预设(beauty_portrait 通用人像 / selfie 自拍),与 style 二选一",
          },
          adjustments: {
            type: "object",
            description:
              "微调参数(0-100,可叠加在 style 上):skinSmooth 磨皮 / skinBrighten 透亮 / whiten 白皙 / " +
              "rosy 红润 / vibrance 鲜艳 / clarity 质感 / fade 褪色 / exposure 曝光 / warmth 色温",
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
  },
];
