/**
 * 主 Agent 路由启发式：减少无效「任务分解」LLM 调用。
 */

/** 主 Agent 直答（不分解、不调子 Agent） */
export function isSimpleDirectTask(message: string): boolean {
  const t = message.trim();
  if (!t) return true;

  if (
    /几点|什么时间|现在几|当前时间|北京时间|当地时间|今天几号|几月几日|星期几|周几|什么日期|now\s*time|what\s*time/i.test(
      t,
    )
  ) {
    return true;
  }

  if (/^(你好|您好|hi|hello|嗨|在吗|谢谢|再见|好的|嗯|ok)[\s!！?？。,，~～]*$/i.test(t)) {
    return true;
  }

  return false;
}

const MULTI_STEP_RE =
  /然后|并且|同时|接着|再|以及|顺便|另外|先.+再|一方面|另一方面|第一步|第二步|首先|其次|最后/;

/**
 * 是否值得走「分解 → 子 Agent」路径（否则主 Agent 直答 + 全工具）。
 */
export function requiresTaskDecomposition(message: string): boolean {
  if (isSimpleDirectTask(message)) return false;

  const t = message.trim();
  if (MULTI_STEP_RE.test(t)) return true;

  const clauses = t.split(/[，,；;]/).filter((s) => s.trim().length > 4);
  if (clauses.length >= 2) return true;

  return t.length > 96;
}
