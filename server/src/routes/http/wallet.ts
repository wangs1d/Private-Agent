import type { FastifyInstance } from "fastify";

import type { HttpRouteDeps } from "./types.js";

/**
 * 真实资金钱包子域（法币等；对接支付前仍为内存模拟）。
 * Agent World 内点数见 `/world/*` 的 `agentWorldCredits`，勿与本域混用。
 */
export function registerWalletRoutes(app: FastifyInstance, deps: HttpRouteDeps): void {
  const { realFundsWallet } = deps;

  app.post("/wallet/bootstrap", async (request) => {
    const body = request.body as { sessionId?: string };
    const sessionId = body?.sessionId ?? "default-session";
    const ledger = realFundsWallet.bootstrap(sessionId);
    return { ok: true, ledgerKind: "real_funds", ledger };
  });
}
