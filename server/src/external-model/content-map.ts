/**
 * ContentMap：大体积文本的确定性结构索引（WP1，2026-09-17）。
 *
 * 借鉴 DeusData/codebase-memory-mcp 的核心思路——「先查紧凑结构，再取最小定向
 * 片段」——把它从代码库推广到任意工具结果原文（网页正文 / JSON / CSV / 代码 /
 * 长文本）。与 ObservationPack 组合：归档原文时顺带建 map（几百字符），
 * obs_recall 用 mode="outline" 看结构、用 query=关键词 定向跳转，替代盲翻页。
 *
 * 防幻觉约束（见方案）：
 *  - 只做确定性规则抽取（标题/表头/键名/签名/段落首句），禁止任何 LLM 改写；
 *  - 所有 offset 基于行锚定/字面量定位，与原文坐标严格一致；
 *  - outline 输出自带「仅供导航，引用细节前先读对应节」的语义（由调用方提示承载）。
 */

export type ContentKind = "markdown" | "code" | "json" | "csv" | "text";

export interface ContentMapSection {
  /** 节标签：标题文本 / JSON 键路径 / 行区间 / 符号签名 / 段落首句（确定性截取）。 */
  title: string;
  /** 原文中的字符偏移（与 obs 原文同一坐标系）。 */
  offset: number;
  /** 节长（字符）。 */
  chars: number;
  /** 层级（markdown 标题级 1-6；其余 kind 恒 1）。 */
  level?: number;
}

export interface ContentMap {
  kind: ContentKind;
  totalChars: number;
  sections: ContentMapSection[];
}

/** 节数上限：超出时回退到均匀分块，保证 outline 渲染体积有界。 */
const MAX_SECTIONS = 120;
/** title 截取长度。 */
const TITLE_MAX_CHARS = 80;
/** 段落分块的最小节长（text/csv 兜底分块粒度）。 */
const TEXT_CHUNK_MIN_CHARS = 400;

// ── kind 识别 ──

function looksLikeJson(text: string): boolean {
  const t = text.trimStart();
  if (!t.startsWith("{") && !t.startsWith("[")) return false;
  if (text.length > 2_000_000) return false; // 超大文本不做全量 parse（防御）
  try {
    void JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function looksLikeCsv(text: string): boolean {
  const lines = text.split("\n", 21).filter((l) => l.trim());
  if (lines.length < 3) return false;
  for (const delim of [",", "\t"]) {
    const counts = lines.slice(0, 20).map((l) => l.split(delim).length);
    if (Math.max(...counts) >= 2) {
      const mode = counts[0]!;
      const consistent = counts.filter((c) => Math.abs(c - mode) <= 1).length;
      if (consistent / counts.length >= 0.8) return true;
    }
  }
  return false;
}

const CODE_SIGNATURE_RE =
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s*\*?\s*[A-Za-z_$][\w$]*|(?:class|def|interface|enum|struct|fn)\s+[A-Za-z_$][\w$]*|(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>)/;

function looksLikeCode(text: string): boolean {
  const lines = text.split("\n");
  let hits = 0;
  for (const line of lines) {
    if (CODE_SIGNATURE_RE.test(line)) hits++;
    if (hits >= 2) return true;
  }
  return false;
}

export function detectContentKind(text: string): ContentKind {
  if (looksLikeJson(text)) return "json";
  if (/^#{1,6}\s+\S/m.test(text.slice(0, 5000))) return "markdown";
  if (looksLikeCsv(text)) return "csv";
  if (looksLikeCode(text)) return "code";
  return "text";
}

// ── 各 kind 的节抽取（全部行锚定，offset 精确） ──

function extractMarkdownSections(text: string): ContentMapSection[] {
  const sections: ContentMapSection[] = [];
  const re = /^(#{1,6})\s+(.+)$/gm;
  const marks: Array<{ offset: number; level: number; title: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    marks.push({ offset: m.index, level: m[1]!.length, title: m[2]!.trim() });
  }
  if (marks.length === 0) return [];
  // 首个标题前的引言（>80 字符才有导航价值）
  if (marks[0]!.offset > 80) {
    sections.push({
      title: "(开头)",
      offset: 0,
      chars: marks[0]!.offset,
      level: 1,
    });
  }
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i]!;
    const end = i + 1 < marks.length ? marks[i + 1]!.offset : text.length;
    sections.push({
      title: clipTitle(start.title),
      offset: start.offset,
      chars: end - start.offset,
      level: start.level,
    });
  }
  return sections;
}

function extractJsonSections(text: string): ContentMapSection[] {
  // 顶层键名字面量定位：位置可能落在嵌套同名键上，但坐标必然真实，
  // 作为「导航窗口」足够（读回的是原文切片，不依赖 JSON 合法性）。
  const sections: ContentMapSection[] = [
    { title: "(开头)", offset: 0, chars: 0, level: 1 },
  ];
  const re = /"([^"\\\n]{1,60})"\s*:/g;
  let m: RegExpExecArray | null;
  const seen = new Set<number>();
  while ((m = re.exec(text)) !== null && sections.length < MAX_SECTIONS) {
    if (seen.has(m.index)) continue;
    seen.add(m.index);
    sections.push({ title: clipTitle(m[1]!), offset: m.index, chars: 0, level: 1 });
  }
  sections.sort((a, b) => a.offset - b.offset);
  for (let i = 0; i < sections.length; i++) {
    const end = i + 1 < sections.length ? sections[i + 1]!.offset : text.length;
    sections[i]!.chars = end - sections[i]!.offset;
  }
  return sections.filter((s) => s.chars > 0 || s.offset === 0);
}

