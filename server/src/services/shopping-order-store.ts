/**
 * 购物订单本地存储（JSON 文件，模式对齐 booking-order-store）。
 *
 * - 本地 orderId（so_*） ↔ 平台订单号的映射与状态快照
 *   （此前订单只存在平台侧，查历史/对账/查重靠重爬；本表是购物订单的唯一本地事实）
 * - 单日累计金额统计（单日预算用）
 * - file 为 null 时纯内存（测试用）
 * - 写入原子化（tmp + rename），并发写串行化
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

/** 订单状态机：提交成功即 pending_payment；终态 = completed/cancelled/failed */
export type ShoppingOrderStatus =
  | "pending_payment"
  | "paid"
  | "shipped"
  | "completed"
  | "cancelled"
  | "failed";

export const SHOPPING_TERMINAL_STATUSES: ReadonlySet<ShoppingOrderStatus> = new Set([
  "completed",
  "cancelled",
  "failed",
]);

export interface StoredShoppingOrder {
  /** 本地订单 id：so_<ts36>_<rand> */
  orderId: string;
  actorId: string;
  platform: string;
  /** 平台侧订单号（提交成功后回填；平台未回吐时为 null） */
  platformOrderId: string | null;
  /** 商品标题（结算页快照，缺省用下单入参） */
  title: string;
  quantity: number;
  amountCny: number | null;
  currency?: string;
  status: ShoppingOrderStatus;
  addressSummary: string | null;
  /** 提交后落在的收银台/支付页 URL（供用户手动支付或 alipay-bot 代付） */
  paymentUrl: string | null;
  checkoutUrl: string | null;
  note: string | null;
  /**
   * 单日预算统计的日期键（本地时区 YYYY-MM-DD，= 创建时刻的本地日期）。
   * 旧数据缺省时回退 createdAt 的 UTC 前缀。
   */
  dateKey?: string;
  createdAt: string;
  updatedAt: string;
}

export function newShoppingOrderId(now = new Date()): string {
  return `so_${now.getTime().toString(36)}_${randomBytes(4).toString("hex")}`;
}

/** 本地时区日期键（YYYY-MM-DD）——与 booking-order-store 同实现。 */
export function localDateKey(d: Date): string {
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

/**
 * 平台订单文案 → 本地状态映射（track 同步用；关键词按命中优先级排列）。
 * 返回 null 表示无法识别（保留本地原状态）。
 */
export function mapPlatformStatusText(text: string | undefined): ShoppingOrderStatus | null {
  const t = String(text ?? "");
  if (!t) return null;
  if (/待付款|待支付|等待买家付款/.test(t)) return "pending_payment";
  if (/已取消|已关闭|交易关闭/.test(t)) return "cancelled";
  if (/退款|售后中/.test(t)) return "failed";
  if (/已完成|交易成功|已完成/.test(t)) return "completed";
  if (/已发货|待收货|运输中|派送中/.test(t)) return "shipped";
  if (/已付款|待发货|已下单/.test(t)) return "paid";
  return null;
}

export interface ShoppingOrderListFilter {
  platform?: string;
  statuses?: ShoppingOrderStatus[];
  includeFinished?: boolean;
  limit?: number;
}

export class ShoppingOrderStore {
  private orders = new Map<string, StoredShoppingOrder>();
  private writeChain: Promise<void> = Promise.resolve();
  private loaded = false;

  constructor(private readonly file: string | null = null) {}

  private async ensureLoaded(): Promise<void> {
    if (this.loaded || !this.file) return;
    this.loaded = true;
    try {
      if (existsSync(this.file)) {
        const raw = await readFile(this.file, "utf8");
        const parsed = JSON.parse(raw) as { orders?: StoredShoppingOrder[] };
        for (const order of parsed.orders ?? []) {
          if (order?.orderId) this.orders.set(order.orderId, order);
        }
      }
    } catch {
      // 损坏文件：从空开始（与 booking-order-store 容错策略一致）
    }
  }

  private persist(): void {
    if (!this.file) return;
    const file = this.file;
    const payload = JSON.stringify({ orders: [...this.orders.values()] }, null, 2);
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(dirname(file), { recursive: true });
      const tmp = join(dirname(file), `.${basename(file)}.${randomBytes(4).toString("hex")}.tmp`);
      await writeFile(tmp, payload, "utf8");
      await rename(tmp, file);
    }).catch((err) => {
      // 写盘失败必须可见：订单文件是单日预算的统计依据，静默丢写会让预算失真
      console.warn("[ShoppingOrderStore] 订单写盘失败", err);
    });
  }

  async create(order: StoredShoppingOrder): Promise<StoredShoppingOrder> {
    await this.ensureLoaded();
    this.orders.set(order.orderId, order);
    this.persist();
    return order;
  }

  async get(orderId: string): Promise<StoredShoppingOrder | null> {
    await this.ensureLoaded();
    return this.orders.get(orderId) ?? null;
  }

  async update(orderId: string, patch: Partial<StoredShoppingOrder>): Promise<StoredShoppingOrder | null> {
    await this.ensureLoaded();
    const existing = this.orders.get(orderId);
    if (!existing) return null;
    const updated: StoredShoppingOrder = { ...existing, ...patch, orderId, updatedAt: new Date().toISOString() };
    this.orders.set(orderId, updated);
    this.persist();
    return updated;
  }

  /** 按平台订单号查（同一 actor 下唯一）。 */
  async findByPlatformOrder(actorId: string, platform: string, platformOrderId: string): Promise<StoredShoppingOrder | null> {
    await this.ensureLoaded();
    const key = platformOrderId.trim();
    if (!key) return null;
    for (const order of this.orders.values()) {
      if (order.actorId === actorId && order.platform === platform && order.platformOrderId === key) {
        return order;
      }
    }
    return null;
  }

  async listByActor(actorId: string, filter: ShoppingOrderListFilter = {}): Promise<StoredShoppingOrder[]> {
    await this.ensureLoaded();
    const includeFinished = filter.includeFinished ?? true;
    const out: StoredShoppingOrder[] = [];
    // 新 → 旧
    const entries = [...this.orders.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    for (const order of entries) {
      if (order.actorId !== actorId) continue;
      if (filter.platform && order.platform !== filter.platform) continue;
      if (!includeFinished && SHOPPING_TERMINAL_STATUSES.has(order.status)) continue;
      if (filter.statuses && !filter.statuses.includes(order.status)) continue;
      out.push(order);
      if (filter.limit && out.length >= filter.limit) break;
    }
    return out;
  }

  /** 等待在途写入全部落盘（测试/停机前调用）。 */
  async flush(): Promise<void> {
    await this.writeChain;
  }

  /**
   * 某 actor 在指定日期键（本地时区 YYYY-MM-DD）提交的订单金额合计。
   * cancelled / failed 不计；amountCny 为 null 计 0（以平台结算为准的订单）。
   */
  async sumAmountOnDate(actorId: string, dateKey: string): Promise<number> {
    await this.ensureLoaded();
    let sum = 0;
    for (const order of this.orders.values()) {
      if (order.actorId !== actorId) continue;
      if (order.status === "cancelled" || order.status === "failed") continue;
      if ((order.dateKey ?? localDateKey(new Date(order.createdAt))) !== dateKey) continue;
      sum += order.amountCny ?? 0;
    }
    return sum;
  }
}
