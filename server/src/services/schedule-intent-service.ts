import type { ExternalChatProvider } from "../external-model/types.js";

export type ScheduleDraft = {
  title: string;
  description: string;
  kind: "reminder" | "action" | "weather_brief";
  runAt: string;
  recurrence: "none" | "daily" | "weekly";
  reminderMessage?: string;
  action?: {
    url: string;
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    body?: unknown;
  };
};

/** 工具/API 在创建前需向用户确认重复方式时的固定提示（给模型读 tool.result）。 */
export const SCHEDULE_RECURRENCE_CONFIRM_HINT =
  "用户尚未说明提醒是否重复。请先向用户确认：这是一次性提醒，还是每天/每周重复？在用户明确回答前不要创建提醒，也不要声称已设置成功。";

export type ScheduleIntentParseResult =
  | { matched: true; draft: ScheduleDraft }
  | {
      matched: false;
      needsRecurrenceConfirm: true;
      draft: ScheduleDraft;
      hint: string;
    }
  | { matched: false; hint: string };

export class ScheduleIntentService {
  constructor(private readonly externalChat: ExternalChatProvider | null = null) {}

  /** 解析并判断是否可立即创建（提醒类在未说明重复时会要求先追问）。 */
  async parseForCreate(sessionId: string, userText: string): Promise<ScheduleIntentParseResult> {
    const draft = await this.resolveDraft(sessionId, userText);
    if (!draft) {
      return {
        matched: false,
        hint: "未能解析时间或事项。请包含具体时刻，如「明天 9:00 提醒我开会」「早上七点叫我起床」。",
      };
    }
    if (draft.kind === "reminder" && needsRecurrenceConfirmation(userText)) {
      return {
        matched: false,
        needsRecurrenceConfirm: true,
        draft,
        hint: SCHEDULE_RECURRENCE_CONFIRM_HINT,
      };
    }
    return { matched: true, draft };
  }

  /** 仅解析草案（不拦截重复确认）；供预览接口使用。 */
  async parse(sessionId: string, userText: string): Promise<ScheduleDraft | null> {
    return this.resolveDraft(sessionId, userText);
  }

  private async resolveDraft(sessionId: string, userText: string): Promise<ScheduleDraft | null> {
    const modelDraft = await this.parseByModel(sessionId, userText);
    const draft = modelDraft ?? this.parseByRule(userText);
    if (!draft) return null;
    return applyRecurrenceFromUserText(userText, draft);
  }

  private async parseByModel(sessionId: string, userText: string): Promise<ScheduleDraft | null> {
    if (!this.externalChat?.isEnabled()) return null;
    const prompt = [
      "你是任务解析器。请把用户句子解析为定时任务 JSON。",
      "只返回 JSON，不要输出 markdown 或解释。",
      "若无法解析，返回 {\"ok\":false}。",
      "可解析格式示例：明天 09:00 提醒我开会；今天 18:00 调用 https://api.com/sync 同步；每天 7:00 天气提醒（kind 为 weather_brief）。",
      "recurrence 规则：仅当用户明确说出「每天/每日/每周」等重复词时用 daily 或 weekly；明确单次（仅一次/明天/今天/后天）用 none。",
      "若只有时刻与提醒事项、未说明单次或每天/每周，返回 {\"ok\":false,\"reason\":\"needs_recurrence\"}，不要猜测 recurrence。",
      "若用户要「天气/气温/穿衣/带伞」类定时简报，kind 用 weather_brief，不要填 reminderMessage 或 action。",
      "JSON 结构：",
      "{",
      '  "ok": true,',
      '  "task": {',
      '    "title": "string",',
      '    "description": "string",',
      '    "kind": "reminder|action|weather_brief",',
      '    "runAt": "ISO-8601 string",',
      '    "recurrence": "none|daily|weekly",',
      '    "reminderMessage": "string optional（仅 reminder）",',
      '    "action": { "url": "https://...", "method": "POST", "body": {} }',
      "  }",
      "}",
      `用户输入：${userText}`,
    ].join("\n");
    try {
      const text = await this.externalChat.streamCompletion(sessionId, { text: prompt }, () => {
        // HTTP 路由不需要流式回传。
      });
      const json = safeParseJsonObject(text);
      if (!json || json.ok !== true || !json.task) return null;
      const task = validateDraft(json.task);
      return task;
    } catch {
      return null;
    }
  }

