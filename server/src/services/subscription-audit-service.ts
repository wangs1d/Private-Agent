// SubscriptionAuditService —— 订阅服务自动盘点（财务管家 P0，痛点场景）
//
// 数据来源：finance-deep 账本（transactions.json）。检测逻辑纯确定性（零 LLM）：
//   同商户（归一化）+ 金额相近（±10%）+ 周期规律（7/30/90/365 天 ±容差）
//   连续 ≥2 期命中 → 疑似订阅（candidate），用户确认后转 confirmed。
//
// 使用率评估（克制原则）：不偷窥用户行为，只记录两处明确信号——
//   1. 用户口头反馈（finance.update_subscription action=used）
//   2. 续费提醒时用户回复（同上，由对话层落）
//   月度盘点按「60 天未使用/从未记录使用」给出"建议评估取消"名单。
//
// 存储：`data/finance/{actorId}/subscriptions.json`（与账本同目录），
// 懒加载 + 写穿式落盘（文件小、写入频率低）。
//
// 续费提醒：start() 启动每日扫描（到达 SUBSCRIPTION_SCAN_HOUR 且今日未扫），
// confirmed 订阅 nextRenewalDate 在 3 天内 → onRenewalReminder 回调
// （装配层接 ProactivityHub speak，life_reminder kind），同一续费日只提醒一次。
import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { FinanceDeepService, FinanceCategory } from "./finance-deep-service.js";

/** 订阅状态：candidate 疑似（待确认）/ confirmed 已确认 / cancelled 已退订 / ignored 非订阅 */
export type SubscriptionStatus = "candidate" | "confirmed" | "cancelled" | "ignored";

/** 单条订阅记录。 */
export interface SubscriptionRecord {
  id: string;
  /** 商户名（保留用户可见原始名） */
  merchant: string;
  /** 每期金额 */
  amount: number;
  /** 周期天数：7 周付 / 30 月付 / 90 季付 / 365 年付（也接受自定义 1~366） */
  periodDays: number;
  category?: FinanceCategory;
  status: SubscriptionStatus;
  /** 下次续费日 YYYY-MM-DD（confirmed 有意义） */
  nextRenewalDate?: string;
  /** 最近一次扣款日期（检测来源为账本最新一笔） */
  lastChargedAt?: string;
  /** 最近使用日期 YYYY-MM-DD（用户口头反馈；从未记录则缺省） */
  lastUsedAt?: string;
  note?: string;
  /** 检测证据：命中的交易 ID 与连续期数 */
  evidence?: { transactionIds: string[]; occurrences: number };
  createdAt: string;
  updatedAt: string;
}

/** 订阅记录归一化输入（confirm / 手动登记） */
export interface SubscriptionConfirmInput {
  subscriptionId?: string;
  merchant: string;
  amount: number;
  periodDays: number;
  nextRenewalDate?: string;
  category?: FinanceCategory;
  note?: string;
}

/** 更新操作 */
export type SubscriptionUpdateAction =
  | "used"        // 标记最近使用（lastUsedAt=今天或指定日期）
  | "cancel"      // 已退订
  | "ignore"      // 不是订阅（误检测/一次性支出）
  | "reactivate"  // 恢复为 confirmed（cancel/ignore 反悔）
  | "set_renewal" // 修改下次续费日
  | "note";       // 仅写备注

export interface SubscriptionUpdateInput {
  subscriptionId: string;
  action: SubscriptionUpdateAction;
  lastUsedAt?: string;
  nextRenewalDate?: string;
  note?: string;
}

