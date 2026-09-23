/**
 * 回复风格闸（Reply Style Gate，2026-09-22）：
 * 在 TurnFinalizer 收口对最终回复做**程序层**人格强制——不靠 prompt 求模型，
 * 直接对越形回复做确定性整形。动机（真机轨迹 3b22ae220b1a4a97）：
 * 模型在长上下文里无视【说话方式】的简短基准，产出 4 大段道歉式找补+
 * 连环让步收尾；prompt 加规则已被证伪（上下文太多模型不听），唯一可靠的是
 * 产出侧机械执法。
 *
 * 设计约束：
 * - 正常回复零接触：先检测、有越形才动刀——不动合格回复一个字节；
 * - 零 token / 零延迟：纯正则 + 句级手术，不加任何 LLM 调用；
 * - 协议块保真：NEXT_UP / 渲染标记 / 卡片块先摘出、整形后原样拼回，
 *   不破坏 ws 层（chat-user-message）的协议提取；
 * - 永不变差：整形结果为空时回退原文；只删句、不改写、不重排；
 * - 车道差异：overlong 只管 chat 面（task 交付天然长、由结构豁免）；
 *   人格检查（道歉/找补/连环让步）双车道同规。
 *
 * 与 assistant-humanizer 的分工：humanizer（去重/口头禅清理）挂在认知快路径
 * 与工具结果处理器；本闸挂在主管道唯一收口 TurnFinalizer，主管在此前没有任何
 * 文本级执法。互不替代。
 */

export type ReplyStyleLane = "chat" | "task";

export type ReplyStyleViolation =
  | "apology_persona" // 道歉开场 / 道歉词堆积
  | "hedge_pileup" // 找补/自证堆积（"我不编""怕你糟心""实话讲"连环）
  | "offer_pileup" // 连环让步式收尾（"截图丢给我""或者你想让我""我帮你存"）
  | "self_explain" // 能力自诉句（"我的问题在于：我看不到…"——结论已给，这就是废话）
  | "overlong"; // chat 面纯文本超长（无结构却超过句数/字数上限）

export type ReplyStyleGateResult = {
  text: string;
  changed: boolean;
  violations: ReplyStyleViolation[];
};

/** 总开关：REPLY_STYLE_GATE=off|0|false 时整闸旁路（默认开） */
function isGateDisabled(): boolean {
  const raw = (process.env.REPLY_STYLE_GATE ?? "").trim().toLowerCase();
  return raw === "off" || raw === "0" || raw === "false";
}

// ── 协议块：先摘出、整形后原样拼回（与 reply-envelope 的剥离语义一致）──

const PROTOCOL_BLOCK_RE =
  /\[(?:NEXT_UP|AGENT_RESULT_CARD|DATA_BRIEF|VIDEO_MEDIA|CHAT_MEDIA|CONTENT_SUMMARY_V2|IMAGE_RESULT)_(?:START|END)\][\s\S]*?(?:\[(?:NEXT_UP|AGENT_RESULT_CARD|DATA_BRIEF|VIDEO_MEDIA|CHAT_MEDIA|CONTENT_SUMMARY_V2|IMAGE_RESULT)_(?:START|END)\]|$)/g;
const PROTOCOL_INLINE_MARKER_RE =
  /\[(?:RENDER_HINT|RENDER_AS):[A-Za-z_]+\]|\[(?:NEXT_UP|AGENT_RESULT_CARD|DATA_BRIEF|VIDEO_MEDIA|CHAT_MEDIA|CONTENT_SUMMARY_V2|IMAGE_RESULT)_(?:START|END)\]/g;

/** 摘出协议块/标记，返回（裸正文, 待拼回片段）。片段按原文出现顺序保序。 */
export function extractProtocolBlocks(text: string): { body: string; blocks: string[] } {
  const blocks: string[] = [];
  let body = text.replace(PROTOCOL_BLOCK_RE, (m) => {
    blocks.push(m);
    return "\n";
  });
  body = body.replace(PROTOCOL_INLINE_MARKER_RE, (m) => {
    blocks.push(m);
    return "";
  });
  return { body: body.trim(), blocks };
}

// ── 人格特征词面 ──

