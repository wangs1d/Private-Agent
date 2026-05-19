import type { ChatCompletionContentPart } from "openai/resources/chat/completions";

import type { ChatUserTurn } from "./types.js";

/** 将一轮用户输入转为 OpenAI Chat Completions 的 `user.content`（纯文本或多模态片段）。 */
export function openAiUserContentFromTurn(turn: ChatUserTurn): string | ChatCompletionContentPart[] {
  const frames = turn.visionFrames?.length ? turn.visionFrames : undefined;
  if (!frames?.length) {
    return turn.text;
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