/** 检测常量 */
const STANDARD_PERIODS = [7, 30, 90, 365] as const;
/** 周期容差：±3 天（月付扣款日漂移 / 周付跨月） */
const PERIOD_TOLERANCE_DAYS = 3;
/** 金额波动容差：单期内 ±10%（涨价/优惠价仍算同一订阅） */
const AMOUNT_TOLERANCE_RATIO = 0.1;
/** 连续 ≥2 期命中才出候选（3 笔交易；降误报） */
const MIN_OCCURRENCES = 2;
/** 使用率红线：超过 60 天未使用建议评估取消 */
const LOW_USAGE_DAYS = 60;
/** 续费提前提醒天数 */
const RENEWAL_REMIND_AHEAD_DAYS = 3;

export interface SubscriptionAuditDeps {
  financeDeepService: FinanceDeepService;
  /** 测试注入时钟 */
  now?: () => Date;
  /** 续费提醒回调（装配层接 ProactivityHub，life_reminder kind） */
  onRenewalReminder?: (actorId: string, message: string) => void;
}

export class SubscriptionAuditService {
  private readonly deps: SubscriptionAuditDeps;
  /** 内存态：actorId → 记录列表（懒加载） */
  private readonly stores = new Map<string, SubscriptionRecord[]>();

  /** 每日扫描调度 */
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  private lastScanDay = "";
  private started = false;
  /** 已提醒过的续费（actorId|subId|renewalDate），防重复打扰 */
  private readonly remindedKeys = new Set<string>();

  constructor(deps: SubscriptionAuditDeps) {
    this.deps = deps;
  }

  /**
   * 装配层后置接线：ProactivityHub 就绪后注入提醒回调。
   * （服务构造早于 hub 的场景；runDailyScan 只在回调注入后才会触发提醒。）
   */
  setOnRenewalReminder(cb: (actorId: string, message: string) => void): void {
    this.deps.onRenewalReminder = cb;
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  // ─── 持久化（懒加载 + 写穿） ────────────────────────────────

  private file(actorId: string): string {
    return join(this.dataRoot(), actorId, "subscriptions.json");
  }

  private async loadRecords(actorId: string): Promise<SubscriptionRecord[]> {
    const cached = this.stores.get(actorId);
    if (cached) return cached;
    let records: SubscriptionRecord[] = [];
    try {
      const raw = await readFile(this.file(actorId), "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) records = this.normalizeRecords(parsed);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("ENOENT")) {
        console.error(`[SubscriptionAudit] load ${actorId} failed:`, error);
      }
    }
    this.stores.set(actorId, records);
    return records;
  }

  private async saveRecords(actorId: string, records: SubscriptionRecord[]): Promise<void> {
    this.stores.set(actorId, records);
    const dir = join(this.dataRoot(), actorId);
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(this.file(actorId), JSON.stringify(records, null, 2), "utf8");
    } catch (error) {
      console.error(`[SubscriptionAudit] save ${actorId} failed:`, error);
    }
  }

  /** 与 FinanceDeepService 同一个 dataRoot（构造参数），经账本服务间接持有 */
  private dataRoot(): string {
    return this.deps.financeDeepService.getDataRoot();
  }

  private normalizeRecords(input: unknown[]): SubscriptionRecord[] {
    return input
      .filter((item) => item && typeof item === "object")
      .map((item) => {
        const r = item as Record<string, unknown>;
        return {
          id: typeof r.id === "string" && r.id ? r.id : randomUUID(),
          merchant: String(r.merchant ?? "未知商户"),
          amount: Math.abs(Number(r.amount) || 0),
          periodDays: clampPeriod(Number(r.periodDays)),
          ...(typeof r.category === "string" ? { category: r.category as FinanceCategory } : {}),
          status: isStatus(r.status) ? r.status : "candidate",
          ...(typeof r.nextRenewalDate === "string" ? { nextRenewalDate: r.nextRenewalDate } : {}),
          ...(typeof r.lastChargedAt === "string" ? { lastChargedAt: r.lastChargedAt } : {}),
          ...(typeof r.lastUsedAt === "string" ? { lastUsedAt: r.lastUsedAt } : {}),
          ...(typeof r.note === "string" ? { note: r.note } : {}),
          ...(r.evidence && typeof r.evidence === "object"
            ? {
                evidence: {
                  transactionIds: Array.isArray((r.evidence as Record<string, unknown>).transactionIds)
                    ? ((r.evidence as Record<string, unknown>).transactionIds as unknown[]).map(String)
                    : [],
                  occurrences: Number((r.evidence as Record<string, unknown>).occurrences) || 0,
                },
              }
            : {}),
          createdAt: typeof r.createdAt === "string" ? r.createdAt : this.now().toISOString(),
          updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : this.now().toISOString(),
        };
      });
  }

