// BillManagementService —— 账单管理（订阅与财务清理 · 追踪/提醒/预算）
//
// 追踪：定期账单（房租/水电/燃气/话费/宽带/物业/信用卡还款/保险…）登记 + 下次到期日推算
//       + 状态判定（即将到期 due_soon / 已逾期 overdue / 正常 ok / 一次性已缴 paid）。
//       周付/月付账单按 dueDay（周几/几号）推算，且「本周期已缴」判定防止缴完还提醒；
//       季付/年付/一次性按 dueDate（下次到期日）追踪，缴一次自动顺延一个周期。
// 提醒：每日扫描（到达 BILL_SCAN_HOUR 且今日未扫），到期前 N 天（默认 3）+ 已逾期账单
//       → onBillReminder 回调（装配层接 ProactivityHub speak，life_reminder kind），
//       同一到期日只提醒一次。
// 预算：缴费（markBillPaid）自动写入 finance-deep 账本（source=bill_payment），
//       返回该分类预算的最新执行进度——账单缴费即时反映到预算，无需再手动记账。
//
// 存储：`data/finance/{actorId}/bills.json`（与账本同目录），懒加载 + 写穿式落盘。
import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  FinanceDeepService,
  FinanceCategory,
  BudgetStatus,
} from "./finance-deep-service.js";

/** 账单周期：weekly 周付 / monthly 月付 / quarterly 季付 / yearly 年付 / one_off 一次性 */
export type BillCadence = "weekly" | "monthly" | "quarterly" | "yearly" | "one_off";

/** 派生状态：due_soon 即将到期（窗口内）/ overdue 已逾期 / ok 正常 / paid 已缴（一次性） */
export type BillStatus = "due_soon" | "overdue" | "ok" | "paid";

/** 单条账单记录。 */
export interface BillRecord {
  id: string;
  /** 账单名（如 房租 / 水电费 / 信用卡还款） */
  name: string;
  /** 收款方/商户（可选） */
  merchant?: string;
  /** 每期金额 */
  amount: number;
  cadence: BillCadence;
  /** 扣费日：weekly 1~7（周一~周日）/ monthly·quarterly·yearly 1~31（几号，季/年仅作展示参考） */
  dueDay?: number;
  /** 下次到期日 YYYY-MM-DD：quarterly/yearly/one_off 必填（缴费后自动顺延）；weekly/monthly 不填自动推算 */
  dueDate?: string;
  /** 预算分类（缴费入账用，默认 居住） */
  category: FinanceCategory;
  /** 是否自动扣款（提醒话术不同：确认余额充足 vs 记得手动缴） */
  autopay: boolean;
  /** 最近一次缴费日期 YYYY-MM-DD */
  lastPaidAt?: string;
  lastPaidAmount?: number;
  /** 缴费历史（最新在前，最多保留 24 条） */
  payments: Array<{ date: string; amount: number; transactionId?: string }>;
  note?: string;
  createdAt: string;
  updatedAt: string;
}

/** 登记账单输入。 */
export interface BillAddInput {
  name: string;
  amount: number;
  cadence: BillCadence;
  dueDay?: number;
  dueDate?: string;
  category?: FinanceCategory;
  autopay?: boolean;
  merchant?: string;
  note?: string;
}

/** 账单更新输入（只改传入字段）。 */
export interface BillUpdateInput {
  name?: string;
  amount?: number;
  dueDay?: number;
  dueDate?: string;
  category?: FinanceCategory;
  autopay?: boolean;
  merchant?: string;
  note?: string;
}

/** 缴费结果：账单顺延 + 入账 transactionId + 分类预算最新进度。 */
export interface BillPayResult {
  ok: boolean;
  error?: string;
  bill?: BillRecord;
  /** 入账交易 ID（source=bill_payment） */
  transactionId?: string;
  /** 缴费后该分类的预算执行进度（设置了该分类预算时返回） */
  budget?: BudgetStatus;
}

/** 单条账单 + 派生信息（listBills 返回）。 */
export interface BillWithStatus {
  bill: BillRecord;
  nextDueDate: string | null;
  daysUntilDue: number | null;
  status: BillStatus;
  /** 折算月成本（one_off 不折算，返回 0） */
  monthlyEquivalent: number;
}

/** 常量 */
/** 到期提前提醒天数 */
const BILL_REMIND_AHEAD_DAYS = 3;
/** 缴费历史保留上限 */
const MAX_PAYMENTS = 24;
const CADENCES: BillCadence[] = ["weekly", "monthly", "quarterly", "yearly", "one_off"];

