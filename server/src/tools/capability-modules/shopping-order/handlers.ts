import type { ToolHandler, ToolContext, ToolRegistry } from "../../tool-registry.js";
import type { ShoppingOrderService } from "../../../services/shopping-order-service.js";
import type { SearchFilters } from "../../../services/shopping-platforms/index.js";

/**
 * shopping.order.* 工具 handler 工厂集合 + 注册入口。
 *
 * 每个 handler 调用 {@link ShoppingOrderService} 对应方法，统一返回：
 *   - 成功：`{ ok: true, ..., summary: string }`
 *   - 失败：`{ ok: false, error: string, retryable?: boolean }`
 *
 * 访问模式：本模块**在沙箱模式下也可运行**，不强制要求「完全访问」。
 * 安全护栏由以下机制独立保障（不依赖 agentAccessMode）：
 *   1. Cookie 双重门禁：用户须先导入平台 Cookie 并显式授权 agentAllowed=true
 *   2. 两阶段确认：place / cancel 须先生成 token，用户确认后带 token 执行
 *   3. 金额上限：SHOPPING_ORDER_MAX_AMOUNT_CNY（默认 5000）超阈值拒绝提交
 *   4. 平台白名单：未实现 adapter 的平台直接拒绝
 *   5. 审计日志：所有操作记录到 audit-service
 *
 * 注册入口见本文件 {@link registerShoppingOrderTools}，由 `./index.ts` 的
 * CapabilityModule.register 闭包调用。
 */

/** shopping-order 模块依赖（局部类型，避免修改全局 CapabilityModuleDeps）。 */
export interface ShoppingOrderModuleDeps {
  shoppingOrderService: ShoppingOrderService;
}

/** shopping.order.search —— 后台无头浏览器搜索商品。 */
export function createShoppingSearchHandler(
  service: ShoppingOrderService,
): ToolHandler {
  return async (input: Record<string, unknown>, context: ToolContext) => {
    const platform = typeof input.platform === "string" ? input.platform.trim() : "";
    const query = typeof input.query === "string" ? input.query.trim() : "";
    if (!platform) return { ok: false, error: "缺少 platform（目标购物平台）" };
    if (!query) return { ok: false, error: "缺少 query（搜索关键词）" };

    const filters: SearchFilters | undefined = input.filters && typeof input.filters === "object"
      ? {
          maxPrice: typeof (input.filters as Record<string, unknown>).maxPrice === "number"
            ? (input.filters as Record<string, unknown>).maxPrice as number
            : undefined,
          sort: typeof (input.filters as Record<string, unknown>).sort === "string"
            ? (input.filters as Record<string, unknown>).sort as SearchFilters["sort"]
            : undefined,
          limit: typeof (input.filters as Record<string, unknown>).limit === "number"
            ? (input.filters as Record<string, unknown>).limit as number
            : undefined,
        }
      : undefined;

    return service.searchProduct(context, platform, query, filters);
  };
}

/** shopping.order.place —— 两阶段确认下单。 */
export function createShoppingPlaceHandler(
  service: ShoppingOrderService,
): ToolHandler {
  return async (input: Record<string, unknown>, context: ToolContext) => {
    const platform = typeof input.platform === "string" ? input.platform.trim() : "";
    const item = typeof input.item === "string" ? input.item.trim() : "";
    if (!platform) return { ok: false, error: "缺少 platform（目标购物平台）" };
    if (!item) return { ok: false, error: "缺少 item（商品描述或 URL）" };

    const quantity = typeof input.quantity === "number" && Number.isFinite(input.quantity)
      ? Math.floor(input.quantity)
      : 1;
    const confirm = input.confirm === true;
    const confirmationToken = typeof input.confirmationToken === "string"
      ? input.confirmationToken.trim()
      : undefined;

    if (confirm && !confirmationToken) {
      return { ok: false, error: "confirm=true 时必须提供 confirmationToken（来自阶段一）" };
    }

    return service.placeOrder(context, platform, item, quantity, confirm, confirmationToken);
  };
}

/** shopping.order.track —— 查询订单状态/物流。 */
export function createShoppingTrackHandler(
  service: ShoppingOrderService,
): ToolHandler {
  return async (input: Record<string, unknown>, context: ToolContext) => {
    const platform = typeof input.platform === "string" ? input.platform.trim() : "";
    if (!platform) return { ok: false, error: "缺少 platform（目标购物平台）" };

    const orderId = typeof input.orderId === "string" && input.orderId.trim()
      ? input.orderId.trim()
      : undefined;

    return service.trackOrder(context, platform, orderId);
  };
}

/** shopping.order.cancel —— 两阶段确认取消订单。 */
export function createShoppingCancelHandler(
  service: ShoppingOrderService,
): ToolHandler {
  return async (input: Record<string, unknown>, context: ToolContext) => {
    const platform = typeof input.platform === "string" ? input.platform.trim() : "";
    const orderId = typeof input.orderId === "string" ? input.orderId.trim() : "";
    if (!platform) return { ok: false, error: "缺少 platform（目标购物平台）" };
    if (!orderId) return { ok: false, error: "缺少 orderId（要取消的订单号）" };

    const confirm = input.confirm === true;
    const confirmationToken = typeof input.confirmationToken === "string"
      ? input.confirmationToken.trim()
      : undefined;

    if (confirm && !confirmationToken) {
      return { ok: false, error: "confirm=true 时必须提供 confirmationToken（来自阶段一）" };
    }

    return service.cancelOrder(context, platform, orderId, confirm, confirmationToken);
  };
}

/**
 * 注册 shopping-order 全部工具到 ToolRegistry。
 *
 * 调用方：`capability-modules/index.ts` 的 `buildCapabilityModules` 闭包，
 * 最终由 `registerAllCapabilityModules` 在启动阶段统一调用。
 */
export function registerShoppingOrderTools(
  registry: ToolRegistry,
  deps: ShoppingOrderModuleDeps,
): void {
  const { shoppingOrderService } = deps;
  registry.register("shopping.order.search", createShoppingSearchHandler(shoppingOrderService));
  registry.register("shopping.order.place", createShoppingPlaceHandler(shoppingOrderService));
  registry.register("shopping.order.track", createShoppingTrackHandler(shoppingOrderService));
  registry.register("shopping.order.cancel", createShoppingCancelHandler(shoppingOrderService));
}
