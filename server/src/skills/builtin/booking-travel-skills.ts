import { resolveActorId } from "../../agent/actor-id.js";
import type { AlipayBotService } from "../../services/alipay-bot-service.js";
import type { AuditService } from "../../services/audit-service.js";
import type { BookingOrderStore, StoredBookingOrder } from "../../services/booking/booking-order-store.js";
import { TravelTicketProvider } from "../../services/booking/providers/travel-ticket-provider.js";
import { travelTicketStore, type TicketType } from "../../skills/travel-planning/travel-ticket-store.js";
import type { SkillDefinition } from "../types.js";

/**
 * 内置 Skill：旅行票务预订闭环（travel 域结算与出票）。
 *
 * 与 TravelTicketProvider（booking 域 travel）配合，把「下单 → 真实支付 →
 * 出票入票夹」串成可真实跑通的链路：
 *
 *   1. booking.book（domain=travel，两阶段确认）创建待支付订单
 *   2. booking.travel-pay        —— 用用户本人支付宝钱包真实扣款（AI 支付通道）
 *   3. booking.travel-pay-check  —— 轮询支付结果，成功后订单推进 confirmed
 *   4. booking.travel-issue      —— 出票确认：票写入票夹（travelTicketStore），
 *      订单推进 in_progress；之后可开到站监控（travel.arrival-monitor）接力
 *
 * 支付边界：扣款只发生在用户本人授权的钱包（用户在支付宝 App 内确认），
 * Agent 不持有任何支付凭证。
 */

type Deps = {
  alipayBotService: AlipayBotService;
  bookingOrderStore: BookingOrderStore;
  travelTicketProvider: TravelTicketProvider;
  audit?: AuditService | null;
};

/** 从支付宝 CLI 输出中提取订单号/查询单号（outShakeNo）。 */
function extractOutShakeNo(stdout: string): string {
  if (!stdout) return "";
  const jsonMatch = /"(?:outShakeNo|out_shake_no|orderNo|order_no)"\s*:\s*"([^"]+)"/.exec(stdout);
  if (jsonMatch) return jsonMatch[1];
  const textMatch = /(?:订单号|查询单号|支付单号)[:：]\s*([A-Za-z0-9_-]{6,})/.exec(stdout);
  if (textMatch) return textMatch[1];
  return "";
}

