import type { ToolHandler, ToolContext } from "../../tool-registry.js";
import { resolveActorId } from "../../../agent/actor-id.js";
import type {
  FinanceDeepService,
  FinanceTransaction,
  FinanceCategory,
} from "../../../services/finance-deep-service.js";
import { FINANCE_CATEGORIES } from "../../../services/finance-deep-service.js";
import type {
  SubscriptionAuditService,
  SubscriptionStatus,
} from "../../../services/subscription-audit-service.js";
import { monthlyCost, periodLabel } from "../../../services/subscription-audit-service.js";

/**
 * finance.import_transactions 工具 handler。
 *
 * 解析 json / csv 文本，调用 {@link FinanceDeepService.importTransactions} 批量入库。
 * 未分类（category 为空或非法）由 service 内部按 description 关键词自动分类。
 */
export function createFinanceImportTransactionsHandler(
  service: FinanceDeepService,
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

    let items: FinanceTransaction[] = [];
    try {
      if (format === "json") {
        const parsed = JSON.parse(data);
        if (!Array.isArray(parsed)) {
          return { ok: false, error: "JSON 数据必须为数组" };
        }
        items = parsed
          .filter((item) => item && typeof item === "object")
          .map((item) => {
            const r = item as Record<string, unknown>;
            return {
              id: typeof r.id === "string" ? r.id : "",
              date: String(r.date ?? ""),
              amount: Number(r.amount),
              type: r.type === "income" ? ("income" as const) : ("expense" as const),
              category: typeof r.category === "string" ? (r.category as FinanceCategory) : "其他",
              ...(typeof r.merchant === "string" && r.merchant ? { merchant: r.merchant } : {}),
              ...(typeof r.description === "string" && r.description ? { description: r.description } : {}),
              ...(typeof r.source === "string" && r.source ? { source: r.source } : {}),
            };
          })
          .filter((t) => t.date && Number.isFinite(t.amount));
      } else {
        // CSV 解析
        items = parseCsv(data);
      }
    } catch (error) {
      return {
        ok: false,
        error: `数据解析失败：${error instanceof Error ? error.message : String(error)}`,
        retryable: true,
      };
    }

    if (items.length === 0) {
      return {
        ok: false,
        error: "解析后未得到有效记录（请检查字段：date/amount/type）",
      };
    }

    // 注入 source（若调用方传入）
    const source =
      typeof input.source === "string" && input.source.trim()
        ? input.source.trim()
        : undefined;
    if (source) {
      items = items.map((t) => ({ ...t, source }));
    }

    const actorId = resolveActorId(context);
    const added = await service.importTransactions(actorId, items);

    return {
      ok: true,
      imported: added,
      total: items.length,
      summary: `成功导入 ${added} 条交易记录（共解析 ${items.length} 条）`,
    };
  };
}

/**
 * finance.analyze_spending 工具 handler。
 */
export function createFinanceAnalyzeSpendingHandler(
  service: FinanceDeepService,
): ToolHandler {
  return async (input: Record<string, unknown>, context: ToolContext) => {
    const from =
      typeof input.from === "string" && input.from.trim() ? input.from.trim() : undefined;
    const to = typeof input.to === "string" && input.to.trim() ? input.to.trim() : undefined;
    const groupByRaw = typeof input.groupBy === "string" ? input.groupBy.trim() : undefined;
    const groupBy =
      groupByRaw === "category" || groupByRaw === "month" ? groupByRaw : undefined;

    const actorId = resolveActorId(context);
    const analysis = service.analyzeSpending(actorId, from, to, groupBy);

    const topCats = analysis.topCategories
      .map((c) => `${c.category} ¥${c.total.toFixed(2)}（${(c.ratio * 100).toFixed(0)}%）`)
      .join("、");

    return {
      ok: true,
      analysis,
      summary:
        analysis.count === 0
          ? `时间段内无交易记录（${analysis.from} ~ ${analysis.to}）`
          : `总支出 ¥${analysis.totalExpense.toFixed(2)} / 总收入 ¥${analysis.totalIncome.toFixed(2)} / 净额 ¥${analysis.net.toFixed(2)}（趋势 ${analysis.trend}）。Top：${topCats}`,
    };
  };
}