function extractCsvSections(text: string): ContentMapSection[] {
  // 表头一节 + 每 200 行一节的行区间
  const lines = text.split("\n");
  const header = lines[0] ?? "";
  const sections: ContentMapSection[] = [];
  const ROWS_PER_SECTION = 200;
  let offset = 0;
  let rowStart = 1;
  const pushSection = (endLineIdx: number) => {
    const startOffset = offset;
    // 计算到 endLineIdx 行末的偏移
    let end = startOffset;
    for (let i = rowStart; i <= endLineIdx && i < lines.length; i++) {
      end += lines[i]!.length + 1;
    }
    if (end > startOffset) {
      sections.push({
        title: `第 ${rowStart}-${Math.min(endLineIdx, lines.length - 1)} 行`,
        offset: startOffset,
        chars: end - startOffset,
        level: 1,
      });
    }
    offset = end;
    rowStart = endLineIdx + 1;
  };
  const headerCols = header.split(/[\t,]/).length;
  sections.push({
    title: `表头（${headerCols} 列）: ${clipTitle(header.replace(/[\t,]+/g, " / "))}`,
    offset: 0,
    chars: header.length + 1,
    level: 1,
  });
  offset = header.length + 1;
  for (let i = 1; i < lines.length; i += ROWS_PER_SECTION) {
    pushSection(Math.min(i + ROWS_PER_SECTION - 1, lines.length - 1));
  }
  return sections.filter((s) => s.chars > 0);
}

function extractCodeSections(text: string): ContentMapSection[] {
  const sections: ContentMapSection[] = [];
  const lines = text.split("\n");
  const marks: Array<{ offset: number; title: string }> = [];
  let offset = 0;
  for (const line of lines) {
    if (CODE_SIGNATURE_RE.test(line)) {
      marks.push({ offset, title: clipTitle(line.trim()) });
    }
    offset += line.length + 1;
  }
  if (marks.length === 0) return [];
  if (marks[0]!.offset > 80) {
    sections.push({ title: "(开头)", offset: 0, chars: marks[0]!.offset, level: 1 });
  }
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i]!;
    const end = i + 1 < marks.length ? marks[i + 1]!.offset : text.length;
    sections.push({ title: start.title, offset: start.offset, chars: end - start.offset, level: 1 });
  }
  return sections;
}

function extractTextSections(text: string): ContentMapSection[] {
  // 按空行分段，累计 ≥ TEXT_CHUNK_MIN_CHARS 才成节
  const sections: ContentMapSection[] = [];
  const re = /\n\s*\n/g;
  const breaks: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) breaks.push(m.index);
  let start = 0;
  for (const br of breaks) {
    if (br - start >= TEXT_CHUNK_MIN_CHARS) {
      const slice = text.slice(start, br);
      sections.push({
        title: clipTitle(firstLine(slice)),
        offset: start,
        chars: br - start,
        level: 1,
      });
      start = br + (text.slice(br).match(/^\n\s*\n/)?.[0]?.length ?? 1);
    }
  }
  if (start < text.length) {
    const slice = text.slice(start);
    if (slice.trim()) {
      sections.push({
        title: clipTitle(firstLine(slice)),
        offset: start,
        chars: slice.length,
        level: 1,
      });
    }
  }
  return sections;
}

