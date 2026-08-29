import type { ToolHandler, ToolContext } from "../../tool-registry.js";
import { resolveActorId } from "../../../agent/actor-id.js";
import type { HealthFitnessService, HealthMetric } from "../../../services/health-fitness-service.js";

/**
 * health.log_metric 工具 handler。
 *
 * 调用 {@link HealthFitnessService.logMetric} 落盘一条记录。
 */
export function createHealthLogMetricHandler(
  service: HealthFitnessService,
): ToolHandler {
  return async (input: Record<string, unknown>, context: ToolContext) => {
    const type = String(input.type ?? "").trim();
    if (!type) {
      return { ok: false, error: "缺少 type（指标类型，如 weight / heart_rate / steps）" };
    }
    const value = Number(input.value);
    if (!Number.isFinite(value)) {
      return { ok: false, error: "缺少或非法 value（应为数字）" };
    }
    const unit = String(input.unit ?? "").trim();
    if (!unit) {
      return { ok: false, error: "缺少 unit（单位，如 kg / bpm / steps）" };
    }
    const note =
      typeof input.note === "string" && input.note.trim() ? input.note.trim() : undefined;
    const timestamp =
      typeof input.timestamp === "string" && input.timestamp.trim()
        ? input.timestamp.trim()
        : undefined;

    const actorId = resolveActorId(context);
    const metric = await service.logMetric(actorId, type, value, unit, note, timestamp);

    return {
      ok: true,
      metric,
      summary: `已记录 ${type}=${value}${unit}（${metric.timestamp}）`,
    };
  };
}

/**
 * health.get_metrics 工具 handler。
 */
export function createHealthGetMetricsHandler(
  service: HealthFitnessService,
): ToolHandler {
  return async (input: Record<string, unknown>, context: ToolContext) => {
    const actorId = resolveActorId(context);
    const type =
      typeof input.type === "string" && input.type.trim() ? input.type.trim() : undefined;
    const from =
      typeof input.from === "string" && input.from.trim() ? input.from.trim() : undefined;
    const to = typeof input.to === "string" && input.to.trim() ? input.to.trim() : undefined;
    const limit =
      input.limit != null ? Math.max(1, Math.min(1000, Number(input.limit) || 100)) : 100;

    const metrics = service.getMetrics(actorId, type, from, to, limit);

    return {
      ok: true,
      metrics,
      count: metrics.length,
      summary:
        metrics.length === 0
          ? `未找到匹配的健康记录（type=${type ?? "all"}）`
          : `找到 ${metrics.length} 条健康记录（type=${type ?? "all"}）`,
    };
  };
}

/**
 * health.get_summary 工具 handler。
 */
export function createHealthGetSummaryHandler(
  service: HealthFitnessService,
): ToolHandler {
  return async (input: Record<string, unknown>, context: ToolContext) => {
    const type = String(input.type ?? "").trim();
    if (!type) {
      return { ok: false, error: "缺少 type（指标类型）" };
    }
    const periodRaw = String(input.period ?? "").trim();
    if (periodRaw !== "week" && periodRaw !== "month" && periodRaw !== "year") {
      return { ok: false, error: "period 必须为 week / month / year" };
    }

    const actorId = resolveActorId(context);
    const summary = service.getSummary(actorId, type, periodRaw);

    return {
      ok: true,
      summary_data: summary,
      summary:
        summary.count === 0
          ? `${periodRaw} 内无 ${type} 记录`
          : `${periodRaw} 内 ${type}：均值 ${summary.mean}，趋势 ${summary.trend}（${summary.count} 条记录）`,
    };
  };
}

/**
 * health.query 工具 handler（Task 19 健康关怀）。
 *
 * 「这周跑了几次步」类确定性统计：服务端按时间范围聚合（可选按备注关键词
 * 过滤，如只看 note 含「跑步」的运动记录），返回数字，LLM 只负责措辞。
 * 聚合口径：
 *   - count      记录条数（每次一条记录 → 「跑了几次」）
 *   - days       有记录的天数（「有几天在运动」）
 *   - sum        总和（「这周总共运动了多少分钟」）
 *   - mean       均值（「平均每次跑多久」）
 *   - mean_daily 日均值（按有记录的天分组求均值，「日均步数」）
 */