/**
 * finance.set_budget 工具 handler。
 */
export function createFinanceSetBudgetHandler(
  service: FinanceDeepService,
): ToolHandler {
  return async (input: Record<string, unknown>, context: ToolContext) => {
    const categoryRaw = String(input.category ?? "").trim();
    if (!(FINANCE_CATEGORIES as readonly string[]).includes(categoryRaw)) {
      return {
        ok: false,
        error: `category 必须为：${FINANCE_CATEGORIES.join(" / ")}`,
      };
    }
    const category = categoryRaw as FinanceCategory;
    const amount = Number(input.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return { ok: false, error: "amount 必须为正数" };
    }
    const periodRaw = String(input.period ?? "").trim();
    if (periodRaw !== "monthly" && periodRaw !== "yearly") {
      return { ok: false, error: "period 必须为 monthly 或 yearly" };
    }
    const startDate =
      typeof input.startDate === "string" && input.startDate.trim()
        ? input.startDate.trim()
        : undefined;
    const endDate =
      typeof input.endDate === "string" && input.endDate.trim()
        ? input.endDate.trim()
        : undefined;

    const actorId = resolveActorId(context);
    const budget = service.setBudget(actorId, category, amount, periodRaw, startDate, endDate);

    return {
      ok: true,
      budget,
      summary: `已设置 ${category} 预算 ¥${amount.toFixed(2)}（${periodRaw === "monthly" ? "每月" : "每年"}）`,
    };
  };
}

/**
 * finance.get_budget_status 工具 handler。
 */
export function createFinanceGetBudgetStatusHandler(
  service: FinanceDeepService,
): ToolHandler {
  return async (input: Record<string, unknown>, context: ToolContext) => {
    const month =
      typeof input.month === "string" && input.month.trim()
        ? input.month.trim()
        : undefined;

    const actorId = resolveActorId(context);
    const statuses = service.getBudgetStatus(actorId, month);

    if (statuses.length === 0) {
      return {
        ok: true,
        budgets: [],
        summary: "暂未设置任何预算",
      };
    }

    const exceeded = statuses.filter((s) => s.level === "exceeded");
    const warning = statuses.filter((s) => s.level === "warning");
    const summaryParts: string[] = [`共 ${statuses.length} 个预算`];
    if (exceeded.length > 0) {
      summaryParts.push(
        `⚠️ 超支 ${exceeded.length} 个：${exceeded.map((s) => s.budget.category).join("、")}`,
      );
    }
    if (warning.length > 0) {
      summaryParts.push(
        `提醒 ${warning.length} 个：${warning.map((s) => s.budget.category).join("、")}`,
      );
    }

    return {
      ok: true,
      budgets: statuses,
      summary: summaryParts.join("，"),
    };
  };
}

/**
 * finance.reconcile 工具 handler。
 */