export interface BillManagementDeps {
  financeDeepService: FinanceDeepService;
  /** 测试注入时钟 */
  now?: () => Date;
  /** 到期提醒回调（装配层接 ProactivityHub，life_reminder kind） */
  onBillReminder?: (actorId: string, message: string) => void;
}

export class BillManagementService {
  private readonly deps: BillManagementDeps;
  /** 内存态：actorId → 账单列表（懒加载） */
  private readonly stores = new Map<string, BillRecord[]>();

  /** 每日扫描调度 */
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  private lastScanDay = "";
  private started = false;
  /** 已提醒过的账单（actorId|billId|到期日），防重复打扰 */
  private readonly remindedKeys = new Set<string>();

  constructor(deps: BillManagementDeps) {
    this.deps = deps;
  }

  /** 装配层后置接线：ProactivityHub 就绪后注入提醒回调。 */
  setOnBillReminder(cb: (actorId: string, message: string) => void): void {
    this.deps.onBillReminder = cb;
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  // ─── 持久化（懒加载 + 写穿） ────────────────────────────────

  private file(actorId: string): string {
    return join(this.deps.financeDeepService.getDataRoot(), actorId, "bills.json");
  }

  private async loadBills(actorId: string): Promise<BillRecord[]> {
    const cached = this.stores.get(actorId);
    if (cached) return cached;
    let bills: BillRecord[] = [];
    try {
      const raw = await readFile(this.file(actorId), "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) bills = this.normalizeBills(parsed);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("ENOENT")) {
        console.error(`[BillManagement] load ${actorId} failed:`, error);
      }
    }
    this.stores.set(actorId, bills);
    return bills;
  }

  private async saveBills(actorId: string, bills: BillRecord[]): Promise<void> {
    this.stores.set(actorId, bills);
    const dir = join(this.deps.financeDeepService.getDataRoot(), actorId);
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(this.file(actorId), JSON.stringify(bills, null, 2), "utf8");
    } catch (error) {
      console.error(`[BillManagement] save ${actorId} failed:`, error);
    }
  }

  private normalizeBills(input: unknown[]): BillRecord[] {
    const nowIso = this.now().toISOString();
    return input
      .filter((item) => item && typeof item === "object")
      .map((item) => {
        const b = item as Record<string, unknown>;
        const cadence = CADENCES.includes(b.cadence as BillCadence)
          ? (b.cadence as BillCadence)
          : "monthly";
        return {
          id: typeof b.id === "string" && b.id ? b.id : randomUUID(),
          name: String(b.name ?? "未命名账单"),
          ...(typeof b.merchant === "string" && b.merchant ? { merchant: b.merchant } : {}),
          amount: Math.abs(Number(b.amount) || 0),
          cadence,
          ...(typeof b.dueDay === "number" && Number.isFinite(b.dueDay) ? { dueDay: b.dueDay } : {}),
          ...(typeof b.dueDate === "string" ? { dueDate: b.dueDate } : {}),
          category: (isValidCategory(b.category) ? b.category : "居住") as FinanceCategory,
          autopay: b.autopay === true,
          ...(typeof b.lastPaidAt === "string" ? { lastPaidAt: b.lastPaidAt } : {}),
          ...(typeof b.lastPaidAmount === "number" && Number.isFinite(b.lastPaidAmount)
            ? { lastPaidAmount: b.lastPaidAmount }
            : {}),
          payments: Array.isArray(b.payments)
            ? b.payments
                .filter((p) => p && typeof p === "object")
                .map((p) => {
                  const pay = p as Record<string, unknown>;
                  const out: { date: string; amount: number; transactionId?: string } = {
                    date: String(pay.date ?? ""),
                    amount: Math.abs(Number(pay.amount) || 0),
                  };
                  if (typeof pay.transactionId === "string") out.transactionId = pay.transactionId;
                  return out;
                })
                .filter((p) => p.date && p.amount > 0)
            : [],
          ...(typeof b.note === "string" ? { note: b.note } : {}),
          createdAt: typeof b.createdAt === "string" ? b.createdAt : nowIso,
          updatedAt: typeof b.updatedAt === "string" ? b.updatedAt : nowIso,
        };
      });
  }

  // ─── 登记 / 更新 / 删除 ─────────────────────────────────────

