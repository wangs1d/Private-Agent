import type { ChatCompletionContentPart } from "openai/resources/chat/completions";

import type { ChatUserTurn } from "./types.js";
import { modelSupportsVision } from "./vision-support.js";

export type UserContentBuildOptions = {
  /** 本轮使用的模型名，用于判断是否支持视觉。缺省视为支持视觉（保留原行为）。 */
  model?: string;
};

/** 将一轮用户输入转为 OpenAI Chat Completions 的 `user.content`（纯文本或多模态片段）。 */
export function openAiUserContentFromTurn(
  turn: ChatUserTurn,
  opts?: UserContentBuildOptions,
): string | ChatCompletionContentPart[] {
  const frames = turn.visionFrames?.length ? turn.visionFrames : undefined;
  if (!frames?.length) {
    return turn.text;
  }
  // 纯文本模型（deepseek-chat / deepseek-reasoner / gpt-3.5 等）不支持 image_url，
  // 直接注入会导致 OpenAI 兼容 API 报 400、整轮对话失败——照片"发不进对话"。
  // 主对话（abstract-chat-provider）必须与工具链注入点保持一致地按模型能力分流。
  const visionSupported = opts?.model ? modelSupportsVision(opts.model) : true;
  if (!visionSupported) {
    const count = frames.length;
    const note =
      `（用户发送了 ${count} 张照片。当前模型无法直接查看图片画面，` +
      `若下方附有图片 OCR 识别文本请据此回答；` +
      `否则请如实告知用户无法查看图片，请其用文字描述图片内容或改用支持视觉的模型。）`;
    return turn.text ? `${turn.text}\n\n${note}` : note;
  }
  const parts: ChatCompletionContentPart[] = [{ type: "text", text: turn.text }];
  for (const f of frames) {
    parts.push({
      type: "image_url",
      image_url: {
        url: `data:${f.mimeType};base64,${f.dataBase64}`,
        detail: "auto",
      },
    });
  }
  return parts;
}