export function createFinanceReconcileHandler(
  service: FinanceDeepService,
): ToolHandler {
  return async (input: Record<string, unknown>, context: ToolContext) => {
    const expectedRaw = input.expectedItems;
    if (!Array.isArray(expectedRaw) || expectedRaw.length === 0) {
      return { ok: false, error: "缺少 expectedItems（账单列表）或为空" };
    }

    const expectedItems: FinanceTransaction[] = expectedRaw
      .filter((item) => item && typeof item === "object")
      .map((item) => {
        const r = item as Record<string, unknown>;
        return {
          id: typeof r.id === "string" ? r.id : "",
          date: String(r.date ?? ""),
          amount: Math.abs(Number(r.amount) || 0),
          type: r.type === "income" ? ("income" as const) : ("expense" as const),
          category: "其他" as FinanceCategory,
          ...(typeof r.merchant === "string" && r.merchant ? { merchant: r.merchant } : {}),
          ...(typeof r.description === "string" && r.description ? { description: r.description } : {}),
        };
      })
      .filter((t) => t.date && Number.isFinite(t.amount));

    if (expectedItems.length === 0) {
      return { ok: false, error: "解析后未得到有效账单条目（请检查 date/amount/type 字段）" };
    }

    const actorId = resolveActorId(context);
    const diff = service.reconcile(actorId, expectedItems);

    const summaryParts: string[] = [
      `账单 ${expectedItems.length} 条 / 已记录匹配 ${diff.summary.matched} 条`,
    ];
    if (diff.summary.onlyInRecords > 0) {
      summaryParts.push(`仅已记录有 ${diff.summary.onlyInRecords} 条`);
    }
    if (diff.summary.onlyInExpected > 0) {
      summaryParts.push(`仅账单有 ${diff.summary.onlyInExpected} 条`);
    }
    if (diff.summary.amountMismatch > 0) {
      summaryParts.push(`金额不一致 ${diff.summary.amountMismatch} 条`);
    }

    return {
      ok: true,
      diff,
      summary: summaryParts.join("，"),
    };
  };
}

/**
 * finance.categorize 工具 handler。
 */
export function createFinanceCategorizeHandler(
  service: FinanceDeepService,
): ToolHandler {
  return async (input: Record<string, unknown>) => {
    const description = String(input.description ?? "").trim();
    if (!description) {
      return { ok: false, error: "缺少 description（交易描述）" };
    }
    const amount =
      input.amount != null && Number.isFinite(Number(input.amount))
        ? Number(input.amount)
        : undefined;

    const result = service.categorize(description, amount);

    return {
      ok: true,
      category: result.category,
      matched: result.matched,
      summary: `分类为「${result.category}」${result.matched ? `（命中关键词：${result.matched}）` : "（未命中任何关键词，归为其他）"}`,
    };
  };
}

/**
 * finance.export_report 工具 handler。
 */
export function createFinanceExportReportHandler(
  service: FinanceDeepService,
): ToolHandler {
  return async (input: Record<string, unknown>, context: ToolContext) => {
    const from = String(input.from ?? "").trim();
    if (!from) {
      return { ok: false, error: "缺少 from（起始时间）" };
    }
    const to = String(input.to ?? "").trim();
    if (!to) {
      return { ok: false, error: "缺少 to（结束时间）" };
    }
    const formatRaw = String(input.format ?? "markdown").trim();
    const format =
      formatRaw === "markdown" || formatRaw === "csv" || formatRaw === "json"
        ? formatRaw
        : "markdown";

    const actorId = resolveActorId(context);
    try {
      const result = await service.exportReport(actorId, from, to, format);
      return {
        ok: true,
        fileUrl: result.fileUrl,
        filePath: result.filePath,
        size: result.size,
        format: result.format,
        summary: `已导出 ${format} 报告：${result.fileUrl}（${result.size} 字节）`,
      };
    } catch (error) {
      return {
        ok: false,
        error: `导出失败：${error instanceof Error ? error.message : String(error)}`,
        retryable: true,
      };
    }
  };
}

/**
 * finance.list_subscriptions 工具 handler。
 *
 * 先自动刷新疑似订阅候选（确定性检测），再按状态过滤列出。
 */
