/**
 * shared_browser 动作风险分级（确认门判定）。
 *
 * 分级结果由 coordinator 附在 shared.browser.invoke 下发（gate 字段），
 * 客户端据此弹确认条：用户「允许」才真正执行，拒绝/超时返回 denied。
 *
 * 分级策略（宁多勿漏，误拦成本只是一次点击确认）：
 *   - click 命中提交/支付/下单类文案 → high（任何站点）
 *   - 高风险域（电商/票务/支付）上的 click / submit 型输入 → high
 *   - 其余动作 → low（直接执行；read/get_state/scroll 天然只读）
 */

const HIGH_RISK_DOMAINS: readonly string[] = [
  "taobao.com", "tmall.com", "jd.com", "pinduoduo.com", "yangkeduo.com",
  "meituan.com", "dianping.com", "douyin.com", "kuaishou.com",
  "damai.cn", "damai.com", "ctrip.com", "trip.com", "qunar.com",
  "12306.cn", "alipay.com", "tenpay.com", "pay.weixin.qq.com",
  "ebay.com", "amazon.com", "booking.com", "airbnb.com",
];

const SUBMIT_KEYWORDS: readonly string[] = [
  "支付", "付款", "提交订单", "确认订单", "结算", "下单", "立即购买",
  "马上抢", "立即预订", "提交", "确认支付", "去支付", "checkout",
  "place order", "pay now", "submit order",
];

export interface SharedBrowserRiskAssessment {
  level: "low" | "high";
  /** high 时的原因（展示在客户端确认条上）。 */
  reason?: string;
  /** 目标摘要（点击文本/选择器/输入内容前缀，展示用）。 */
  targetSummary?: string;
}

export function classifySharedBrowserInvoke(
  action: string,
  params: Record<string, unknown>,
  context: { url?: string } = {},
): SharedBrowserRiskAssessment {
  // 只读动作永不设门
  if (action !== "click" && action !== "type") return { level: "low" };

  const url = String(context.url ?? "").toLowerCase();
  const domainHigh = HIGH_RISK_DOMAINS.some((d) => url.includes(d));

  if (action === "click") {
    const target = String(
      params.text ?? params.selector ?? (params.ref != null ? `元素#${params.ref}` : ""),
    ).slice(0, 60);
    const hit = SUBMIT_KEYWORDS.some((k) => target.toLowerCase().includes(k));
    if (hit) {
      return { level: "high", reason: "目标疑似提交/支付类操作", targetSummary: target };
    }
    if (domainHigh) {
      return { level: "high", reason: "高风险站点（电商/票务/支付）上的点击", targetSummary: target };
    }
    return { level: "low" };
  }

  // type：仅在 submit 型输入且高风险域时设门（普通填表不打扰）
  if (action === "type") {
    const target = String(params.text ?? "").slice(0, 60);
    if (params.submit === true && domainHigh) {
      return { level: "high", reason: "高风险站点上的回车提交", targetSummary: target };
    }
    return { level: "low" };
  }

  return { level: "low" };
}
