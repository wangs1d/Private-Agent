import type { ScheduleDraft, ScheduleIntentParseResult } from "../services/schedule-intent-service.js";
import { buildRecurrenceConfirmToolResult } from "../services/schedule-intent-service.js";

/** 将 parseForCreate 结果转为工具返回值；创建方在 matched=true 时自行 createTask。 */
export function toolResultFromScheduleParse(
  parsed: ScheduleIntentParseResult,
): { proceed: true; draft: ScheduleDraft } | { proceed: false; result: Record<string, unknown> } {
  if (parsed.matched) {
    return { proceed: true, draft: parsed.draft };
  }
  if ("needsRecurrenceConfirm" in parsed && parsed.needsRecurrenceConfirm) {
    return {
      proceed: false,
      result: buildRecurrenceConfirmToolResult(parsed.draft, parsed.suggestion),
    };
  }
  return {
    proceed: false,
    result: {
      ok: true,
      matched: false,
      hint: parsed.hint,
    },
  };
}
