import { randomUUID } from "crypto";

import { resolveActorId } from "../agent/actor-id.js";
import type { AuditService } from "./audit-service.js";
import type { BrowserSessionService } from "./browser-session-service.js";
import type { BrowserSessionSiteId } from "./browser-session-sites.js";
import type { ImportedBrowserCookie } from "./browser-session-types.js";
import { getShoppingPlatformAdapter, listSupportedPlatforms } from "./shopping-platforms/index.js";
import type {
  CheckoutSnapshot,
  OrderStatus,
  ProductSummary,
  SearchFilters,
  ShoppingPlatformAdapter,
} from "./shopping-platforms/index.js";
import type { ToolContext } from "../tools/tool-registry.js";

/** 金额上限（CNY），结算页总价超此阈值拒绝提交。 */
function getMaxAmountCny(): number {
  const v = Number.parseInt(process.env.SHOPPING_ORDER_MAX_AMOUNT_CNY ?? "5000", 10);
  return Number.isFinite(v) && v > 0 ? v : 5000;
}

/** 确认 token TTL（毫秒）。 */
function getConfirmationTtlMs(): number {
  const v = Number.parseInt(process.env.SHOPPING_ORDER_CONFIRMATION_TTL_MS ?? "300000", 10);
  return Number.isFinite(v) && v > 0 ? v : 300_000;
}

/** 阶段一存活的 Playwright Page + 上下文，供阶段二复用。 */
interface ActiveSession {
  platform: string;
  actorId: string;
  item: string;
  quantity: number;
  snapshot: CheckoutSnapshot;
  // 持有 page 与 context 的关闭句柄
  close: () => Promise<void>;
  closed: boolean;
  expiresAt: number;
}

/** 两阶段确认的待确认记录。 */
interface PendingConfirmation {
  token: string;
  platform: string;
  actorId: string;
  item: string;
  quantity: number;
  snapshot: CheckoutSnapshot;
  session?: ActiveSession;
  expiresAt: number;
}

/** 服务返回的通用结构。 */
export type ShoppingOrderResult =
  | { ok: true; summary: string } & Record<string, unknown>
  | { ok: false; error: string; retryable?: boolean };

/** Playwright 动态加载（避免在未安装时启动失败）。 */
async function loadPlaywright(): Promise<typeof import("playwright") | null> {
  try {
    return await import("playwright");
  } catch {
    return null;
  }
}

/** 把 ImportedBrowserCookie 转成 Playwright addCookies 格式（参照 browser-page-fetch.ts）。 */
function toPlaywrightCookies(
  pageUrl: string,
  cookies: ImportedBrowserCookie[],
): Array<{
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}> {
  let defaultHost = "";
  try {
    defaultHost = new URL(pageUrl).hostname;
  } catch {
    /* ignore */
  }
  return cookies.map((c) => {
    const domain = (c.domain ?? defaultHost).replace(/^\./, "");
    const sameSite = normalizeSameSite(c.sameSite);
    return {
      name: c.name,
      value: c.value,
      domain: domain.startsWith(".") ? domain : `.${domain}`,
      path: c.path ?? "/",
      expires: c.expires,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite,
    };
  });
}

function normalizeSameSite(raw?: string): "Strict" | "Lax" | "None" | undefined {
  if (!raw) return undefined;
  const s = raw.toLowerCase();
  if (s === "strict") return "Strict";
  if (s === "lax") return "Lax";
  if (s === "none") return "None";
  return undefined;
}

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

/**
 * 购物/下单编排服务。
 *
 * 在服务端后台启动 Playwright 无头浏览器，注入用户预先导入并授权的 Cookie，
 * 驱动浏览器多步操作完成搜索/下单/查单/取消。
 *
 * 安全护栏：
 * - 复用 browser-session 双重门禁（有 Cookie 且 agentAllowed=true）
 * - 平台白名单（getAdapter 返回 null 即拒绝）
 * - 金额上限（SHOPPING_ORDER_MAX_AMOUNT_CNY 默认 5000）
 * - 两阶段确认 token 5 分钟 TTL
 * - 审计日志（每次操作落 AuditService）
 */
