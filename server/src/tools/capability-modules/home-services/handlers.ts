import type { ToolHandler, ToolContext, ToolRegistry } from "../../tool-registry.js";
import type { BookingService } from "../../../services/booking/booking-service.js";
import { HOME_SERVICE_TYPES } from "../../../services/booking/providers/simulated-local-providers.js";

/**
 * home_service.* 工具 handler 工厂集合 + 注册入口。
 *
 * 返回契约与 shopping-order 一致；安全护栏由 BookingService 统一保障
 * （两阶段确认 / 单笔与单日限额 / 审计 / 承诺板）。
 */

export interface HomeServicesModuleDeps {
  bookingService: BookingService;
}

const VALID_SERVICE_TYPES = new Set<string>(HOME_SERVICE_TYPES);

function coerceServiceType(raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return { ok: false, error: `缺少 serviceType。可选：${HOME_SERVICE_TYPES.join("/")}` };
  if (!VALID_SERVICE_TYPES.has(value)) {
    return { ok: false, error: `非法 serviceType「${value}」。可选：${HOME_SERVICE_TYPES.join("/")}` };
  }
  return { ok: true, value };
}

function optionalString(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

/** home_service.search —— 套餐搜索。 */
export function createHomeServiceSearchHandler(service: BookingService): ToolHandler {
  return async (input: Record<string, unknown>, context: ToolContext) => {
    const serviceType = coerceServiceType(input.serviceType);
    if (!serviceType.ok) return serviceType;
    return service.search(
      context,
      "home_service",
      {
        city: optionalString(input.city),
        scheduleAt: optionalString(input.scheduleAt) ?? null,
        params: {
          serviceType: serviceType.value,
          address: optionalString(input.address) ?? "",
        },
      },
      optionalString(input.provider),
    );
  };
}

/** home_service.book —— 两阶段确认下单。 */
export function createHomeServiceBookHandler(service: BookingService): ToolHandler {
  return async (input: Record<string, unknown>, context: ToolContext) => {
    const serviceType = coerceServiceType(input.serviceType);
    if (!serviceType.ok) return serviceType;
    const optionId = optionalString(input.optionId);
    if (!optionId) return { ok: false, error: "缺少 optionId（来自 home_service.search 的套餐 id）" };

    const confirm = input.confirm === true;
    const confirmationToken = optionalString(input.confirmationToken);
    if (confirm && !confirmationToken) {
      return { ok: false, error: "confirm=true 时必须提供 confirmationToken（来自阶段一）" };
    }

    return service.book(context, "home_service", {
      provider: optionalString(input.provider),
      optionId,
      params: {
        serviceType: serviceType.value,
        address: optionalString(input.address) ?? "",
      },
      city: optionalString(input.city),
      scheduleAt: optionalString(input.scheduleAt) ?? null,
      confirm,
      confirmationToken,
    });
  };
}

/** home_service.status —— 订单状态。 */
export function createHomeServiceStatusHandler(service: BookingService): ToolHandler {
  return async (input: Record<string, unknown>, context: ToolContext) => {
    return service.getStatus(context, "home_service", optionalString(input.orderId));
  };
}

/** home_service.reschedule —— 改期。 */
export function createHomeServiceRescheduleHandler(service: BookingService): ToolHandler {
  return async (input: Record<string, unknown>, context: ToolContext) => {
    const orderId = optionalString(input.orderId);
    const scheduleAt = optionalString(input.scheduleAt);
    if (!orderId) return { ok: false, error: "缺少 orderId" };
    if (!scheduleAt) return { ok: false, error: "缺少 scheduleAt（新上门时间，ISO）" };
    return service.reschedule(context, "home_service", orderId, scheduleAt);
  };
}

/** home_service.cancel —— 两阶段确认取消。 */
export function createHomeServiceCancelHandler(service: BookingService): ToolHandler {
  return async (input: Record<string, unknown>, context: ToolContext) => {
    const orderId = optionalString(input.orderId);
    if (!orderId) return { ok: false, error: "缺少 orderId（要取消的订单号）" };
    const confirm = input.confirm === true;
    const confirmationToken = optionalString(input.confirmationToken);
    if (confirm && !confirmationToken) {
      return { ok: false, error: "confirm=true 时必须提供 confirmationToken（来自阶段一）" };
    }
    return service.cancel(context, "home_service", orderId, confirm, confirmationToken, optionalString(input.reason));
  };
}

/** 注册 home-services 全部工具到 ToolRegistry。 */
export function registerHomeServicesTools(registry: ToolRegistry, deps: HomeServicesModuleDeps): void {
  const { bookingService } = deps;
  registry.register("home_service.search", createHomeServiceSearchHandler(bookingService));
  registry.register("home_service.book", createHomeServiceBookHandler(bookingService));
  registry.register("home_service.status", createHomeServiceStatusHandler(bookingService));
  registry.register("home_service.reschedule", createHomeServiceRescheduleHandler(bookingService));
  registry.register("home_service.cancel", createHomeServiceCancelHandler(bookingService));
}
