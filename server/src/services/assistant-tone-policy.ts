export type AssistantToneMode = "steady" | "soft" | "direct" | "light";
export type AssistantFirstMove = "ack" | "answer" | "judge" | "confirm" | "none";

export function detectAssistantToneMode(userText: string | undefined): AssistantToneMode {
  const text = userText?.trim() ?? "";
  if (!text) return "steady";

  if (/(难受|崩溃|烦死|无语|顶不住|好烦|委屈|想哭|压力大|撑不住)/i.test(text)) {
    return "soft";
  }
  if (/(快点|马上|立刻|直接说|说重点|别废话|一句话|简短点|赶时间)/i.test(text)) {
    return "direct";
  }
  if (/(谢谢|谢了|多谢|哈哈|笑死|乐了|有点意思|你怎么看|你觉得)/i.test(text)) {
    return "light";
  }
  return "steady";
}

export function detectAssistantFirstMove(userText: string | undefined): AssistantFirstMove {
  const text = userText?.trim() ?? "";
  if (!text) return "none";

  if (/(难受|崩溃|烦死|无语|顶不住|好烦|委屈|想哭|压力大|撑不住)/i.test(text)) {
    return "ack";
  }
  if (/(快点|马上|立刻|直接说|说重点|别废话|一句话|简短点|赶时间)/i.test(text)) {
    return "answer";
  }
  if (/(怎么回事|为什么|啥情况|什么情况)/i.test(text)) {
    return "answer";
  }
  if (/(能不能|可以吗|行不行|要不要)/i.test(text)) {
    return "confirm";
  }
  if (/(帮我看|帮我判断|你怎么看|你觉得)/i.test(text)) {
    return "judge";
  }
  return "none";
}