export function createHealthQueryHandler(
  service: HealthFitnessService,
): ToolHandler {
  return async (input: Record<string, unknown>, context: ToolContext) => {
    const type = String(input.type ?? "").trim();
    if (!type) {
      return { ok: false, error: "缺少 type（指标类型，如 exercise_duration / steps）" };
    }
    const aggregate = String(input.aggregate ?? "count").trim();
    if (!["count", "days", "sum", "mean", "mean_daily"].includes(aggregate)) {
      return {
        ok: false,
        error: "aggregate 必须为 count / days / sum / mean / mean_daily",
      };
    }
    const noteKeyword =
      typeof input.note_keyword === "string" && input.note_keyword.trim()
        ? input.note_keyword.trim()
        : undefined;

    // 时间范围：period=week/month/year 按回看窗口；custom 用 from/to
    const periodRaw = String(input.period ?? "week").trim();
    let fromIso: string;
    let toIso: string;
    if (periodRaw === "custom") {
      fromIso = String(input.from ?? "").trim();
      toIso = String(input.to ?? "").trim();
      if (!fromIso || !toIso) {
        return { ok: false, error: "period=custom 需要提供 from / to（ISO 8601）" };
      }
    } else {
      if (periodRaw !== "week" && periodRaw !== "month" && periodRaw !== "year") {
        return { ok: false, error: "period 必须为 week / month / year / custom" };
      }
      const periodMs =
        periodRaw === "week" ? 7 * 86_400_000 : periodRaw === "month" ? 30 * 86_400_000 : 365 * 86_400_000;
      fromIso = new Date(Date.now() - periodMs).toISOString();
      toIso = new Date().toISOString();
    }

    const actorId = resolveActorId(context);
    let metrics = service.getMetrics(actorId, type, fromIso, toIso, 10_000);
    if (noteKeyword) {
      const kw = noteKeyword.toLowerCase();
      metrics = metrics.filter((m) => (m.note ?? "").toLowerCase().includes(kw));
    }

    // 确定性聚合（零 LLM）
    const days = new Set(metrics.map((m) => m.timestamp.slice(0, 10)));
    const sum = metrics.reduce((acc, m) => acc + m.value, 0);
    let value = 0;
    let label = "";
    switch (aggregate) {
      case "count":
        value = metrics.length;
        label = "记录条数";
        break;
      case "days":
        value = days.size;
        label = "有记录的天数";
        break;
      case "sum":
        value = Number(sum.toFixed(2));
        label = "总和";
        break;
      case "mean":
        value = metrics.length > 0 ? Number((sum / metrics.length).toFixed(2)) : 0;
        label = "均值";
        break;
      case "mean_daily":
        value = days.size > 0 ? Number((sum / days.size).toFixed(2)) : 0;
        label = "日均值";
        break;
    }

    const unit = metrics[0]?.unit ?? "";
    return {
      ok: true,
      aggregate,
      label,
      value,
      unit,
      period: periodRaw,
      from: fromIso,
      to: toIso,
      type,
      note_keyword: noteKeyword,
      matched: metrics.length,
      matched_days: days.size,
      summary:
        metrics.length === 0
          ? `${periodRaw} 内没有${noteKeyword ? `备注含「${noteKeyword}」的` : ""}${type}记录`
          : `${periodRaw} 内${noteKeyword ? `备注含「${noteKeyword}」的` : ""}${type} ${label}为 ${value}${unit ? unit : ""}（匹配 ${metrics.length} 条 / ${days.size} 天）`,
    };
  };
}

/**
 * health.set_goal 工具 handler。
 */
export function createHealthSetGoalHandler(
  service: HealthFitnessService,
): ToolHandler {
  return async (input: Record<string, unknown>, context: ToolContext) => {
    const type = String(input.type ?? "").trim();
    if (!type) {
      return { ok: false, error: "缺少 type（指标类型）" };
    }
    const target = Number(input.target);
    if (!Number.isFinite(target)) {
      return { ok: false, error: "缺少或非法 target（应为数字）" };
    }
    const periodRaw = String(input.period ?? "").trim();
    if (
      periodRaw !== "daily" &&
      periodRaw !== "weekly" &&
      periodRaw !== "monthly" &&
      periodRaw !== "yearly" &&
      periodRaw !== "total"
    ) {
      return { ok: false, error: "period 必须为 daily / weekly / monthly / yearly / total" };
    }
    const deadline =
      typeof input.deadline === "string" && input.deadline.trim()
        ? input.deadline.trim()
        : undefined;

    const actorId = resolveActorId(context);
    const goal = service.setGoal(actorId, type, target, periodRaw, deadline);

    return {
      ok: true,
      goal,
      summary: `已设置目标：${type} 达到 ${target}（${periodRaw}）`,
    };
  };
}