  // ─── 候选检测（确定性，零 LLM） ─────────────────────────────

  /**
   * 扫描账本刷新疑似订阅候选。
   * 规则：同商户（归一化）+ 金额 ±10% + 周期规律（标准周期 ±3 天）连续 ≥2 期。
   * 已有 confirmed/cancelled/ignored 记录的商户不再出候选；
   * 已有 candidate 但新检测期数更多时更新证据。
   *
   * @returns 本次新发现/更新的候选数
   */
  async refreshCandidates(actorId: string): Promise<number> {
    const finance = this.deps.financeDeepService;
    const txs = finance.getTransactions(actorId, undefined, undefined, undefined, 10_000);
    const records = await this.loadRecords(actorId);
    const settledMerchants = new Set(
      records
        .filter((r) => r.status === "confirmed" || r.status === "cancelled" || r.status === "ignored")
        .map((r) => normalizeMerchant(r.merchant)),
    );

    // 按归一化商户分组（仅支出且带商户名的交易）；display 保留原始名供展示
    const groups = new Map<
      string,
      { display: string; items: { date: number; amount: number; id: string }[] }
    >();
    for (const t of txs) {
      if (t.type !== "expense" || !t.merchant) continue;
      const key = normalizeMerchant(t.merchant);
      const group = groups.get(key) ?? { display: t.merchant, items: [] };
      group.items.push({ date: Date.parse(t.date), amount: t.amount, id: t.id });
      groups.set(key, group);
    }

    let changed = 0;
    for (const [key, group] of groups) {
      const items = group.items;
      if (settledMerchants.has(key)) continue;
      if (items.length < MIN_OCCURRENCES + 1) continue;
      items.sort((a, b) => a.date - b.date);
      const chain = detectRecurringChain(items);
      if (!chain) continue;

      const existing = records.find((r) => normalizeMerchant(r.merchant) === key);
      if (existing && existing.status === "candidate") {
        if ((existing.evidence?.occurrences ?? 0) < chain.occurrences) {
          existing.evidence = { transactionIds: chain.transactionIds, occurrences: chain.occurrences };
          existing.amount = chain.amount;
          existing.periodDays = chain.periodDays;
          existing.lastChargedAt = isoDay(items[items.length - 1].date);
          existing.updatedAt = this.now().toISOString();
          changed += 1;
        }
        continue;
      }
      if (existing) continue; // 并发下 settled 集已过期的情况，兜底跳过

      records.push({
        id: randomUUID(),
        merchant: group.display,
        amount: chain.amount,
        periodDays: chain.periodDays,
        status: "candidate",
        lastChargedAt: isoDay(items[items.length - 1].date),
        evidence: { transactionIds: chain.transactionIds, occurrences: chain.occurrences },
        createdAt: this.now().toISOString(),
        updatedAt: this.now().toISOString(),
      });
      changed += 1;
    }

    if (changed > 0) await this.saveRecords(actorId, records);
    return changed;
  }

  // ─── 查询 / 确认 / 更新 ─────────────────────────────────────