export function createFinanceListSubscriptionsHandler(
  service: SubscriptionAuditService,
): ToolHandler {
  return async (input: Record<string, unknown>, context: ToolContext) => {
    const statusRaw = String(input.status ?? "all").trim();
    const statuses: SubscriptionStatus[] | undefined =
      statusRaw === "all" || !statusRaw
        ? undefined
        : ([statusRaw].filter((s): s is SubscriptionStatus =>
            ["candidate", "confirmed", "cancelled", "ignored"].includes(s),
          ) as SubscriptionStatus[]);
    if (statusRaw !== "all" && statusRaw && (statuses?.length ?? 0) === 0) {
      return {
        ok: false,
        error: "status 必须为 all / candidate / confirmed / cancelled / ignored",
      };
    }

    const actorId = resolveActorId(context);
    const newCandidates = await service.refreshCandidates(actorId);
    const records = await service.listSubscriptions(actorId, statuses);

    const summaryParts: string[] = [];
    const confirmed = records.filter((r) => r.status === "confirmed");
    const candidates = records.filter((r) => r.status === "candidate");
    if (records.length === 0) {
      summaryParts.push("暂无订阅记录");
    } else {
      if (confirmed.length > 0) {
        const monthly = confirmed.reduce((acc, r) => acc + monthlyCost(r.amount, r.periodDays), 0);
        summaryParts.push(
          `确认订阅 ${confirmed.length} 个，折算月成本约 ¥${monthly.toFixed(2)}` +
            `（${confirmed.map((r) => `${r.merchant} ¥${r.amount.toFixed(2)}/${periodLabel(r.periodDays)}`).join("、")}）`,
        );
      }
      if (candidates.length > 0) {
        summaryParts.push(
          `疑似订阅 ${candidates.length} 个待确认` +
            `（${candidates.map((r) => r.merchant).join("、")}）`,
        );
      }
      const settled = records.filter(
        (r) => r.status === "cancelled" || r.status === "ignored",
      );
      if (settled.length > 0) summaryParts.push(`已退订/忽略 ${settled.length} 个`);
      if (newCandidates > 0) summaryParts.push(`本次新检测到 ${newCandidates} 个候选`);
    }

    return {
      ok: true,
      subscriptions: records,
      newCandidates,
      summary: summaryParts.join("，"),
    };
  };
}

/**
 * finance.confirm_subscription 工具 handler。
 */
export function createFinanceConfirmSubscriptionHandler(
  service: SubscriptionAuditService,
): ToolHandler {
  return async (input: Record<string, unknown>, context: ToolContext) => {
    const merchant = String(input.merchant ?? "").trim();
    const amount = Number(input.amount);
    const periodDays = Number(input.periodDays);
    if (!merchant) return { ok: false, error: "缺少 merchant（商户/服务名）" };
    if (!Number.isFinite(amount) || amount <= 0) {
      return { ok: false, error: "amount 必须为正数" };
    }
    if (!Number.isFinite(periodDays) || periodDays < 1 || periodDays > 366) {
      return { ok: false, error: "periodDays 必须为 1~366 的天数（常见 7/30/90/365）" };
    }
    const subscriptionId =
      typeof input.subscriptionId === "string" && input.subscriptionId.trim()
        ? input.subscriptionId.trim()
        : undefined;
    const nextRenewalDate =
      typeof input.nextRenewalDate === "string" && input.nextRenewalDate.trim()
        ? input.nextRenewalDate.trim()
        : undefined;
    const categoryRaw = typeof input.category === "string" ? input.category.trim() : "";
    const category = (FINANCE_CATEGORIES as readonly string[]).includes(categoryRaw)
      ? (categoryRaw as FinanceCategory)
      : undefined;

    const actorId = resolveActorId(context);
    const record = await service.confirmSubscription(actorId, {
      ...(subscriptionId ? { subscriptionId } : {}),
      merchant,
      amount,
      periodDays,
      ...(nextRenewalDate ? { nextRenewalDate } : {}),
      ...(category ? { category } : {}),
    });
    if (!record) {
      return { ok: false, error: "确认失败：找不到对应订阅记录（可先 list_subscriptions 查看）" };
    }

    return {
      ok: true,
      subscription: record,
      summary:
        `已确认订阅「${record.merchant}」：¥${record.amount.toFixed(2)}/${periodLabel(record.periodDays)}` +
        (record.nextRenewalDate ? `，下次续费 ${record.nextRenewalDate}（前 3 天会提醒你）` : ""),
    };
  };
}

