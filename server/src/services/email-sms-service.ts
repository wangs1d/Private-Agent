import { createHmac, randomUUID } from "node:crypto";

import nodemailer, { type Transporter, type SendMailOptions } from "nodemailer";

/** nodemailer 附件类型（顶层未直接导出，从 SendMailOptions 派生以避免子路径导入兼容问题）。 */
type Attachment = NonNullable<NonNullable<SendMailOptions["attachments"]>>[number];

/**
 * 主动邮件 / 短信发送能力服务。
 *
 * 与 {@link EmailRegistrationService}（用户邮箱注册收件侧）互补：
 *   - 注册服务负责 inbound：分配 local@domain、解析入站邮件里的验证码
 *   - 本服务负责 outbound：通过 SMTP 主动发邮件 / 通过 SMS 网关主动发短信
 *
 * SMTP 客户端用 nodemailer；SMS 网关用阿里云短信 HTTP API（fetch 直调，不引入完整 SDK）。
 *
 * SMTP 凭证复用思路：与 inbound 邮件流同源，但走独立的 service 实例，
 * 不污染 {@link EmailRegistrationService} 的内存状态。
 *
 * 启用条件：
 *   - 邮件：`OUTBOUND_SMTP_HOST` + `OUTBOUND_SMTP_USER` + `OUTBOUND_SMTP_PASS` 三者齐备
 *   - 短信：`ALIYUN_SMS_ACCESS_KEY_ID` + `ALIYUN_SMS_ACCESS_KEY_SECRET` + 签名 + 模板 齐备
 *   - 任一未配置时 `isEmailEnabled()` / `isSmsEnabled()` 返回 false，工具层给出友好错误
 */

/** 邮件附件（结构对齐 nodemailer Attachment，但只暴露安全字段）。 */
export interface EmailSmsAttachment {
  /** 文件名，例如 "report.pdf" */
  filename: string;
  /** 本地文件绝对路径（与 content 二选一） */
  path?: string;
  /** base64 编码内容（与 path 二选一，不含 data: 前缀） */
  content?: string;
  /** MIME 类型，例如 "application/pdf"，未传时由 nodemailer 推断 */
  contentType?: string;
}

/** sendEmail 入参。 */
export interface SendEmailParams {
  to: string;
  subject: string;
  /** 纯文本正文（与 html 至少传一个） */
  body?: string;
  /** HTML 正文（可选，会覆盖 body 作为渲染主体） */
  html?: string;
  attachments?: EmailSmsAttachment[];
}

/** sendSms 入参。 */
export interface SendSmsParams {
  /** 手机号，国内 11 位或带国家码 +86138… */
  to: string;
  text: string;
  /** 可选模板变量（JSON 字符串）；未传时把 text 截断后塞入 ${content} 之类的占位需配合模板 */
  templateParams?: string;
}

export type SendEmailResult =
  | { ok: true; messageId: string; to: string; summary: string }
  | { ok: false; error: string; retryable?: boolean };

export type SendSmsResult =
  | { ok: true; messageId: string; to: string; bizId?: string; summary: string }
  | { ok: false; error: string; retryable?: boolean };

interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
}

interface AliyunSmsConfig {
  accessKeyId: string;
  accessKeySecret: string;
  signName: string;
  templateCode: string;
}

/** RFC3986 百分号编码（阿里云 RPC 签名专用，比 encodeURIComponent 多编 !*'()）。 */
function percentEncode(s: string): string {
  return encodeURIComponent(s)
    .replace(/!/g, "%21")
    .replace(/\*/g, "%2A")
    .replace(/'/g, "%27")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29");
}

/** 简单的手机号校验：允许 11 位国内号 / 带 + 的国际号。 */
function isValidPhoneNumber(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  return /^\+?\d{7,15}$/.test(t.replace(/[\s-]/g, ""));
}

/** 简单的邮箱地址校验。 */
function isValidEmail(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  // 允许 "Name <a@b>" 格式
  const addr = t.match(/<([^>]+@[^>]+)>/)?.[1] ?? t;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr);
}

export class EmailSmsService {
  private readonly smtpConfig: SmtpConfig | null;
  private readonly smsConfig: AliyunSmsConfig | null;
  private transporter: Transporter | null = null;