  async listSubscriptions(
    actorId: string,
    statuses?: SubscriptionStatus[],
  ): Promise<SubscriptionRecord[]> {
    const records = await this.loadRecords(actorId);
    const filtered = statuses && statuses.length > 0
      ? records.filter((r) => statuses.includes(r.status))
      : records;
    const order: Record<SubscriptionStatus, number> = {
      confirmed: 0,
      candidate: 1,
      cancelled: 2,
      ignored: 3,
    };
    return [...filtered].sort(
      (a, b) =>
        order[a.status] - order[b.status] ||
        monthlyCost(b.amount, b.periodDays) - monthlyCost(a.amount, a.periodDays),
    );
  }

  /** 确认候选 / 手动登记订阅。 */
  async confirmSubscription(
    actorId: string,
    input: SubscriptionConfirmInput,
  ): Promise<SubscriptionRecord | null> {
    const merchant = String(input.merchant ?? "").trim();
    const amount = Number(input.amount);
    const periodDays = clampPeriod(Number(input.periodDays));
    if (!merchant) return null;
    if (!Number.isFinite(amount) || amount <= 0) return null;
    if (!Number.isFinite(periodDays)) return null;

    const records = await this.loadRecords(actorId);
    const key = normalizeMerchant(merchant);
    let record =
      (input.subscriptionId
        ? records.find((r) => r.id === input.subscriptionId)
        : undefined) ??
      records.find((r) => normalizeMerchant(r.merchant) === key);
    const nowIso = this.now().toISOString();
    if (!record) {
      record = {
        id: randomUUID(),
        merchant,
        amount,
        periodDays,
        status: "confirmed",
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      records.push(record);
    }
    record.merchant = merchant;
    record.amount = amount;
    record.periodDays = periodDays;
    record.status = "confirmed";
    if (input.nextRenewalDate) record.nextRenewalDate = input.nextRenewalDate;
    if (input.category) record.category = input.category;
    if (input.note) record.note = input.note;
    record.updatedAt = nowIso;
    await this.saveRecords(actorId, records);
    return record;
  }

  /** 更新状态 / 使用记录。 */
  async updateSubscription(
    actorId: string,
    input: SubscriptionUpdateInput,
  ): Promise<SubscriptionRecord | null> {
    const records = await this.loadRecords(actorId);
    const record = records.find((r) => r.id === input.subscriptionId);
    if (!record) return null;
    const now = this.now();
    const nowIso = now.toISOString();
    switch (input.action) {
      case "used":
        record.lastUsedAt = input.lastUsedAt ?? isoDay(now.getTime());
        break;
      case "cancel":
        record.status = "cancelled";
        break;
      case "ignore":
        record.status = "ignored";
        break;
      case "reactivate":
        record.status = "confirmed";
        break;
      case "set_renewal":
        if (input.nextRenewalDate) record.nextRenewalDate = input.nextRenewalDate;
        break;
      case "note":
        if (input.note) record.note = input.note;
        break;
    }
    record.updatedAt = nowIso;
    await this.saveRecords(actorId, records);
    return record;
  }

  // ─── 盘点摘要（月报追加段；纯确定性文本） ────────────────────

  /** 月度订阅盘点段（无订阅时返回空串，月报不追加）。 */
  async buildAuditSummary(actorId: string): Promise<string> {
    await this.refreshCandidates(actorId);
    const records = await this.listSubscriptions(actorId);
    const confirmed = records.filter((r) => r.status === "confirmed");
    const candidates = records.filter((r) => r.status === "candidate");
    if (confirmed.length === 0 && candidates.length === 0) return "";

    const now = this.now();
    const lines: string[] = [];
    let monthlyTotal = 0;
    const lowUsage: string[] = [];
    for (const r of confirmed) {
      monthlyTotal += monthlyCost(r.amount, r.periodDays);
      const daysUnused = r.lastUsedAt
        ? Math.floor((now.getTime() - Date.parse(r.lastUsedAt)) / 86_400_000)
        : null;
      if (daysUnused === null || daysUnused >= LOW_USAGE_DAYS) {
        lowUsage.push(
          `- ${r.merchant}：¥${r.amount.toFixed(2)}/${periodLabel(r.periodDays)}` +
            (daysUnused === null ? "（从未记录使用）" : `（${daysUnused} 天未用，上次 ${r.lastUsedAt}）`),
        );
      }
    }
    lines.push(
      `订阅盘点：确认 ${confirmed.length} 个，折算月成本约 ¥${monthlyTotal.toFixed(2)}。` +
        (candidates.length > 0 ? `另有 ${candidates.length} 个疑似订阅待确认。` : ""),
    );
    if (lowUsage.length > 0) {
      lines.push("建议评估是否取消：", ...lowUsage.slice(0, 5));
    }
    if (candidates.length > 0) {
      lines.push(
        "疑似订阅（待确认）：",
        ...candidates
          .slice(0, 5)
          .map(
            (c) =>
              `- ${c.merchant}：¥${c.amount.toFixed(2)}/${periodLabel(c.periodDays)}（近 ${c.evidence?.occurrences ?? "?"} 期规律扣款）`,
          ),
      );
    }
    return lines.join("\n");
  }

  // ─── 续费提醒（每日扫描） ───────────────────────────────────

  /** 启动每日扫描调度（每小时检查一次是否到达扫描时刻；测试可直调 runDailyScan） */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.scanTimer = setInterval(() => {
      try {
        void this.tickScan();
      } catch (err) {
        console.log(`[SubscriptionAudit] 扫描 tick 失败（忽略）: ${err}`);
      }
    }, 60 * 60 * 1000);
    if (typeof this.scanTimer.unref === "function") this.scanTimer.unref();
    console.log("[SubscriptionAudit] 订阅盘点监听已启动（候选检测 + 续费提醒）");
  }

