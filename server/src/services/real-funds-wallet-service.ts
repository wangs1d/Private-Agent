import type { WalletAction } from "../protocol.js";
import { getRuntimeConfig } from "../config/env.js";

/** 真实资金账本（法币等；对接支付通道前仍为内存模拟，但与世界内货币完全分离） */
export type RealFundsLedger = {
  kind: "real_funds";
  /** ISO 4217，默认 CNY */
  currencyCode: string;
  balance: number;
  frozen: number;
};

export type RealFundsWalletResult = {
  ok: boolean;
  reason?: string;
  ledger: RealFundsLedger;
};

function defaultCurrency(): string {
  return getRuntimeConfig().realFundsDefaultCurrency;
}

function initialBalance(): number {
  return getRuntimeConfig().realFundsInitialBalance;
}

/**
 * 真实资金钱包：冻结/扣款/退款等，用于与 Agent World 内「世界点数」无关的结算。
 * 请勿用本服务消费 World 商店；世界内购买请使用 `WorldService` / `agentWorldCredits`。
 */
export class RealFundsWalletService {
  private readonly wallets = new Map<string, RealFundsLedger>();

  bootstrap(sessionId: string): RealFundsLedger {
    const existing = this.wallets.get(sessionId);
    if (existing) return existing;
    const next: RealFundsLedger = {
      kind: "real_funds",
      currencyCode: defaultCurrency(),
      balance: initialBalance(),
      frozen: 0,
    };
    this.wallets.set(sessionId, next);
    return next;
  }

  simulate(sessionId: string, action: WalletAction, amount: number): RealFundsWalletResult {
    const wallet = this.bootstrap(sessionId);
    if (amount <= 0) {
      return { ok: false, reason: "金额必须大于 0", ledger: wallet };
    }
    if (action === "freeze") {
      if (wallet.balance < amount) return { ok: false, reason: "余额不足", ledger: wallet };
      wallet.balance -= amount;
      wallet.frozen += amount;
      return { ok: true, ledger: wallet };
    }
    if (action === "debit" || action === "purchase") {
      if (wallet.frozen >= amount) {
        wallet.frozen -= amount;
        return { ok: true, ledger: wallet };
      }
      if (wallet.balance < amount) return { ok: false, reason: "可用余额不足", ledger: wallet };
      wallet.balance -= amount;
      return { ok: true, ledger: wallet };
    }
    if (action === "refund") {
      wallet.balance += amount;
      return { ok: true, ledger: wallet };
    }
    return { ok: false, reason: "不支持的动作", ledger: wallet };
  }
}
