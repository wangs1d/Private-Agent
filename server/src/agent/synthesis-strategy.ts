/**
 * 数据驱动回复策略评估器
 *
 * 核心思路：不靠 prompt 硬编码"必须怎么做"，而是根据工具循环收集到的真实数据质量，
 * 程序化选择最合适的回复策略，动态注入到 LLM 的最终生成步骤。
 *
 * 流程：工具结果 → 评估数据质量 → 选择策略 → 注入策略指令 → LLM 语言化输出
 */

/** 工具收集到的数据片段 */
export interface CollectedToolData {
  toolName: string;
  ok: boolean;
  /** 工具返回的文本内容（从 result 中提取） */
  text: string;
  /** 结果长度（字符数） */
  length: number;
  /** 是否是搜索类工具 */
  isSearch: boolean;
  /** 是否是抓取类工具 */
  isFetch: boolean;
}

/** 数据质量评估结果 */
export interface DataQualityAssessment {
  /** 来源数量（不同工具调用次数） */
  sourceCount: number;
  /** 搜索类工具调用次数 */
  searchCount: number;
  /** 抓取类工具调用次数 */
  fetchCount: number;
  /** 成功的工具调用数 */
  successCount: number;
  /** 失败的工具调用数 */
  failureCount: number;
  /** 总内容长度 */
  totalContentLength: number;
  /** 内容多样性：不同工具名称数 */
  toolDiversity: number;
  /** 综合质量等级 */
  level: "high" | "medium" | "low" | "contradictory" | "empty";
  /** 评估理由（用于日志） */
  reason: string;
}

/** 回复策略 */
export type SynthesisStrategy =
  | "framework_attribution" // 高质量数据：结论先行 + 2-4 维度归因
  | "layered_progressive"   // 中等数据：先事实后推断，分层递进
  | "honest_sparse"          // 低质量数据：坦诚说明已知+未知
  | "multi_perspective"      // 矛盾数据：多视角对比
  | "direct_answer";         // 无工具数据：直接回答（纯知识）

/** 策略指令（注入 LLM 的动态指令） */
export interface StrategyDirective {
  strategy: SynthesisStrategy;
  /** 注入给 LLM 的策略指令文本 */
  instruction: string;
  /** 数据质量评估（用于日志/调试） */
  quality: DataQualityAssessment;
}

/** 搜索类工具名关键词 */
const SEARCH_TOOL_KEYWORDS = ["search", "web_search", "search_web", "bing", "google"];
/** 抓取类工具名关键词 */
const FETCH_TOOL_KEYWORDS = ["fetch", "web_fetch", "fetch_web", "browse", "get_page"];

function isSearchTool(name: string): boolean {
  const lower = name.toLowerCase();
  return SEARCH_TOOL_KEYWORDS.some((kw) => lower.includes(kw));
}

function isFetchTool(name: string): boolean {
  const lower = name.toLowerCase();
  return FETCH_TOOL_KEYWORDS.some((kw) => lower.includes(kw));
}

/** 从工具结果中提取文本内容 */
function extractToolText(result: Record<string, unknown>): string {
  // 常见字段优先级：text > content > snippet > answer > summary > body
  const fields = ["text", "content", "snippet", "answer", "summary", "body", "results", "data"];
  for (const field of fields) {
    const val = result[field];
    if (typeof val === "string" && val.trim()) return val;
    if (Array.isArray(val)) {
      // 搜索结果数组：拼接每条的 snippet/title
      const texts = val
        .map((item) => {
          if (typeof item === "string") return item;
          if (item && typeof item === "object") {
            const obj = item as Record<string, unknown>;
            return String(obj.snippet ?? obj.content ?? obj.text ?? obj.title ?? "");
          }
          return "";
        })
        .filter(Boolean);
      if (texts.length > 0) return texts.join("\n");
    }
  }
  // 兜底：JSON stringify 截断
  try {
    return JSON.stringify(result).slice(0, 500);
  } catch {
    return "";
  }
}

/** 评估收集到的工具数据质量 */
export function assessDataQuality(toolData: CollectedToolData[]): DataQualityAssessment {
  if (toolData.length === 0) {
    return {
      sourceCount: 0,
      searchCount: 0,
      fetchCount: 0,
      successCount: 0,
      failureCount: 0,
      totalContentLength: 0,
      toolDiversity: 0,
      level: "empty",
      reason: "无工具调用数据",
    };
  }

  const successCount = toolData.filter((d) => d.ok).length;
  const failureCount = toolData.filter((d) => !d.ok).length;
  const searchCount = toolData.filter((d) => d.isSearch).length;
  const fetchCount = toolData.filter((d) => d.isFetch).length;
  const totalContentLength = toolData.reduce((sum, d) => sum + d.length, 0);
  const uniqueTools = new Set(toolData.map((d) => d.toolName));
  const toolDiversity = uniqueTools.size;

  // 成功的工具结果文本
  const successTexts = toolData.filter((d) => d.ok && d.text.length > 20).map((d) => d.text);

  // 矛盾检测：多个来源内容差异极大（简化：看是否有明显矛盾的标志词）
  const hasContradiction =
    successTexts.length >= 2 &&
    successTexts.some((t) => /但是|然而|不过|相反|actually|however|but/i.test(t)) &&
    successTexts.some((t) => /相反|contra|否定|推翻| refute/i.test(t));

  // 质量等级判定
  let level: DataQualityAssessment["level"];
  let reason: string;

  if (hasContradiction) {
    level = "contradictory";
    reason = `多源数据存在矛盾信号（${successTexts.length}个来源）`;
  } else if (successCount === 0) {
    level = "low";
    reason = `全部工具调用失败（${failureCount}次）`;
  } else if (successCount >= 3 && totalContentLength > 800 && toolDiversity >= 2) {
    level = "high";
    reason = `多源充分（${successCount}个成功结果，${toolDiversity}种工具，${totalContentLength}字符）`;
  } else if (successCount >= 1 && totalContentLength > 200) {
    level = "medium";
    reason = `数据部分充分（${successCount}个成功结果，${totalContentLength}字符）`;
  } else {
    level = "low";
    reason = `数据稀少（${successCount}个成功结果，${totalContentLength}字符）`;
  }

  return {
    sourceCount: toolData.length,
    searchCount,
    fetchCount,
    successCount,
    failureCount,
    totalContentLength,
    toolDiversity,
    level,
    reason,
  };
}