  /** 登记账单。weekly/monthly 需 dueDay；quarterly/yearly/one_off 需 dueDate。 */
  async addBill(actorId: string, input: BillAddInput): Promise<BillRecord | null> {
    const error = validateBillInput(input);
    if (error) return null;
    const now = this.now();
    const record: BillRecord = {
      id: randomUUID(),
      name: input.name.trim(),
      amount: Math.abs(input.amount),
      cadence: input.cadence,
      category: input.category ?? "居住",
      autopay: input.autopay ?? false,
      payments: [],
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      ...(input.merchant?.trim() ? { merchant: input.merchant.trim() } : {}),
      ...(input.note?.trim() ? { note: input.note.trim() } : {}),
      ...(input.dueDay != null ? { dueDay: clampDueDay(input.cadence, input.dueDay) } : {}),
      ...(input.dueDate?.trim() ? { dueDate: normalizeDay(input.dueDate.trim()) } : {}),
    };
    const bills = await this.loadBills(actorId);
    bills.push(record);
    await this.saveBills(actorId, bills);
    return record;
  }

  async updateBill(
    actorId: string,
    billId: string,
    patch: BillUpdateInput,
  ): Promise<BillRecord | null> {
    const bills = await this.loadBills(actorId);
    const bill = bills.find((b) => b.id === billId);
    if (!bill) return null;
    if (patch.name?.trim()) bill.name = patch.name.trim();
    if (patch.amount != null && Number.isFinite(patch.amount) && patch.amount > 0) {
      bill.amount = Math.abs(patch.amount);
    }
    if (patch.dueDay != null && Number.isFinite(patch.dueDay) && bill.cadence) {
      // dueDay 合法性按账单当前周期校验
      bill.dueDay = clampDueDay(bill.cadence, patch.dueDay);
    }
    if (patch.dueDate?.trim()) bill.dueDate = normalizeDay(patch.dueDate.trim());
    if (patch.category && isValidCategory(patch.category)) bill.category = patch.category;
    if (patch.autopay != null) bill.autopay = patch.autopay === true;
    if (patch.merchant !== undefined) {
      if (patch.merchant.trim()) bill.merchant = patch.merchant.trim();
      else delete bill.merchant;
    }
    if (patch.note !== undefined) {
      if (patch.note.trim()) bill.note = patch.note.trim();
      else delete bill.note;
    }
    bill.updatedAt = this.now().toISOString();
    await this.saveBills(actorId, bills);
    return bill;
  }

  async deleteBill(actorId: string, billId: string): Promise<boolean> {
    const bills = await this.loadBills(actorId);
    const idx = bills.findIndex((b) => b.id === billId);
    if (idx < 0) return false;
    bills.splice(idx, 1);
    await this.saveBills(actorId, bills);
    return true;
  }

  // ─── 追踪（状态推算） ───────────────────────────────────────