  constructor(opts: { smtp?: SmtpConfig; sms?: AliyunSmsConfig } = {}) {
    this.smtpConfig = opts.smtp ?? EmailSmsService.readSmtpConfigFromEnv();
    this.smsConfig = opts.sms ?? EmailSmsService.readSmsConfigFromEnv();
  }

  private static readSmtpConfigFromEnv(): SmtpConfig | null {
    const host = process.env.OUTBOUND_SMTP_HOST?.trim();
    const user = process.env.OUTBOUND_SMTP_USER?.trim();
    const pass = process.env.OUTBOUND_SMTP_PASS?.trim();
    if (!host || !user || !pass) return null;
    const port = Number(process.env.OUTBOUND_SMTP_PORT ?? 465);
    const secure = (process.env.OUTBOUND_SMTP_SECURE ?? "true").toLowerCase() !== "false";
    const from = process.env.OUTBOUND_SMTP_FROM?.trim() || user;
    return { host, port, secure, user, pass, from };
  }

  private static readSmsConfigFromEnv(): AliyunSmsConfig | null {
    const accessKeyId = process.env.ALIYUN_SMS_ACCESS_KEY_ID?.trim();
    const accessKeySecret = process.env.ALIYUN_SMS_ACCESS_KEY_SECRET?.trim();
    const signName = process.env.ALIYUN_SMS_SIGN_NAME?.trim();
    const templateCode = process.env.ALIYUN_SMS_TEMPLATE_CODE?.trim();
    if (!accessKeyId || !accessKeySecret || !signName || !templateCode) return null;
    return { accessKeyId, accessKeySecret, signName, templateCode };
  }

  /** 邮件能力是否启用（SMTP 凭证齐备）。 */
  isEmailEnabled(): boolean {
    return this.smtpConfig != null;
  }

  /** 短信能力是否启用（阿里云 SMS 凭证齐备）。 */
  isSmsEnabled(): boolean {
    return this.smsConfig != null;
  }

  /** 是否至少一个通道可用。 */
  isEnabled(): boolean {
    return this.isEmailEnabled() || this.isSmsEnabled();
  }

  /** 惰性创建 nodemailer transporter；多次调用幂等。 */
  private getTransporter(): Transporter {
    if (!this.smtpConfig) {
      throw new Error("SMTP 未配置：请设置 OUTBOUND_SMTP_HOST / OUTBOUND_SMTP_USER / OUTBOUND_SMTP_PASS");
    }
    if (!this.transporter) {
      this.transporter = nodemailer.createTransport({
        host: this.smtpConfig.host,
        port: this.smtpConfig.port,
        secure: this.smtpConfig.secure,
        auth: { user: this.smtpConfig.user, pass: this.smtpConfig.pass },
      });
    }
    return this.transporter;
  }

  /**
   * 通过 SMTP 主动发邮件。
   *
   * @returns 成功返回 messageId / 收件人 / 摘要；失败返回错误与是否可重试。
   */
  async sendEmail(params: SendEmailParams): Promise<SendEmailResult> {
    if (!this.isEmailEnabled()) {
      return {
        ok: false,
        error: "邮件发送未配置：服务端需设置 OUTBOUND_SMTP_HOST / OUTBOUND_SMTP_USER / OUTBOUND_SMTP_PASS / OUTBOUND_SMTP_FROM",
        retryable: false,
      };
    }
    const to = params.to.trim();
    if (!isValidEmail(to)) {
      return { ok: false, error: `收件人地址无效：${to}`, retryable: false };
    }
    const subject = params.subject.trim();
    if (!subject) {
      return { ok: false, error: "邮件 subject 不能为空", retryable: false };
    }
    const body = params.body?.trim() ?? "";
    const html = params.html?.trim() ?? "";
    if (!body && !html) {
      return { ok: false, error: "邮件正文不能为空（body 或 html 至少传一个）", retryable: false };
    }

    const attachments: Attachment[] | undefined = params.attachments?.length
      ? params.attachments.map((a) => ({
          filename: a.filename,
          path: a.path,
          content: a.content ? Buffer.from(a.content, "base64") : undefined,
          contentType: a.contentType,
        }))
      : undefined;

    const mailOptions: SendMailOptions = {
      from: this.smtpConfig!.from,
      to,
      subject,
      text: body || undefined,
      html: html || undefined,
      attachments,
    };

    try {
      const info = await this.getTransporter().sendMail(mailOptions);
      const attachmentNote = attachments?.length ? `（含 ${attachments.length} 个附件）` : "";
      return {
        ok: true,
        messageId: info.messageId,
        to,
        summary: `已发送邮件到 ${to}：${subject}${attachmentNote}`,
      };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      // 网络层 / SMTP 暂时性错误通常可重试；认证 / 地址错误不可重试
      const retryable = /timeout|connect|network|ECONNREFUSED|ETIMEDOUT/i.test(error);
      return { ok: false, error, retryable };
    }
  }