  private parseByRule(userText: string): ScheduleDraft | null {
    const normalized = userText.trim();
    const runAt = parseDateTimeFromPrompt(normalized);
    if (!runAt) return null;
    const recurrence = inferRecurrenceFromUserText(normalized);
    const urlMatch = normalized.match(/https?:\/\/[^\s]+/i);
    if (urlMatch) {
      return {
        title: "AI 动作任务",
        description: normalized,
        kind: "action",
        runAt: runAt.toISOString(),
        recurrence,
        action: {
          url: urlMatch[0],
          method: /GET/i.test(normalized) ? "GET" : "POST",
          body: { prompt: normalized },
        },
      };
    }
    if (isWeatherBriefIntent(normalized)) {
      return {
        title: "每日天气与穿衣提示",
        description: normalized,
        kind: "weather_brief",
        runAt: runAt.toISOString(),
        recurrence,
      };
    }
    if (isReminderIntent(normalized)) {
      const reminderText =
        normalized
          .replace(
            /(明天|今天|后天|每天|每周)?\s*(?:早上|上午|中午|下午|晚上|夜间|凌晨|半夜)?\s*(?:\d{1,2}[:：]\d{2}|[零一二两三四五六七八九十廿]{1,4}\s*点(?:\s*\d{1,2}\s*分?|半)?|\d{1,2}\s*点(?:\s*\d{1,2}\s*分?|半)?)/,
            "",
          )
          .trim() || "到点提醒";
      return {
        title: "AI 提醒任务",
        description: normalized,
        kind: "reminder",
        runAt: runAt.toISOString(),
        recurrence,
        reminderMessage: reminderText,
      };
    }
    return null;
  }
}

function safeParseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}

function validateDraft(input: unknown): ScheduleDraft | null {
  if (!input || typeof input !== "object") return null;
  const v = input as Record<string, unknown>;
  const title = String(v.title ?? "").trim();
  const description = String(v.description ?? "").trim();
  const kind = v.kind;
  const runAt = String(v.runAt ?? "");
  const recurrence = v.recurrence;
  const validKind = kind === "reminder" || kind === "action" || kind === "weather_brief";
  const validRecurrence = recurrence === "none" || recurrence === "daily" || recurrence === "weekly";
  if (!title || !description || !validKind || !validRecurrence) return null;
  const runAtDate = new Date(runAt);
  if (Number.isNaN(runAtDate.getTime())) return null;
  if (kind === "weather_brief") {
    return { title, description, kind: "weather_brief", runAt: runAtDate.toISOString(), recurrence };
  }
  if (kind === "reminder") {
    const reminderMessage = String(v.reminderMessage ?? "").trim() || description;
    return { title, description, kind, runAt: runAtDate.toISOString(), recurrence, reminderMessage };
  }
  const actionObj = v.action as Record<string, unknown> | undefined;
  const url = String(actionObj?.url ?? "").trim();
  if (!url) return null;
  const methodRaw = String(actionObj?.method ?? "POST").toUpperCase();
  const method = ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(methodRaw)
    ? (methodRaw as "GET" | "POST" | "PUT" | "PATCH" | "DELETE")
    : "POST";
  return {
    title,
    description,
    kind,
    runAt: runAtDate.toISOString(),
    recurrence,
    action: { url, method, body: actionObj?.body },
  };
}

