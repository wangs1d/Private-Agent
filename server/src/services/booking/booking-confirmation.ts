/**
 * 预订层统一两阶段确认（ask_first 分支）。
 *
 * 与 shopping-order 的 PendingConfirmation 同构，但抽成独立可测组件：
 *   阶段一（confirm=false）：mint() 生成 token（TTL 默认 5 分钟），
 *     返回待确认摘要；LLM 必须先向用户复述摘要
 *   阶段二（confirm=true + token）：consume() 校验 token / TTL / actor /
 *     action / domain 一致后放行执行；一次性消费
 *
 * token 过期自动清理（60s 定时 + 消费时惰性删除）。
 */

import { randomUUID } from "node:crypto";

import type { BookingDomain, BookingDraft } from "./booking-provider.js";

export interface BookingPendingConfirmation {
  token: string;
  actorId: string;
  domain: BookingDomain;
  provider: string;
  /** 确认的动作：book（下单）/ cancel（取消） */
  action: "book" | "cancel";
  /** book：订单草稿；cancel：待取消的本地 orderId */
  draft: BookingDraft | null;
  orderId: string | null;
  /** 复述给用户的摘要 */
  summary: string;
  amountCny: number | null;
  expiresAt: number;
}

export interface BookingConfirmationStoreOptions {
  ttlMs?: number;
  now?: () => number;
}

export type ConsumeResult =
  | { ok: true; pending: BookingPendingConfirmation }
  | { ok: false; error: string; retryable?: boolean };

export class BookingConfirmationStore {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly pendings = new Map<string, BookingPendingConfirmation>();
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(opts: BookingConfirmationStoreOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 300_000;
    this.now = opts.now ?? (() => Date.now());
  }

  /** 阶段一：生成待确认记录。 */
  mint(input: {
    actorId: string;
    domain: BookingDomain;
    provider: string;
    action: "book" | "cancel";
    draft?: BookingDraft | null;
    orderId?: string | null;
    summary: string;
    amountCny: number | null;
  }): BookingPendingConfirmation {
    this.startCleanup();
    const pending: BookingPendingConfirmation = {
      token: randomUUID(),
      actorId: input.actorId,
      domain: input.domain,
      provider: input.provider,
      action: input.action,
      draft: input.draft ?? null,
      orderId: input.orderId ?? null,
      summary: input.summary,
      amountCny: input.amountCny,
      expiresAt: this.now() + this.ttlMs,
    };
    this.pendings.set(pending.token, pending);
    return pending;
  }

  /** 阶段二：校验并一次性消费 token。 */
  consume(
    token: string,
    expect: { actorId: string; action: "book" | "cancel"; domain: BookingDomain },
  ): ConsumeResult {
    if (!token) return { ok: false, error: "缺少 confirmationToken（来自阶段一）" };
    const pending = this.pendings.get(token);
    if (!pending) {
      return { ok: false, error: "确认 token 无效或已被使用，请重新发起（confirm=false）", retryable: true };
    }
    if (this.now() > pending.expiresAt) {
      this.pendings.delete(token);
      return { ok: false, error: "确认已过期，请重新发起（confirm=false）", retryable: true };
    }
    if (pending.actorId !== expect.actorId) {
      return { ok: false, error: "确认 token 与当前用户不匹配" };
    }
    if (pending.action !== expect.action || pending.domain !== expect.domain) {
      return { ok: false, error: `确认 token 与当前操作不匹配（token 属于 ${pending.domain} ${pending.action}）` };
    }
    this.pendings.delete(token);
    return { ok: true, pending };
  }

  /** 失败归还：把未执行成功的待确认记录放回（保留原 TTL；已过期则丢弃）。 */
  restore(pending: BookingPendingConfirmation): void {
    if (this.now() > pending.expiresAt) return;
    this.pendings.set(pending.token, pending);
  }

  /** 存量统计（测试/调试）。 */
  get size(): number {
    return this.pendings.size;
  }

  private startCleanup(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => {
      const nowMs = this.now();
      for (const [token, pending] of this.pendings) {
        if (nowMs > pending.expiresAt) this.pendings.delete(token);
      }
    }, 60_000);
    this.cleanupTimer.unref?.();
  }

  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.pendings.clear();
  }
}
