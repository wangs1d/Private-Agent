import { resolveActorId } from "../agent/actor-id.js";
import type { ToolRegistry } from "./tool-registry.js";
import type { FriendService } from "../services/friend-service.js";

/** 全部支持的消费类别 */
const ALL_CATEGORIES = [
  "hotel", "movie", "shopping", "food_delivery", "dine_in",
  "taxi", "ride_hailing", "public_transit", "parking",
  "travel", "flight", "train", "bus_ticket",
  "entertainment", "concert", "sports_event", "exhibition",
  "beauty", "spa", "hair_salon", "massage",
  "health", "medical", "pharmacy", "gym",
  "education", "course", "book", "subscription",
  "utility", "phone_bill", "electricity", "water", "gas", "internet",
  "gift", "flower", "red_packet", "donation",
  "pet", "pet_food", "pet_medical", "pet_grooming",
  "home_service", "cleaning", "repair", "moving",
  "digital", "game", "software", "cloud_service",
  "office", "printing", "courier", "rental",
  "insurance", "financial", "investment",
  "other",
] as const;

type Category = (typeof ALL_CATEGORIES)[number];

function isValidCategory(value: string): value is Category {
  return (ALL_CATEGORIES as readonly string[]).includes(value);
}

const CATEGORY_MAP: Record<string, string> = {
  hotel: "酒店预订",
  movie: "电影票",
  shopping: "网购购物",
  food_delivery: "外卖点餐",
  dine_in: "到店餐饮",
  taxi: "打车出行",
  ride_hailing: "网约车",
  public_transit: "公共交通",
  parking: "停车缴费",
  travel: "旅行预订",
  flight: "机票预订",
  train: "火车票",
  bus_ticket: "汽车票",
  entertainment: "娱乐消费",
  concert: "演唱会门票",
  sports_event: "体育赛事门票",
  exhibition: "展览门票",
  beauty: "美妆消费",
  spa: "SPA养生",
  hair_salon: "美发造型",
  massage: "按摩理疗",
  health: "健康消费",
  medical: "医疗费用",
  pharmacy: "药品购买",
  gym: "健身运动",
  education: "教育学习",
  course: "课程购买",
  book: "图书文具",
  subscription: "会员订阅",
  utility: "生活缴费",
  phone_bill: "话费充值",
  electricity: "电费缴纳",
  water: "水费缴纳",
  gas: "燃气费缴纳",
  internet: "宽带网络",
  gift: "礼品购买",
  flower: "鲜花订购",
  red_packet: "红包转账",
  donation: "公益捐赠",
  pet: "宠物消费",
  pet_food: "宠物用品",
  pet_medical: "宠物医疗",
  pet_grooming: "宠物美容",
  home_service: "家政服务",
  cleaning: "保洁服务",
  repair: "维修服务",
  moving: "搬家服务",
  digital: "数字产品",
  game: "游戏充值",
  software: "软件购买",
  cloud_service: "云服务",
  office: "办公用品",
  printing: "打印复印",
  courier: "快递物流",
  rental: "租赁服务",
  insurance: "保险费用",
  financial: "金融服务",
  investment: "投资理财",
  other: "其他消费",
};

const CATEGORY_EMOJI: Record<string, string> = {
  hotel: "🏨", movie: "🎬", shopping: "🛒", food_delivery: "🍱", dine_in: "🍽️",
  taxi: "🚕", ride_hailing: "🚗", public_transit: "🚌", parking: "🅿️",
  travel: "✈️", flight: "✈️", train: "🚄", bus_ticket: "🚌",
  entertainment: "🎭", concert: "🎤", sports_event: "⚽", exhibition: "🖼️",
  beauty: "💄", spa: "💆", hair_salon: "💇", massage: "💆",
  health: "❤️", medical: "🏥", pharmacy: "💊", gym: "🏋️",
  education: "📚", course: "🎓", book: "📖", subscription: "⭐",
  utility: "📋", phone_bill: "📱", electricity: "⚡", water: "💧", gas: "🔥", internet: "🌐",
  gift: "🎁", flower: "💐", red_packet: "🧧", donation: "❤️‍🩹",
  pet: "🐾", pet_food: "🦴", pet_medical: "🏥", pet_grooming: "✂️",
  home_service: "🏠", cleaning: "🧹", repair: "🔧", moving: "📦",
  digital: "💻", game: "🎮", software: "💿", cloud_service: "☁️",
  office: "✏️", printing: "🖨️", courier: "📦", rental: "🔑",
  insurance: "🛡️", financial: "🏦", investment: "📈",
  other: "💳",
};

/**
 * Agent 钱包操作工具集
 * 包括转账（需好友关系）、查询余额、查询交易记录、购物消费（全场景）等功能
 */
export function registerWalletTools(registry: ToolRegistry, friendService?: FriendService): void {
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
   * Agent 执行转账（需要对方是好友）
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

    // 好友关系验证（如果 friendService 可用）
    if (friendService) {
      const areFriends = friendService.areFriends(actorId, recipientId);
      if (!areFriends) {
        throw new Error(`转账失败：${recipientId} 不是您的好友。只能向好友转账，请先添加好友关系。`);
      }
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

  /**
   * Agent 代用户消费/购物（覆盖所有可购买的真实生活服务场景）
   */
  registry.register("wallet.purchase", async (input, context) => {
    const actorId = resolveActorId({ userId: context.userId, sessionId: context.sessionId });

    const category = String(input.category ?? "").trim().toLowerCase();
    const amount = Number(input.amount);
    const description = String(input.description ?? "").trim();
    const merchant = String(input.merchant ?? "").trim();
    const orderDetails = input.orderDetails as Record<string, unknown> | undefined;

    // 参数验证
    if (!category) {
      throw new Error(`缺少消费类别 (category)。支持：${ALL_CATEGORIES.join(", ")}`);
    }
    if (!amount || amount <= 0) {
      throw new Error("消费金额必须大于0");
    }
    if (!description) {
      throw new Error("缺少消费描述 (description)");
    }

    // 验证消费类别
    if (!isValidCategory(category)) {
      throw new Error(`不支持的消费类别：${category}。支持：${ALL_CATEGORIES.join(", ")}`);
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

    // 执行扣款
    const transactionId = `purchase_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const previousBalance = data.balance;
    data.balance -= amount;

    const displayName = CATEGORY_MAP[category] || category;

    // 记录交易
    const transaction = {
      id: transactionId,
      type: "purchase",
      category,
      categoryDisplayName: displayName,
      title: `${displayName} - ${description}`,
      amount: -amount,
      balance: data.balance,
      createdAt: new Date().toISOString(),
      merchant: merchant || undefined,
      description,
      orderDetails: orderDetails || undefined,
      status: "completed",
    };

    data.transactions.unshift(transaction);

    // 根据不同类别生成友好的响应消息
    const emoji = CATEGORY_EMOJI[category] || "💳";
    const message = `${emoji} ${displayName}成功！已支付 ¥${amount.toFixed(2)} - ${description}${merchant ? `（${merchant}）` : ""}`;

    return {
      summary: `${displayName}成功`,
      transactionId,
      category,
      categoryDisplayName: displayName,
      amount,
      description,
      merchant: merchant || undefined,
      previousBalance,
      currentBalance: data.balance,
      orderDetails: orderDetails || undefined,
      createdAt: transaction.createdAt,
      message,
    };
  });
}