  /**
   * 通过阿里云短信 HTTP API 主动发短信。
   *
   * 不引入完整 SDK，仅用 fetch + crypto 签名（RPC 风格）。
   * 文档：https://help.aliyun.com/zh/sms/developer-reference/api-dysmsapi-2017-05-25-sendsms
   */
  async sendSms(params: SendSmsParams): Promise<SendSmsResult> {
    if (!this.isSmsEnabled()) {
      return {
        ok: false,
        error: "短信发送未配置：服务端需设置 ALIYUN_SMS_ACCESS_KEY_ID / ALIYUN_SMS_ACCESS_KEY_SECRET / ALIYUN_SMS_SIGN_NAME / ALIYUN_SMS_TEMPLATE_CODE",
        retryable: false,
      };
    }
    const to = params.to.trim();
    if (!isValidPhoneNumber(to)) {
      return { ok: false, error: `手机号无效：${to}`, retryable: false };
    }
    const text = params.text.trim();
    if (!text) {
      return { ok: false, error: "短信内容不能为空", retryable: false };
    }

    const cfg = this.smsConfig!;
    // 业务参数：PhoneNumbers / SignName / TemplateCode / TemplateParam
    const templateParam = params.templateParams ?? JSON.stringify({ content: text.slice(0, 500) });

    const commonParams: Record<string, string> = {
      SignatureMethod: "HMAC-SHA1",
      SignatureVersion: "1.0",
      SignatureNonce: randomUUID(),
      AccessKeyId: cfg.accessKeyId,
      Timestamp: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
      Format: "JSON",
      Version: "2017-05-25",
      Action: "SendSms",
      RegionId: "cn-hangzhou",
    };
    const bizParams: Record<string, string> = {
      PhoneNumbers: to.replace(/^\+86/, ""),
      SignName: cfg.signName,
      TemplateCode: cfg.templateCode,
      TemplateParam: templateParam,
    };

    const allParams = { ...commonParams, ...bizParams };

    // 1. 构造规范化查询串（按 key 字典序）
    const canonicalQuery = Object.keys(allParams)
      .sort()
      .map((k) => `${percentEncode(k)}=${percentEncode(allParams[k])}`)
      .join("&");

    // 2. 拼签名原文：GET&%2F&<percent_encode(canonicalQuery)>
    const stringToSign = `GET&${percentEncode("/")}&${percentEncode(canonicalQuery)}`;

    // 3. HMAC-SHA1（key = AccessKeySecret + "&"），base64 输出
    const signature = createHmac("sha1", cfg.accessKeySecret + "&")
      .update(stringToSign, "utf8")
      .digest("base64");

    // 4. 把 Signature 加入查询串，发起 GET 请求
    const finalQuery = `${canonicalQuery}&Signature=${percentEncode(signature)}`;
    const url = `https://dysmsapi.aliyuncs.com/?${finalQuery}`;

    try {
      const res = await fetch(url, { method: "GET" });
      const json = (await res.json()) as { Code?: string; Message?: string; BizId?: string; RequestId?: string };
      if (!res.ok || json.Code !== "OK") {
        const err = `阿里云短信发送失败：${json.Code ?? `HTTP ${res.status}`} ${json.Message ?? res.statusText}`;
        // 凭证 / 模板 / 签名错误不可重试；限流 / 系统错误可重试
        const retryable = /isv.BUSINESS_LIMIT_CONTROL|isv.SYSTEM_ERROR|SignatureNonceUsed/i.test(json.Code ?? "");
        return { ok: false, error: err, retryable };
      }
      return {
        ok: true,
        messageId: json.RequestId ?? randomUUID(),
        bizId: json.BizId,
        to,
        summary: `已发送短信到 ${to}：${text.slice(0, 30)}${text.length > 30 ? "…" : ""}`,
      };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      return { ok: false, error, retryable: true };
    }
  }
}