/** 用户是否已明确单次或重复（明确则可直接创建，无需追问）。 */
export function isRecurrenceExplicit(userText: string): boolean {
  const normalized = userText.trim();
  if (inferRecurrenceFromUserText(normalized) !== "none") return true;
  if (
    /仅一次|就一次|单次|一次性的|仅此一次|只提醒一次|只叫一次|不要重复|不用每天|不重复|别重复/.test(
      normalized,
    )
  ) {
    return true;
  }
  if (/明天|今天|后天|今早|今晚|明早|明晚|大后天/.test(normalized)) return true;
  return false;
}

/** 提醒类且能解析出时间，但未说明是否重复 → 须先向用户确认。 */
export function needsRecurrenceConfirmation(userText: string): boolean {
  const normalized = userText.trim();
  if (!isReminderIntent(normalized)) return false;
  if (isWeatherBriefIntent(normalized)) return false;
  if (/https?:\/\/[^\s]+/i.test(normalized)) return false;
  if (!parseDateTimeFromPrompt(normalized)) return false;
  return !isRecurrenceExplicit(normalized);
}

export function buildRecurrenceConfirmToolResult(draft: ScheduleDraft): Record<string, unknown> {
  return {
    ok: true,
    matched: false,
    needsRecurrenceConfirm: true,
    hint: SCHEDULE_RECURRENCE_CONFIRM_HINT,
    suggestedQuestion: "这是一次性提醒，还是每天重复？",
    parsedNextRunAt: draft.runAt,
    parsedReminderMessage: draft.reminderMessage ?? draft.description,
  };
}

/** 从用户原句推断重复规则（未明确重复词则单次 none）。 */
export function inferRecurrenceFromUserText(userText: string): "none" | "daily" | "weekly" {
  const normalized = userText.trim();
  if (/每周|每星期|每个星期|礼拜/.test(normalized)) return "weekly";
  if (
    /每天|每日|天天|每个工作日|工作日每天|每天早晨|每天早上|每晚|每天晚上|夜里每天/.test(
      normalized,
    )
  ) {
    return "daily";
  }
  return "none";
}

function applyRecurrenceFromUserText(userText: string, draft: ScheduleDraft): ScheduleDraft {
  const recurrence = inferRecurrenceFromUserText(userText);
  if (draft.recurrence === recurrence) return draft;
  return { ...draft, recurrence };
}

/** 闹钟/叫醒类意图（含口语「叫我起床」等，不必出现「提醒」二字） */
function isReminderIntent(text: string): boolean {
  return /提醒我|提醒一下|提醒|闹钟|叫我起床|起床|叫醒|叫我|定时叫|定时提醒/.test(text);
}

/** 天气/穿衣类定时简报（与普通「提醒我」区分：须含下列关键词之一） */
function isWeatherBriefIntent(text: string): boolean {
  return /(天气|气温|穿衣|天气预报|天气提醒|出门穿|带伞)/.test(text);
}

function validClock(hours: number, minutes: number): boolean {
  return (
    Number.isInteger(hours) &&
    Number.isInteger(minutes) &&
    hours >= 0 &&
    hours <= 23 &&
    minutes >= 0 &&
    minutes <= 59
  );
}

