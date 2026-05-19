import { resolveActorId } from "../agent/actor-id.js";
import type { ToolRegistry } from "./tool-registry.js";

/**
 * Agent 钱包操作工具集
 * 包括转账、查询余额、查询交易记录等功能
 */
export function registerWalletTools(registry: ToolRegistry): void {
  // 模拟数据存储 - 实际应该使用数据库
  const walletData = new Map<string, {
    balance: number;
    transactions: Array<{
      id: string;
      type: string;
      title: string;
      amount: number;
      balance: number;
      createdAt: string;
      recipient?: string;
      remark?: string;
      status: string;
    }>;
  }>();

  /**
   * 查询钱包余额
   */
  registry.register("wallet.get_balance", async (input, context) => {
    const actorId = resolveActorId({ userId: context.userId, sessionId: context.sessionId });
    
    // 初始化钱包数据（如果不存在）
    if (!walletData.has(actorId)) {
      walletData.set(actorId, {
        balance: 1000.00,
        transactions: [],
      });
    }

    const data = walletData.get(actorId)!;
    
    return {
      summary: "查询成功",
      balance: data.balance,
      currency: "CNY",
      actorId,
    };
  });

  /**
   * Agent 执行转账
   */
  registry.register("wallet.transfer", async (input, context) => {
    const actorId = resolveActorId({ userId: context.userId, sessionId: context.sessionId });
    
    const recipientId = String(input.recipientId ?? "").trim();
    const amount = Number(input.amount);
    const remark = String(input.remark ?? "").trim();

    // 参数验证
    if (!recipientId) {
      throw new Error("缺少收款人ID (recipientId)");
    }
    if (!amount || amount <= 0) {
      throw new Error("转账金额必须大于0");
    }

    // 初始化钱包数据（如果不存在）
    if (!walletData.has(actorId)) {
      walletData.set(actorId, {
        balance: 1000.00,
        transactions: [],
      });
    }

    const data = walletData.get(actorId)!;

    // 检查余额是否充足
    if (data.balance < amount) {
      throw new Error(`余额不足，当前余额：¥${data.balance.toFixed(2)}，需要：¥${amount.toFixed(2)}`);
    }

    // 执行转账
    const transactionId = `tx_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const previousBalance = data.balance;
    data.balance -= amount;

    // 记录交易
    const transaction = {
      id: transactionId,
      type: "transfer",
      title: `转账给 ${recipientId}`,
      amount: -amount,
      balance: data.balance,
      createdAt: new Date().toISOString(),
      recipient: recipientId,
      remark: remark || undefined,
      status: "completed",
    };

    data.transactions.unshift(transaction);

    return {
      summary: "转账成功",
      transactionId,
      recipientId,
      amount,
      previousBalance,
      currentBalance: data.balance,
      remark: remark || undefined,
      createdAt: transaction.createdAt,
      message: `已成功转账 ¥${amount.toFixed(2)} 给 ${recipientId}`,
    };
  });

  /**
   * 查询交易记录
   */
  registry.register("wallet.get_transactions", async (input, context) => {
    const actorId = resolveActorId({ userId: context.userId, sessionId: context.sessionId });
    
    const limit = Number(input.limit ?? 20);
    const offset = Number(input.offset ?? 0);
    const typeFilter = String(input.type ?? "all"); // all, income, expense, transfer

    // 初始化钱包数据（如果不存在）
    if (!walletData.has(actorId)) {
      walletData.set(actorId, {
        balance: 1000.00,
        transactions: [],
      });
    }

    const data = walletData.get(actorId)!;
    
    // 过滤交易记录
    let filteredTransactions = data.transactions;
    if (typeFilter !== "all") {
      filteredTransactions = data.transactions.filter(t => t.type === typeFilter);
    }

    // 分页
    const paginatedTransactions = filteredTransactions.slice(offset, offset + limit);

    return {
      summary: "查询成功",
      total: filteredTransactions.length,
      limit,
      offset,
      transactions: paginatedTransactions,
      actorId,
    };
  });

  /**
   * 充值（用于测试）
   */
  registry.register("wallet.recharge", async (input, context) => {
    const actorId = resolveActorId({ userId: context.userId, sessionId: context.sessionId });
    
    const amount = Number(input.amount);

    if (!amount || amount <= 0) {
      throw new Error("充值金额必须大于0");
    }

    // 初始化钱包数据（如果不存在）
    if (!walletData.has(actorId)) {
      walletData.set(actorId, {
        balance: 1000.00,
        transactions: [],
      });
    }

    const data = walletData.get(actorId)!;
    const previousBalance = data.balance;
    data.balance += amount;

    // 记录交易
    const transactionId = `tx_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const transaction = {
      id: transactionId,
      type: "income",
      title: "充值",
      amount: amount,
      balance: data.balance,
      createdAt: new Date().toISOString(),
      status: "completed",
    };

    data.transactions.unshift(transaction);

    return {
      summary: "充值成功",
      transactionId,
      amount,
      previousBalance,
      currentBalance: data.balance,
      message: `已成功充值 ¥${amount.toFixed(2)}`,
    };
  });
}