/** 道歉词：聊天回复里的道歉腔（用户 2026-09-22 定调：不要道歉人格） */
const APOLOGY_WORD_RE = /(抱歉|不好意思|对不起|恕我|请谅解|请见谅)/;
/** 事实词：句内含这些（或数字/链接）说明承载信息，删句手术要绕开 */
const FACT_MARKER_RE = /(查到|搜到|查不到|搜不到|知道|订好|已订|完成|失败|\d|https?:\/\/)/;
/** 找补/自证腔：单句出现 1 次是坦诚，连环出现就是道歉人格 */
const HEDGE_RE =
  /(怕给你|怕你(?:看|多想|嫌弃|介意)|反倒(?:糟心|添堵|闹心)|糟心|我不编|不瞎编|不敢乱说|不敢保证|实话(?:讲|说)|坦白(?:讲|说)|说句实话|丑话说在前|别嫌弃)/g;
/** 让步式收尾：主动递出一串补偿选项，正常人不这么说话 */
const OFFER_RE =
  /(或者你?想让我|你也可以|要不要我|你可以让我|丢给我|截图发|发给我，我|我帮你存|你就让我|需要的话我|我帮你盯着|我帮你留意|吱一声)/g;
/** 能力自诉·强标记：结论已经给过，这类句子是同义反复的废话本体，直接删 */
const SELF_EXPLAIN_STRONG_RE =
  /(我的问题(?:在于|是)|我看不到|我抓不着|我抓不到|我看不了|限于(?:能力|权限)|这(?:是|属于)我的(?:能力|局限)(?:问题|边界)?)/;
/** 能力自诉·弱标记：单看是正常说明，仅在找补/超长已定罪时一并删 */
const SELF_EXPLAIN_WEAK_RE = /(我只能|我搜不了|我无法|我这边看不到)/;

// ── 句级手术 ──

/** 分句（含句末标点；；与换行同作边界，让"；或者…"式连环让步能被切开） */
function splitSentences(text: string): string[] {
  return [...text.matchAll(/[^。！？!?；;\n]+[。！？!?；;]?/gu)]
    .map((m) => m[0]?.trim() ?? "")
    .filter(Boolean);
}

function countMatches(text: string, re: RegExp): number {
  return [...text.matchAll(new RegExp(re.source, "gu"))].length;
}

