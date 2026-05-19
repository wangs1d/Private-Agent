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

export class ScheduleIntentService {
  constructor(private readonly externalChat: ExternalChatProvider | null = null) {}

  async parse(sessionId: string, userText: string): Promise<ScheduleDraft | null> {
    const modelDraft = await this.parseByModel(sessionId, userText);
    if (modelDraft) return modelDraft;
    return this.parseByRule(userText);
  }

  private async parseByModel(sessionId: string, userText: string): Promise<ScheduleDraft | null> {
    if (!this.externalChat?.isEnabled()) return null;
    const prompt = [
      "你是任务解析器。请把用户句子解析为定时任务 JSON。",
      "只返回 JSON，不要输出 markdown 或解释。",
      "若无法解析，返回 {\"ok\":false}。",
      "可解析格式示例：明天 09:00 提醒我开会；今天 18:00 调用 https://api.com/sync 同步；每天 7:00 天气提醒（kind 为 weather_brief）。",
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
    const recurrence: "none" | "daily" | "weekly" = /每天/.test(normalized)
      ? "daily"
      : /每周/.test(normalized)
        ? "weekly"
        : "none";
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
    if (/提醒我|提醒|闹钟/.test(normalized)) {
      const reminderText =
        normalized.replace(/(明天|今天|后天|每天|每周)?\s*\d{1,2}[:：]\d{2}/, "").trim() || "到点提醒";
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

/** 从文案解析时、分：支持 14:30、7点、7点半、7点30、7 点 30 分 */
function parseHourMinuteFromPrompt(text: string): { hours: number; minutes: number } | null {
  const colon = text.match(/(\d{1,2})[:：](\d{2})/);
  if (colon) {
    const hours = Number(colon[1]);
    const minutes = Number(colon[2]);
    if (validClock(hours, minutes)) return { hours, minutes };
  }
  const half = text.match(/(\d{1,2})\s*点半/);
  if (half) {
    const hours = Number(half[1]);
    if (validClock(hours, 30)) return { hours, minutes: 30 };
  }
  const pointSub = text.match(/(\d{1,2})\s*点\s*(\d{1,2})\s*分?/);
  if (pointSub && !text.includes("点半")) {
    const hours = Number(pointSub[1]);
    const minutes = Number(pointSub[2]);
    if (validClock(hours, minutes)) return { hours, minutes };
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
