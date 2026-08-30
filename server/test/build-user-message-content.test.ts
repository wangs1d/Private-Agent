import assert from "node:assert/strict";
import test from "node:test";

import { openAiUserContentFromTurn } from "../src/external-model/build-user-message-content.js";
import type { ChatUserTurn } from "../src/external-model/types.js";

function makeTurn(): ChatUserTurn {
  return {
    text: "帮我看看这张照片",
    visionFrames: [
      {
        sourceKind: "agent_attachment",
        sourceId: "gallery:photo.jpg",
        mimeType: "image/jpeg",
        dataBase64: "aGVsbG8=",
      },
    ],
  };
}

test("无照片时返回纯文本", () => {
  const content = openAiUserContentFromTurn({ text: "你好" }, { model: "deepseek-chat" });
  assert.equal(content, "你好");
});

test("视觉模型（gpt-4o）注入 image_url 多模态片段", () => {
  const content = openAiUserContentFromTurn(makeTurn(), { model: "gpt-4o" });
  assert.ok(Array.isArray(content));
  const parts = content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
  assert.equal(parts[0]?.type, "text");
  assert.equal(parts[0]?.text, "帮我看看这张照片");
  assert.equal(parts[1]?.type, "image_url");
  assert.ok(parts[1]?.image_url?.url.startsWith("data:image/jpeg;base64,"));
});

test("非视觉模型（deepseek-chat）降级为文本，不注入 image_url", () => {
  const content = openAiUserContentFromTurn(makeTurn(), { model: "deepseek-chat" });
  assert.equal(typeof content, "string");
  const text = content as string;
  assert.ok(text.includes("帮我看看这张照片"));
  assert.ok(text.includes("1 张照片"));
  assert.ok(!text.includes("image_url"));
});

test("deepseek-reasoner 同样视为非视觉模型", () => {
  const content = openAiUserContentFromTurn(makeTurn(), { model: "deepseek-reasoner" });
  assert.equal(typeof content, "string");
});

test("未指定 model 时保留原行为（默认视觉路径）", () => {
  const content = openAiUserContentFromTurn(makeTurn());
  assert.ok(Array.isArray(content));
});
