import { shouldSkipNarrativeRecall } from "./memory-signal.js";

export { shouldSkipNarrativeRecall };

const DIRECT_CLOCK_RE =
  /现在.*几点|几点了|当前.*时间|今天.*几号|今天.*星期|我.*在哪|当前位置|current time|what time|where am i/i;

const RELATIVE_REMINDER_RE =
  /([一二三四五六七八九十\d]+)\s*(分钟|小时|天|周|minute|hour|day|week)\s*(后|later).{0,20}(提醒|叫|喊|remind|wake)/i;

const MULTI_STEP_RE =
  /然后|并且|同时|接着|再|以及|顺便|另外|先.+再|一方面|另一方面|第一步|第二步|首先|其次|最后/i;

const FACT_LOOKUP_RE =
  /搜索|查一下|查询|联网|浏览|天气|新闻|最新|最近|价格|赛程|日程|版本|电影|排片|热映|订票|购票|股价|行情|公告|search|look up|weather|news|latest|recent|price|schedule|version|movie|ticket|stock/i;

export function isSimpleDirectTask(message: string): boolean {
  const t = message.trim();
  if (!t) return true;
  if (DIRECT_CLOCK_RE.test(t)) return true;
  if (RELATIVE_REMINDER_RE.test(t)) return true;
  return false;
}

export function requiresTaskDecomposition(message: string): boolean {
  if (isSimpleDirectTask(message)) return false;

  const t = message.trim();
  if (MULTI_STEP_RE.test(t)) return true;
  if (FACT_LOOKUP_RE.test(t)) return true;

  const clauses = t.split(/[，；,;]/).filter((s) => s.trim().length > 4);
  if (clauses.length >= 2) return true;

  return t.length > 96;
}

/**
 * 复杂任务是否可用"简单单点工具快车道"：只需调用一次工具即可完成任务。
 *
 * Fast 车道只做回复、不再承载工具执行；所有需要工具的任务下沉 complex。
 * 本判定在 complex 内做第二次分流：
 *  - true  → 走单点快车道：直接跑一遍单轮工具循环（跳过子 Agent 委派 / plan-execute 慢车道），
 *            让"工具被极快找到并完成"，避免多轮编排的开销。
 *  - false → 走标准 plan-and-execute 慢车道（多步/写操作/子 Agent）。
 *
 * 规则：非纯对话（能被一次工具调用满足、无多步衔接、无长句堆叠）即视为单点。
 */
export function shouldUseSimpleToolFastLane(message: string): boolean {
  if (isSimpleDirectTask(message)) return true;
  const t = message.trim();
  if (!t) return true;
  // 多步衔接词 → 需 plan-execute，不走快车道
  if (MULTI_STEP_RE.test(t)) return false;
  // 超长 / 含多个并列子句 → 多步，走慢车道
  if (t.length > 96) return false;
  const clauses = t.split(/[，；,;]/).filter((s) => s.trim().length > 4);
  if (clauses.length >= 2) return false;
  return true;
}
