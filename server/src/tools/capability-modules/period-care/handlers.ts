import type { ToolHandler, ToolContext } from "../../tool-registry.js";
import { resolveActorId } from "../../../agent/actor-id.js";
import type { PeriodCareService } from "../../../services/period-care-service.js";

/**
 * period.* 工具 handler 集合。
 *
 * handler 只做入参清洗 + actorId 解析，业务全部在 PeriodCareService。
 * 预测结果的 summary 统一带「估算」措辞，避免 LLM 自行加码成断言。
 */

function parsePain(input: Record<string, unknown>): number | undefined {
  if (input.pain == null) return undefined;
  const v = Number(input.pain);
  return Number.isFinite(v) ? v : undefined;
}

function parseSymptoms(input: Record<string, unknown>): string[] | undefined {
  if (!Array.isArray(input.symptoms)) return undefined;
  const arr = input.symptoms.map(String).map((s) => s.trim()).filter(Boolean);
  return arr.length > 0 ? arr : undefined;
}

function optDate(input: Record<string, unknown>): string | undefined {
  return typeof input.date === "string" && input.date.trim() ? input.date.trim() : undefined;
}

function optNote(input: Record<string, unknown>): string | undefined {
  return typeof input.note === "string" && input.note.trim() ? input.note.trim() : undefined;
}

function optFlow(input: Record<string, unknown>): string | undefined {
  return typeof input.flow === "string" && input.flow.trim() ? input.flow.trim() : undefined;
}

/** 把 PeriodCycleStatus 压成给 LLM 的一句话摘要。 */
function statusSummary(status: ReturnType<PeriodCareService["getStatus"]>): string {
  if (!status.hasData) {
    return "还没有经期记录；可以告诉用户「下次来说一声『我大姨妈来了』就可以开始记录了」";
  }
  const parts: string[] = [];
  parts.push(status.inPeriod ? `正处于经期（周期第 ${status.cycleDay} 天）` : `当前为周期第 ${status.cycleDay ?? "?"} 天`);
  if (status.predictedNextStart) {
    const until = status.daysUntilPredictedStart ?? 0;
    const when = until > 0 ? `${until} 天后（${status.predictedNextStart} 前后 ±${status.predictedRangeDays} 天）` : `已到预测日（${status.predictedNextStart}）`;
    parts.push(`下次预计${when}，置信度${status.confidence === "high" ? "较高" : status.confidence === "medium" ? "中等" : "偏低（记录还少）"}`);
  }
  return parts.join("；") + "。均为估算，非医学结论";
}

export function createPeriodLogStartHandler(service: PeriodCareService): ToolHandler {
  return async (input, context) => {
    const actorId = resolveActorId(context);
    try {
      const { cycle, merged } = await service.logPeriodStart(actorId, {
        date: optDate(input),
        flow: optFlow(input),
        pain: parsePain(input),
        symptoms: parseSymptoms(input),
        note: optNote(input),
      });
      const status = service.getStatus(actorId);
      return {
        ok: true,
        cycle,
        merged,
        status,
        summary: `已记录经期开始（${cycle.startDate}${merged ? "，合并到已有记录" : ""}）。${statusSummary(status)}`,
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };
}

export function createPeriodLogEndHandler(service: PeriodCareService): ToolHandler {
  return async (input, context) => {
    const actorId = resolveActorId(context);
    const cycle = await service.logPeriodEnd(actorId, { date: optDate(input) });
    if (!cycle) {
      return {
        ok: false,
        error: "没有进行中的经期记录；请用户先用「我来月经了」记录开始",
      };
    }
    return {
      ok: true,
      cycle,
      summary: `已记录经期结束（${cycle.startDate} ~ ${cycle.endDate}，共 ${cycle.endDate && Math.max(1, Math.round((Date.parse(cycle.endDate) - Date.parse(cycle.startDate)) / 86_400_000) + 1)} 天）`,
    };
  };
}

export function createPeriodLogDailyHandler(service: PeriodCareService): ToolHandler {
  return async (input, context) => {
    const actorId = resolveActorId(context);
    try {
      const log = await service.logDaily(actorId, {
        date: optDate(input),
        pain: parsePain(input),
        mood: typeof input.mood === "string" && input.mood.trim() ? input.mood.trim() : undefined,
        symptoms: parseSymptoms(input),
        note: optNote(input),
      });
      return {
        ok: true,
        log,
        summary: `已记录 ${log.date} 的状态打卡`,
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };
}

export function createPeriodStatusHandler(service: PeriodCareService): ToolHandler {
  return async (_input, context) => {
    const actorId = resolveActorId(context);
    const status = service.getStatus(actorId);
    return {
      ok: true,
      status,
      summary: statusSummary(status),
    };
  };
}

export function createPeriodHistoryHandler(service: PeriodCareService): ToolHandler {
  return async (input, context) => {
    const actorId = resolveActorId(context);
    const limit = input.limit != null ? Number(input.limit) : 12;
    const cycles = service.getHistory(actorId, Number.isFinite(limit) ? limit : 12);
    return {
      ok: true,
      cycles,
      count: cycles.length,
      summary:
        cycles.length === 0
          ? "还没有经期记录"
          : `共返回 ${cycles.length} 次经期记录（最近在前）`,
    };
  };
}

export function createPeriodSetReminderHandler(service: PeriodCareService): ToolHandler {
  return async (input, context) => {
    const actorId = resolveActorId(context);
    const settings = await service.updateSettings(actorId, {
      reminderEnabled: typeof input.enabled === "boolean" ? input.enabled : undefined,
      reminderDaysBefore: input.days_before != null ? Number(input.days_before) : undefined,
      reminderHour: input.hour != null ? Number(input.hour) : undefined,
      cycleLengthOverride: input.cycle_length != null ? Number(input.cycle_length) : undefined,
      periodLengthOverride: input.period_length != null ? Number(input.period_length) : undefined,
    });
    return {
      ok: true,
      settings,
      summary: `已更新：提醒${settings.reminderEnabled ? `开启（提前 ${settings.reminderDaysBefore} 天、${settings.reminderHour} 点）` : "关闭"}${settings.cycleLengthOverride ? `，周期按 ${settings.cycleLengthOverride} 天计` : ""}`,
    };
  };
}
