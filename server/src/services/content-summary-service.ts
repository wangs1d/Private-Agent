export type ContentCategory =
  | "news"
  | "article"
  | "search_result"
  | "webpage"
  | "document"
  | "code"
  | "data"
  | "list"
  | "multi_section"
  | "table"
  | "general";

export interface BriefPoint {
  icon: string;
  text: string;
  section?: string;
}

export interface ContentSummary {
  id: string;
  category: ContentCategory;
  title: string;
  briefPoints: BriefPoint[];
  detailContent: string;
  cardIcon: string;
  cardLabel: string;
  sections?: SectionInfo[];
  metadata?: {
    source?: string;
    url?: string;
    date?: string;
    author?: string;
    wordCount?: number;
    itemCount?: number;
    sectionCount?: number;
    hasTable?: boolean;
    hasList?: boolean;
    [key: string]: unknown;
  };
  createdAt: string;
}

export interface SectionInfo {
  title: string;
  pointCount: number;
}

export interface SummarizeOptions {
  maxLength?: number;
  briefPointCount?: number;
  forceSummary?: boolean;
}

const CATEGORY_CONFIG: Record<ContentCategory, { 
  icon: string; 
  label: string;
  cardIcon: string;
  briefIcons: string[];
}> = {
  news: { 
    icon: "📰", 
    label: "资讯",
    cardIcon: "☰",
    briefIcons: ["🔥", "💡", "⚡", "🚀", "✨", "📌", "🎯", "💬"]
  },
  article: { 
    icon: "📄", 
    label: "文章",
    cardIcon: "☰",
    briefIcons: ["📝", "📖", "🔍", "💭", "⭐", "🎨"]
  },
  search_result: { 
    icon: "🔍", 
    label: "搜索结果",
    cardIcon: "☰",
    briefIcons: ["🔎", "📊", "🌐", "💡", "📋"]
  },
  webpage: { 
    icon: "🌐", 
    label: "网页",
    cardIcon: "☰",
    briefIcons: ["🔗", "📄", "ℹ️", "📍"]
  },
  document: { 
    icon: "📋", 
    label: "文档",
    cardIcon: "☰",
    briefIcons: ["📑", "📝", "📎", "📁"]
  },
  code: { 
    icon: "💻", 
    label: "代码",
    cardIcon: "☰",
    briefIcons: ["⚙️", "🔧", "🐛", "✅", "📦"]
  },
  data: { 
    icon: "📊", 
    label: "调研报告",
    cardIcon: "☰",
    briefIcons: ["📈", "📉", "🗂️", "📌", "🔢"]
  },
  list: {
    icon: "📋",
    label: "清单",
    cardIcon: "☰",
    briefIcons: ["✅", "📌", "🔹", "▸", "•", "→"]
  },
  multi_section: {
    icon: "📑",
    label: "汇总",
    cardIcon: "☰",
    briefIcons: ["📌", "🔖", "📎", "🏷️", "📁", "📂"]
  },
  table: {
    icon: "📊",
    label: "数据表",
    cardIcon: "☰",
    briefIcons: ["📊", "📈", "📉", "📋", "🔢"]
  },
  general: { 
    icon: "📝", 
    label: "详情",
    cardIcon: "☰",
    briefIcons: ["📌", "💡", "⭐", "📋"]
  },
};

/** 低于此字数不启用摘要折叠卡 */
const SUMMARY_THRESHOLD = 800;

/** 调研报告：主区展示结论类板块，数据类板块仅进详情卡 */
const CONCLUSION_SECTION_RE =
  /结论|核心|要点|建议|总结|发现|概要|摘要|研判|观点|executive|summary|conclusion/i;
const DATA_SUPPORT_SECTION_RE =
  /数据|附录|来源|引用|表格|统计|明细|支撑|证据|样本|方法论|链接|原始|附录|chart|table|source/i;

const CONTENT_SUMMARY_MARKER = "[CONTENT_SUMMARY_V2_START]";

