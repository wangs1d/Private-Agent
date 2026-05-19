type QuotaCell = {
  limit: number;
  reserved: number;
  consumed: number;
};

/**
 * L3 算力配额（MVP）：进程内按 session 计量，reserve / consume / release。
 * 与外部模型真实计费解耦，仅提供统一协议面。
 */
export class ComputeQuotaService {
  private readonly bySession = new Map<string, QuotaCell>();
  private readonly defaultLimit: number;

  constructor() {
    const raw = process.env.COMPUTE_QUOTA_DEFAULT_UNITS;
    const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
    this.defaultLimit = Number.isFinite(n) && n > 0 ? n : 1_000_000;
  }

  private cell(sessionId: string): QuotaCell {
    let c = this.bySession.get(sessionId);
    if (!c) {
      c = { limit: this.defaultLimit, reserved: 0, consumed: 0 };
      this.bySession.set(sessionId, c);
    }
    return c;
  }

  getState(sessionId: string): {
    limit: number;
    reserved: number;
    consumed: number;
    available: number;
  } {
    const c = this.cell(sessionId);
    const available = c.limit - c.reserved - c.consumed;
    return { limit: c.limit, reserved: c.reserved, consumed: c.consumed, available };
  }

  adjust(
    sessionId: string,
    op: "reserve" | "consume" | "release",
    units: number,
  ): { ok: true } | { ok: false; reason: string } {
    const c = this.cell(sessionId);
    if (op === "reserve") {
      const available = c.limit - c.reserved - c.consumed;
      if (units > available) return { ok: false, reason: "INSUFFICIENT_QUOTA" };
      c.reserved += units;
      return { ok: true };
    }
    if (op === "release") {
      if (units > c.reserved) return { ok: false, reason: "RESERVE_UNDERFLOW" };
      c.reserved -= units;
      return { ok: true };
    }
    const fromReserved = Math.min(units, c.reserved);
    c.reserved -= fromReserved;
    const remaining = units - fromReserved;
    const availableAfter = c.limit - c.reserved - c.consumed;
    if (remaining > availableAfter) {
      c.reserved += fromReserved;
      return { ok: false, reason: "INSUFFICIENT_QUOTA" };
    }
    c.consumed += units;
    return { ok: true };
  }
}
