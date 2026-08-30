/**
 * 行程持久化存储（单例，进程内缓存 + 磁盘落盘）
 *
 * 职责：travel.plan-itinerary 生成行程后按 planId 落盘，供跨轮/跨重启的
 * 「按需回查」——LLM 上下文只留极简回执（summarizeItinerary），明细永远
 * 不进对话历史；用户追问时由 travel.get-itinerary 工具从这里读取。
 *
 * 分层架构（见 travel-planning-skills.ts 头注释）：
 *   热层  = prompt 状态快照（buildTravelStatePrompt，一行目的地/日期）
 *   冷层  = 本存储的完整明细（get-itinerary 按天粒度按需读取）
 *
 * 存储：data/travel-plans/{planId}.json 单文件单行程（planId 含时间戳唯一），
 * 进程内 Map 索引 + 惰性磁盘读；写入同步刷盘（行程生成是低频事件）。
 */
import fs from "node:fs";
import path from "node:path";

export interface StoredTravelPlan {
  /** 行程 ID（travel-planning-service 生成，形如 plan-1788076649218） */
  planId: string;
  destination: string;
  title: string;
  startDate: string;
  endDate: string;
  /** 落盘时间（毫秒）；save 未传时自动补 */
  createdAt?: number;
  /** 用户原始诉求（规划输入，供回查时还原语境） */
  requestInput?: string;
  /** 用户偏好标签 */
  preferences?: string[];
  /** 总实付（pricingSummary.totalFinal，冗余一份避免读全文） */
  totalCost?: number;
  days: Array<{
    date: string;
    items: Array<{
      type: string;
      name: string;
      startTime: string;
      latitude: number;
      longitude: number;
      address: string;
      priceInfo: string;
      description: string;
      tips?: string[];
      images?: string[];
      reviews?: unknown[];
      videos?: Array<Record<string, unknown>>;
    }>;
  }>;
}

const MAX_PLANS = 50;

class TravelPlanStore {
  private root: string;
  /** planId → 计划（进程内缓存；磁盘为权威源，未命中惰性读） */
  private mem = new Map<string, StoredTravelPlan>();

  constructor() {
    // 测试可用 TRAVEL_PLAN_STORE_DIR 覆盖存储目录（默认 data/travel-plans）
    this.root = path.resolve(
      process.env.TRAVEL_PLAN_STORE_DIR || path.join(process.cwd(), "data", "travel-plans"),
    );
    this.ensureDir(this.root);
  }

  /** 保存/覆盖行程（同步落盘；planId 冲突时后写覆盖） */
  save(plan: StoredTravelPlan): void {
    if (!plan.planId) return;
    const withTs: StoredTravelPlan = { ...plan, createdAt: plan.createdAt ?? Date.now() };
    this.mem.set(plan.planId, withTs);
    try {
      fs.writeFileSync(
        this.planPath(plan.planId),
        JSON.stringify(withTs),
        "utf8",
      );
    } catch (err) {
      console.error("[TravelPlanStore] save failed:", err);
    }
    this.prune();
  }

  /** 按 planId 读行程：内存未命中时惰性读磁盘 */
  get(planId: string): StoredTravelPlan | null {
    const cached = this.mem.get(planId);
    if (cached) return cached;
    try {
      const raw = fs.readFileSync(this.planPath(planId), "utf8");
      const parsed = JSON.parse(raw) as StoredTravelPlan;
      if (parsed?.planId) {
        this.mem.set(parsed.planId, parsed);
        return parsed;
      }
    } catch {
      // 不存在/损坏 → null
    }
    return null;
  }

  /** 按目的地名找最近一份行程（大小写/首尾空格不敏感，精确匹配） */
  findByDestination(destination: string): StoredTravelPlan | null {
    const key = destination.trim().toLowerCase();
    if (!key) return null;
    let best: StoredTravelPlan | null = null;
    for (const plan of this.listAll()) {
      if ((plan.destination ?? "").trim().toLowerCase() === key) {
        if (!best || (plan.createdAt ?? 0) > (best.createdAt ?? 0)) best = plan;
      }
    }
    return best;
  }

  /**
   * 全部行程摘要（新→旧），供状态快照与列表查询。
   * 只取轻量字段，days 不展开。
   */
  listSummaries(limit = 5): Array<{
    planId: string;
    destination: string;
    title: string;
    startDate: string;
    endDate: string;
    dayCount: number;
    totalCost?: number;
    createdAt: number;
  }> {
    return this.listAll()
      .slice(0, Math.max(1, limit))
      .map((p) => ({
        planId: p.planId,
        destination: p.destination,
        title: p.title,
        startDate: p.startDate,
        endDate: p.endDate,
        dayCount: p.days?.length ?? 0,
        ...(p.totalCost != null ? { totalCost: p.totalCost } : {}),
        createdAt: p.createdAt ?? 0,
      }));
  }

  /** 磁盘全量扫描（新→旧）。内存有值时优先内存。 */
  private listAll(): StoredTravelPlan[] {
    const merged = new Map<string, StoredTravelPlan>();
    try {
      for (const f of fs.readdirSync(this.root)) {
        if (!f.endsWith(".json")) continue;
        const plan = this.get(f.replace(/\.json$/, ""));
        if (plan) merged.set(plan.planId, plan);
      }
    } catch {
      // 目录不可读 → 只用内存
    }
    for (const plan of this.mem.values()) merged.set(plan.planId, plan);
    return [...merged.values()].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  }

  /** 超限清理：只删磁盘文件（保留最近 MAX_PLANS 份） */
  private prune(): void {
    const all = this.listAll();
    for (const plan of all.slice(MAX_PLANS)) {
      this.mem.delete(plan.planId);
      try {
        fs.unlinkSync(this.planPath(plan.planId));
      } catch {
        // ignore
      }
    }
  }

  private planPath(planId: string): string {
    // planId 由服务生成（plan-<ts>），仍做一层文件名净化防路径注入
    const safe = planId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
    return path.join(this.root, `${safe || "plan"}.json`);
  }

  private ensureDir(dir: string): void {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      // ignore
    }
  }
}

export const travelPlanStore = new TravelPlanStore();