function generateId(): string {
  return `sum-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function looksLikeCapabilityOrToolDump(content: string): boolean {
  const lineCount = content.split("\n").length;
  if (lineCount < 6) return false;
  return (
    /当前可用.*工具|【宿主能力|【Agent World】|wallet\.|search_web|master_invoke/.test(
      content,
    ) && lineCount >= 8
  );
}

/**
 * 仅当内容超过 SUMMARY_THRESHOLD（800 字）时启用摘要卡，避免普通回复频繁出现折叠框。
 */
export function isEligibleForSummaryCard(
  _category: ContentCategory,
  content: string,
  _features: {
    hasSections: boolean;
    hasList: boolean;
    hasTable: boolean;
    lineCount: number;
    sectionCount: number;
    listItemCount: number;
  },
): boolean {
  return content.length >= SUMMARY_THRESHOLD;
}

function detectContentType(content: string): {
  category: ContentCategory;
  features: {
    hasSections: boolean;
    hasList: boolean;
    hasTable: boolean;
    hasLongParagraphs: boolean;
    lineCount: number;
    sectionCount: number;
    listItemCount: number;
  };
} {
  const lines = content.split("\n");
  const lineCount = lines.length;
  
  let sectionCount = 0;
  let listItemCount = 0;
  let tableLikeLines = 0;
  let longParaCount = 0;

  const sectionPatterns = [
    /^#{1,3}\s+/,
    /^(一|二|三|四|五|六|七|八|九|十)[、.．]/,
    /^\d+[、.．)\]]/,
    /^(第[一二三四五六七八九十]+[部分章节])/,
    /^\[.*?\]/,
    /^(##|###|####)\s+/,
  ];

  const listPatterns = [
    /^[\s]*[-•*→▸‣⁃◦·]\s+/,
    /^[\s]*\d+[.)]\s+/,
    /^\*\*.+\*\*[:：]/,
    /^[""「『【].+[""」』】]/,
  ];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    for (const pattern of sectionPatterns) {
      if (pattern.test(trimmed)) {
        sectionCount++;
        break;
      }
    }

    for (const pattern of listPatterns) {
      if (pattern.test(trimmed)) {
        listItemCount++;
        break;
      }
    }

    if (trimmed.includes("|") && trimmed.split("|").length >= 4) {
      tableLikeLines++;
    }

    if (trimmed.length > 150 && !listPatterns.some(p => p.test(trimmed))) {
      longParaCount++;
    }
  }

  const hasSections = sectionCount >= 2;
  const hasList = listItemCount >= 3;
  const hasTable = tableLikeLines >= 2 || (content.includes("|") && content.split("\n").filter(l => l.includes("|")).length >= 3);
  const hasLongParagraphs = longParaCount >= 2;

  let category: ContentCategory = "general";

  if (hasSections && sectionCount >= 3) {
    category = "multi_section";
  } else if (hasTable && tableLikeLines > listItemCount) {
    category = "table";
  } else if (hasList && listItemCount > sectionCount * 2) {
    category = "list";
  } else if (hasLongParagraphs && lineCount < 10) {
    category = "article";
  } else if (
    /调研|研究报告|分析报告|行业报告|竞品分析/.test(content) ||
    (/核心结论|数据支撑|研究结论/.test(content) && (hasSections || hasTable))
  ) {
    category = "data";
  } else if (content.includes("新闻") || content.includes("最新") || content.includes("日报")) {
    category = "news";
  } else if (content.includes("搜索") || content.includes("结果")) {
    category = "search_result";
  }

  return {
    category,
    features: {
      hasSections,
      hasList,
      hasTable,
      hasLongParagraphs,
      lineCount,
      sectionCount,
      listItemCount,
    }
  };
}

function detectCategory(content: string, source?: string): ContentCategory {
  const lowerSource = (source ?? "").toLowerCase();

  if (lowerSource.includes("news")) return "news";
  if (lowerSource.includes("search")) return "search_result";
  if (
    lowerSource.includes("report") ||
    lowerSource.includes("research") ||
    lowerSource.includes("survey")
  ) {
    return "data";
  }

  return detectContentType(content).category;
}

function extractTitle(content: string, category: ContentCategory): string {
  const lines = content.split("\n").filter((line) => line.trim());
  const config = CATEGORY_CONFIG[category];
  const today = new Date().toISOString().split("T")[0];

  const titlePatterns = [
    /^#{1,2}\s+(.+)$/,
    /^(一|二|三|四|五)[、.．\s](.+)$/,
    /^\[(.+?)\]$/,
  ];

  for (const line of lines) {
    const trimmed = line.trim();
    for (const pattern of titlePatterns) {
      const match = trimmed.match(pattern);
      if (match && match[1] && match[1].length < 100) {
        return match[1].trim();
      }
    }
    
    if (trimmed.length > 8 && trimmed.length < 120 && !trimmed.startsWith("-") && !trimmed.startsWith("*")) {
      return trimmed;
    }
  }

  return `${config.label}_${today}`;
}

interface ParsedSection {
  title: string;
  items: string[];
  rawText: string;
}

function parseSections(content: string): ParsedSection[] {
  const sections: ParsedSection[] = [];
  const lines = content.split("\n");
  
  let currentSection: ParsedSection | null = null;
  
  const sectionHeaderPattern = /^#{1,3}\s+|(?:^|\n)(?:[一二三四五六七八九十]+[、.．]|(?:##?\s+))/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    
    if (!trimmed) continue;

    const isSectionHeader = sectionHeaderPattern.test(trimmed) || 
      (/^(一|二|三|四|五|六|七|八|九|十)[、.．]/.test(trimmed) && trimmed.length < 30);

    if (isSectionHeader) {
      if (currentSection) {
        sections.push(currentSection);
      }
      
      const title = trimmed.replace(/^#+\s*/, "").replace(/^[一二三四五六七八九十]+[、.．]\s*/, "");
      currentSection = {
        title,
        items: [],
        rawText: "",
      };
    } else if (currentSection) {
      if (trimmed.length > 5) {
        currentSection.items.push(trimmed);
        currentSection.rawText += (currentSection.rawText ? "\n" : "") + trimmed;
      }
    }
  }

  if (currentSection) {
    sections.push(currentSection);
  }

  return sections.length > 0 ? sections : [{ title: "", items: lines.filter(l => l.trim()), rawText: content }];
}

function truncateBrief(text: string, maxLen: number): string {
  const clean = text.trim();
  if (clean.length <= maxLen) return clean;
  return `${clean.slice(0, maxLen - 3)}...`;
}

function isGenericSummaryTitle(title: string, category: ContentCategory): boolean {
  const config = CATEGORY_CONFIG[category];
  return (
    !title ||
    title.length < 3 ||
    title.startsWith(`${config.label}_`) ||
    /^\d{4}-\d{2}-\d{2}$/.test(title)
  );
}

/** 按内容关键词推断任务主体（如科技新闻、旅游计划） */
const TASK_SUBJECT_RULES: ReadonlyArray<{ pattern: RegExp; subject: string }> = [
  { pattern: /旅游|行程|景点|攻略|自驾|民宿|机票|签证|出境|酒店预订|自由行/, subject: "旅游计划" },
  { pattern: /菜谱|美食|餐厅|探店|小吃|餐饮/, subject: "美食推荐" },
  { pattern: /科技|人工智能|AI\b|芯片|互联网|数码|发布会|大模型|机器人/, subject: "科技新闻" },
  { pattern: /财经|股票|基金|股市|经济|央行|利率|理财/, subject: "财经资讯" },
  { pattern: /健康|医疗|养生|用药|体检/, subject: "健康资讯" },
  { pattern: /健身|运动|训练计划|减脂|增肌/, subject: "运动计划" },
  { pattern: /教育|学习|课程|考试|培训|备考/, subject: "学习资料" },
  { pattern: /育儿|亲子|宝宝|儿童/, subject: "育儿指南" },
  { pattern: /装修|家居|买房|租房|软装/, subject: "家居生活" },
  { pattern: /婚礼|婚庆|婚宴/, subject: "婚礼筹备" },
  { pattern: /购物|商品|比价|电商|优惠|种草/, subject: "购物推荐" },
  { pattern: /日程|待办|会议|提醒|排期|周报|月报/, subject: "日程安排" },
  { pattern: /招聘|简历|面试|求职|offer/i, subject: "求职指导" },
  { pattern: /天气|气温|降水|预报|台风/, subject: "天气预报" },
  { pattern: /电影|剧集|综艺|娱乐|明星/, subject: "娱乐资讯" },
  { pattern: /体育|赛事|球赛|奥运|世界杯/, subject: "体育资讯" },
  { pattern: /汽车|新能源|试驾|车市/, subject: "汽车资讯" },
  { pattern: /政策|法规|条例|政府|通知/, subject: "政策解读" },
  { pattern: /代码|函数|API|程序|编程|Bug|调试|部署/i, subject: "技术文档" },
  { pattern: /步骤|教程|如何|操作指引|说明书|上手/, subject: "操作指南" },
  { pattern: /调研|研究报告|竞品|行业分析|市场分析|白皮书/, subject: "调研报告" },
  { pattern: /新闻|头条|简报|早报|晚报|舆情|要闻/, subject: "新闻资讯" },
];

const CATEGORY_SUBJECT_FALLBACK: Record<ContentCategory, string> = {
  news: "新闻资讯",
  article: "文章阅读",
  search_result: "检索结果",
  webpage: "网页摘录",
  document: "文档资料",
  code: "技术文档",
  data: "调研报告",
  list: "任务清单",
  multi_section: "专题汇总",
  table: "数据表格",
  general: "内容详情",
};

export function inferTaskSubject(
  content: string,
  category: ContentCategory,
  rawTitle: string,
): string {
  const titleHint = rawTitle.trim();
  if (
    !isGenericSummaryTitle(titleHint, category) &&
    titleHint.length >= 4 &&
    titleHint.length <= 18 &&
    /计划|攻略|指南|简报|总结|报告|清单|方案|安排|推荐|资讯|新闻/.test(titleHint)
  ) {
    return titleHint;
  }

  const sample = `${titleHint}\n${content}`.slice(0, 4000);
  for (const rule of TASK_SUBJECT_RULES) {
    if (rule.pattern.test(sample)) {
      return rule.subject;
    }
  }

  return CATEGORY_SUBJECT_FALLBACK[category];
}

function resolveCardTitle(
  rawTitle: string,
  subjectLabel: string,
  category: ContentCategory,
): string {
  if (!isGenericSummaryTitle(rawTitle, category) && rawTitle.length <= 48) {
    return rawTitle.trim();
  }
  return subjectLabel;
}

/** 精简区：对全文的概括性介绍（非正文摘录） */
function buildOverviewIntro(
  content: string,
  subjectLabel: string,
  headline: string,
  features: {
    sectionCount: number;
    listItemCount: number;
    hasTable: boolean;
  },
): string {
  const structureParts: string[] = [];

  if (features.sectionCount >= 2) {
    structureParts.push(`${features.sectionCount} 个板块`);
  } else if (features.listItemCount >= 3) {
    structureParts.push(`${features.listItemCount} 条要点`);
  } else if (features.hasTable) {
    structureParts.push("含表格");
  }

  const structureHint =
    structureParts.length > 0 ? `，${structureParts.join("、")}` : "";

  return `【${subjectLabel}】全文约 ${content.length} 字${structureHint}。`;
}

/** 精简区要点：仅高层主题/结论，不复制详情正文 */
function extractOverviewHighlights(
  content: string,
  category: ContentCategory,
  features: {
    hasSections: boolean;
    hasList: boolean;
    sectionCount: number;
    listItemCount: number;
  },
  maxCount: number,
): BriefPoint[] {
  const config = CATEGORY_CONFIG[category];
  const icons = config.briefIcons;
  const points: BriefPoint[] = [];
  let index = 0;

  const push = (text: string, section?: string) => {
    if (index >= maxCount) return;
    const clean = text.trim();
    if (clean.length < 4) return;
    points.push({
      icon: icons[index % icons.length],
      text: truncateBrief(clean, 100),
      section,
    });
    index++;
  };

  if (features.hasSections) {
    const sections = parseSections(content);
    const titles = sections
      .map((s) => s.title.trim())
      .filter((t) => t.length > 0 && t.length < 50);

    if (category === "data") {
      for (const section of sections) {
        if (index >= maxCount) break;
        const title = section.title.trim();
        if (title && DATA_SUPPORT_SECTION_RE.test(title)) continue;
        if (title && !CONCLUSION_SECTION_RE.test(title) && points.length > 0) continue;
        if (title) {
          push(`板块：${title}`, title);
        } else if (section.items[0]) {
          push(truncateBrief(section.items[0], 80), title);
        }
      }
    } else if (titles.length > 0) {
      if (titles.length <= 4) {
        push(`主要涵盖：${titles.join("、")}`);
      } else {
        push(`主要涵盖 ${titles.length} 个部分：${titles.slice(0, 3).join("、")}等`);
      }
    }
  } else if (features.hasList && features.listItemCount >= 3) {
    push(`清单共 ${features.listItemCount} 项`);
    const lines = content.split("\n").filter((l) => l.trim());
    let picked = 0;
    for (const line of lines) {
      if (picked >= 2 || index >= maxCount) break;
      const trimmed = line.trim();
      const clean = trimmed
        .replace(/^[\s]*[-•*→▸‣⁃◦·#*]+\s*/, "")
        .replace(/^[""「『【]/, "")
        .replace(/[""」』】]$/, "")
        .trim();
      if (clean.length >= 6) {
        push(`示例：${truncateBrief(clean, 55)}`);
        picked++;
      }
    }
  } else {
    const sentences = content
      .split(/[。！？.!?]/)
      .map((s) => s.replace(/\s+/g, " ").trim())
      .filter((s) => s.length >= 12 && s.length <= 200);
    for (let i = 0; i < Math.min(sentences.length, maxCount); i++) {
      push(sentences[i]);
    }
  }

  return points;
}

function extractBriefPoints(
  content: string,
  category: ContentCategory,
  maxCount: number = 6,
  subjectLabel?: string,
): BriefPoint[] {
  const contentType = detectContentType(content);
  const rawTitle = extractTitle(content, category);
  const subject = subjectLabel ?? inferTaskSubject(content, category, rawTitle);
  const cardTitle = resolveCardTitle(rawTitle, subject, category);
  const config = CATEGORY_CONFIG[category];
  const icons = config.briefIcons;

  const intro: BriefPoint = {
    icon: icons[0],
    text: buildOverviewIntro(content, subject, cardTitle, {
      sectionCount: contentType.features.sectionCount,
      listItemCount: contentType.features.listItemCount,
      hasTable: contentType.features.hasTable,
    }),
  };

  const highlights = extractOverviewHighlights(
    content,
    category,
    contentType.features,
    Math.max(1, maxCount - 1),
  );

  return [intro, ...highlights].slice(0, maxCount);
}

export function createContentSummary(
  content: string,
  options: SummarizeOptions & { source?: string } = {}
): ContentSummary | null {
  const {
    maxLength = SUMMARY_THRESHOLD,
    briefPointCount = 6,
    forceSummary = false,
    source,
  } = options;

  if (!content || !content.trim()) {
    return null;
  }

  if (content.includes(CONTENT_SUMMARY_MARKER) || looksLikeCapabilityOrToolDump(content)) {
    return null;
  }

  const contentType = detectContentType(content);
  const category = detectCategory(content, source);

  const eligible =
    forceSummary ||
    isEligibleForSummaryCard(category, content, contentType.features);

  if (!eligible) {
    return null;
  }

  const config = CATEGORY_CONFIG[category];
  const rawTitle = extractTitle(content, category);
  const subjectLabel = inferTaskSubject(content, category, rawTitle);
  const cardTitle = resolveCardTitle(rawTitle, subjectLabel, category);

  const briefPoints = extractBriefPoints(
    content,
    category,
    briefPointCount,
    subjectLabel,
  );
  if (briefPoints.length === 0) {
    return null;
  }
  
  let sections: SectionInfo[] | undefined;
  if (contentType.features.hasSections) {
    const parsed = parseSections(content);
    sections = parsed.map(s => ({
      title: s.title || "未命名",
      pointCount: s.items.length,
    }));
  }

  console.log(`[ContentSummary] Created: ${category}, subject=${subjectLabel}, ${briefPoints.length} points`);

  return {
    id: generateId(),
    category,
    title: cardTitle,
    briefPoints,
    detailContent: content,
    cardIcon: config.cardIcon,
    cardLabel: subjectLabel,
    sections,
    metadata: {
      source,
      subjectLabel,
      wordCount: content.length,
      itemCount: briefPoints.length,
      sectionCount: sections?.length,
      hasTable: contentType.features.hasTable,
      hasList: contentType.features.hasList,
    },
    createdAt: new Date().toISOString(),
  };
}

export function formatContentSummaryForChat(summary: ContentSummary): string {
  const summaryData = JSON.stringify({
    type: "content_summary_v2",
    id: summary.id,
    category: summary.category,
    title: summary.title,
    cardIcon: summary.cardIcon,
    cardLabel: summary.cardLabel,
    subjectLabel: summary.cardLabel,
    briefCount: summary.briefPoints.length,
    detailContent: summary.detailContent,
    sections: summary.sections,
    metadata: summary.metadata ?? {},
  });

  // 仅保留一行简短标题，详情由 <details_card /> 折叠展示
  const titleLine = summary.title
    ? `${summary.cardIcon || "📋"} ${summary.cardLabel || ""}：${summary.title}`
    : "";

  return `[CONTENT_SUMMARY_V2_START]
${summaryData}
[CONTENT_SUMMARY_V2_END]

${titleLine}

<details_card ref="${summary.id}" />`;
}

/**
 * 纯文本格式（微信/Claw 端）：直接输出正文内容，不展示概要元信息。
 */
export function formatContentSummaryForPlainText(summary: ContentSummary): string {
  return summary.detailContent?.trim() ?? "";
}

export function shouldSummarizeContent(content: string, _threshold: number = SUMMARY_THRESHOLD): boolean {
  if (!content?.trim()) return false;
  if (content.includes(CONTENT_SUMMARY_MARKER)) return false;
  if (looksLikeCapabilityOrToolDump(content)) return false;
  if (content.length < SUMMARY_THRESHOLD) return false;

  const contentType = detectContentType(content);
  const category = detectCategory(content);
  return isEligibleForSummaryCard(category, content, contentType.features);
}