/** 支付状态启发式判定（CLI 输出非结构化，按关键词分类）。 */
function classifyPaymentStatus(stdout: string): "paid" | "failed" | "pending" | "unknown" {
  const text = stdout ?? "";
  if (/支付成功|已成功支付|付款成功|交易成功|TRADE_SUCCESS|\"success\"\s*:\s*true/i.test(text)) return "paid";
  if (/支付失败|付款失败|交易失败|已关闭|已超时|TRADE_(CLOSED|FAILED)/i.test(text)) return "failed";
  if (/待支付|等待(用户)?(支付|付款)|二维码|请扫|WAIT_BUYER_PAY/i.test(text)) return "pending";
  return "unknown";
}

function travelOrderLabel(order: StoredBookingOrder): string {
  return `${order.title}${order.amountCny != null ? ` ¥${order.amountCny}` : ""}`;
}

async function loadTravelOrder(
  deps: Deps,
  actorId: string,
  orderId: string,
): Promise<{ ok: true; order: StoredBookingOrder } | { ok: false; error: string }> {
  const order = await deps.bookingOrderStore.get(orderId);
  if (!order || order.actorId !== actorId) return { ok: false, error: `订单 ${orderId} 不存在` };
  if (order.domain !== "travel") return { ok: false, error: `订单 ${orderId} 不是旅行票务订单（domain=${order.domain}）` };
  return { ok: true, order };
}

async function recordAudit(
  deps: Deps,
  ctx: { sessionId?: string | undefined },
  action: string,
  extra: Record<string, unknown>,
): Promise<void> {
  if (!deps.audit) return;
  try {
    await deps.audit.record({
      ts: new Date().toISOString(),
      category: "booking",
      action,
      domain: "travel",
      ...extra,
      sessionId: ctx.sessionId,
    });
  } catch {
    // 审计失败静默（与 booking-service 一致）
  }
}

export function createBookingTravelBuiltinSkills(deps: Deps): SkillDefinition[] {
  const { alipayBotService, travelTicketProvider } = deps;

  /** 1. 发起支付宝 AI 支付（真实扣款，用户手机确认） */
  const travel_pay: SkillDefinition = {
    metadata: {
      name: "booking.travel-pay",
      version: "1.0.0",
      displayName: "旅行订单支付宝支付",
      description:
        "对 travel 域待支付订单发起支付宝 AI 支付（从用户本人钱包真实扣款，用户在支付宝 App 内确认）。" +
        "前置：booking.book（domain=travel）已创建订单，且用户已明确同意支付金额。" +
        "paymentLink 为商家收银台链接/订单串（携程/12306/酒店平台 H5 支付链接，或经 alipay.proxy-trade 从商家下单接口获取）；" +
        "订单已带支付链接时可省略。返回 awaiting_user_payment 时，提醒用户在支付宝内确认，然后调 booking.travel-pay-check 查询结果。",
      kind: "builtin",
      tags: ["booking", "travel", "alipay", "payment", "支付", "机票", "火车票", "酒店"],
      icon: "🎫",
      parameters: [
        { name: "orderId", type: "string", required: true, description: "travel 域订单号（bkg_*）" },
        {
          name: "paymentLink",
          type: "string",
          required: false,
          description: "商家收银台链接/订单串；订单已带支付链接时可省略",
        },
      ],
      outputSchema: {
        ok: "是否成功发起",
        paymentStatus: "awaiting_user_payment | failed",
        outShakeNo: "支付宝查询单号（pay-check 用）",
        stdout: "CLI 原始输出",
      },
      permissions: ["wallet:read", "wallet:write"],
      timeoutMs: 60_000,
    },
    handler: async (input, context) => {
      const actorId = resolveActorId(context);
      const orderId = typeof input.orderId === "string" ? input.orderId.trim() : "";
      if (!orderId) return { ok: false, error: "缺少 orderId", actorId };

      const loaded = await loadTravelOrder(deps, actorId, orderId);
      if (!loaded.ok) return { ok: false, error: loaded.error, actorId };
      const { order } = loaded;
      if (order.status !== "pending_payment") {
        return { ok: false, error: `订单当前状态为 ${order.status}，只有待支付订单可以发起支付`, actorId };
      }

      // 钱包门禁：未开通先引导授权，而不是失败
      const wallet = alipayBotService.forUser(actorId);
      const walletStatus = await wallet.checkWallet();
      if (walletStatus.status === "not_opened" || walletStatus.code !== 200) {
        return {
          ok: false,
          error: "该用户支付宝支付功能未开通。请先引导用户完成首次授权：alipay.apply-wallet 生成链接 → 用户扫码 → alipay.bind-wallet 绑定",
          actorId,
          walletStatus: walletStatus.status,
        };
      }

      const paymentLink =
        (typeof input.paymentLink === "string" && input.paymentLink.trim()) || order.paymentUrl || "";
      if (!paymentLink) {
        return {
          ok: false,
          error:
            "缺少支付链接。请向用户要商家收银台链接/订单串，或用 alipay.proxy-trade 从商家下单接口提取后重试",
          actorId,
        };
      }

      const sessionId = context.sessionId;
      const intentSummary = `服务内容：${travelOrderLabel(order)}，支付金额：${order.amountCny != null ? `¥${order.amountCny}` : "以订单为准"}，支付对象：旅行票务商家`;
      const result = await wallet.submitPayment(sessionId, paymentLink, intentSummary);
      const outShakeNo = extractOutShakeNo(result.stdout);
      if (outShakeNo) {
        await deps.bookingOrderStore.update(orderId, {
          params: { ...order.params, payOutShakeNo: outShakeNo, payPaymentLink: paymentLink },
        });
      }
      await recordAudit(deps, context, "travel_pay_submit", {
        actorId,
        orderId,
        providerOrderId: order.providerOrderId,
        outShakeNo: outShakeNo || null,
      });

      const status = classifyPaymentStatus(result.stdout);
      if (status === "paid") {
        travelTicketProvider.markPaid(order.providerOrderId ?? "");
        await deps.bookingOrderStore.update(orderId, { status: "confirmed" });
        await recordAudit(deps, context, "travel_pay_confirmed", { actorId, orderId });
        return {
          ok: true,
          actorId,
          paymentStatus: "paid",
          outShakeNo: outShakeNo || null,
          stdout: result.stdout,
          summary: "支付已完成，订单已推进为 confirmed。可引导出票：booking.travel-issue",
        };
      }
      return {
        ok: result.ok,
        actorId,
        paymentStatus: result.ok ? "awaiting_user_payment" : "failed",
        outShakeNo: outShakeNo || null,
        stdout: result.stdout,
        error: result.error,
        summary: result.ok
          ? "已发起支付（真实扣款）。请提醒用户在支付宝 App 内确认付款，完成后调用 booking.travel-pay-check 查询结果"
          : "发起支付失败，请查看 error/stdout",
      };
    },
  };

  /** 2. 查询支付结果并推进订单状态 */
  const travel_pay_check: SkillDefinition = {
    metadata: {
      name: "booking.travel-pay-check",
      version: "1.0.0",
      displayName: "查询旅行订单支付结果",
      description:
        "查询 travel 域订单的支付宝支付状态；支付成功时自动把订单推进为 confirmed。用户付款后询问「付了吗」「成功没」时调用。",
      kind: "builtin",
      tags: ["booking", "travel", "alipay", "查询", "支付"],
      icon: "🔍",
      parameters: [
        { name: "orderId", type: "string", required: true, description: "travel 域订单号（bkg_*）" },
        { name: "outShakeNo", type: "string", required: false, description: "支付宝查询单号（缺省用发起支付时记录的）" },
      ],
      outputSchema: { ok: "boolean", paymentStatus: "paid | pending | failed | unknown", orderStatus: "订单最新状态" },
      permissions: ["wallet:read"],
      timeoutMs: 30_000,
    },
    handler: async (input, context) => {
      const actorId = resolveActorId(context);
      const orderId = typeof input.orderId === "string" ? input.orderId.trim() : "";
      if (!orderId) return { ok: false, error: "缺少 orderId", actorId };
      const loaded = await loadTravelOrder(deps, actorId, orderId);
      if (!loaded.ok) return { ok: false, error: loaded.error, actorId };
      const { order } = loaded;
      if (order.status !== "pending_payment") {
        return {
          ok: true,
          actorId,
          paymentStatus: order.status === "confirmed" ? "paid" : "unknown",
          orderStatus: order.status,
          summary: `订单当前状态 ${order.status}，无需再查询支付`,
        };
      }

      const outShakeNo =
        (typeof input.outShakeNo === "string" && input.outShakeNo.trim()) ||
        (typeof order.params.payOutShakeNo === "string" ? order.params.payOutShakeNo : "");
      if (!outShakeNo) {
        return { ok: false, error: "缺少 outShakeNo（发起支付时未记录，请提供）", actorId };
      }
      const result = await alipayBotService.forUser(actorId).queryPaymentStatus({ outShakeNo });
      const status = classifyPaymentStatus(result.stdout);
      if (status === "paid") {
        travelTicketProvider.markPaid(order.providerOrderId ?? "");
        await deps.bookingOrderStore.update(orderId, { status: "confirmed" });
        await recordAudit(deps, context, "travel_pay_confirmed", { actorId, orderId, outShakeNo });
        return {
          ok: true,
          actorId,
          paymentStatus: "paid",
          orderStatus: "confirmed",
          stdout: result.stdout,
          summary: "支付成功，订单已推进为 confirmed。接下来引导出票：booking.travel-issue",
        };
      }
      await recordAudit(deps, context, "travel_pay_check", { actorId, orderId, outShakeNo, status });
      return {
        ok: true,
        actorId,
        paymentStatus: status,
        orderStatus: order.status,
        stdout: result.stdout,
        summary:
          status === "pending"
            ? "用户尚未完成支付，稍后再查或提醒用户在支付宝内确认"
            : status === "failed"
              ? "支付失败/已关闭，可重新发起 booking.travel-pay"
              : "支付状态未识别，请参考 stdout 原文判断",
      };
    },
  };

  /** 3. 出票确认：票写入票夹，订单推进 in_progress */
  const travel_issue: SkillDefinition = {
    metadata: {
      name: "booking.travel-issue",
      version: "1.0.0",
      displayName: "旅行订单出票确认",
      description:
        "支付成功后（订单 confirmed）确认出票：把票务信息写入票夹（行程/到站监控/接站约车的数据源），订单推进 in_progress。" +
        "出票信息来自商家出票回执（短信/邮件/订单页），用户确认后录入。录入后建议开启到站监控：travel.arrival-monitor。",
      kind: "builtin",
      tags: ["booking", "travel", "出票", "票夹", "机票", "火车票", "酒店"],
      icon: "🧾",
      parameters: [
        { name: "orderId", type: "string", required: true, description: "travel 域订单号（bkg_*）" },
        {
          name: "type",
          type: "string",
          required: true,
          description: "票务类型：flight（机票）/ train（火车票）/ hotel（酒店）",
        },
        { name: "carrier", type: "string", required: true, description: "航司 / 车次承运 / 酒店名" },
        { name: "code", type: "string", required: false, description: "航班号 / 车次 / 酒店确认号" },
        { name: "fromStation", type: "string", required: false, description: "出发机场/车站名" },
        { name: "fromCity", type: "string", required: false, description: "出发城市" },
        { name: "toStation", type: "string", required: false, description: "到达机场/车站名" },
        { name: "toCity", type: "string", required: false, description: "到达城市" },
        { name: "departTime", type: "string", required: false, description: "出发时间（ISO 或 YYYY-MM-DD HH:mm）" },
        { name: "arriveTime", type: "string", required: false, description: "到达时间" },
        { name: "seat", type: "string", required: false, description: "舱位/席别/座位" },
        { name: "gate", type: "string", required: false, description: "航站楼/检票口" },
        { name: "checkInDate", type: "string", required: false, description: "酒店入住日期（YYYY-MM-DD）" },
        { name: "checkOutDate", type: "string", required: false, description: "酒店退房日期" },
        { name: "roomType", type: "string", required: false, description: "房型" },
        { name: "arrivalRideOptIn", type: "boolean", required: false, description: "到站约车 opt-in（缺省 true）" },
      ],
      outputSchema: { ok: "boolean", ticketId: "票夹 ticketId", orderStatus: "订单最新状态" },
      permissions: ["storage:write"],
      timeoutMs: 30_000,
    },
    handler: async (input, context) => {
      const actorId = resolveActorId(context);
      const orderId = typeof input.orderId === "string" ? input.orderId.trim() : "";
      if (!orderId) return { ok: false, error: "缺少 orderId", actorId };
      const loaded = await loadTravelOrder(deps, actorId, orderId);
      if (!loaded.ok) return { ok: false, error: loaded.error, actorId };
      const { order } = loaded;
      if (order.status === "pending_payment") {
        return { ok: false, error: "订单还未支付，先完成支付（booking.travel-pay → travel-pay-check）", actorId };
      }
      if (order.status === "in_progress" || order.status === "completed") {
        return { ok: false, error: `订单已出票（状态 ${order.status}）`, actorId };
      }

      const typeRaw = typeof input.type === "string" ? input.type.trim() : "";
      if (typeRaw !== "flight" && typeRaw !== "train" && typeRaw !== "hotel") {
        return { ok: false, error: "type 必须是 flight / train / hotel", actorId };
      }
      const type = typeRaw as TicketType;
      const carrier = typeof input.carrier === "string" ? input.carrier.trim() : "";
      if (!carrier) return { ok: false, error: "缺少 carrier（航司/车次/酒店名）", actorId };

      const ticket = travelTicketStore.save({
        type,
        source: "manual",
        passenger: typeof input.passenger === "string" ? input.passenger.trim() : undefined,
        carrier,
        code: typeof input.code === "string" ? input.code.trim() : undefined,
        fromStation: typeof input.fromStation === "string" ? input.fromStation.trim() : undefined,
        fromCity: typeof input.fromCity === "string" ? input.fromCity.trim() : undefined,
        toStation: typeof input.toStation === "string" ? input.toStation.trim() : undefined,
        toCity: typeof input.toCity === "string" ? input.toCity.trim() : undefined,
        departTime: typeof input.departTime === "string" ? input.departTime.trim() : undefined,
        arriveTime: typeof input.arriveTime === "string" ? input.arriveTime.trim() : undefined,
        seat: typeof input.seat === "string" ? input.seat.trim() : undefined,
        gate: typeof input.gate === "string" ? input.gate.trim() : undefined,
        checkInDate: typeof input.checkInDate === "string" ? input.checkInDate.trim() : undefined,
        checkOutDate: typeof input.checkOutDate === "string" ? input.checkOutDate.trim() : undefined,
        roomType: typeof input.roomType === "string" ? input.roomType.trim() : undefined,
        rawText: typeof input.rawText === "string" ? input.rawText.slice(0, 500) : undefined,
        arrivalRideOptIn: input.arrivalRideOptIn === false ? false : true,
      });

      travelTicketProvider.markIssued(order.providerOrderId ?? "", ticket.ticketId);
      await deps.bookingOrderStore.update(orderId, {
        status: "in_progress",
        params: { ...order.params, issueTicketId: ticket.ticketId },
      });
      await recordAudit(deps, context, "travel_issue", { actorId, orderId, ticketId: ticket.ticketId });

      return {
        ok: true,
        actorId,
        ticketId: ticket.ticketId,
        orderStatus: "in_progress",
        summary:
          `已出票并写入票夹（ticketId=${ticket.ticketId}）。` +
          (type === "hotel"
            ? "可提醒用户到店办理入住。"
            : "建议开启到站监控（travel.arrival-monitor）：落地/到站前 45 分钟可协助约车或通知接站人。"),
      };
    },
  };

  return [travel_pay, travel_pay_check, travel_issue];
}

export function registerBookingTravelBuiltinSkills(
  register: (skill: SkillDefinition) => void,
  deps: Deps,
): void {
  for (const s of createBookingTravelBuiltinSkills(deps)) {
    register(s);
  }
}
