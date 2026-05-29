import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

/** 用于去重合并的轻量指纹（同 role + 内容前缀 + tool_call id）。 */
export function chatMessageFingerprint(msg: ChatCompletionMessageParam): string {
  const role = msg.role;
  let content = "";
  if (typeof msg.content === "string") {
    content = msg.content.slice(0, 240);
  } else if (Array.isArray(msg.content)) {
    content = JSON.stringify(msg.content).slice(0, 240);
  }
  let toolIds = "";
  if (msg.role === "assistant" && Array.isArray((msg as { tool_calls?: unknown }).tool_calls)) {
    toolIds = (msg as { tool_calls: Array<{ id?: string }> }).tool_calls
      .map((t) => t.id ?? "")
      .join(",");
  }
  if (msg.role === "tool") {
    toolIds = String((msg as { tool_call_id?: string }).tool_call_id ?? "");
  }
  return `${role}|${content}|${toolIds}`;
}

function stripSystem(msgs: ChatCompletionMessageParam[]): {
  system: ChatCompletionMessageParam | null;
  body: ChatCompletionMessageParam[];
} {
  if (msgs[0]?.role === "system") {
    return { system: msgs[0], body: msgs.slice(1) };
  }
  return { system: null, body: msgs };
}

/**
 * 将裸 `actorId` 线程中 master 尚未包含的消息，插入到 master 最后一条 user 消息之前。
 * 修复「统一窗口 UI 一条线、后端 session / master:session 分裂」导致的追问答非所问。
 */
export function mergeActorThreadIntoMasterThread(
  rawThread: ChatCompletionMessageParam[],
  masterThread: ChatCompletionMessageParam[],
): ChatCompletionMessageParam[] {
  const { system: masterSys, body: masterBody } = stripSystem(masterThread);
  const { body: rawBody } = stripSystem(rawThread);

  const masterFps = new Set(masterBody.map(chatMessageFingerprint));
  const uniqueRaw = rawBody.filter((m) => !masterFps.has(chatMessageFingerprint(m)));
  if (uniqueRaw.length === 0) {
    return masterThread;
  }

  let lastUserIdx = -1;
  for (let i = masterBody.length - 1; i >= 0; i--) {
    if (masterBody[i]?.role === "user") {
      lastUserIdx = i;
      break;
    }
  }

  const mergedBody =
    lastUserIdx >= 0
      ? [...masterBody.slice(0, lastUserIdx), ...uniqueRaw, ...masterBody.slice(lastUserIdx)]
      : [...masterBody, ...uniqueRaw];

  const sys = masterSys ?? rawThread[0];
  if (sys?.role === "system") {
    return [sys, ...mergedBody];
  }
  return mergedBody;
}