  /** 列出账单（按紧迫度排序：overdue > due_soon > ok > paid），附月均固定支出合计。 */
  async listBills(actorId: string): Promise<{
    bills: BillWithStatus[];
    summary: {
      total: number;
      dueSoonCount: number;
      overdueCount: number;
      /** 周期账单折算月成本合计（固定支出盘子） */
      monthlyRecurringTotal: number;
    };
  }> {
    const bills = await this.loadBills(actorId);
    const now = this.now();
    const withStatus = bills.map((bill) => {
      const { nextDueDate, daysUntilDue, status } = billStatusOf(bill, now, BILL_REMIND_AHEAD_DAYS);
      return {
        bill,
        nextDueDate,
        daysUntilDue,
        status,
        monthlyEquivalent: monthlyEquivalentOf(bill),
      };
    });
    const order: Record<BillStatus, number> = { overdue: 0, due_soon: 1, ok: 2, paid: 3 };
    withStatus.sort((a, b) => {
      if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status];
      const ad = a.nextDueDate ?? "9999-99-99";
      const bd = b.nextDueDate ?? "9999-99-99";
      return ad < bd ? -1 : ad > bd ? 1 : 0;
    });
    return {
      bills: withStatus,
      summary: {
        total: withStatus.length,
        dueSoonCount: withStatus.filter((b) => b.status === "due_soon").length,
        overdueCount: withStatus.filter((b) => b.status === "overdue").length,
        monthlyRecurringTotal: Number(
          withStatus
            .reduce((acc, b) => acc + b.monthlyEquivalent, 0)
            .toFixed(2),
        ),
      },
    };
  }

  /** 单条账单的派生信息（下次到期日 / 状态 / 折算月成本）；不存在返回 null。 */
  async describeBill(actorId: string, billId: string): Promise<BillWithStatus | null> {
    const bills = await this.loadBills(actorId);
    const bill = bills.find((b) => b.id === billId);
    if (!bill) return null;
    const { nextDueDate, daysUntilDue, status } = billStatusOf(bill, this.now(), BILL_REMIND_AHEAD_DAYS);
    return {
      bill,
      nextDueDate,
      daysUntilDue,
      status,
      monthlyEquivalent: monthlyEquivalentOf(bill),
    };
  }

  // ─── 缴费（预算联动） ───────────────────────────────────────

  /**
   * 标记账单已缴：写缴费历史 + 顺延周期 + 自动入账（source=bill_payment）
   * + 返回该分类预算的最新执行进度。
   */
  async markBillPaid(
    actorId: string,
    billId: string,
    opts?: { date?: string; amount?: number },
  ): Promise<BillPayResult> {
    const bills = await this.loadBills(actorId);
    const bill = bills.find((b) => b.id === billId);
    if (!bill) return { ok: false, error: "找不到该账单（可先 list_bills 查看）" };

    const now = this.now();
    const payDate = opts?.date?.trim() ? normalizeDay(opts.date.trim()) : isoDay(now.getTime());
    if (!payDate) return { ok: false, error: "date 格式应为 YYYY-MM-DD" };
    const rawAmount = Number(opts?.amount);
    const payAmount = Math.abs(
      Number.isFinite(rawAmount) && rawAmount > 0 ? rawAmount : bill.amount,
    );

    // 顺延：dueDate 驱动的周期（季/年/一次性）推下个到期日
    if (bill.cadence === "quarterly" || bill.cadence === "yearly") {
      if (bill.dueDate) bill.dueDate = advanceDaysByMonths(bill.dueDate, bill.cadence === "yearly" ? 12 : 3);
    }

    const finance = this.deps.financeDeepService;
    let transactionId: string | undefined;
    if (bill.cadence !== "one_off" || !bill.lastPaidAt) {
      const description = `账单缴费：${bill.name}`;
      const added = await finance.importTransactions(actorId, [
        {
          id: "",
          date: payDate,
          amount: payAmount,
          type: "expense",
          category: bill.category,
          ...(bill.merchant ? { merchant: bill.merchant } : {}),
          description,
          source: "bill_payment",
        },
      ]);
      if (added > 0) {
        const latest = finance.getTransactions(actorId, undefined, undefined, undefined, 5);
        const hit = latest.find(
          (t) => t.source === "bill_payment" && t.description === description && t.date.startsWith(payDate),
        );
        transactionId = hit?.id;
      }
    }

    bill.lastPaidAt = payDate;
    bill.lastPaidAmount = payAmount;
    bill.payments.unshift({ date: payDate, amount: payAmount, ...(transactionId ? { transactionId } : {}) });
    if (bill.payments.length > MAX_PAYMENTS) bill.payments.length = MAX_PAYMENTS;
    bill.updatedAt = now.toISOString();
    await this.saveBills(actorId, bills);

    // 预算联动：该分类预算的最新执行进度（未设预算则 undefined）
    const budget = finance.getBudgetStatus(actorId).find((s) => s.budget.category === bill.category);

    return { ok: true, bill, ...(transactionId ? { transactionId } : {}), ...(budget ? { budget } : {}) };
  }

  // ─── 到期提醒（每日扫描） ───────────────────────────────────

  /** 启动每日扫描调度（每小时检查一次是否到达扫描时刻；测试可直调 runDailyScan） */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.scanTimer = setInterval(() => {
      try {
        void this.tickScan();
      } catch (err) {
        console.log(`[BillManagement] 扫描 tick 失败（忽略）: ${err}`);
      }
    }, 60 * 60 * 1000);
    if (typeof this.scanTimer.unref === "function") this.scanTimer.unref();
    console.log("[BillManagement] 账单到期提醒监听已启动（到期前 3 天 / 逾期提醒）");
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
    const scanHour = Number(process.env.BILL_SCAN_HOUR ?? 9);
    if (now.getHours() < (Number.isFinite(scanHour) ? scanHour : 9)) return;
    this.lastScanDay = today;
    void this.runDailyScan(now).catch((err) => {
      console.log(`[BillManagement] 每日扫描失败（忽略）: ${err}`);
    });
  }

  /** 每日扫描：全部 actor 的到期前/逾期提醒（同一到期日只提醒一次）。 */
  async runDailyScan(now: Date = this.now()): Promise<void> {
    if (!this.deps.onBillReminder) return;
    const actors = this.deps.financeDeepService.listActorIds();
    for (const actorId of actors) {
      try {
        const { bills } = await this.listBills(actorId);
        const actionable = bills.filter(
          (b) => b.status === "due_soon" || b.status === "overdue",
        );
        if (actionable.length === 0) continue;
        const pending = actionable.filter((b) => {
          const key = `${actorId}|${b.bill.id}|${b.nextDueDate}`;
          if (this.remindedKeys.has(key)) return false;
          this.remindedKeys.add(key);
          return true;
        });
        if (pending.length === 0) continue;
        const lines = pending.map((b) => {
          if (b.status === "overdue") {
            return (
              `- ${b.bill.name}：¥${b.bill.amount.toFixed(2)}，${b.nextDueDate} 已到期` +
              `（逾期 ${-(b.daysUntilDue ?? 0)} 天）${b.bill.autopay ? "（设了自动扣款，请确认是否已扣）" : ""}`
            );
          }
          const days = b.daysUntilDue ?? 0;
          return (
            `- ${b.bill.name}：¥${b.bill.amount.toFixed(2)}，${b.nextDueDate} 到期` +
            `（${days === 0 ? "就是今天" : `还有 ${days} 天`}）` +
            (b.bill.autopay ? "（自动扣款，确认余额充足）" : "")
          );
        });
        const message =
          `账单提醒：\n${lines.join("\n")}\n` +
          `缴完告诉我一声，我帮你记入账本并更新预算。`;
        this.deps.onBillReminder(actorId, message);
        console.log(`[BillManagement] 到期提醒 actor=${actorId} ${pending.length} 条`);
      } catch (err) {
        console.log(`[BillManagement] 到期扫描失败（忽略）actor=${actorId}: ${err}`);
      }
    }
  }
}