export class ShoppingOrderService {
  private readonly pendingConfirmations = new Map<string, PendingConfirmation>();
  /** 定期清理过期 token + 关闭存活 Page */
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly deps: {
      browserSessionService: BrowserSessionService;
      audit?: AuditService;
    },
  ) {
    // 每 60 秒清理一次过期确认 + 关闭存活 Page
    this.cleanupTimer = setInterval(() => this.cleanupExpired(), 60_000);
    this.cleanupTimer.unref?.();
  }

  /** 主动销毁：关闭所有存活 Page。 */
  async dispose(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    for (const pending of this.pendingConfirmations.values()) {
      if (pending.session && !pending.session.closed) {
        await pending.session.close().catch(() => {});
      }
    }
    this.pendingConfirmations.clear();
  }

  /** 列出已实现的平台（供 handler 做参数校验）。 */
  listSupportedPlatforms(): string[] {
    return listSupportedPlatforms();
  }

  async searchProduct(
    ctx: ToolContext,
    platform: string,
    query: string,
    filters?: SearchFilters,
  ): Promise<ShoppingOrderResult> {
    const actorId = resolveActorId(ctx);
    const adapter = this.requireAdapter(platform);
    if (!adapter) {
      return { ok: false, error: `平台「${platform}」暂不支持。已实现：${listSupportedPlatforms().join("/")}` };
    }
    const limit = Math.min(Math.max(filters?.limit ?? 5, 1), 10);

    const cookieResult = await this.getCookieAndSiteId(actorId, platform);
    if (!cookieResult.ok) return cookieResult;

    const pw = await loadPlaywright();
    if (!pw) {
      return {
        ok: false,
        error: "Playwright 未安装。请在 server 目录执行: npx playwright install chromium",
        retryable: false,
      };
    }

    const { chromium } = pw;
    const browser = await chromium.launch({
      headless: true,
      args: ["--disable-blink-features=AutomationControlled"],
    });
    try {
      const url = adapter.searchUrl(query, filters);
      const context = await browser.newContext({ userAgent: USER_AGENT, locale: "zh-CN" });
      await context.addCookies(toPlaywrightCookies(url, cookieResult.cookies));
      const page = await context.newPage();
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
      await page.waitForTimeout(3_000);

      const products = await adapter.extractProducts(page, limit);

      // 二次过滤：maxPrice
      const filtered = filters?.maxPrice
        ? products.filter((p) => p.price == null || p.price <= (filters.maxPrice as number))
        : products;

      await this.audit(ctx, "search", platform, { query, limit, resultCount: filtered.length });

      if (filtered.length === 0) {
        return {
          ok: true,
          summary: `在${platform}搜索「${query}」未找到商品（可能登录态失效或页面结构变更）`,
          products: [],
          platform,
          query,
          hint: "若无结果，请确认 Cookie 未过期且已授权 agentAllowed=true",
        };
      }

      return {
        ok: true,
        summary: `在${platform}搜索「${query}」找到 ${filtered.length} 个商品`,
        products: filtered,
        platform,
        query,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: `搜索失败：${message}${message.includes("Executable doesn't exist") ? "（请在 server 目录执行: npx playwright install chromium）" : ""}`,
        retryable: /timeout|navigation/i.test(message),
      };
    } finally {
      await browser.close().catch(() => {});
    }
  }

  async placeOrder(
    ctx: ToolContext,
    platform: string,
    item: string,
    quantity: number,
    confirm: boolean,
    confirmationToken?: string,
  ): Promise<ShoppingOrderResult> {
    const actorId = resolveActorId(ctx);

    // 阶段二：confirm=true + token
    if (confirm) {
      return this.executePlaceStage2(ctx, platform, confirmationToken);
    }

    // 阶段一：confirm=false
    return this.executePlaceStage1(ctx, platform, item, quantity);
  }

  private async executePlaceStage1(
    ctx: ToolContext,
    platform: string,
    item: string,
    quantity: number,
  ): Promise<ShoppingOrderResult> {
    const actorId = resolveActorId(ctx);
    const adapter = this.requireAdapter(platform);
    if (!adapter) {
      return { ok: false, error: `平台「${platform}」暂不支持。已实现：${listSupportedPlatforms().join("/")}` };
    }
    const qty = Math.min(Math.max(quantity, 1), 99);

    // item 可以是商品 URL 或关键词描述。
    // 若是 URL，直接作为 product.url；否则需要先搜索拿到 product。
    let product: ProductSummary;
    if (/^https?:\/\//i.test(item)) {
      product = { title: "用户指定商品", url: item };
    } else {
      // 先搜索找到第一个匹配商品
      const searchResult = await this.searchProduct(ctx, platform, item, { limit: 1 });
      if (!searchResult.ok) return searchResult;
      const products = (searchResult as { products?: ProductSummary[] }).products ?? [];
      if (products.length === 0) {
        return {
          ok: false,
          error: `在${platform}未找到「${item}」相关商品，无法下单`,
          retryable: true,
        };
      }
      product = products[0];
    }

    const cookieResult = await this.getCookieAndSiteId(actorId, platform);
    if (!cookieResult.ok) return cookieResult;

    const pw = await loadPlaywright();
    if (!pw) {
      return { ok: false, error: "Playwright 未安装。请在 server 目录执行: npx playwright install chromium", retryable: false };
    }

    const { chromium } = pw;
    const browser = await chromium.launch({
      headless: true,
      args: ["--disable-blink-features=AutomationControlled"],
    });
    try {
      const context = await browser.newContext({ userAgent: USER_AGENT, locale: "zh-CN" });
      const firstUrl = product.url ?? adapter.searchUrl(item);
      await context.addCookies(toPlaywrightCookies(firstUrl, cookieResult.cookies));
      const page = await context.newPage();

      const snapshot = await adapter.navigateToCheckout(page, product, qty);
      if (!snapshot.ok) {
        await context.close().catch(() => {});
        return { ok: false, error: snapshot.error ?? "走到结算页失败", retryable: snapshot.retryable };
      }

      // 金额上限校验
      if (snapshot.totalPrice != null && snapshot.totalPrice > getMaxAmountCny()) {
        await context.close().catch(() => {});
        await this.audit(ctx, "place_blocked_amount", platform, {
          item, quantity: qty, totalPrice: snapshot.totalPrice, limit: getMaxAmountCny(),
        });
        return {
          ok: false,
          error: `订单总价 ¥${snapshot.totalPrice} 超过上限 ¥${getMaxAmountCny()}，已拒绝提交。可调整 SHOPPING_ORDER_MAX_AMOUNT_CNY 环境变量。`,
          retryable: false,
        };
      }

      // 生成确认 token，保留存活 Page
      const token = randomUUID();
      const session: ActiveSession = {
        platform,
        actorId,
        item,
        quantity: qty,
        snapshot,
        closed: false,
        expiresAt: Date.now() + getConfirmationTtlMs(),
        close: async () => {
          if (session.closed) return;
          session.closed = true;
          await context.close().catch(() => {});
        },
      };
      const pending: PendingConfirmation = {
        token,
        platform,
        actorId,
        item,
        quantity: qty,
        snapshot,
        session,
        expiresAt: session.expiresAt,
      };
      this.pendingConfirmations.set(token, pending);

      await this.audit(ctx, "place_stage1", platform, {
        item, quantity: qty, totalPrice: snapshot.totalPrice, token,
      });

      const summaryParts: string[] = [
        `即将在${platform}下单`,
        snapshot.itemTitle ? `商品：${snapshot.itemTitle}` : "",
        `数量：${snapshot.quantity ?? qty}`,
        snapshot.totalPrice != null ? `总价：¥${snapshot.totalPrice}` : "",
        snapshot.addressSummary ? `收货：${snapshot.addressSummary}` : "",
      ].filter(Boolean);

      return {
        ok: true,
        summary: summaryParts.join("，"),
        needsConfirmation: true,
        confirmationToken: token,
        platform,
        itemTitle: snapshot.itemTitle,
        unitPrice: snapshot.unitPrice,
        quantity: snapshot.quantity,
        totalPrice: snapshot.totalPrice,
        currency: snapshot.currency,
        addressSummary: snapshot.addressSummary,
        screenshotBase64: snapshot.screenshotBase64,
        checkoutUrl: snapshot.checkoutUrl,
        expiresInMs: getConfirmationTtlMs(),
        hint: "请向用户复述上述摘要，得到明确同意后，带 confirm=true + confirmationToken 再调用本工具完成提交",
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `走到结算页失败：${message}`, retryable: /timeout|navigation/i.test(message) };
    }
    // 注意：阶段一不关闭 browser，由 session.close() 在阶段二/过期时关闭
  }

  private async executePlaceStage2(
    ctx: ToolContext,
    platform: string,
    confirmationToken?: string,
  ): Promise<ShoppingOrderResult> {
    if (!confirmationToken) {
      return { ok: false, error: "阶段二缺少 confirmationToken" };
    }
    const pending = this.pendingConfirmations.get(confirmationToken);
    if (!pending) {
      return { ok: false, error: "确认 token 无效或已过期，请重新发起下单（confirm=false）", retryable: true };
    }
    if (Date.now() > pending.expiresAt) {
      this.pendingConfirmations.delete(confirmationToken);
      if (pending.session && !pending.session.closed) {
        await pending.session.close().catch(() => {});
      }
      return { ok: false, error: "确认已过期，请重新发起下单（confirm=false）", retryable: true };
    }
    if (pending.platform !== platform) {
      return { ok: false, error: `平台不匹配：token 属于 ${pending.platform}，但请求平台为 ${platform}` };
    }

    const adapter = this.requireAdapter(platform);
    if (!adapter) {
      return { ok: false, error: `平台「${platform}」暂不支持` };
    }

    try {
      // 优先复用阶段一存活 Page
      let submitResult;
      if (pending.session && !pending.session.closed) {
        // 阶段一保留的 context 已关闭，但 Page 还在？实际上 context.close 会关闭 page。
        // 这里改为：阶段二重新启动浏览器注入 Cookie，重新走到结算页，再提交。
        // （保持简单：不复用 Page，因为 context/page 生命周期管理复杂，重建更稳）
        await pending.session.close().catch(() => {});
      }

      // 重建浏览器，重新走到结算页
      const cookieResult = await this.getCookieAndSiteId(pending.actorId, platform);
      if (!cookieResult.ok) {
        this.pendingConfirmations.delete(confirmationToken);
        return cookieResult;
      }

      const pw = await loadPlaywright();
      if (!pw) {
        return { ok: false, error: "Playwright 未安装", retryable: false };
      }

      const { chromium } = pw;
      const browser = await chromium.launch({
        headless: true,
        args: ["--disable-blink-features=AutomationControlled"],
      });
      try {
        const product: ProductSummary = {
          title: pending.snapshot.itemTitle ?? pending.item,
          url: pending.snapshot.checkoutUrl,
        };
        const context = await browser.newContext({ userAgent: USER_AGENT, locale: "zh-CN" });
        const firstUrl = product.url ?? adapter.searchUrl(pending.item);
        await context.addCookies(toPlaywrightCookies(firstUrl, cookieResult.cookies));
        const page = await context.newPage();

        // 若 checkoutUrl 存在且仍有效，直接 goto 结算页；否则重新走 navigateToCheckout
        if (pending.snapshot.checkoutUrl && /^https:\/\//i.test(pending.snapshot.checkoutUrl)) {
          await page.goto(pending.snapshot.checkoutUrl, { waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => {});
          await page.waitForTimeout(2_000);
        } else {
          const reSnap = await adapter.navigateToCheckout(page, product, pending.quantity);
          if (!reSnap.ok) {
            return { ok: false, error: reSnap.error ?? "重新走到结算页失败", retryable: reSnap.retryable };
          }
        }

        submitResult = await adapter.submitOrder(page);
      } finally {
        await browser.close().catch(() => {});
      }

      this.pendingConfirmations.delete(confirmationToken);

      await this.audit(ctx, "place_stage2", platform, {
        item: pending.item,
        quantity: pending.quantity,
        totalPrice: pending.snapshot.totalPrice,
        orderId: submitResult.orderId,
        ok: submitResult.ok,
      });

      if (!submitResult.ok) {
        return { ok: false, error: submitResult.error ?? "提交订单失败", retryable: submitResult.retryable };
      }

      return {
        ok: true,
        summary: `已在${platform}提交订单${submitResult.orderId ? `（订单号 ${submitResult.orderId}）` : ""}${submitResult.error ? `；${submitResult.error}` : ""}`,
        platform,
        orderId: submitResult.orderId,
        itemTitle: pending.snapshot.itemTitle,
        totalPrice: pending.snapshot.totalPrice,
        currency: pending.snapshot.currency,
        note: submitResult.error ?? "订单已提交。若需支付，请在客户端完成。",
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `提交订单失败：${message}`, retryable: /timeout|navigation/i.test(message) };
    }
  }

  async trackOrder(
    ctx: ToolContext,
    platform: string,
    orderId?: string,
  ): Promise<ShoppingOrderResult> {
    const actorId = resolveActorId(ctx);
    const adapter = this.requireAdapter(platform);
    if (!adapter) {
      return { ok: false, error: `平台「${platform}」暂不支持。已实现：${listSupportedPlatforms().join("/")}` };
    }

    const cookieResult = await this.getCookieAndSiteId(actorId, platform);
    if (!cookieResult.ok) return cookieResult;

    const pw = await loadPlaywright();
    if (!pw) {
      return { ok: false, error: "Playwright 未安装。请在 server 目录执行: npx playwright install chromium", retryable: false };
    }

    const { chromium } = pw;
    const browser = await chromium.launch({
      headless: true,
      args: ["--disable-blink-features=AutomationControlled"],
    });
    try {
      const url = adapter.orderListUrl();
      const context = await browser.newContext({ userAgent: USER_AGENT, locale: "zh-CN" });
      await context.addCookies(toPlaywrightCookies(url, cookieResult.cookies));
      const page = await context.newPage();
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
      await page.waitForTimeout(3_000);

      const orders: OrderStatus[] = await adapter.readOrderStatus(page, orderId);

      await this.audit(ctx, "track", platform, { orderId, resultCount: orders.length });

      if (orders.length === 0) {
        return {
          ok: true,
          summary: orderId ? `未在${platform}找到订单 ${orderId}` : `在${platform}未找到订单`,
          orders: [],
          platform,
        };
      }

      return {
        ok: true,
        summary: `查询到 ${orders.length} 个${platform}订单`,
        orders,
        platform,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `查询订单失败：${message}`, retryable: /timeout|navigation/i.test(message) };
    } finally {
      await browser.close().catch(() => {});
    }
  }

  async cancelOrder(
    ctx: ToolContext,
    platform: string,
    orderId: string,
    confirm: boolean,
    confirmationToken?: string,
  ): Promise<ShoppingOrderResult> {
    const actorId = resolveActorId(ctx);

    // 阶段二
    if (confirm) {
      const pending = confirmationToken ? this.pendingConfirmations.get(confirmationToken) : null;
      if (!pending) {
        return { ok: false, error: "取消确认 token 无效或已过期，请重新发起取消（confirm=false）", retryable: true };
      }
      if (Date.now() > pending.expiresAt) {
        this.pendingConfirmations.delete(confirmationToken!);
        if (pending.session && !pending.session.closed) await pending.session.close().catch(() => {});
        return { ok: false, error: "确认已过期，请重新发起取消", retryable: true };
      }
      // 取消不需要保留 Page，直接执行
      this.pendingConfirmations.delete(confirmationToken!);
      return this.executeCancel(ctx, platform, orderId);
    }

    // 阶段一：生成 token 返回确认摘要
    const token = randomUUID();
    this.pendingConfirmations.set(token, {
      token,
      platform,
      actorId,
      item: orderId,
      quantity: 1,
      snapshot: { ok: true, itemTitle: orderId },
      expiresAt: Date.now() + getConfirmationTtlMs(),
    });

    await this.audit(ctx, "cancel_stage1", platform, { orderId, token });

    return {
      ok: true,
      summary: `即将在${platform}取消订单 ${orderId}`,
      needsConfirmation: true,
      confirmationToken: token,
      platform,
      orderId,
      expiresInMs: getConfirmationTtlMs(),
      hint: "请向用户确认后，带 confirm=true + confirmationToken 再调用本工具完成取消",
    };
  }

  private async executeCancel(
    ctx: ToolContext,
    platform: string,
    orderId: string,
  ): Promise<ShoppingOrderResult> {
    const actorId = resolveActorId(ctx);
    const adapter = this.requireAdapter(platform);
    if (!adapter) return { ok: false, error: `平台「${platform}」暂不支持` };

    const cookieResult = await this.getCookieAndSiteId(actorId, platform);
    if (!cookieResult.ok) return cookieResult;

    const pw = await loadPlaywright();
    if (!pw) return { ok: false, error: "Playwright 未安装", retryable: false };

    const { chromium } = pw;
    const browser = await chromium.launch({
      headless: true,
      args: ["--disable-blink-features=AutomationControlled"],
    });
    try {
      const url = adapter.orderListUrl();
      const context = await browser.newContext({ userAgent: USER_AGENT, locale: "zh-CN" });
      await context.addCookies(toPlaywrightCookies(url, cookieResult.cookies));
      const page = await context.newPage();
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
      await page.waitForTimeout(3_000);

      const result = await adapter.cancelOrder(page, orderId);

      await this.audit(ctx, "cancel_stage2", platform, { orderId, ok: result.ok, error: result.error });

      if (!result.ok) {
        return { ok: false, error: result.error ?? "取消订单失败", retryable: result.retryable };
      }
      return {
        ok: true,
        summary: `已在${platform}取消订单 ${orderId}`,
        platform,
        orderId,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `取消订单失败：${message}`, retryable: /timeout|navigation/i.test(message) };
    } finally {
      await browser.close().catch(() => {});
    }
  }

  // ============ 内部工具 ============

  private requireAdapter(platform: string): ShoppingPlatformAdapter | null {
    return getShoppingPlatformAdapter(platform);
  }

  private async getCookieAndSiteId(
    actorId: string,
    platform: string,
  ): Promise<
    | { ok: true; cookies: ImportedBrowserCookie[]; siteId: BrowserSessionSiteId }
    | { ok: false; error: string; retryable?: boolean }
  > {
    // platform 与 siteId 同名（taobao/jd/meituan/tmall/...）
    const siteId = platform as BrowserSessionSiteId;
    try {
      const cookies = await this.deps.browserSessionService.getCookiesForAgent(actorId, siteId);
      if (cookies.length === 0) {
        return {
          ok: false,
          error: `未导入 ${platform} 的 Cookie。请先在客户端 POST /integrations/browser-sessions/import 导入，再 POST /consent 授权 agentAllowed=true`,
        };
      }
      return { ok: true, cookies, siteId };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        error: message.includes("未授权") || message.includes("agentAllowed")
          ? message
          : `获取 ${platform} Cookie 失败：${message}`,
      };
    }
  }

  private async audit(
    ctx: ToolContext,
    action: string,
    platform: string,
    extra: Record<string, unknown>,
  ): Promise<void> {
    if (!this.deps.audit) return;
    try {
      await this.deps.audit.record({
        ts: new Date().toISOString(),
        category: "shopping_order",
        action,
        platform,
        actorId: resolveActorId(ctx),
        sessionId: ctx.sessionId,
        chatUserMessageId: ctx.chatUserMessageId,
        ...extra,
      });
    } catch {
      /* 审计失败不影响主流程 */
    }
  }

  private cleanupExpired(): void {
    const now = Date.now();
    for (const [token, pending] of this.pendingConfirmations.entries()) {
      if (now > pending.expiresAt) {
        if (pending.session && !pending.session.closed) {
          pending.session.close().catch(() => {});
        }
        this.pendingConfirmations.delete(token);
      }
    }
  }
}