function hasStructure(text: string): boolean {
  return (
    /(^|\n)\s*(?:#{1,3}\s|[-*•]\s|\d+[.)、]\s)/.test(text) ||
    text.split("\n").some((l) => l.split("|").length >= 3) ||
    /```|https?:\/\/|\[[^\]]+\]\(/.test(text)
  );
}

function isDroppableApology(sentence: string): boolean {
  return APOLOGY_WORD_RE.test(sentence) && !FACT_MARKER_RE.test(sentence);
}

function isHedgeOnlySentence(sentence: string): boolean {
  return countMatches(sentence, HEDGE_RE) >= 2 && !FACT_MARKER_RE.test(sentence);
}

function isOfferSentence(sentence: string): boolean {
  return countMatches(sentence, OFFER_RE) >= 1 && !FACT_MARKER_RE.test(sentence);
}

/** 除本句外，是否还有别的句子承载搜索结论（查到/搜到/没有结果类事实） */
function factCarriedElsewhere(sentences: string[], exclude: string): boolean {
  return sentences.some((s) => s !== exclude && FACT_MARKER_RE.test(s));
}

/**
 * 能力自诉句删除判定：强标记句（"我的问题在于：我看不到…"）在已有别句承载
 * 事实时是纯废话；弱标记句（"我只能…"）仅在找补/超长已定罪时随案删除。
 */
function isDroppableSelfExplain(
  sentence: string,
  violations: ReplyStyleViolation[],
  factCarriedElsewhere: boolean,
): boolean {
  if (SELF_EXPLAIN_STRONG_RE.test(sentence)) {
    return factCarriedElsewhere || violations.includes("hedge_pileup");
  }
  if (SELF_EXPLAIN_WEAK_RE.test(sentence)) {
    return (
      factCarriedElsewhere &&
      (violations.includes("hedge_pileup") ||
        violations.includes("overlong") ||
        violations.includes("offer_pileup"))
    );
  }
  return false;
}

// chat 面纯文本上限：超过即砍。正常人微信式回复到不了这个量级。
const CHAT_MAX_SENTENCES = 3;
const CHAT_MAX_PLAIN_CHARS = 160;
const CHAT_KEEP_SENTENCES = 2;
const CHAT_KEEP_PLAIN_CHARS = 120;

/**
 * 执法入口：检测 + 越形才整形。
 * 检测在协议块摘出后的裸正文上做；整形只做句级删除，绝不改写、不重排。
 */
export function enforceReplyStyle(
  rawText: string,
  lane: ReplyStyleLane = "chat",
): ReplyStyleGateResult {
  if (!rawText || isGateDisabled()) return { text: rawText, changed: false, violations: [] };

  const { body, blocks } = extractProtocolBlocks(rawText);
  if (!body) return { text: rawText, changed: false, violations: [] };

  const violations = detectViolations(body, lane);
  if (violations.length === 0) return { text: rawText, changed: false, violations: [] };

  const trimmedBody = trimBody(body, violations, lane);
  if (!trimmedBody || trimmedBody === body) {
    return { text: rawText, changed: trimmedBody !== body, violations };
  }
  const suffix = blocks.length > 0 ? `\n\n${blocks.join("")}` : "";
  return { text: `${trimmedBody}${suffix}`, changed: true, violations };
}

function detectViolations(body: string, lane: ReplyStyleLane): ReplyStyleViolation[] {
  const out: ReplyStyleViolation[] = [];
  const sentences = splitSentences(body);
  const apologyCount = countMatches(body, APOLOGY_WORD_RE);
  const firstSentence = sentences[0] ?? "";
  const apologyOpening =
    APOLOGY_WORD_RE.test(firstSentence.replace(/^[\s\p{Extended_Pictographic}*#\-—－]*/u, "")) &&
    sentences.length >= 2;
  if (apologyOpening || apologyCount >= 2) out.push("apology_persona");
  if (countMatches(body, HEDGE_RE) >= 2) out.push("hedge_pileup");
  if (countMatches(body, OFFER_RE) >= 2) out.push("offer_pileup");
  if (
    sentences.length >= 2 &&
    sentences.some((s) => SELF_EXPLAIN_STRONG_RE.test(s) || SELF_EXPLAIN_WEAK_RE.test(s))
  ) {
    out.push("self_explain");
  }
  if (
    lane === "chat" &&
    !hasStructure(body) &&
    (sentences.length > CHAT_MAX_SENTENCES ||
      body.replace(/[\s*#>`~|]/g, "").length > CHAT_MAX_PLAIN_CHARS)
  ) {
    out.push("overlong");
  }
  return out;
}

/** 供隔离重写产物复检：越形产物不合格时回退确定性整形结果 */
export function detectReplyStyleViolations(
  text: string,
  lane: ReplyStyleLane = "chat",
): ReplyStyleViolation[] {
  const { body } = extractProtocolBlocks(text);
  if (!body) return [];
  return detectViolations(body, lane);
}

function trimBody(
  body: string,
  violations: ReplyStyleViolation[],
  lane: ReplyStyleLane,
): string {
  const sentences = splitSentences(body);
  const structured = hasStructure(body);

  // 结构化正文（交付/表格/链接）：人格词只做最小手术（删道歉句），不做长度/找补大手术，
  // 避免破坏交付结构。
  if (structured) {
    const kept = sentences.filter((s) => !isDroppableApology(s));
    return kept.length > 0 ? kept.join("") : body;
  }

  let kept = sentences.filter((s) => {
    if (isDroppableApology(s)) return false;
    if (violations.includes("hedge_pileup") && isHedgeOnlySentence(s)) return false;
    if (violations.includes("offer_pileup") && isOfferSentence(s)) return false;
    if (
      violations.includes("self_explain") &&
      isDroppableSelfExplain(s, violations, factCarriedElsewhere(sentences, s))
    ) {
      return false;
    }
    return true;
  });

  // overlong：正文没有结构却超过上限 → 只保留前若干句（信息密度最高的开头）。
  if (violations.includes("overlong")) {
    const capped: string[] = [];
    let plain = 0;
    for (const s of kept) {
      const sPlain = s.replace(/[\s*#>`~|]/g, "").length;
      if (capped.length >= CHAT_KEEP_SENTENCES || plain + sPlain > CHAT_KEEP_PLAIN_CHARS) break;
      capped.push(s);
      plain += sPlain;
    }
    if (capped.length > 0) kept = capped;
  }

  // 永不变差：删空了就不如不删——回退原正文
  if (kept.length === 0) return body;
  return kept.join("");
}
