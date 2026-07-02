import crypto from "node:crypto";
import { getPaymentConfig, type PaymentConfig } from "../config/payment-config.js";

export interface PaymentOrderRequest {
  amount: number;
  description: string;
  outTradeNo?: string;
  provider: "wechat" | "alipay";
  method: "native" | "h5";
  notifyUrl?: string;
  metadata?: Record<string, string>;
}

export interface PaymentOrderResult {
  ok: boolean;
  outTradeNo: string;
  provider: string;
  method: string;
  amount: number;
  description: string;
  qrCodeDataUrl?: string;
  qrCodeText?: string;
  payUrl?: string;
  status: "pending" | "paid" | "closed" | "error";
  createdAt: string;
  rawResponse?: unknown;
  error?: string;
}

export interface PaymentQueryResult {
  ok: boolean;
  outTradeNo: string;
  provider: string;
  tradeState: string;
  tradeStateDesc: string;
  amount: number;
  payerInfo?: string;
  payTime?: string;
  rawResponse?: unknown;
  error?: string;
}

function generateOutTradeNo(): string {
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(6).toString("hex");
  return `PAY${ts}${rand}`.toUpperCase().slice(0, 32);
}

function sha256(data: string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function hmacSha256(key: string, data: string): string {
  return crypto.createHmac("sha256", key).update(data).digest("hex");
}

function rsaSha256Sign(data: string, privateKeyPem: string): string {
  const sign = crypto.createSign("RSA-SHA256");
  sign.update(data);
  sign.end();
  return sign.sign(privateKeyPem, "base64");
}

function rsaSha256Verify(data: string, signature: string, publicKeyPem: string): boolean {
  const verify = crypto.createVerify("RSA-SHA256");
  verify.update(data);
  verify.end();
  return verify.verify(publicKeyPem, signature, "base64");
}

export class PaymentService {
  private config: PaymentConfig;
  private mockOrders: Map<string, PaymentOrderResult>;

  constructor() {
    this.config = getPaymentConfig();
    this.mockOrders = new Map();
  }

  private wechatMode(): "live" | "mock" {
    return this.config.wechatMode;
  }

  private alipayMode(): "live" | "mock" {
    return this.config.alipayMode;
  }

  private wechatCredentialsAvailable(): boolean {
    return Boolean(
      this.config.wechatAppId &&
      this.config.wechatMchId &&
      this.config.wechatApiKey
    );
  }

  private alipayCredentialsAvailable(): boolean {
    return Boolean(
      this.config.alipayAppId &&
      this.config.alipayPrivateKey
    );
  }

  async createOrder(req: PaymentOrderRequest): Promise<PaymentOrderResult> {
    if (req.amount <= 0) {
      return {
        ok: false,
        outTradeNo: "",
        provider: req.provider,
        method: req.method,
        amount: req.amount,
        description: req.description,
        status: "error",
        createdAt: new Date().toISOString(),
        error: "金额必须大于 0",
      };
    }

    const outTradeNo = req.outTradeNo || generateOutTradeNo();

    if (req.provider === "wechat") {
      return this.createWechatOrder(req, outTradeNo);
    }
    if (req.provider === "alipay") {
      return this.createAlipayOrder(req, outTradeNo);
    }

    return {
      ok: false,
      outTradeNo,
      provider: req.provider,
      method: req.method,
      amount: req.amount,
      description: req.description,
      status: "error",
      createdAt: new Date().toISOString(),
      error: `不支持的支付提供商：${req.provider}`,
    };
  }

  private async createWechatOrder(
    req: PaymentOrderRequest,
    outTradeNo: string
  ): Promise<PaymentOrderResult> {
    if (this.wechatMode() === "mock" || !this.wechatCredentialsAvailable()) {
      return this.createWechatMockOrder(req, outTradeNo);
    }

    try {
      return await this.createWechatLiveOrder(req, outTradeNo);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        outTradeNo,
        provider: "wechat",
        method: req.method,
        amount: req.amount,
        description: req.description,
        status: "error",
        createdAt: new Date().toISOString(),
        error: `微信支付下单失败：${message}`,
      };
    }
  }

  private async createWechatLiveOrder(
    req: PaymentOrderRequest,
    outTradeNo: string
  ): Promise<PaymentOrderResult> {
    const { wechatAppId, wechatMchId, wechatApiKey } = this.config;

    const body = {
      appid: wechatAppId,
      mchid: wechatMchId,
      description: req.description.slice(0, 127),
      out_trade_no: outTradeNo,
      notify_url: req.notifyUrl || "",
      amount: {
        total: Math.round(req.amount * 100),
        currency: "CNY",
      },
      ...(req.metadata ? { attach: JSON.stringify(req.metadata) } : {}),
    };

    const bodyStr = JSON.stringify(body);
    const nonceStr = crypto.randomBytes(16).toString("hex");
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = this.wechatV3Sign("POST", "/v3/pay/transactions/native", timestamp, nonceStr, bodyStr);

    const response = await fetch("https://api.mch.weixin.qq.com/v3/pay/transactions/native", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": `WECHATPAY2-SHA256-RSA2048 mchid="${wechatMchId}",nonce_str="${nonceStr}",signature="${signature}",timestamp="${timestamp}",serial_no="${this.config.wechatCertSerialNo || ""}"`,
      },
      body: bodyStr,
    });

    if (!response.ok) {
      const errBody = await response.text();
      throw new Error(`HTTP ${response.status}: ${errBody}`);
    }

    const result = await response.json() as Record<string, unknown>;

    return {
      ok: true,
      outTradeNo,
      provider: "wechat",
      method: "native",
      amount: req.amount,
      description: req.description,
      qrCodeText: result.code_url as string,
      payUrl: result.code_url as string,
      status: "pending",
      createdAt: new Date().toISOString(),
      rawResponse: result,
    };
  }

  private wechatV3Sign(
    method: string,
    path: string,
    timestamp: string,
    nonceStr: string,
    body: string
  ): string {
    const message = `${method}\n${path}\n${timestamp}\n${nonceStr}\n${body}\n`;
    return rsaSha256Sign(message, this.config.wechatPrivateKey || "");
  }

  private createWechatMockOrder(
    req: PaymentOrderRequest,
    outTradeNo: string
  ): PaymentOrderResult {
    const result: PaymentOrderResult = {
      ok: true,
      outTradeNo,
      provider: "wechat",
      method: req.method,
      amount: req.amount,
      description: req.description,
      qrCodeText: `weixin://wxpay/bizpayurl?pr=${outTradeNo}`,
      payUrl: `https://mock-pay.local/wechat/${outTradeNo}`,
      status: "pending",
      createdAt: new Date().toISOString(),
    };

    this.mockOrders.set(outTradeNo, result);
    return result;
  }

  private async createAlipayOrder(
    req: PaymentOrderRequest,
    outTradeNo: string
  ): Promise<PaymentOrderResult> {
    if (this.alipayMode() === "mock" || !this.alipayCredentialsAvailable()) {
      return this.createAlipayMockOrder(req, outTradeNo);
    }

    try {
      return await this.createAlipayLiveOrder(req, outTradeNo);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        outTradeNo,
        provider: "alipay",
        method: req.method,
        amount: req.amount,
        description: req.description,
        status: "error",
        createdAt: new Date().toISOString(),
        error: `支付宝下单失败：${message}`,
      };
    }
  }

  private async createAlipayLiveOrder(
    req: PaymentOrderRequest,
    outTradeNo: string
  ): Promise<PaymentOrderResult> {
    const { alipayAppId, alipayPrivateKey, alipayGatewayUrl } = this.config;

    const bizContent = JSON.stringify({
      out_trade_no: outTradeNo,
      total_amount: req.amount.toFixed(2),
      subject: req.description.slice(0, 256),
      product_code: "FACE_TO_FACE_PAYMENT",
      ...(req.metadata ? { passback_params: encodeURIComponent(JSON.stringify(req.metadata)) } : {}),
    });

    const params: Record<string, string> = {
      app_id: alipayAppId || "",
      method: req.method === "h5" ? "alipay.trade.page.pay" : "alipay.trade.precreate",
      charset: "utf-8",
      sign_type: "RSA2",
      timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "+08:00"),
      version: "1.0",
      biz_content: bizContent,
      ...(req.notifyUrl ? { notify_url: req.notifyUrl } : {}),
    };

    const signStr = this.alipayBuildSignStr(params);
    params.sign = rsaSha256Sign(signStr, alipayPrivateKey || "");

    const gateway = alipayGatewayUrl || "https://openapi.alipay.com/gateway.do";
    const formBody = new URLSearchParams(params).toString();

    const response = await fetch(gateway, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
      },
      body: formBody,
    });

    const responseText = await response.text();
    const responseData = Object.fromEntries(new URLSearchParams(responseText));
    const responseJson = JSON.parse(
      (responseData.alipay_trade_precreate_response || responseData.alipay_trade_page_pay_response || "{}") as string
    ) as Record<string, unknown>;

    if (responseJson.code !== "10000") {
      throw new Error(`${responseJson.sub_msg || responseJson.msg || "未知错误"}`);
    }

    return {
      ok: true,
      outTradeNo,
      provider: "alipay",
      method: req.method,
      amount: req.amount,
      description: req.description,
      qrCodeText: responseJson.qr_code as string,
      payUrl: responseJson.qr_code as string,
      status: "pending",
      createdAt: new Date().toISOString(),
      rawResponse: responseJson,
    };
  }

  private alipayBuildSignStr(params: Record<string, string>): string {
    const excludeKeys = new Set(["sign", "sign_type"]);
    const sorted = Object.keys(params)
      .filter((k) => !excludeKeys.has(k) && params[k] !== undefined && params[k] !== "")
      .sort();
    return sorted.map((k) => `${k}=${params[k]}`).join("&");
  }

  private createAlipayMockOrder(
    req: PaymentOrderRequest,
    outTradeNo: string
  ): PaymentOrderResult {
    const result: PaymentOrderResult = {
      ok: true,
      outTradeNo,
      provider: "alipay",
      method: req.method,
      amount: req.amount,
      description: req.description,
      qrCodeText: `https://mock-pay.local/alipay/${outTradeNo}`,
      payUrl: `https://mock-pay.local/alipay/${outTradeNo}`,
      status: "pending",
      createdAt: new Date().toISOString(),
    };

    this.mockOrders.set(outTradeNo, result);
    return result;
  }

  async queryOrder(outTradeNo: string, provider: "wechat" | "alipay"): Promise<PaymentQueryResult> {
    const mockOrder = this.mockOrders.get(outTradeNo);
    if (mockOrder) {
      if (mockOrder.status === "paid") {
        return {
          ok: true,
          outTradeNo,
          provider,
          tradeState: provider === "alipay" ? "TRADE_SUCCESS" : "SUCCESS",
          tradeStateDesc: "支付成功",
          amount: mockOrder.amount,
          payTime: new Date().toISOString(),
        };
      }
      if (mockOrder.status === "closed") {
        return {
          ok: true,
          outTradeNo,
          provider,
          tradeState: provider === "alipay" ? "TRADE_CLOSED" : "CLOSED",
          tradeStateDesc: "已关闭",
          amount: mockOrder.amount,
        };
      }
      return {
        ok: true,
        outTradeNo,
        provider,
        tradeState: provider === "alipay" ? "WAIT_BUYER_PAY" : "NOTPAY",
        tradeStateDesc: "待支付",
        amount: mockOrder.amount,
      };
    }

    if (provider === "wechat") {
      return this.queryWechatOrder(outTradeNo);
    }
    return this.queryAlipayOrder(outTradeNo);
  }

  private async queryWechatOrder(outTradeNo: string): Promise<PaymentQueryResult> {
    if (this.wechatMode() === "mock" || !this.wechatCredentialsAvailable()) {
      return {
        ok: true,
        outTradeNo,
        provider: "wechat",
        tradeState: "NOTPAY",
        tradeStateDesc: "待支付（模拟模式）",
        amount: 0,
      };
    }

    try {
      const { wechatMchId } = this.config;
      const path = `/v3/pay/transactions/out-trade-no/${outTradeNo}?mchid=${wechatMchId}`;
      const nonceStr = crypto.randomBytes(16).toString("hex");
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const signature = this.wechatV3Sign("GET", path, timestamp, nonceStr, "");

      const response = await fetch(`https://api.mch.weixin.qq.com${path}`, {
        method: "GET",
        headers: {
          "Accept": "application/json",
          "Authorization": `WECHATPAY2-SHA256-RSA2048 mchid="${wechatMchId}",nonce_str="${nonceStr}",signature="${signature}",timestamp="${timestamp}",serial_no="${this.config.wechatCertSerialNo || ""}"`,
        },
      });

      if (!response.ok) {
        const errBody = await response.text();
        throw new Error(`HTTP ${response.status}: ${errBody}`);
      }

      const result = await response.json() as Record<string, unknown>;
      const tradeState = result.trade_state as string;
      const tradeStateMap: Record<string, string> = {
        SUCCESS: "支付成功",
        REFUND: "转入退款",
        NOTPAY: "未支付",
        CLOSED: "已关闭",
        REVOKED: "已撤销",
        USERPAYING: "用户支付中",
        PAYERROR: "支付失败",
      };

      return {
        ok: true,
        outTradeNo,
        provider: "wechat",
        tradeState,
        tradeStateDesc: tradeStateMap[tradeState] || tradeState,
        amount: (result.amount as Record<string, unknown>)?.total as number / 100 || 0,
        payerInfo: (result.payer as Record<string, unknown>)?.openid as string,
        payTime: result.success_time as string,
        rawResponse: result,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        outTradeNo,
        provider: "wechat",
        tradeState: "ERROR",
        tradeStateDesc: "查询失败",
        amount: 0,
        error: message,
      };
    }
  }

  private async queryAlipayOrder(outTradeNo: string): Promise<PaymentQueryResult> {
    if (this.alipayMode() === "mock" || !this.alipayCredentialsAvailable()) {
      return {
        ok: true,
        outTradeNo,
        provider: "alipay",
        tradeState: "WAIT_BUYER_PAY",
        tradeStateDesc: "待支付（模拟模式）",
        amount: 0,
      };
    }

    try {
      const { alipayAppId, alipayPrivateKey, alipayGatewayUrl } = this.config;

      const bizContent = JSON.stringify({ out_trade_no: outTradeNo });
      const params: Record<string, string> = {
        app_id: alipayAppId || "",
        method: "alipay.trade.query",
        charset: "utf-8",
        sign_type: "RSA2",
        timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "+08:00"),
        version: "1.0",
        biz_content: bizContent,
      };

      const signStr = this.alipayBuildSignStr(params);
      params.sign = rsaSha256Sign(signStr, alipayPrivateKey || "");

      const gateway = alipayGatewayUrl || "https://openapi.alipay.com/gateway.do";
      const formBody = new URLSearchParams(params).toString();

      const response = await fetch(gateway, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8" },
        body: formBody,
      });

      const responseText = await response.text();
      const responseData = Object.fromEntries(new URLSearchParams(responseText));
      const responseJson = JSON.parse(
        (responseData.alipay_trade_query_response || "{}") as string
      ) as Record<string, unknown>;

      if (responseJson.code !== "10000") {
        throw new Error(`${responseJson.sub_msg || responseJson.msg || "未知错误"}`);
      }

      const tradeState = responseJson.trade_status as string;
      const tradeStateMap: Record<string, string> = {
        WAIT_BUYER_PAY: "交易创建，等待买家付款",
        TRADE_CLOSED: "未付款交易超时关闭",
        TRADE_SUCCESS: "交易支付成功",
        TRADE_FINISHED: "交易结束，不可退款",
      };

      return {
        ok: true,
        outTradeNo,
        provider: "alipay",
        tradeState,
        tradeStateDesc: tradeStateMap[tradeState] || tradeState,
        amount: parseFloat((responseJson.total_amount as string) || "0"),
        payerInfo: (responseJson.buyer_logon_id as string),
        payTime: (responseJson.send_pay_date as string),
        rawResponse: responseJson,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        outTradeNo,
        provider: "alipay",
        tradeState: "ERROR",
        tradeStateDesc: "查询失败",
        amount: 0,
        error: message,
      };
    }
  }

  mockCompletePayment(outTradeNo: string): boolean {
    const order = this.mockOrders.get(outTradeNo);
    if (!order) return false;
    order.status = "paid";
    this.mockOrders.set(outTradeNo, order);
    return true;
  }

  mockClosePayment(outTradeNo: string): boolean {
    const order = this.mockOrders.get(outTradeNo);
    if (!order) return false;
    order.status = "closed";
    this.mockOrders.set(outTradeNo, order);
    return true;
  }

  getMockOrders(): PaymentOrderResult[] {
    return Array.from(this.mockOrders.values());
  }
}

let sharedPaymentService: PaymentService | null = null;

export function getSharedPaymentService(): PaymentService {
  if (!sharedPaymentService) {
    sharedPaymentService = new PaymentService();
  }
  return sharedPaymentService;
}

export function setSharedPaymentService(service: PaymentService): void {
  sharedPaymentService = service;
}