/**
 * finance.update_subscription 工具 handler。
 */
export function createFinanceUpdateSubscriptionHandler(
  service: SubscriptionAuditService,
): ToolHandler {
  return async (input: Record<string, unknown>, context: ToolContext) => {
    const subscriptionId = String(input.subscriptionId ?? "").trim();
    const action = String(input.action ?? "").trim();
    if (!subscriptionId) return { ok: false, error: "缺少 subscriptionId" };
    const validActions = ["used", "cancel", "ignore", "reactivate", "set_renewal", "note"];
    if (!validActions.includes(action)) {
      return { ok: false, error: `action 必须为：${validActions.join(" / ")}` };
    }
    if (action === "set_renewal" && !String(input.nextRenewalDate ?? "").trim()) {
      return { ok: false, error: "action=set_renewal 时必须传 nextRenewalDate" };
    }
    if (action === "note" && !String(input.note ?? "").trim()) {
      return { ok: false, error: "action=note 时必须传 note" };
    }

    const actorId = resolveActorId(context);
    const record = await service.updateSubscription(actorId, {
      subscriptionId,
      action: action as "used" | "cancel" | "ignore" | "reactivate" | "set_renewal" | "note",
      ...(typeof input.lastUsedAt === "string" && input.lastUsedAt.trim()
        ? { lastUsedAt: input.lastUsedAt.trim() }
        : {}),
      ...(typeof input.nextRenewalDate === "string" && input.nextRenewalDate.trim()
        ? { nextRenewalDate: input.nextRenewalDate.trim() }
        : {}),
      ...(typeof input.note === "string" && input.note.trim() ? { note: input.note.trim() } : {}),
    });
    if (!record) {
      return { ok: false, error: "找不到该订阅记录（可先 list_subscriptions 查看）" };
    }

    const actionLabels: Record<string, string> = {
      used: `已记录使用${record.lastUsedAt ? `（最近使用 ${record.lastUsedAt}）` : ""}`,
      cancel: "已标记为退订（不再参与续费提醒）",
      ignore: "已忽略（不再出候选）",
      reactivate: "已恢复为确认订阅",
      set_renewal: `下次续费日已改为 ${record.nextRenewalDate}`,
      note: "备注已更新",
    };

    return {
      ok: true,
      subscription: record,
      summary: `「${record.merchant}」${actionLabels[action]}`,
    };
  };
}

// ─── 内部工具：CSV 解析 ────────────────────────────────────────
/** 简易 CSV 解析：支持带引号字段与可选字段为空。 */
function parseCsv(text: string): FinanceTransaction[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const header = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const idx = {
    date: header.indexOf("date"),
    amount: header.indexOf("amount"),
    type: header.indexOf("type"),
    category: header.indexOf("category"),
    merchant: header.indexOf("merchant"),
    description: header.indexOf("description"),
  };
  if (idx.date < 0 || idx.amount < 0) return [];

  const out: FinanceTransaction[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cols = splitCsvLine(lines[i]);
    const date = (cols[idx.date] ?? "").trim();
    const amountStr = (cols[idx.amount] ?? "").trim();
    const amount = Number(amountStr);
    if (!date || !Number.isFinite(amount)) continue;
    const typeRaw = idx.type >= 0 ? (cols[idx.type] ?? "").trim().toLowerCase() : "expense";
    const type: "income" | "expense" = typeRaw === "income" ? "income" : "expense";
    const categoryRaw = idx.category >= 0 ? (cols[idx.category] ?? "").trim() : "";
    const merchant = idx.merchant >= 0 ? (cols[idx.merchant] ?? "").trim() : "";
    const description = idx.description >= 0 ? (cols[idx.description] ?? "").trim() : "";
    out.push({
      id: "",
      date,
      amount: Math.abs(amount),
      type,
      category: (categoryRaw || "其他") as FinanceCategory,
      ...(merchant ? { merchant } : {}),
      ...(description ? { description } : {}),
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
