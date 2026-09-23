/**
 * 显式禁网开关（2026-09-23，代码级确定性约束）。
 *
 * 真实事故（2026-09-22 日志取证）：用户说「不要联网。列出搬家要带的8样物品…」，
 * 路由超时降级任务面后，投机搜索拿**整句原话**（含「不要联网」三个字）当查询词
 * 烧了 4 次真实搜索请求。prompt 层约定挡不住降级路径的程序动作——"不要联网"
 * 是用户对系统能力的显式指令，必须由代码确定性执行，不依赖模型或路由器自觉。
 *
 * 语义：命中即本轮
 *   1. 不发起投机搜索（specEvidence）；
 *   2. 不消费/注入任何前置检索证据（routeQuery / speculative 均跳过）；
 *   3. 可见工具集剥离联网检索族（search/fetch/hot_rankings/deep_search…）——
 *      主模型"自决"的前提是环境不提供与用户指令冲突的选项（对齐 ChatGPT
 *      手动搜索开关的产品语义：用户关掉搜索，模型就没有搜索可用）；
 *   4. 注入一行 taskContext 说明，让模型知道为什么不联网、照实回答即可。
 */

/**
 * 显式禁网/禁搜索表达。锚定常见说法，宁可漏判不可误判——
 * 误判会把真正想搜的轮的联网能力摘掉（如「不要联网词典那个APP」是歧义表达，
 * 不收录）；漏判只回到 prompt 层软约束。
 */
const EXPLICIT_NO_WEB_RE =
  /不要联网|不用联网|无需联网|不必联网|别联网|禁止联网|不要上网搜|不用上网|无需上网|别上网搜|不要搜索|不用搜索|无需搜索|别搜索|禁止搜索|不要查网|不要联网搜|离线(?:回答|作答|模式)|断网(?:回答|作答|模式)|不(?:许|要|准).{0,4}(?:联网|搜索)/;

export function isExplicitNoWebRequest(text: string): boolean {
  const t = (text ?? "").trim();
  if (!t || t.length > 500) return false;
  return EXPLICIT_NO_WEB_RE.test(t);
}

/** 联网检索族工具名（禁网轮从可见集中剥离）。 */
const WEB_SEARCH_TOOL_RE =
  /^(search_web|search_images|search_videos|search_images_batch|deep_search|fetch_web|hot_rankings|internet\.|info\.inspect_webpage|info\.navigate_site|info\.read_webpage|info\.search)/;

export function filterWebSearchTools(tools: import("openai/resources/chat/completions").ChatCompletionTool[]): import("openai/resources/chat/completions").ChatCompletionTool[] {
  return tools.filter((t) => !WEB_SEARCH_TOOL_RE.test(("function" in t ? t.function?.name : "") ?? ""));
}

export const NO_WEB_TURN_NOTE =
  "[本轮用户明确要求不联网：不要调用任何联网搜索/网页抓取工具，凭已有知识、记忆与对话上下文作答；属于当前事实的部分如实说明你无法联网核实。]";
