import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import Database from "better-sqlite3";
import type { Database as SqliteDatabase } from "better-sqlite3";

/**
 * 支付订单持久台账（SQLite）。
 *
 * 之前订单只在 mock 模式存进程内 Map，live 订单本地没有任何记录，
 * 管理后台看不到真实收入。现在下单（无论 mock/live）都落台账，
 * 状态随查询/模拟回调同步：
 *   - mock 模式：mockCompletePayment / mockClosePayment 时更新；
 *   - live 模式：客户端经 payment.query_order 轮询渠道，queryOrder
 *     拿到终态（成功/关闭/退款）时回写。
 *
 * 台账是管理侧的本地副本，渠道侧仍是交易事实源；台账写失败不阻断支付主流程。
 */

export type PaymentOrderMode = "mock" | "live";
export type PaymentOrderStatus = "pending" | "paid" | "closed" | "refunded" | "error";

export type LedgerOrderRow = {
  outTradeNo: string;
  provider: string;
  method: string;
  amount: number;
  description: string;
  mode: PaymentOrderMode;
  status: PaymentOrderStatus;
  createdAt: string;
  updatedAt: string;
  paidAt: string | null;
};

export type LedgerModeStats = {
  total: number;
  pending: number;
  paid: number;
  closed: number;
  refunded: number;
  paidAmount: number;
};

export function paymentLedgerDbPath(): string {
  return (
    process.env.PAYMENT_LEDGER_DB?.trim() ||
    join(process.cwd(), "data", "payment", "orders.db")
  );
}

export class PaymentOrderLedger {
  private db: SqliteDatabase | null = null;

  private open(): SqliteDatabase | null {
    if (this.db) return this.db;
    try {
      const file = paymentLedgerDbPath();
      mkdirSync(dirname(file), { recursive: true });
      const db = new Database(file);
      db.pragma("journal_mode = WAL");
      db.exec(`
        CREATE TABLE IF NOT EXISTS orders (
          out_trade_no TEXT PRIMARY KEY,
          provider     TEXT NOT NULL,
          method       TEXT NOT NULL,
          amount       REAL NOT NULL,
          description  TEXT NOT NULL,
          mode         TEXT NOT NULL,
          status       TEXT NOT NULL,
          created_at   TEXT NOT NULL,
          updated_at   TEXT NOT NULL,
          paid_at      TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at DESC);
      `);
      this.db = db;
      return db;
    } catch (err) {
      console.error("[payment-ledger] open failed:", err);
      return null;
    }
  }

  record(row: LedgerOrderRow): void {
    const db = this.open();
    if (!db) return;
    try {
      db.prepare(`
        INSERT INTO orders (out_trade_no, provider, method, amount, description, mode, status, created_at, updated_at, paid_at)
        VALUES (@outTradeNo, @provider, @method, @amount, @description, @mode, @status, @createdAt, @updatedAt, @paidAt)
        ON CONFLICT(out_trade_no) DO NOTHING
      `).run(row);
    } catch (err) {
      console.error("[payment-ledger] record failed:", err);
    }
  }

  updateStatus(outTradeNo: string, status: PaymentOrderStatus, paidAt?: string): void {
    const db = this.open();
    if (!db) return;
    try {
      db.prepare(`
        UPDATE orders SET status = @status, paid_at = COALESCE(@paidAt, paid_at), updated_at = @updatedAt
        WHERE out_trade_no = @outTradeNo
      `).run({
        outTradeNo,
        status,
        paidAt: paidAt ?? null,
        updatedAt: new Date().toISOString(),
      });
    } catch (err) {
      console.error("[payment-ledger] updateStatus failed:", err);
    }
  }

  list(limit = 200): LedgerOrderRow[] {
    const db = this.open();
    if (!db) return [];
    try {
      return db.prepare(
        `SELECT out_trade_no AS outTradeNo, provider, method, amount, description,
                mode, status, created_at AS createdAt, updated_at AS updatedAt, paid_at AS paidAt
         FROM orders ORDER BY created_at DESC LIMIT ?`,
      ).all(Math.min(Math.max(limit, 1), 1000)) as unknown as LedgerOrderRow[];
    } catch (err) {
      console.error("[payment-ledger] list failed:", err);
      return [];
    }
  }

  /** 某时刻以来的累计下单金额（含未支付，排除 error 单）——支付护栏日预算用 */
  sumAmountSince(startIso: string): number {
    const db = this.open();
    if (!db) return 0;
    try {
      const row = db.prepare(
        `SELECT COALESCE(SUM(amount), 0) AS total FROM orders WHERE created_at >= ? AND status != 'error'`,
      ).get(startIso) as { total: number } | undefined;
      return Number(row?.total ?? 0);
    } catch (err) {
      console.error("[payment-ledger] sumAmountSince failed:", err);
      return 0;
    }
  }

  stats(): { total: LedgerModeStats; mock: LedgerModeStats; live: LedgerModeStats } {
    const empty = (): LedgerModeStats => ({
      total: 0, pending: 0, paid: 0, closed: 0, refunded: 0, paidAmount: 0,
    });
    const out = { total: empty(), mock: empty(), live: empty() };
    const db = this.open();
    if (!db) return out;
    try {
      const rows = db.prepare(
        `SELECT mode, status, COUNT(*) AS count, COALESCE(SUM(amount), 0) AS amountSum FROM orders GROUP BY mode, status`,
      ).all() as Array<{ mode: string; status: string; count: number; amountSum: number }>;
      for (const row of rows) {
        const bucket =
          row.mode === "mock" ? out.mock : row.mode === "live" ? out.live : null;
        if (!bucket) continue;
        const targets = [out.total, bucket];
        for (const t of targets) {
          t.total += row.count;
          if (row.status === "pending") t.pending += row.count;
          else if (row.status === "paid") {
            t.paid += row.count;
            t.paidAmount += row.amountSum;
          } else if (row.status === "closed") t.closed += row.count;
          else if (row.status === "refunded") t.refunded += row.count;
        }
      }
      for (const t of [out.total, out.mock, out.live]) {
        t.paidAmount = Math.round(t.paidAmount * 100) / 100;
      }
      return out;
    } catch (err) {
      console.error("[payment-ledger] stats failed:", err);
      return out;
    }
  }
}

let sharedLedger: PaymentOrderLedger | null = null;

export function getPaymentOrderLedger(): PaymentOrderLedger {
  if (!sharedLedger) sharedLedger = new PaymentOrderLedger();
  return sharedLedger;
}