  stop(): void {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
    this.started = false;
  }

  private tickScan(): void {
    const now = this.now();
    const today = isoDay(now.getTime());
    if (this.lastScanDay === today) return;
    const scanHour = Number(process.env.SUBSCRIPTION_SCAN_HOUR ?? 9);
    if (now.getHours() < (Number.isFinite(scanHour) ? scanHour : 9)) return;
    this.lastScanDay = today;
    void this.runDailyScan(now).catch((err) => {
      console.log(`[SubscriptionAudit] 每日扫描失败（忽略）: ${err}`);
    });
  }

  /** 每日扫描：全部 actor 的续费前提醒（同一续费日只提醒一次）。 */
  async runDailyScan(now: Date = this.now()): Promise<void> {
    if (!this.deps.onRenewalReminder) return;
    const actors = this.deps.financeDeepService.listActorIds();
    for (const actorId of actors) {
      try {
        const records = await this.listSubscriptions(actorId, ["confirmed"]);
        const upcoming = records.filter((r) => {
          if (!r.nextRenewalDate) return false;
          const days = daysUntil(r.nextRenewalDate, now);
          return days !== null && days >= 0 && days <= RENEWAL_REMIND_AHEAD_DAYS;
        });
        if (upcoming.length === 0) continue;
        const pending = upcoming.filter((r) => {
          const key = `${actorId}|${r.id}|${r.nextRenewalDate}`;
          if (this.remindedKeys.has(key)) return false;
          this.remindedKeys.add(key);
          return true;
        });
        if (pending.length === 0) continue;
        const lines = pending.map((r) => {
          const days = daysUntil(r.nextRenewalDate!, now) ?? 0;
          const usedHint = isLowUsage(r, now) ? "最近似乎没怎么用，" : "";
          return (
            `- ${r.merchant}：¥${r.amount.toFixed(2)}/${periodLabel(r.periodDays)}，` +
            `${days === 0 ? "今天" : `${days} 天后`}（${r.nextRenewalDate}）自动续费。${usedHint}续费前取消可以省下这笔。`
          );
        });
        const message =
          `以下订阅即将自动续费：\n${lines.join("\n")}\n` +
          `还在用的话忽略这条即可；不用了告诉我，我帮你从订阅清单里划掉。`;
        this.deps.onRenewalReminder(actorId, message);
        console.log(`[SubscriptionAudit] 续费提醒 actor=${actorId} ${pending.length} 条`);
      } catch (err) {
        console.log(`[SubscriptionAudit] 续费扫描失败（忽略）actor=${actorId}: ${err}`);
      }
    }
  }
}

