const DIRECT_FACT_QUERY_RE =
  /在哪|在不在|有没有|是不是|是否|最新情况|最近动态|现在|今天|昨天|行踪|确切消息|确切行踪|消息准不准|准不准|确定吗|确认了吗/u;

const ANALYSIS_EXPANSION_RE = /为什么|分析|原因|影响|怎么看|展开|详细|复盘|对比|总结|讲讲/u;

export function isDirectFactQuery(userText: string): boolean {
  const compact = userText.replace(/\s+/g, "").trim();
  if (!compact) return false;
  if (!DIRECT_FACT_QUERY_RE.test(compact)) return false;
  return !ANALYSIS_EXPANSION_RE.test(compact);
}

export function shouldSuppressFollowUp(userText: string): boolean {
  return isDirectFactQuery(userText);
}
