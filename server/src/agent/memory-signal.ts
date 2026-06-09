export const MEMORY_EXPLICIT_RE =
  /记住|记得|别忘了|帮我记着|记一下|不要忘记|偏好|喜欢|讨厌|不喜欢|禁忌|生日|纪念日|important|remember|prefer/i;

export const MEMORY_RECALL_HINT_RE =
  /之前|上次|说过|刚才|刚刚|前面|earlier|before|last time|you said/i;

export const MEMORY_SUMMARY_PRIORITY_RE =
  /之前|上次|说过|刚才|刚刚|记住|记得|偏好|喜欢|讨厌|习惯|禁忌|生日|纪念日|承诺|答应|prefer|remember|you said|last time|promise/i;

export const AMBIGUOUS_FOLLOWUP_RE =
  /^(你确定(?:吗)?[？?]?$|(?:真的|确实)(?:吗)?[？?]?$|(?:是吗|对吗|对不对)[？?]?$|(?:为什么|为何)[？?]?$|(?:然后呢|接着呢)[？?]?$|[？?。,\s]+)$/;

export function isAmbiguousFollowUpMessage(message: string): boolean {
  const t = message.trim();
  if (!t) return false;
  if (t.length > 20) return false;
  return AMBIGUOUS_FOLLOWUP_RE.test(t);
}

export const AGENT_COMMITMENT_RE =
  /我会|我将|已为你|已经帮你|已设置|已创建|已添加|已安排|已提醒|帮你记住|帮你查|结论是|建议是|remember to|i will|i've set/i;

export type MemorySignalResult = {
  isHighSignal: boolean;
  reasons: string[];
  extractLines: string[];
};

function firstSentence(text: string, maxLen: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return "";
  const cut = t.split(/[。！？?!\n]/)[0]?.trim() || t;
  return cut.length > maxLen ? `${cut.slice(0, maxLen)}...` : cut;
}

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

  const isHighSignal =
    reasons.includes("explicit_remember") || reasons.includes("agent_commitment");

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

export function shouldInjectMemorySummary(message: string): boolean {
  const t = message.trim();
  if (!t) return false;
  if (MEMORY_EXPLICIT_RE.test(t)) return true;
  if (MEMORY_RECALL_HINT_RE.test(t)) return true;
  return MEMORY_SUMMARY_PRIORITY_RE.test(t);
}

export function buildFollowUpAnchorPrompt(message: string): string | undefined {
  if (!isAmbiguousFollowUpMessage(message)) return undefined;
  return "FU|anchor=prev-assistant|topic=last|calendar=schedule-only";
}
