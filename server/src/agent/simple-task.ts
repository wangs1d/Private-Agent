const MEMORY_RECALL_HINT_RE =
  /生日|纪念日|记住|记得|之前|上次|说过|偏好|喜欢|讨厌|姓名|名字|叫啥|叫什么|档案|回忆|履历|历史|important|memory/i;

const DIRECT_CLOCK_RE =
  /现在.*几点|几点了|当前.*时间|今天.*几号|今天.*星期|我.*在哪|当前位置|current time|what time|where am i/i;

const RELATIVE_REMINDER_RE =
  /([一二三四五六七八九十\d]+)\s*(分钟|小时|天|周|minute|hour|day|week)\s*(后|later).{0,20}(提醒|叫|喊|remind|wake)/i;

const MULTI_STEP_RE =
  /然后|并且|同时|接着|再|以及|顺便|另外|先.+再|一方面|另一方面|第一步|第二步|首先|其次|最后/i;

const FACT_LOOKUP_RE =
  /搜索|查一下|查询|联网|浏览|天气|新闻|最新|最近|价格|赛程|日程|版本|search|look up|weather|news|latest|recent|price|schedule|version/i;

export function isSimpleDirectTask(message: string): boolean {
  const t = message.trim();
  if (!t) return true;
  if (DIRECT_CLOCK_RE.test(t)) return true;
  if (RELATIVE_REMINDER_RE.test(t)) return true;
  return false;
}

export function shouldSkipNarrativeRecall(message: string): boolean {
  const t = message.trim();
  if (!t) return true;
  if (MEMORY_RECALL_HINT_RE.test(t)) return false;
  if (t.length <= 16) return true;
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
