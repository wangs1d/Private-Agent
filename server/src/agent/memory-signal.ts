export const MEMORY_EXPLICIT_RE =
  /记住|记得|别忘了|帮我记着|记一下|不要忘记|偏好|喜欢|讨厌|不喜欢|禁忌|生日|纪念日|important|remember|prefer/i;

/**
 * 跨会话回忆线索：命中说明用户想衔接「更早会话/窗口外」的内容 → 允许触发长期记忆检索。
 * 注意：窗口内指代词（刚才/刚刚/前面）不在此列——它们指向当前窗口内，应由 thread/STM 消解，
 * 一命中就拉长期快照会把昨天/前天的内容注入当前问题，是串台的根因之一（见 recall-gate）。
 */
export const MEMORY_RECALL_HINT_RE =
  /上次|上回|之前|先前|早些时候|说过|谈过|提过|earlier|before|last time|you said/i;

/** 窗口内指代（"刚才那个文件呢"类）：不触发跨会话检索，由 STM/thread 覆盖 */
export const IN_WINDOW_DEIXIS_RE = /刚才|刚刚|才说|才聊|前面|前面(?:说|聊|讲)的|刚说|刚聊/i;

/**
 * 跨会话升级词：即使句子同时带窗口内指代词（刚才/刚刚/之前），命中这些词也说明
 * 用户明确指向「更早的沟通/历史约定」→ 不能短路，应放行长期检索。
 */
const CROSS_SESSION_ESCALATE_RE =
  /(?:上[次回]|昨天|前天|上周|上上周|上上个|那时|那会儿|以前|先前|过去|早先)|(?:说过|谈过|提过|聊过|讲过|聊了|说了|谈了|讲了|商量过|讨论过|约定过|答应过|保证过|告诉过我|提醒过我|记得|还记得|记不记得)|(?:last time|you said|you told|earlier|before|remember)/i;

/**
 * 窗口内纯指代短路：「刚才/刚刚/前面/之前」等指当前窗口内内容时，
 * 由 thread/STM 消解即可，触发长期检索会把更早会话的旧记忆注入当前问题——串台根因之一。
 * 带「上次/昨天/说过/记得」等跨会话升级词时返回 false（放行检索）。
 */
export function isWindowDeixisShortCircuit(message: string): boolean {
  const t = message.trim();
  if (!t) return false;
  if (!IN_WINDOW_DEIXIS_RE.test(t) && !/之前/.test(t)) return false;
  // 显式记忆指令（"记住我刚才说的"）不能短路
  if (MEMORY_EXPLICIT_RE.test(t)) return false;
  // 明确的跨会话/跨天/历史谈话线索优先放行
  if (CROSS_SESSION_ESCALATE_RE.test(t)) return false;
  return true;
}

export const MEMORY_SUMMARY_PRIORITY_RE =
  /之前|上次|上回|先前|说过|谈过|提过|记住|记得|偏好|喜欢|讨厌|习惯|禁忌|生日|纪念日|承诺|答应|earlier|before|prefer|remember|you said|last time|promise/i;

// 追问模式：
// 1) 短问句（"你确定吗/然后呢"等）—— 用 | 串起
// 2) 长度放宽：长一点的追问（"再具体讲讲来龙去脉"10+字）也常出现
// 3) 含明确追问词（再具体/展开/细说/详细/解释/继续/往下）的中等长度句子也算
// 4) 尾部带语气词（呢/啊/吧/哈/嘛）也算追问信号
// 5) 单独仅标点/空字符串也算（兼容纯回复表情的退化场景）
export const AMBIGUOUS_FOLLOWUP_RE =
  /^(?:你确定(?:吗)?[？?]?|(?:真的|确实)(?:吗)?[？?]?|(?:是吗|对吗|对不对)[？?]?|(?:为什么|为何)[？?]?|(?:然后呢|接着呢|后来呢|再然后呢|还有什么|还有吗)|(?:再|再讲)?具体(?:点|一点|一些|讲讲|说说|聊聊|描述描述)|(?:再|讲)?详细(?:点|一点|一些|讲讲|说说)|展开(?:说说|讲讲|聊聊|描述|一下)|细说(?:说|一下)?|说说看|讲讲看|聊聊看|解释(?:一下|下|说说)?|继续(?:说|讲|聊)?|往下(?:说|讲)?|说详细点|讲详细点|聊详细点|说(说|讲|聊)(?:看|下)?|怎么说|怎么讲|怎么弄|咋办|怎么办|为何|为啥|你说呢|你觉得呢|给我(?:看看|讲讲|说说|聊聊)?|然后(?:呢)?|(?:具体|详细)说说|(?:具体|详细)讲讲|具体咋办|具体怎么弄)(?:[？?!！。,\s]*|[啊吧哈嘛呢呀]*)$|[？?。,\s]+$/;

