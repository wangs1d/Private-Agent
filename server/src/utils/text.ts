export function chunkText(text: string, size: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size));
  }
  return chunks;
}

/**
 * 折叠相邻的完全相同行（包括跨多轮工具调用时 LLM 自带的「同句复述」）。
 * 不区分大小写、不去重非相邻行,避免误伤包含相同短语的并列项。
 * 用于清理最终回复里与「实时进度句」重复的尾巴,让用户只看到一次。
 */
export function dedupeAdjacentLines(text: string): string {
  if (!text) return text;
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let lastNormalized = "";
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      // 保留空行作为段落分隔,不做折叠
      if (out.length > 0 && out[out.length - 1] !== "") out.push("");
      continue;
    }
    const normalized = trimmed.toLowerCase();
    if (normalized === lastNormalized) continue;
    out.push(raw);
    lastNormalized = normalized;
  }
  // 去掉尾部多余空行
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out.join("\n");
}

/**
 * 将 LLM 原始状态行转换为用户友好的简短动作描述。
 *
 * 设计原则：
 * - 不暴露工具名（如 search_web、browser.fetch_page）
 * - 不展示搜索结果的具体内容
 * - 仅描述 Agent 正在"哪里/如何"获取信息（来源/动作）
 * - 短文本（≤40字）保留原样，通常是简短的思考说明
 */
export function formatStatusForDisplay(rawLine: string): string {
  const t = rawLine.trim();
  if (!t) return "";
  // 短文本直接保留（通常是简短思考/动作说明，不会是结果内容）
  if (t.length <= 40) return t;

  // 网络搜索 / 信息检索类 → 描述为"从网络检索"
  if (
    /搜索|查找|检索|搜到|找到.*?(?:结果|信息|内容|以下)|根据.*?(?:搜索|查询|检索)|bing|必应|google/i.test(t)
  ) {
    return "正在从网络检索相关信息…";
  }

  // 记忆/历史回顾类
  if (/记忆|历史|回顾|之前.*?(?:聊过|说过|提到|讨论|记录|存档|过往)/i.test(t)) {
    return "正在查阅历史记忆…";
  }

  // 网页/链接浏览类
  if (/网页|页面|浏览|打开.*?(?:链接|网址|url|http)/i.test(t)) {
    return "正在浏览网页内容…";
  }

  // 社交平台检索类
  if (/微博|小红书|微信|公众号|抖音|朋友圈|社交/i.test(t)) {
    return "正在从社交平台检索信息…";
  }

  // 代码/技术文档类
  if (/代码|文档|github|仓库|api|接口/i.test(t)) {
    return "正在查阅技术资料…";
  }

  // 其他长文本：截断处理，避免展示大段内容
  return t.slice(0, 30) + "…";
}
