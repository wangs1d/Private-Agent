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