const CN_DIGIT: Record<string, number> = {
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

/** 中文小写数字 → 0–23 点（如 七→7，十一→11，二十三→23） */
function parseChineseHourToken(token: string): number | null {
  const t = token.trim();
  if (!t) return null;
  if (/^\d{1,2}$/.test(t)) {
    const n = Number(t);
    return n >= 0 && n <= 23 ? n : null;
  }
  if (t === "十") return 10;
  if (t.startsWith("十")) {
    const rest = t.slice(1);
    if (!rest) return 10;
    const ones = CN_DIGIT[rest[0]!];
    return ones != null ? 10 + ones : null;
  }
  if (t.endsWith("十")) {
    const head = t.slice(0, -1);
    if (!head) return 10;
    const tens = CN_DIGIT[head[0]!];
    return tens != null ? tens * 10 : null;
  }
  if (t.includes("十")) {
    const [head, tail] = t.split("十");
    const tens = head ? (CN_DIGIT[head] ?? (head === "" ? 1 : null)) : 1;
    const ones = tail ? (CN_DIGIT[tail] ?? 0) : 0;
    if (tens == null) return null;
    return tens * 10 + ones;
  }
  const single = CN_DIGIT[t];
  return single != null ? single : null;
}

/** 根据 早上/下午/晚上 等修饰词将 1–11 点映射到 24 小时制 */
function applyDayPeriodHint(hours: number, text: string): number {
  if (/晚上|夜间|半夜|傍晚/.test(text) && hours >= 1 && hours <= 11) return hours + 12;
  if (/下午/.test(text) && hours >= 1 && hours <= 11) return hours + 12;
  return hours;
}

/** 从文案解析时、分：支持 14:30、7点、7点半、七点、十一点半、早上七点 */
function parseHourMinuteFromPrompt(text: string): { hours: number; minutes: number } | null {
  const colon = text.match(/(\d{1,2})[:：](\d{2})/);
  if (colon) {
    const hours = Number(colon[1]);
    const minutes = Number(colon[2]);
    if (validClock(hours, minutes)) return { hours, minutes };
  }

  const cnHalf = text.match(
    /(?:早上|上午|中午|下午|晚上|夜间|凌晨|半夜)?\s*([零一二两三四五六七八九十廿]{1,4})\s*点半/,
  );
  if (cnHalf) {
    const hours = parseChineseHourToken(cnHalf[1]!);
    if (hours != null && validClock(applyDayPeriodHint(hours, text), 30)) {
      return { hours: applyDayPeriodHint(hours, text), minutes: 30 };
    }
  }

  const half = text.match(/(\d{1,2})\s*点半/);
  if (half) {
    const hours = Number(half[1]);
    if (validClock(hours, 30)) return { hours, minutes: 30 };
  }

  const cnPointSub = text.match(
    /(?:早上|上午|中午|下午|晚上|夜间|凌晨|半夜)?\s*([零一二两三四五六七八九十廿]{1,4})\s*点\s*(\d{1,2})\s*分?/,
  );
  if (cnPointSub && !text.includes("点半")) {
    const hours = parseChineseHourToken(cnPointSub[1]!);
    const minutes = Number(cnPointSub[2]);
    if (hours != null && validClock(applyDayPeriodHint(hours, text), minutes)) {
      return { hours: applyDayPeriodHint(hours, text), minutes };
    }
  }

  const pointSub = text.match(/(\d{1,2})\s*点\s*(\d{1,2})\s*分?/);
  if (pointSub && !text.includes("点半")) {
    const hours = Number(pointSub[1]);
    const minutes = Number(pointSub[2]);
    if (validClock(hours, minutes)) return { hours, minutes };
  }

  const cnPointOnly = text.match(
    /(?:早上|上午|中午|下午|晚上|夜间|凌晨|半夜)?\s*([零一二两三四五六七八九十廿]{1,4})\s*点(?!半)/,
  );
  if (cnPointOnly) {
    const hours = parseChineseHourToken(cnPointOnly[1]!);
    if (hours != null && validClock(applyDayPeriodHint(hours, text), 0)) {
      return { hours: applyDayPeriodHint(hours, text), minutes: 0 };
    }
  }

  const pointOnly = text.match(/(\d{1,2})\s*点(?!半)/);
  if (pointOnly) {
    const hours = Number(pointOnly[1]);
    if (validClock(hours, 0)) return { hours, minutes: 0 };
  }
  return null;
}

function parseDateTimeFromPrompt(text: string): Date | null {
  const hm = parseHourMinuteFromPrompt(text);
  if (!hm) return null;
  const { hours, minutes } = hm;
  const now = new Date();
  const target = new Date(now);
  if (/后天/.test(text)) target.setDate(target.getDate() + 2);
  else if (/明天/.test(text)) target.setDate(target.getDate() + 1);
  target.setHours(hours, minutes, 0, 0);
  if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
  return target;
}