function uniformChunks(text: string, targetCount: number): ContentMapSection[] {
  const lines = text.split("\n");
  const perChunk = Math.max(1, Math.ceil(lines.length / targetCount));
  const sections: ContentMapSection[] = [];
  let offset = 0;
  for (let i = 0; i < lines.length; i += perChunk) {
    const chunkLines = lines.slice(i, i + perChunk);
    const chars = chunkLines.reduce((s, l) => s + l.length + 1, 0);
    sections.push({
      title: clipTitle(firstLine(chunkLines.join("\n"))),
      offset,
      chars,
      level: 1,
    });
    offset += chars;
  }
  return sections.filter((s) => s.chars > 0);
}

// ── 查询打分（BM25-lite + 可选语义向量混合，WP1.1 精确度优化） ──

function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const w of text.toLowerCase().match(/[a-z0-9][a-z0-9._-]*/g) ?? []) {
    tokens.push(w);
  }
  const cjk = text.match(/[\u4e00-\u9fa5]/g) ?? [];
  for (let i = 0; i < cjk.length - 1; i++) {
    tokens.push(cjk[i]! + cjk[i + 1]!);
  }
  return tokens;
}

function cosineVec(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** 语义混合打分的输入：query 向量 + 与 map.sections 对齐的节向量。 */
export interface SemanticHint {
  queryVector: ArrayLike<number>;
  sectionVectors: ArrayLike<number>[];
  /** 显式覆盖融合权重 0-1（缺省自适应：词面有证据 0.25 / 零证据 0.75）。 */
  weight?: number;
}

export interface ScoredSection {
  section: ContentMapSection;
  /** 词面分（idf 加权 + 标题加成 + 长度惩罚 + 覆盖度加成）。 */
  lexical: number;
  /** 语义余弦相似度 0-1（无语义输入时恒 0）。 */
  semantic: number;
  /** 混合归一总分（用于排序与置信判断）。 */
  final: number;
  /** 命中的 distinct query 词数 / query 总词数。 */
  matchedRatio: number;
}

/**
 * 详尽打分（降序）。词面侧在 BM25-lite 基础上叠加覆盖度加成
 * （命中 distinct query 词的比例）——修复「标题/表头小节靠单一常见词 +
 * 标题加成反超真证据节」的缺陷。语义侧可选：提供 SemanticHint 时按
 * 余弦相似度归一后与词面归一分加权融合，任一侧缺失自动退化为单侧。
 */
export function scoreSectionsDetailed(
  map: ContentMap,
  rawText: string,
  query: string,
  semantic?: SemanticHint,
): ScoredSection[] {
  const qTokens = [...new Set(tokenize(query))];
  if (map.sections.length === 0) return [];
  const SCOPE_SAMPLE_CHARS = 8000;
  const sectionTokens = map.sections.map((s) =>
    tokenize((s.title + " ") + rawText.slice(s.offset, s.offset + Math.min(s.chars, SCOPE_SAMPLE_CHARS))),
  );

  // 词面：正文证据为主（tf/df/长度惩罚），标题证据为辅（小额加分、不参与长度惩罚）
  // ——标题与正文分离计分，杜绝「标题/表头小节靠标题词×加成反超真证据节」
  const df = new Map<string, number>();
  for (const tokens of sectionTokens) {
    const uniq = new Set(tokens);
    for (const t of qTokens) {
      if (uniq.has(t)) df.set(t, (df.get(t) ?? 0) + 1);
    }
  }
  const lexicals = map.sections.map((s, i) => {
    const tf = new Map<string, number>();
    for (const t of sectionTokens[i]!) tf.set(t, (tf.get(t) ?? 0) + 1);
    const titleTokens = new Set(tokenize(s.title));
    let bodyScore = 0;
    let titleScore = 0;
    let matched = 0;
    for (const t of qTokens) {
      const freq = tf.get(t) ?? 0;
      if (freq > 0) {
        matched++;
        const idf = Math.log(1 + map.sections.length / (df.get(t) ?? 0));
        bodyScore += (1 + Math.log(freq)) * idf;
      }
      if (titleTokens.has(t)) titleScore += Math.log(1 + map.sections.length / (df.get(t) ?? 0));
    }
    // 长度归一只惩罚正文（巨节天然词频优势），绝不奖励小节
    const penalized = bodyScore / Math.max(1, Math.log(1 + s.chars / 2000));
    const raw = penalized + 0.5 * titleScore;
    // 覆盖度加成：命中越多不同 query 词的证据节越可信
    const coverage = qTokens.length > 0 ? matched / qTokens.length : 0;
    return { raw: raw * (1 + coverage), matched };
  });

  // 语义：余弦 0-1
  const semantics = map.sections.map((_, i) => {
    if (!semantic || !semantic.sectionVectors[i]) return 0;
    return Math.max(0, cosineVec(semantic.queryVector, semantic.sectionVectors[i]!));
  });

  // 自适应融合权重：词面侧已有像样的证据（≥1/3 query 词命中同一文档）→ 语义只做
  // 仲裁（直接证据优先，防语义噪音带偏）；词面零/弱证据（同义改写场景）→ 语义主导。
  // 显式传 weight 时以调用方为准。
  const hasSemantic = !!semantic;
  const bestCoverage = qTokens.length > 0
    ? Math.max(0, ...lexicals.map((x) => x.matched)) / qTokens.length
    : 0;
  const w = semantic?.weight ?? (hasSemantic ? (bestCoverage >= 0.34 ? 0.25 : 0.75) : 0);

  // 各自按最大值归一后加权融合（两侧量纲无关）
  const maxLex = Math.max(0, ...lexicals.map((x) => x.raw));
  const maxSem = Math.max(0, ...semantics);
  const scored = map.sections.map((s, i) => {
    const lexN = maxLex > 0 ? lexicals[i]!.raw / maxLex : 0;
    const semN = maxSem > 0 ? semantics[i]! / maxSem : 0;
    const final = (1 - w) * lexN + w * semN;
    return {
      section: s,
      lexical: lexicals[i]!.raw,
      semantic: semantics[i]!,
      final,
      matchedRatio: qTokens.length > 0 ? lexicals[i]!.matched / qTokens.length : 0,
    };
  });
  return scored
    .filter((x) => x.final > 0)
    .sort((a, b) => b.final - a.final);
}

/** 按 query 给各节打分（降序），只返回节（兼容旧调用方）。 */
export function scoreSections(
  map: ContentMap,
  rawText: string,
  query: string,
  semantic?: SemanticHint,
): ContentMapSection[] {
  return scoreSectionsDetailed(map, rawText, query, semantic).map((x) => x.section);
}

export interface QueryWindow {
  offset: number;
  chars: number;
  /** 命中的节标题（按得分降序，最多 3 个）。 */
  matchedTitles: string[];
  /** 次优候选节标题（最多 3 个）——top 窗口未含答案时换词重试的导航提示。 */
  alternatives?: string[];
  /** true=top 窗口缺直接证据（零词面命中且语义弱），调用方应提示模型换词/翻页。 */
  lowConfidence?: boolean;
}

/**
 * 解析 query → 定向读回窗口：以最高分节为锚，优先向后合并相邻节、不足再向前，
 * 直到接近 budgetChars；词面零命中且语义弱的低置信场景附 alternatives。
 * 大节（> budget）在节内按最早 query 词命中位置切预算窗口（命中点居中）。
 */
export function resolveQueryWindow(
  map: ContentMap,
  rawText: string,
  query: string,
  budgetChars: number,
  semantic?: SemanticHint,
): QueryWindow | null {
  const ranked = scoreSectionsDetailed(map, rawText, query, semantic);
  if (ranked.length === 0) return null;
  const best = ranked[0]!;
  const matchedTitles = ranked.slice(0, 3).map((x) => x.section.title);
  // 次优候选：文档结构里除已命中节外的其余节（doc 序，最多 3 个）——top 窗口没找到
  // 答案时的换词导航提示（候选节按原始结构列出，不依赖打分为正）
  const matchedSet = new Set(matchedTitles);
  const alternatives = map.sections
    .filter((s) => !matchedSet.has(s.title))
    .slice(0, 3)
    .map((s) => s.title);
  // 低置信：top 节没有任何直接词面证据，且语义相似度也不高 → 明示模型换策略
  const lowConfidence = best.matchedRatio === 0 && best.semantic < 0.6;
  const base: QueryWindow = {
    offset: 0,
    chars: 0,
    matchedTitles,
    ...(alternatives.length > 0 ? { alternatives } : {}),
    ...(lowConfidence ? { lowConfidence } : {}),
  };

  // 锚点节本身超预算（CSV 大行块/超长段落）：在节内找最早命中 query 词的位置，
  // 以该位置为锚切出预算窗口；纯语义命中（无词面锚）取节头预算窗
  if (best.section.chars > budgetChars) {
    const bodyStart = best.section.offset;
    const body = rawText.slice(bodyStart, bodyStart + best.section.chars);
    const tokens = [...new Set(tokenize(query))].sort((a, b) => b.length - a.length);
    let pos = -1;
    for (const t of tokens) {
      const i = body.indexOf(t);
      if (i >= 0 && (pos < 0 || i < pos)) pos = i;
    }
    const start = pos >= 0 ? Math.max(bodyStart, bodyStart + pos - 200) : bodyStart;
    const end = Math.min(bodyStart + best.section.chars, start + budgetChars);
    return { ...base, offset: start, chars: end - start };
  }

  const order = map.sections;
  const bestIdx = Math.max(0, order.indexOf(best.section));
  let startIdx = bestIdx;
  let endIdx = bestIdx;
  // 次优节与 top 接近同分且物理相邻 → 并入同一窗口（边界模糊场景一次给够）
  const second = ranked[1];
  if (second && second.final >= 0.75 * best.final) {
    const i2 = order.indexOf(second.section);
    if (Math.abs(i2 - bestIdx) === 1) {
      startIdx = Math.min(startIdx, i2);
      endIdx = Math.max(endIdx, i2);
    }
  }
  const spanChars = () => {
    const start = order[startIdx]!.offset;
    const last = order[endIdx]!;
    return Math.min(last.offset + last.chars, rawText.length) - start;
  };
  // 优先向后扩展（阅读顺序自然）；到尾再向前补
  while (endIdx + 1 < order.length && spanChars() < budgetChars) endIdx++;
  while (startIdx > 0 && spanChars() < budgetChars) startIdx--;
  const start = order[startIdx]!.offset;
  const end = Math.min(order[endIdx]!.offset + order[endIdx]!.chars, rawText.length);
  return { ...base, offset: start, chars: end - start };
}

// ── outline 渲染 ──

export function renderOutline(map: ContentMap, maxLines = 60): string {
  const lines: string[] = [
    `[${map.kind}] 共 ${map.totalChars} 字符 / ${map.sections.length} 节（仅供导航；引用细节前先用 query=关键词 或 offset 读取对应节原文）`,
  ];
  for (const s of map.sections.slice(0, maxLines)) {
    const indent = s.level && s.level > 1 ? "  ".repeat(Math.min(s.level - 1, 5)) : "";
    lines.push(`${indent}- [${s.offset}] ${s.title} (${s.chars})`);
  }
  if (map.sections.length > maxLines) {
    lines.push(`… 其余 ${map.sections.length - maxLines} 节略（用 query=关键词 定向读取）`);
  }
  return lines.join("\n");
}

// ── 入口 ──

export function buildContentMap(text: string): ContentMap {
  const map: ContentMap = {
    kind: "text",
    totalChars: text.length,
    sections: [],
  };
  if (!text || text.length < 120) return map;
  const kind = detectContentKind(text);
  map.kind = kind;
  let sections: ContentMapSection[];
  switch (kind) {
    case "markdown":
      sections = extractMarkdownSections(text);
      break;
    case "json":
      sections = extractJsonSections(text);
      break;
    case "csv":
      sections = extractCsvSections(text);
      break;
    case "code":
      sections = extractCodeSections(text);
      break;
    default:
      sections = extractTextSections(text);
  }
  // 节数超限 → 均匀分块兜底（保证覆盖全文且体积有界）
  if (sections.length === 0 || sections.length > MAX_SECTIONS) {
    sections = uniformChunks(text, MAX_SECTIONS);
  }
  // 覆盖保障：首节必须从 0 开始
  if (sections.length > 0 && sections[0]!.offset > 0) {
    sections.unshift({ title: "(开头)", offset: 0, chars: sections[0]!.offset, level: 1 });
  }
  map.sections = sections;
  return map;
}

function clipTitle(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= TITLE_MAX_CHARS ? t : t.slice(0, TITLE_MAX_CHARS - 1) + "…";
}

function firstLine(s: string): string {
  return s.split("\n", 1)[0] ?? "";
}
