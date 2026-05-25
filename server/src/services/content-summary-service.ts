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
    label: "数据",
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

function generateId(): string {
  return `sum-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function detectContentType(content: string): {
  category: ContentCategory;
  features: {
    hasSections: boolean;
    hasList: boolean;
    hasTable: boolean;
    hasLongParagraphs: boolean;
    lineCount: number;
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
    }
  };
}

function detectCategory(content: string, source?: string): ContentCategory {
  const lowerSource = (source ?? "").toLowerCase();

  if (lowerSource.includes("news") || lowerSource.includes("search")) {
    return lowerSource.includes("news") ? "news" : "search_result";
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

function extractBriefPoints(content: string, category: ContentCategory, maxCount: number = 6): BriefPoint[] {
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

  const contentType = detectContentType(content);
  const shouldSummarize = forceSummary || 
    content.length > maxLength ||
    contentType.features.hasSections ||
    (contentType.features.lineCount > 15 && contentType.features.hasList);

  if (!shouldSummarize) {
    return null;
  }

  const category = detectCategory(content, source);
  const config = CATEGORY_CONFIG[category];

  const briefPoints = extractBriefPoints(content, category, briefPointCount);
  
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

export function shouldSummarizeContent(content: string, threshold: number = SUMMARY_THRESHOLD): boolean {
  if (content.length > threshold) return true;
  
  const contentType = detectContentType(content);
  return contentType.features.hasSections || 
         (contentType.features.lineCount > 12 && contentType.features.hasList);
}