/** 根据数据质量选择回复策略 */
export function selectStrategy(quality: DataQualityAssessment, userMessage: string): StrategyDirective {
  const isAnalysisQuestion = /为什么|分析|怎么回事|原因|导致|影响|怎么回事|怎么回事|背后|逻辑/i.test(userMessage);

  let strategy: SynthesisStrategy;
  let instruction: string;

  switch (quality.level) {
    case "empty":
      // 无工具数据：直接回答（纯知识场景）
      strategy = "direct_answer";
      instruction = "";
      break;

    case "high":
      // 高质量数据 + 分析类问题 → 框架归因
      if (isAnalysisQuestion) {
        strategy = "framework_attribution";
        instruction =
          `你已通过工具收集到充分的数据（${quality.successCount}个来源，${quality.toolDiversity}种工具）。` +
          `请按以下策略组织回复：\n` +
          `1. 结论先行：第一句话给出核心判断（如"N个因素叠加导致X"），不要先铺事实\n` +
          `2. 归因展开：拆出2-4个原因维度，每个维度用「原因→机制→数据」结构展开\n` +
          `3. 综合改写：用自己的话整合多源信息，不要直接转发任何单一来源的原文\n` +
          `4. 信息密度：合并冗余，只保留最有价值的证据\n` +
          `5. 如果信息有缺口，明确说"已知X未知Y"，不要退缩道歉`;
      } else {
        // 高质量数据 + 非分析类 → 分层递进
        strategy = "layered_progressive";
        instruction =
          `你已通过工具收集到充分的数据（${quality.successCount}个来源）。` +
          `请按以下策略组织回复：\n` +
          `1. 直接给出核心信息，不要铺垫\n` +
          `2. 如有必要，补充关键细节（数据/时间/来源）\n` +
          `3. 合并多源冗余信息，只保留最有价值的部分\n` +
          `4. 用自然的口语表述，不要罗列工具调用过程`;
      }
      break;

    case "medium":
      // 中等数据 → 分层递进（先事实后推断）
      strategy = "layered_progressive";
      instruction =
        `你通过工具收集到了部分数据（${quality.successCount}个来源，${quality.totalContentLength}字符）。` +
        `请按以下策略组织回复：\n` +
        `1. 先给出已确认的事实（有数据支撑的部分）\n` +
        `2. 再给出合理推断（基于已有信息的推测，标注是推断）\n` +
        `3. 最后说明待验证点（信息缺口在哪）\n` +
        `4. 不要道歉说"信息不完整"，用"已知X未知Y"替代`;
      break;

    case "contradictory":
      // 矛盾数据 → 多视角对比
      strategy = "multi_perspective";
      instruction =
        `你收集到的数据存在矛盾信号（${quality.successCount}个来源）。` +
        `请按以下策略组织回复：\n` +
        `1. 先说明存在哪些不同说法\n` +
        `2. 对比不同来源的观点差异（A说X，B说Y）\n` +
        `3. 分析分歧原因（数据源不同？时间不同？立场不同？）\n` +
        `4. 给出你的判断倾向（如果有足够线索）或标注需要进一步确认`;
      break;

    case "low":
      // 低质量数据 → 坦诚直说
      strategy = "honest_sparse";
      instruction =
        `工具收集到的数据有限（${quality.successCount}个成功，${quality.failureCount}个失败，${quality.totalContentLength}字符）。` +
        `请按以下策略组织回复：\n` +
        `1. 明确说明目前能确定的信息\n` +
        `2. 明确说明未知的信息（用"目前未知X"而非"抱歉搜不到"）\n` +
        `3. 如果能从已有知识给出方向性判断，简述并标注"基于已有知识推断"\n` +
        `4. 不要道歉，不要退缩，不要说"换个角度"`; 
      break;
  }

  return { strategy, instruction, quality };
}

/** 从 ToolExecutedInfo 数组构造 CollectedToolData */
export function collectToolDataFromResults(
  results: Array<{ toolName: string; ok: boolean; result: Record<string, unknown> }>,
): CollectedToolData[] {
  return results.map((r) => {
    const text = extractToolText(r.result);
    return {
      toolName: r.toolName,
      ok: r.ok,
      text,
      length: text.length,
      isSearch: isSearchTool(r.toolName),
      isFetch: isFetchTool(r.toolName),
    };
  });
}

/** 便捷入口：从工具结果直接得到策略指令 */
export function evaluateAndSelectStrategy(
  toolResults: Array<{ toolName: string; ok: boolean; result: Record<string, unknown> }>,
  userMessage: string,
): StrategyDirective {
  const toolData = collectToolDataFromResults(toolResults);
  const quality = assessDataQuality(toolData);
  return selectStrategy(quality, userMessage);
}
