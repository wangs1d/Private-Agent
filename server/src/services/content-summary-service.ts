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

const SUMMARY_THRESHOLD = 350;

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
 * 仅对「值得折叠」的长内容启用摘要卡，避免普通长回复频繁出现折叠框。
 */
export function isEligibleForSummaryCard(
  category: ContentCategory,
  content: string,
  features: {
    hasSections: boolean;
    hasList: boolean;
    hasTable: boolean;
    lineCount: number;
    sectionCount: number;
    listItemCount: number;
  },
): boolean {
  const len = content.length;
  const { hasSections, hasList, hasTable, lineCount, sectionCount, listItemCount } =
    features;

  if (len < 280) return false;

  switch (category) {
    case "news":
      return len >= 350 || /日报|新闻简报|资讯速递|早报|晚报/.test(content);
    case "data":
      return (
        len >= 400 ||
        /调研|研究报告|分析报告|行业报告|竞品分析|数据支撑/.test(content)
      );
    case "list":
      return (
        hasList &&
        listItemCount >= 5 &&
        (lineCount >= 8 || /步骤|教程|操作指引|如何|第一步|流程/.test(content))
      );
    case "multi_section":
      return len >= 700 && sectionCount >= 3;
    case "table":
      return len >= 650 && hasTable;
    case "search_result":
      return len >= 950;
    case "article":
      return len >= 1100;
    case "webpage":
    case "document":
      return len >= 850;
    case "code":
      return len >= 900 && lineCount >= 20;
    default:
      return len >= 1500 && (hasSections || hasList);
  }
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

function extractResearchBriefPoints(
  content: string,
  maxCount: number = 8,
): BriefPoint[] {
  const config = CATEGORY_CONFIG.data;
  const icons = config.briefIcons;
  const points: BriefPoint[] = [];
  const sections = parseSections(content);
  let index = 0;

  const pushText = (text: string, sectionTitle?: string) => {
    if (index >= maxCount) return;
    const clean = text.trim();
    if (clean.length < 6) return;
    const limit = 320;
    points.push({
      icon: icons[index % icons.length],
      text: clean.length > limit ? `${clean.slice(0, limit - 3)}...` : clean,
      section: sectionTitle,
    });
    index++;
  };

  for (const section of sections) {
    const title = section.title.trim();
    if (title && DATA_SUPPORT_SECTION_RE.test(title)) {
      continue;
    }

    const isConclusion =
      !title || CONCLUSION_SECTION_RE.test(title) || points.length === 0;

    if (!isConclusion) continue;

    if (title) {
      pushText(`【${title}】`, title);
    }
    for (const item of section.items) {
      if (index >= maxCount) break;
      pushText(item, title || undefined);
    }
  }

  if (points.length > 0) {
    return points;
  }

  const sentences = content
    .split(/[。！？.!?;\n]/)
    .filter((s) => s.trim().length > 10);
  for (let i = 0; i < Math.min(sentences.length, maxCount); i++) {
    const sentence = sentences[i].trim();
    points.push({
      icon: icons[i % icons.length],
      text: sentence.length > 200 ? `${sentence.slice(0, 197)}...` : sentence,
    });
  }
  return points;
}

function extractBriefPoints(content: string, category: ContentCategory, maxCount: number = 6): BriefPoint[] {
  if (category === "data") {
    return extractResearchBriefPoints(content, Math.max(maxCount, 8));
  }

  const config = CATEGORY_CONFIG[category];
  const icons = config.briefIcons;
  const points: BriefPoint[] = [];
  
  const contentType = detectContentType(content);
  const { hasSections, hasList } = contentType.features;

  if (hasSections) {
    const sections = parseSections(content);
    let globalIndex = 0;
    
    for (const section of sections) {
      if (globalIndex >= maxCount) break;
      
      if (section.title && !points.find(p => p.text === section.title)) {
        points.push({
          icon: icons[globalIndex % icons.length],
          text: `【${section.title}】`,
          section: section.title,
        });
        globalIndex++;
      }

      for (const item of section.items.slice(0, 2)) {
        if (globalIndex >= maxCount) break;
        
        const cleanItem = item
          .replace(/^[\s]*[-•*→▸‣⁃◦·#*]+\s*/, "")
          .replace(/^[""「『【]/, "")
          .replace(/[""」』】]$/, "")
          .trim();

        if (cleanItem.length >= 8 && cleanItem.length <= 180) {
          points.push({
            icon: icons[globalIndex % icons.length],
            text: cleanItem.length > 120 ? cleanItem.slice(0, 117) + "..." : cleanItem,
            section: section.title || undefined,
          });
          globalIndex++;
        }
      }
    }
  } else if (hasList) {
    const lines = content.split("\n").filter(l => l.trim());
    let index = 0;

    for (const line of lines) {
      if (index >= maxCount) break;

      const trimmed = line.trim();
      const hasEmoji = /^[\p{Emoji_Presentation}\p{Extended_Pictographic}]/u.test(trimmed);

      if (hasEmoji) {
        const emojiMatch = trimmed.match(/^([\p{Emoji_Presentation}\p{Extended_Pictographic}])\s*(.*)/u);
        if (emojiMatch && emojiMatch[2]?.trim() && emojiMatch[2].trim().length >= 6) {
          points.push({
            icon: emojiMatch[1],
            text: emojiMatch[2].trim().length > 120 ? emojiMatch[2].trim().slice(0, 117) + "..." : emojiMatch[2].trim(),
          });
          index++;
          continue;
        }
      }

      const cleanText = trimmed
        .replace(/^[\s]*[-•*→▸‣⁃◦·#*]+\s*/, "")
        .replace(/^[""「『【]/, "")
        .replace(/[""」』】]$/, "")
        .trim();

      if (cleanText.length >= 8) {
        points.push({
          icon: icons[index % icons.length],
          text: cleanText.length > 120 ? cleanText.slice(0, 117) + "..." : cleanText,
        });
        index++;
      }
    }
  } else {
    const sentences = content.split(/[。！？.!?;\n]/).filter(s => s.trim().length > 10);
    for (let i = 0; i < Math.min(sentences.length, maxCount); i++) {
      const sentence = sentences[i].trim();
      points.push({
        icon: icons[i % icons.length],
        text: sentence.length > 120 ? sentence.slice(0, 117) + "..." : sentence,
      });
    }
  }

  return points;
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

  const briefPoints = extractBriefPoints(content, category, briefPointCount);
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

  console.log(`[ContentSummary] Created: ${category}, ${briefPoints.length} points, ${contentType.features.sectionCount} sections`);

  return {
    id: generateId(),
    category,
    title: extractTitle(content, category),
    briefPoints,
    detailContent: content,
    cardIcon: config.cardIcon,
    cardLabel: config.label,
    sections,
    metadata: {
      source,
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
  const briefText = summary.briefPoints
    .map((point) => `${point.icon} ${point.text}`)
    .join("\n");

  const summaryData = JSON.stringify({
    type: "content_summary_v2",
    id: summary.id,
    category: summary.category,
    title: summary.title,
    cardIcon: summary.cardIcon,
    cardLabel: summary.cardLabel,
    briefCount: summary.briefPoints.length,
    detailContent: summary.detailContent,
    sections: summary.sections,
    metadata: summary.metadata ?? {},
  });

  return `[CONTENT_SUMMARY_V2_START]
${summaryData}
[CONTENT_SUMMARY_V2_END]

${briefText}

<details_card ref="${summary.id}" />`;
}

export function shouldSummarizeContent(content: string, _threshold: number = SUMMARY_THRESHOLD): boolean {
  if (!content?.trim()) return false;
  if (content.includes(CONTENT_SUMMARY_MARKER)) return false;
  if (looksLikeCapabilityOrToolDump(content)) return false;
  if (content.length < 280) return false;

  const contentType = detectContentType(content);
  const category = detectCategory(content);
  return isEligibleForSummaryCard(category, content, contentType.features);
}
