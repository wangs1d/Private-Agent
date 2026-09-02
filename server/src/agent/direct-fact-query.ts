const DIRECT_FACT_QUERY_RE =
  /在哪|在不在|有没有|是不是|是否|现在|今天|昨天|行踪|确切消息|确切行踪|消息准不准|准不准|确定吗|确认了吗/u;

const ANALYSIS_EXPANSION_RE = /为什么|分析|原因|影响|怎么看|展开|详细|复盘|对比|总结|讲讲/u;

/**
 * 盘点/汇总类查询：「XX的最新动态」「近况如何」「娱乐圈大事」这类问题要的是
 * 多主题、多来源的信息汇总，答案天然需要充分展开，绝不能按「单一事实查询」
 * 压成「结论 + 1 句依据」。之前把「最新情况/最近动态」放进 DIRECT_FACT_QUERY_RE，
 * 导致动态盘点类问题触发极简回复策略，是「回复潦草」的直接根因之一。
 */
const DIGEST_ROUNDUP_RE =
  /动态|近况|最新情况|最新消息|最新进展|新闻|资讯|热点|热搜|风评|口碑|怎么样了|如何了|盘一盘|盘一下|梳理|汇总|大事/u;

/** 求证单一事实的措辞优先级高于盘点词：「有没有确切消息」是对事实的求证，不是盘点 */
const SINGLE_FACT_VERIFY_RE = /确切消息|消息准不准|准不准/u;

/** 是否是「动态/近况盘点」类查询（要的是多主题汇总，需要充分展开的回答） */
export function isDigestRoundupQuery(userText: string): boolean {
  const compact = userText.replace(/\s+/g, "").trim();
  if (!compact) return false;
  if (SINGLE_FACT_VERIFY_RE.test(compact)) return false;
  return DIGEST_ROUNDUP_RE.test(compact);
}

export function isDirectFactQuery(userText: string): boolean {
  const compact = userText.replace(/\s+/g, "").trim();
  if (!compact) return false;
  if (!DIRECT_FACT_QUERY_RE.test(compact)) return false;
  // 「刘浩存今天有什么动态」虽然带「今天」，但要的是动态盘点，不是单一事实
  if (isDigestRoundupQuery(compact)) return false;
  return !ANALYSIS_EXPANSION_RE.test(compact);
}

export function shouldSuppressFollowUp(userText: string): boolean {
  return isDirectFactQuery(userText);
}
