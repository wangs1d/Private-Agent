/**
 * 内置 Skill：商家下单服务（支付宝官方「智能体接入」模式）。
 *
 * 在支付宝官方 merchant-guide 的框架下，补齐 agent 的「下单」能力：
 *   - alipay.merchant-list：列出已注册可下单的商家
 *   - alipay.merchant-order：按意图路由到商家 → 调用其下单接口 → 拿到 `alipay_` 支付短链
 *      → 引导 alipay.submit-payment 完成真实支付（官方核心原则：下单负责业务流程，支付技能负责支付）
 *
 * 商家目录由 MerchantOrderService 从 `data/merchants.json` 加载（真实商家数据按需接入）。
 */
import { resolveActorId } from "../../agent/actor-id.js";
import type { MerchantOrderService, PlaceOrderParams } from "../../services/merchant-order-service.js";
import type { SkillDefinition } from "../types.js";

type Deps = {
  merchantOrderService: MerchantOrderService;
};

export function createMerchantOrderBuiltinSkills(deps: Deps): SkillDefinition[] {
  const { merchantOrderService } = deps;

  /** 1. 列出可下单的商家 */
  const merchant_list: SkillDefinition = {
    metadata: {
      name: "alipay.merchant-list",
      version: "1.0.0",
      displayName: "列出可下单的商家",
      description:
        "列出当前已注册、可调用其下单接口的商家目录（含 id / 名称 / 分类 / 说明 / 标签）。" +
        "用户表达「帮我买xxx」「下单」「点外卖」「买奶茶」等购买意图、但不确定去哪个商家时，先调用本 skill 查看可选商家，" +
        "再结合 intent 用 alipay.merchant-order 路由到对应商家下单。",
      kind: "builtin",
      tags: ["alipay", "payment", "商家", "下单", "购买", "目录", "merchant"],
      icon: "🏪",
      parameters: [],
      outputSchema: {
        merchants: "商家列表 [{id,name,category,description,tags}]",
        count: "商家数量",
      },
      permissions: ["wallet:read"],
      timeoutMs: 10_000,
    },
    handler: async () => {
      const merchants = merchantOrderService.listMerchants();
      return {
        ok: true,
        count: merchants.length,
        merchants: merchants.map((m) => ({
          id: m.id,
          name: m.name,
          category: m.category,
          description: m.description,
          tags: m.tags,
        })),
        summary: merchants.length
          ? `当前可下单商家 ${merchants.length} 个：${merchants.map((m) => `${m.name}(${m.category})`).join("、")}`
          : "尚未注册任何可下单商家，请联系管理员接入商家数据",
      };
    },
  };

  /** 2. 按意图路由商家并下单，拿到 alipay_ 支付短链 */
  const merchant_order: SkillDefinition = {
    metadata: {
      name: "alipay.merchant-order",
      version: "1.0.0",
      displayName: "商家下单获取支付短链",
      description:
        "按用户购买意图路由到已注册商家，调用其下单接口生成支付宝订单，返回 `alipay_` 支付短链别名。" +
        "这是「直接发起购买」的下单环节：拿到短链后必须引导调用 alipay.submit-payment 完成真实支付" +
        "（sessionId 与 intentSummary 需一并传给支付技能；intentSummary 格式：服务内容：xxx，支付金额：¥xx，支付对象：<商家名>）。" +
        "参数：merchantId 与 intent 二选一（intent 为自然语言如「买杯奶茶」，服务端自动路由商家）；" +
        "params 为下单参数对象（如 {goods, spec, quantity, address}，替换进商家请求模板）。" +
        "若 intent 路由不到商家，返回可选商家列表供二次选择。",
      kind: "builtin",
      tags: ["alipay", "payment", "下单", "购买", "商家", "短链", "merchant", "order"],
      icon: "🛒",
      parameters: [
        { name: "merchantId", type: "string", required: false, description: "指定商家 id（与 intent 二选一，优先）" },
        { name: "intent", type: "string", required: false, description: "购买意图（自然语言），服务端按意图路由商家" },
        { name: "params", type: "object", required: false, description: "下单参数（如 goods/spec/quantity/address），替换进商家请求模板" },
        { name: "sessionId", type: "string", required: false, description: "业务会话 ID（默认取当前会话）" },
      ],
      outputSchema: {
        ok: "是否下单成功",
        merchant: "命中的商家 {id,name}",
        alias: "alipay_ 支付短链别名（供 alipay.submit-payment 使用）",
        paymentLink: "别名即支付链接，原样传给 submit-payment",
        error: "失败原因",
      },
      permissions: ["wallet:read", "wallet:write", "network:external"],
      timeoutMs: 20_000,
    },
    handler: async (input, context) => {
      const actorId = resolveActorId(context);
      const merchantId = typeof input.merchantId === "string" ? input.merchantId.trim() : "";
      const intent = typeof input.intent === "string" ? input.intent.trim() : "";
      const params = (typeof input.params === "object" && input.params !== null ? input.params : {}) as PlaceOrderParams;
      const sessionId = typeof input.sessionId === "string" && input.sessionId.trim()
        ? input.sessionId.trim()
        : context.sessionId;

      let targetId = merchantId;
      if (!targetId) {
        const routed = intent ? merchantOrderService.routeMerchant(intent) : undefined;
        if (!routed) {
          const available = merchantOrderService.listMerchants();
          return {
            ok: false,
            actorId,
            error: "未能按意图路由到商家",
            hint: available.length
              ? `可选商家：${available.map((m) => `${m.id}(${m.name})`).join("、")}，可先调 alipay.merchant-list 查看详情后指定 merchantId`
              : "尚未注册任何可下单商家，请先接入商家数据",
          };
        }
        targetId = routed.id;
      }

      const result = await merchantOrderService.placeOrder(actorId, sessionId, targetId, params);
      if (!result.ok) {
        return {
          ok: false,
          actorId,
          merchant: result.merchant ? { id: result.merchant.id, name: result.merchant.name } : undefined,
          error: result.error,
          stdout: result.stdout,
          hint: "下单失败。若为商家接口异常，请核对商家数据或稍后重试",
        };
      }
      const merchantName = result.merchant?.name ?? targetId;
      return {
        ok: true,
        actorId,
        merchant: result.merchant ? { id: result.merchant.id, name: merchantName } : { id: targetId, name: merchantName },
        alias: result.alias,
        paymentLink: result.alias,
        summary:
          `订单已生成（${merchantName}），支付宝支付短链已拿到。下一步：调用 alipay.submit-payment 完成支付——` +
          `paymentLink 传 ${result.alias}（完整保留，禁止截断/改写），` +
          `intentSummary 按格式「服务内容：${result.merchant?.description ?? merchantName}，支付金额：¥（按商家返回金额填写），支付对象：${merchantName}」。`,
      };
    },
  };

  return [merchant_list, merchant_order];
}

/**
 * 注册商家下单内置 Skills 到 SkillManager。
 */
export function registerMerchantOrderBuiltinSkills(
  register: (skill: SkillDefinition) => void,
  deps: Deps,
): void {
  for (const s of createMerchantOrderBuiltinSkills(deps)) {
    register(s);
  }
}