// ─── 纯函数（导出供测试） ──────────────────────────────────────

/** 商户名归一化：小写 + 去首尾空白 + 压缩空白。 */
export function normalizeMerchant(merchant: string): string {
  return merchant.toLowerCase().trim().replace(/\s+/g, " ");
}

/** 折算月成本（周付 ×30/7，年付 ×30/365）。 */
export function monthlyCost(amount: number, periodDays: number): number {
  if (!Number.isFinite(periodDays) || periodDays <= 0) return amount;
  return Number(((amount * 30) / periodDays).toFixed(2));
}

/** 周期的人话标签。 */
export function periodLabel(periodDays: number): string {
  if (periodDays === 7) return "周";
  if (periodDays === 30) return "月";
  if (periodDays === 90) return "季";
  if (periodDays === 365) return "年";
  return `${periodDays} 天`;
}

/**
 * 在按时间升序的扣款序列里找最长规律链：
 * 对每个标准周期，找连续间隔都 ≈ 周期（±3 天）且金额都 ≈ 链首金额（±10%）的段，
 * 返回最长段（≥ MIN_OCCURRENCES 期）；无则 null。
 */
export function detectRecurringChain(
  items: { date: number; amount: number; id: string }[],
): { transactionIds: string[]; occurrences: number; amount: number; periodDays: number } | null {
  let best: {
    transactionIds: string[];
    occurrences: number;
    amount: number;
    periodDays: number;
  } | null = null;
  for (const period of STANDARD_PERIODS) {
    for (let start = 0; start < items.length; start += 1) {
      const chainIds = [items[start].id];
      const baseAmount = items[start].amount;
      let prev = items[start].date;
      let occurrences = 0;
      for (let i = start + 1; i < items.length; i += 1) {
        const gapDays = (items[i].date - prev) / 86_400_000;
        if (Math.abs(gapDays - period) > PERIOD_TOLERANCE_DAYS) break;
        if (
          Math.abs(items[i].amount - baseAmount) / baseAmount > AMOUNT_TOLERANCE_RATIO
        ) {
          break;
        }
        chainIds.push(items[i].id);
        occurrences += 1;
        prev = items[i].date;
      }
      if (occurrences >= MIN_OCCURRENCES && (!best || occurrences > best.occurrences)) {
        best = {
          transactionIds: chainIds,
          occurrences,
          amount: Number(baseAmount.toFixed(2)),
          periodDays: period,
        };
      }
    }
  }
  return best;
}

/** 距目标日期（YYYY-MM-DD）的天数；解析失败返回 null。 */
export function daysUntil(dateStr: string, now: Date): number | null {
  const target = Date.parse(`${dateStr}T00:00:00`);
  if (!Number.isFinite(target)) return null;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return Math.round((target - today) / 86_400_000);
}

/** 是否低使用（从未记录使用，或超过 60 天未用）。 */
export function isLowUsage(record: SubscriptionRecord, now: Date): boolean {
  if (!record.lastUsedAt) return true;
  const days = Math.floor((now.getTime() - Date.parse(record.lastUsedAt)) / 86_400_000);
  return !Number.isFinite(days) || days >= LOW_USAGE_DAYS;
}

function isoDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function clampPeriod(raw: number): number {
  if (!Number.isFinite(raw)) return NaN;
  return Math.max(1, Math.min(366, Math.round(raw)));
}

function isStatus(v: unknown): v is SubscriptionStatus {
  return (
    v === "candidate" || v === "confirmed" || v === "cancelled" || v === "ignored"
  );
}