// 显式追问信号词：命中后即使句子较长也算追问
// 用于 followUpAnchor 注入和 isAmbiguousFollowUpMessage 兜底判断
const EXPLICIT_FOLLOWUP_TOKEN_RE =
  /再具体|具体点|具体一点|具体一些|再详细|详细点|详细一点|详细一些|展开说说|展开讲讲|展开聊聊|细说|细讲|说细点|讲细点|继续说|继续讲|往下说|往下讲|解释下|解释一下|继续(?!课)|说(说|讲|聊)看|怎么弄|怎么办|咋办|为何|为啥|你说呢|你觉得呢|给我看看|给我讲讲|给我说说|给我聊聊|聊一聊|讲一讲|说一说|具体咋办|具体怎么弄/i;

const IMMEDIATE_ACTION_FOLLOWUP_RE =
  /^(?=.{1,40}$)(?:快点|快|赶紧|马上|直接|现在|别废话|少说|不要说这么多|别说这么多|不用解释|先别解释|别铺垫|少废话)?\s*(?:去)?(?:搜|搜索|查|查询|检索|查一下|搜一下|看一下|找一下|继续搜|继续查|继续检索)(?:\s*(?:一下|下|吧|啊|呀|哈|呢|先|快点|快|赶紧|直接|别废话|少说|不要说这么多|别说这么多|不用解释|先别解释|别铺垫|少废话))*[。！？?!,\s]*$/i;

export function isImmediateActionFollowUpMessage(message: string): boolean {
  const t = message.replace(/\s+/g, " ").trim();
  if (!t) return false;
  return IMMEDIATE_ACTION_FOLLOWUP_RE.test(t);
}

export function isAmbiguousFollowUpMessage(message: string): boolean {
  const t = message.trim();
  if (!t) return false;
  if (isImmediateActionFollowUpMessage(t)) return true;
  // 放宽长度限制：原 20 字放过长追问（"再具体讲讲来龙去脉"已超 20）
  if (t.length > 40) return false;
  // 命中 AMBIGUOUS_FOLLOWUP_RE → 追问
  if (AMBIGUOUS_FOLLOWUP_RE.test(t)) return true;
  // 长度 ≤ 40 且包含显式追问词 → 也算追问
  if (t.length <= 40 && EXPLICIT_FOLLOWUP_TOKEN_RE.test(t)) return true;
  return false;
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
  // 窗口内纯指代短路：thread/STM 可消解，不注入跨会话记忆摘要（防串台）
  if (isWindowDeixisShortCircuit(t)) return false;
  if (MEMORY_EXPLICIT_RE.test(t)) return true;
  if (MEMORY_RECALL_HINT_RE.test(t)) return true;
  return MEMORY_SUMMARY_PRIORITY_RE.test(t);
}

export function buildFollowUpAnchorPrompt(message: string): string | undefined {
  if (!isAmbiguousFollowUpMessage(message)) return undefined;
  if (isImmediateActionFollowUpMessage(message)) {
    return [
      "FU|anchor=latest-explicit-user-request|topic=last|priority=recent-message-over-memory",
      "本轮是催促/执行型短追问。必须继承最近一条明确用户请求里的对象和任务；不要从长期记忆、旧任务栈或更早话题里补主语；如果最近消息里没有明确对象，先简短问清楚。",
    ].join("\n");
  }
  return "FU|anchor=prev-assistant|topic=last|calendar=schedule-only";
}
