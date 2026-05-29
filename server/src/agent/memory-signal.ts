/** 用户显式要求记住或涉及长期偏好的信号 */
export const MEMORY_EXPLICIT_RE =
  /记住|记得|别忘了|帮我记|记下|不要忘记|偏好|喜欢|讨厌|不喜欢|禁忌|生日|纪念日|important|remember|prefer/i;

/** 用户引用历史上下文的信号 */
export const MEMORY_RECALL_HINT_RE =
  /之前|上次|说过|刚才|刚刚|前面|早些时候|earlier|before|last time|you said/i;

/** 短句追问/确认（无自洽语义，必须锚定上一轮对话） */
export const AMBIGUOUS_FOLLOWUP_RE =
  /^(你)?确定[吗？?]?$|^(真的|确实)[吗？?]?$|^(是吗|对吗|对不对)[？?]?$|^(为什么|为何)[？?]?$|^(然后呢|接着呢)[？?]?$|^[？?？!！。…]+$/;

export function isAmbiguousFollowUpMessage(message: string): boolean {
  const t = message.trim();
  if (!t) return false;
  if (t.length > 20) return false;
  return AMBIGUOUS_FOLLOWUP_RE.test(t);
}

/** Agent 承诺、结论、决策类信号 */
export const AGENT_COMMITMENT_RE =
  /我会|我将|已为你|已经帮你|已设置|已创建|已添加|已安排|已提醒|帮你订|帮你查|结论是|建议是|remember to|i will|i've set/i;

export type MemorySignalResult = {
  isHighSignal: boolean;
  reasons: string[];
  /** 供 fast-path 写入 digest / KV / 向量库的摘要行 */
  extractLines: string[];
};

function firstSentence(text: string, maxLen: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return "";
  const cut = t.split(/[。！？.!?\n]/)[0]?.trim() || t;
  return cut.length > maxLen ? `${cut.slice(0, maxLen)}…` : cut;
}

/**
 * 检测本轮是否含高价值记忆信号（供 fast-path 与 recall 跳过对称使用）。
 */
export function detectMemorySignals(userText: string, assistantText: string): MemorySignalResult {
  const user = userText.trim();
  const assistant = assistantText.trim();
  const reasons: string[] = [];
  const extractLines: string[] = [];

  if (MEMORY_EXPLICIT_RE.test(user)) {
    reasons.push("explicit_remember");
    extractLines.push(`[用户要求记住] ${firstSentence(user, 200)}`);
  }
  if (MEMORY_RECALL_HINT_RE.test(user)) {
    reasons.push("recall_reference");
  }
  if (AGENT_COMMITMENT_RE.test(assistant)) {
    reasons.push("agent_commitment");
    extractLines.push(`[Agent 承诺/结论] ${firstSentence(assistant, 200)}`);
  }

  const isHighSignal = reasons.includes("explicit_remember") || reasons.includes("agent_commitment");

  if (isHighSignal && extractLines.length === 0) {
    extractLines.push(`用户: ${firstSentence(user, 120)} | Agent: ${firstSentence(assistant, 120)}`);
  }

  return { isHighSignal, reasons, extractLines };
}

export function shouldSkipNarrativeRecall(message: string): boolean {
  const t = message.trim();
  if (!t) return true;
  if (isAmbiguousFollowUpMessage(t)) return true;
  if (MEMORY_EXPLICIT_RE.test(t) || MEMORY_RECALL_HINT_RE.test(t)) return false;
  if (t.length <= 16) return true;
  return false;
}

export function buildFollowUpAnchorPrompt(message: string): string | undefined {
  if (!isAmbiguousFollowUpMessage(message)) return undefined;
  return [
    "【短句追问 · 必须锚定上一轮】",
    `用户本条消息极短（「${message.trim()}」），是对话线程中**紧邻上一轮**助手回复的追问或确认。`,
    "- 只根据对话历史中**最后一条 assistant 回复**理解用户在问什么，直接回应该话题。",
    "- 禁止切换到其他历史话题（如日程/定时推送/旧任务），除非上一轮正是在讨论该话题。",
    "- 禁止为此类追问调用 calendar.list_tasks / calendar.create_task 等日程工具，除非上一轮明确在确认日程。",
    "- 若上一轮在讨论事实/排名/新闻等，用户「确定？」=质疑该结论，应补充依据或承认不确定，而非答无关任务状态。",
  ].join("\n");
}
