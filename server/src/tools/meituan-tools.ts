import { resolveActorId } from "../agent/actor-id.js";
import type { ToolRegistry } from "./tool-registry.js";
import type { MeituanService } from "../services/meituan-service.js";

export function registerMeituanTools(registry: ToolRegistry, service: MeituanService): void {

  registry.register("meituan.pricing", async (input, context) => {
    const actorId = resolveActorId({ userId: context.userId, sessionId: context.sessionId });

    const pickupAddress = String(input.pickupAddress ?? "").trim();
    const deliveryAddress = String(input.deliveryAddress ?? "").trim();

    if (!pickupAddress) throw new Error("缺少取件地址 (pickupAddress)");
    if (!deliveryAddress) throw new Error("缺少收件地址 (deliveryAddress)");

    const result = await service.pricing({
      pickupAddress,
      pickupDetail: input.pickupDetail ? String(input.pickupDetail).trim() : undefined,
      deliveryAddress,
      deliveryDetail: input.deliveryDetail ? String(input.deliveryDetail).trim() : undefined,
      itemDescription: input.itemDescription ? String(input.itemDescription).trim() : undefined,
      itemWeight: input.itemWeight ? Number(input.itemWeight) : undefined,
      expressType: input.expressType ? Number(input.expressType) : undefined,
    });

    if (!result.ok) {
      throw new Error(result.error || "询价失败");
    }

    return {
      summary: "询价成功",
      deliveryFee: result.deliveryFee,
      totalFee: result.totalFee,
      distance: result.distance,
      estimatedTime: result.estimatedTime,
      expressType: result.expressType,
      pickupAddress,
      deliveryAddress,
      actorId,
    };
  });

  registry.register("meituan.create_order", async (input, context) => {
    const actorId = resolveActorId({ userId: context.userId, sessionId: context.sessionId });

    const pickupAddress = String(input.pickupAddress ?? "").trim();
    const deliveryAddress = String(input.deliveryAddress ?? "").trim();
    const itemDescription = String(input.itemDescription ?? "").trim();

    if (!pickupAddress) throw new Error("缺少取件地址 (pickupAddress)");
    if (!deliveryAddress) throw new Error("缺少收件地址 (deliveryAddress)");
    if (!itemDescription) throw new Error("缺少物品描述 (itemDescription)");

    const result = await service.createOrder({
      pickupAddress,
      pickupDetail: input.pickupDetail ? String(input.pickupDetail).trim() : undefined,
      pickupPhone: input.pickupPhone ? String(input.pickupPhone).trim() : undefined,
      pickupName: input.pickupName ? String(input.pickupName).trim() : undefined,
      deliveryAddress,
      deliveryDetail: input.deliveryDetail ? String(input.deliveryDetail).trim() : undefined,
      deliveryPhone: input.deliveryPhone ? String(input.deliveryPhone).trim() : undefined,
      deliveryName: input.deliveryName ? String(input.deliveryName).trim() : undefined,
      itemDescription,
      itemWeight: input.itemWeight ? Number(input.itemWeight) : undefined,
      expressType: input.expressType ? Number(input.expressType) : undefined,
      tipAmount: input.tipAmount ? Number(input.tipAmount) : undefined,
      remark: input.remark ? String(input.remark).trim() : undefined,
    });

    if (!result.ok) {
      throw new Error(result.error || "创建订单失败");
    }

    return {
      summary: "美团跑腿订单已创建",
      orderId: result.orderId,
      deliveryId: result.deliveryId,
      status: result.status,
      deliveryFee: result.deliveryFee,
      totalFee: result.totalFee,
      estimatedTime: result.estimatedTime,
      pickupAddress,
      deliveryAddress,
      itemDescription,
      actorId,
    };
  });

  registry.register("meituan.query_order", async (input, context) => {
    const actorId = resolveActorId({ userId: context.userId, sessionId: context.sessionId });

    const orderId = String(input.orderId ?? "").trim();
    if (!orderId) throw new Error("缺少订单号 (orderId)");

    const result = await service.queryOrder(orderId);

    if (!result.ok) {
      throw new Error(result.error || "查询订单失败");
    }

    const statusMap: Record<string, string> = {
      "1": "待接单",
      "2": "已接单",
      "3": "取货中",
      "4": "配送中",
      "5": "已完成",
      "6": "已取消",
      pending: "待接单",
      accepted: "已接单",
      picking: "取货中",
      delivering: "配送中",
      completed: "已完成",
      cancelled: "已取消",
    };

    return {
      summary: `订单状态：${statusMap[result.status || ""] || result.statusDesc || result.status}`,
      orderId: result.orderId,
      status: result.status,
      statusDesc: statusMap[result.status || ""] || result.statusDesc,
      riderName: result.riderName,
      riderPhone: result.riderPhone,
      riderLat: result.riderLat,
      riderLng: result.riderLng,
      estimatedTime: result.estimatedTime,
      actorId,
    };
  });

  registry.register("meituan.cancel_order", async (input, context) => {
    const actorId = resolveActorId({ userId: context.userId, sessionId: context.sessionId });

    const orderId = String(input.orderId ?? "").trim();
    if (!orderId) throw new Error("缺少订单号 (orderId)");

    const reason = input.reason ? String(input.reason).trim() : undefined;
    const result = await service.cancelOrder(orderId, reason);

    if (!result.ok) {
      throw new Error(result.error || "取消订单失败");
    }

    return {
      summary: "订单已取消",
      orderId: result.orderId,
      actorId,
    };
  });

  registry.register("meituan.estimate_price", async (input, context) => {
    const actorId = resolveActorId({ userId: context.userId, sessionId: context.sessionId });

    const description = String(input.description ?? "").trim();
    if (!description) throw new Error("缺少物品描述 (description)");

    const estimate = service.estimatePrice(description);

    return {
      summary: "价格预估",
      description,
      estimatedLow: estimate.low,
      estimatedHigh: estimate.high,
      currency: "CNY",
      note: "此为预估价格，实际费用以下单时询价结果为准",
      actorId,
    };
  });
}