/**
 * health.get_goals 工具 handler。
 */
export function createHealthGetGoalsHandler(
  service: HealthFitnessService,
): ToolHandler {
  return async (_input: Record<string, unknown>, context: ToolContext) => {
    const actorId = resolveActorId(context);
    const goals = service.getGoalsWithProgress(actorId);

    return {
      ok: true,
      goals,
      count: goals.length,
      summary:
        goals.length === 0
          ? "暂未设置任何健康目标"
          : `共 ${goals.length} 个目标，达成 ${goals.filter((g) => g.achieved).length} 个`,
    };
  };
}

/**
 * health.import_data 工具 handler。
 *
 * 解析 json / csv 文本，调用 {@link HealthFitnessService.importMetrics} 批量入库。
 */
export function createHealthImportDataHandler(
  service: HealthFitnessService,
): ToolHandler {
  return async (input: Record<string, unknown>, context: ToolContext) => {
    const format = String(input.format ?? "").trim();
    if (format !== "json" && format !== "csv") {
      return { ok: false, error: "format 必须为 json 或 csv" };
    }
    const data = typeof input.data === "string" ? input.data : "";
    if (!data.trim()) {
      return { ok: false, error: "缺少 data（数据内容）" };
    }

    let metrics: HealthMetric[] = [];
    try {
      if (format === "json") {
        const parsed = JSON.parse(data);
        if (!Array.isArray(parsed)) {
          return { ok: false, error: "JSON 数据必须为数组" };
        }
        metrics = parsed
          .filter((item) => item && typeof item === "object")
          .map((item) => ({
            id: typeof item.id === "string" ? item.id : "",
            type: String(item.type ?? ""),
            value: Number(item.value),
            unit: String(item.unit ?? ""),
            timestamp: String(item.timestamp ?? ""),
            ...(typeof item.note === "string" && item.note ? { note: item.note } : {}),
          }))
          .filter((m) => m.type && Number.isFinite(m.value) && m.timestamp);
      } else {
        // CSV 解析（简易实现：首行表头，逗号分隔，允许 note 字段为空）
        metrics = parseCsv(data);
      }
    } catch (error) {
      return {
        ok: false,
        error: `数据解析失败：${error instanceof Error ? error.message : String(error)}`,
        retryable: true,
      };
    }

    if (metrics.length === 0) {
      return { ok: false, error: "解析后未得到有效记录（请检查字段：type/value/unit/timestamp）" };
    }

    const actorId = resolveActorId(context);
    const added = await service.importMetrics(actorId, metrics);

    return {
      ok: true,
      imported: added,
      total: metrics.length,
      summary: `成功导入 ${added} 条健康记录（共解析 ${metrics.length} 条）`,
    };
  };
}

/** 简易 CSV 解析：支持带引号字段与 note 为空。 */
function parseCsv(text: string): HealthMetric[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const header = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const idx = {
    type: header.indexOf("type"),
    value: header.indexOf("value"),
    unit: header.indexOf("unit"),
    timestamp: header.indexOf("timestamp"),
    note: header.indexOf("note"),
  };
  if (idx.type < 0 || idx.value < 0) return [];

  const out: HealthMetric[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cols = splitCsvLine(lines[i]);
    const type = (cols[idx.type] ?? "").trim();
    const valueStr = (cols[idx.value] ?? "").trim();
    const value = Number(valueStr);
    if (!type || !Number.isFinite(value)) continue;
    const unit = idx.unit >= 0 ? (cols[idx.unit] ?? "").trim() : "";
    const timestamp = idx.timestamp >= 0 ? (cols[idx.timestamp] ?? "").trim() : "";
    const note = idx.note >= 0 ? (cols[idx.note] ?? "").trim() : "";
    out.push({
      id: "",
      type,
      value,
      unit,
      timestamp: timestamp || new Date().toISOString(),
      ...(note ? { note } : {}),
    });
  }
  return out;
}

/** 按逗号分隔 CSV 单行，支持双引号包裹的字段（内部逗号不拆分）。 */
function splitCsvLine(line: string): string[] {
  const result: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      result.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  result.push(cur);
  return result;
}
