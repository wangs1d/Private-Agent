function parsePaymentMode(raw: string | undefined): "live" | "mock" {
  if (!raw) return "mock";
  const v = raw.trim().toLowerCase();
  if (v === "live" || v === "sandbox") return "live";
  return "mock";
}

export interface PaymentConfig {
  wechatMode: "live" | "mock";
  wechatAppId: string;
  wechatMchId: string;
  wechatApiKey: string;
  wechatPrivateKey: string;
  wechatCertSerialNo: string;
  alipayMode: "live" | "mock";
  alipayAppId: string;
  alipayPrivateKey: string;
  alipayPublicKey: string;
  alipayGatewayUrl: string;
  paymentNotifyBaseUrl: string;
}

export function getPaymentConfig(env: NodeJS.ProcessEnv = process.env): PaymentConfig {
  return {
    wechatMode: parsePaymentMode(env.WECHAT_PAY_MODE),
    wechatAppId: env.WECHAT_PAY_APP_ID?.trim() || "",
    wechatMchId: env.WECHAT_PAY_MCH_ID?.trim() || "",
    wechatApiKey: env.WECHAT_PAY_API_KEY?.trim() || "",
    wechatPrivateKey: env.WECHAT_PAY_PRIVATE_KEY?.trim() || "",
    wechatCertSerialNo: env.WECHAT_PAY_CERT_SERIAL_NO?.trim() || "",
    alipayMode: parsePaymentMode(env.ALIPAY_MODE),
    alipayAppId: env.ALIPAY_APP_ID?.trim() || "",
    alipayPrivateKey: env.ALIPAY_PRIVATE_KEY?.trim() || "",
    alipayPublicKey: env.ALIPAY_PUBLIC_KEY?.trim() || "",
    alipayGatewayUrl: env.ALIPAY_GATEWAY_URL?.trim() || "https://openapi.alipay.com/gateway.do",
    paymentNotifyBaseUrl: env.PAYMENT_NOTIFY_BASE_URL?.trim() || "",
  };
}

/**
 * 支付护栏（用户可见的硬性边界，PaymentService.createOrder 入口强制执行）：
 * - 单笔上限 / 当日累计上限：0 = 不限；默认开启，防 Agent 失控下单。
 * - 类别授权：只放行列出的业务类别（"*" = 全部），未授权时 Agent 必须先问用户。
 * 差旅订票链路另有独立限额（BOOKING_MAX_AMOUNT_CNY / BOOKING_DAILY_BUDGET_CNY），
 * 两层护栏互不替代。
 */
export interface PaymentGuardrailConfig {
  maxSingleAmountCny: number;
  dailyBudgetCny: number;
  /** 允许代付的业务类别；["*"] = 全部允许 */
  allowedCategories: string[];
}

function readAmountEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw.trim());
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function getPaymentGuardrailConfig(env: NodeJS.ProcessEnv = process.env): PaymentGuardrailConfig {
  const rawCategories = env.PAYMENT_ALLOWED_CATEGORIES?.trim() ?? "";
  const allowedCategories =
    rawCategories === "" || rawCategories === "*"
      ? ["*"]
      : rawCategories
          .split(/[,，]/)
          .map((s) => s.trim())
          .filter(Boolean);
  return {
    maxSingleAmountCny: readAmountEnv(env.PAYMENT_MAX_SINGLE_CNY, 1000),
    dailyBudgetCny: readAmountEnv(env.PAYMENT_DAILY_BUDGET_CNY, 3000),
    allowedCategories,
  };
}