// ─── 纯函数（导出供测试） ──────────────────────────────────────

const FINANCE_CATEGORY_SET = new Set([
  "餐饮", "交通", "购物", "娱乐", "医疗", "教育", "居住", "工资", "其他",
]);

function isValidCategory(v: unknown): v is FinanceCategory {
  return typeof v === "string" && FINANCE_CATEGORY_SET.has(v);
}

function isoDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** YYYY-MM-DD 归一化：非法返回空串。 */
function normalizeDay(dateStr: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr.trim());
  if (!m) return "";
  const ms = Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00`);
  return Number.isFinite(ms) ? `${m[1]}-${m[2]}-${m[3]}` : "";
}

/** 当月天数。 */
function daysInMonth(year: number, month1Based: number): number {
  return new Date(year, month1Based, 0).getDate();
}

/** 某月某号的日期（超出月末则钳到月末），YYYY-MM-DD。 */
function dayInMonth(year: number, month1Based: number, day: number): string {
  const d = Math.min(day, daysInMonth(year, month1Based));
  return `${year}-${String(month1Based).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** 到期日顺延 N 个月（钳月末），YYYY-MM-DD。 */
export function advanceDaysByMonths(dateStr: string, months: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  if (!y || !m || !d) return dateStr;
  const total = (y * 12 + (m - 1)) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return dayInMonth(ny, nm, d);
}

/** dueDay 按周期钳制：weekly 1~7（周一~周日），其余 1~31。 */
export function clampDueDay(cadence: BillCadence, raw: number): number {
  const max = cadence === "weekly" ? 7 : 31;
  return Math.max(1, Math.min(max, Math.round(raw)));
}

/**
 * 周付/月付的下个到期日（含「本周期已缴」判定：上次缴费日晚于上一期到期日即视为本周期已缴，
 * 推到下一期）。季付/年付/一次性直接用存储的 dueDate。
 *
 * @returns 下次到期日（YYYY-MM-DD）；无（一次性已缴）返回 null
 */
export function nextDueDateOf(bill: BillRecord, now: Date): string | null {
  const today = isoDay(now.getTime());
  if (bill.cadence === "one_off") {
    return bill.lastPaidAt ? null : (bill.dueDate ?? null);
  }
  if (bill.cadence === "quarterly" || bill.cadence === "yearly") {
    return bill.dueDate ?? null;
  }

  if (bill.cadence === "weekly") {
    // dueDay: 1=周一 … 7=周日；JS getDay(): 0=周日 … 6=周六
    const todayJsDay = now.getDay();
    const targetJsDay = (bill.dueDay ?? 1) % 7;
    const thisWeek = new Date(now.getTime() - todayJsDay * 86_400_000);
    const occ = (weekOffset: number): string =>
      isoDay(thisWeek.getTime() + (weekOffset * 7 + targetJsDay) * 86_400_000);
    const prev = occ(-1);
    const current = occ(0);
    const next = occ(1);
    return pickCycleOccurrence(bill, today, prev, current, next);
  }

  // monthly：本期 = 本月 dueDay（钳月末），上一期 = 上月 dueDay
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const day = bill.dueDay ?? 1;
  const current = dayInMonth(year, month, day);
  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear = month === 1 ? year - 1 : year;
  const prev = dayInMonth(prevYear, prevMonth, day);
  const next = advanceDaysByMonths(current, 1);
  return pickCycleOccurrence(bill, today, prev, current, next);
}

/**
 * 周期账单的「本周期已缴」公共判定：
 *   - 上期到期日 < 上次缴费 ≤ 本期到期日 → 本周期已缴 → 返回下一期；
 *   - 否则返回本期到期日（未到 → 正常/即将到期；已过 → 保持过去日期以展示逾期天数）。
 */
function pickCycleOccurrence(
  bill: BillRecord,
  today: string,
  prev: string,
  current: string,
  next: string,
): string {
  if (bill.lastPaidAt && bill.lastPaidAt > prev && bill.lastPaidAt <= current) return next;
  return current;
}

/**
 * 账单状态判定。
 * overdue：到期日 < 今天且未缴；due_soon：0 ≤ 距到期 ≤ aheadDays（含当天）；paid：一次性已缴。
 */
export function billStatusOf(
  bill: BillRecord,
  now: Date,
  aheadDays = BILL_REMIND_AHEAD_DAYS,
): { nextDueDate: string | null; daysUntilDue: number | null; status: BillStatus } {
  const nextDueDate = nextDueDateOf(bill, now);
  if (nextDueDate === null) {
    return { nextDueDate: null, daysUntilDue: null, status: "paid" };
  }
  const todayMs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dueMs = Date.parse(`${nextDueDate}T00:00:00`);
  const daysUntilDue = Math.round((dueMs - todayMs) / 86_400_000);
  if (daysUntilDue < 0) return { nextDueDate, daysUntilDue, status: "overdue" };
  if (daysUntilDue <= aheadDays) return { nextDueDate, daysUntilDue, status: "due_soon" };
  return { nextDueDate, daysUntilDue, status: "ok" };
}

/** 折算月成本（固定支出盘子）：周付 ×30/7，月付 ×1，季付 ÷3，年付 ÷12，一次性不计入。 */
export function monthlyEquivalentOf(bill: BillRecord): number {
  if (bill.cadence === "one_off") return 0;
  const factor =
    bill.cadence === "weekly"
      ? 30 / 7
      : bill.cadence === "monthly"
        ? 1
        : bill.cadence === "quarterly"
          ? 1 / 3
          : 1 / 12;
  return Number((bill.amount * factor).toFixed(2));
}

/** 周期的人话标签。 */
export function billCadenceLabel(cadence: BillCadence): string {
  if (cadence === "weekly") return "周";
  if (cadence === "monthly") return "月";
  if (cadence === "quarterly") return "季";
  if (cadence === "yearly") return "年";
  return "一次性";
}

/** 登记校验：非法返回错误信息，合法返回 null。 */
export function validateBillInput(input: BillAddInput): string | null {
  if (!input.name?.trim()) return "缺少 name（账单名）";
  if (!Number.isFinite(input.amount) || input.amount <= 0) return "amount 必须为正数";
  if (!CADENCES.includes(input.cadence)) {
    return `cadence 必须为：${CADENCES.join(" / ")}`;
  }
  if (input.cadence === "weekly" || input.cadence === "monthly") {
    if (!Number.isFinite(input.dueDay)) {
      return `${input.cadence === "weekly" ? "周付账单" : "月付账单"}需要 dueDay（${input.cadence === "weekly" ? "1~7 表示周一~周日" : "1~31 表示几号"}）`;
    }
  }
  if (input.cadence === "quarterly" || input.cadence === "yearly" || input.cadence === "one_off") {
    if (!normalizeDay(input.dueDate ?? "")) {
      return `${input.cadence === "one_off" ? "一次性账单" : "季付/年付账单"}需要 dueDate（下次到期日 YYYY-MM-DD）`;
    }
  }
  return null;
}
