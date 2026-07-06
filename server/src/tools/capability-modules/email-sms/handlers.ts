import type { ToolHandler, ToolContext } from "../../tool-registry.js";
import { resolveActorId } from "../../../agent/actor-id.js";
import type {
  EmailSmsService,
  EmailSmsAttachment,
  SendEmailParams,
  SendSmsParams,
} from "../../../services/email-sms-service.js";

/**
 * email.send 工具 handler 工厂。
 *
 * 调用 {@link EmailSmsService.sendEmail} 通过 SMTP 发送邮件。
 *
 * 失败时返回 `{ ok: false, error, retryable? }`；
 * 成功时返回 `{ ok: true, messageId, to, summary }`。
 *
 * 注意：发邮件属于「主动触达用户」，调用前 LLM 应已与用户确认收件人 / 主题 / 正文。
 */
export function createEmailSendHandler(emailSmsService: EmailSmsService): ToolHandler {
  return async (input: Record<string, unknown>, _context: ToolContext) => {
    // resolveActorId 当前未用于发送逻辑，但保留以便后续审计日志
    void resolveActorId(_context);

    const to = String(input.to ?? "").trim();
    if (!to) {
      return { ok: false, error: "缺少 to（收件人邮箱地址）", retryable: false };
    }
    const subject = String(input.subject ?? "").trim();
    if (!subject) {
      return { ok: false, error: "缺少 subject（邮件主题）", retryable: false };
    }
    const body = input.body != null ? String(input.body) : undefined;
    const html = input.html != null ? String(input.html) : undefined;
    if ((!body || !body.trim()) && (!html || !html.trim())) {
      return {
        ok: false,
        error: "邮件正文不能为空（body 或 html 至少传一个）",
        retryable: false,
      };
    }

    const attachments: EmailSmsAttachment[] | undefined = Array.isArray(input.attachments)
      ? input.attachments
          .map((a, i) => {
            if (typeof a !== "object" || a === null) return null;
            const r = a as Record<string, unknown>;
            const filename = String(r.filename ?? "").trim();
            if (!filename) return null;
            const att: EmailSmsAttachment = { filename };
            if (typeof r.path === "string" && r.path.trim()) att.path = r.path.trim();
            if (typeof r.content === "string" && r.content.trim()) att.content = r.content.trim();
            if (typeof r.contentType === "string" && r.contentType.trim()) att.contentType = r.contentType.trim();
            // path 与 content 都没有时拒绝该附件
            if (!att.path && !att.content) return null;
            void i;
            return att;
          })
          .filter((a): a is EmailSmsAttachment => a != null)
      : undefined;

    const params: SendEmailParams = {
      to,
      subject,
      body,
      html,
      attachments: attachments?.length ? attachments : undefined,
    };

    const result = await emailSmsService.sendEmail(params);
    if (!result.ok) {
      return { ok: false, error: result.error, retryable: result.retryable };
    }
    return {
      ok: true,
      messageId: result.messageId,
      to: result.to,
      summary: result.summary,
    };
  };
}

/**
 * sms.send 工具 handler 工厂。
 *
 * 调用 {@link EmailSmsService.sendSms} 通过阿里云短信网关发送短信。
 *
 * 失败时返回 `{ ok: false, error, retryable? }`；
 * 成功时返回 `{ ok: true, messageId, bizId?, to, summary }`。
 *
 * 注意：发短信属于「主动触达用户」，调用前 LLM 应已与用户确认手机号 / 内容；
 * 短信通道受服务商限流，禁止短时间多次调用同一号码。
 */
export function createSmsSendHandler(emailSmsService: EmailSmsService): ToolHandler {
  return async (input: Record<string, unknown>, _context: ToolContext) => {
    void resolveActorId(_context);

    const to = String(input.to ?? "").trim();
    if (!to) {
      return { ok: false, error: "缺少 to（收件人手机号）", retryable: false };
    }
    const text = String(input.text ?? "").trim();
    if (!text) {
      return { ok: false, error: "缺少 text（短信内容）", retryable: false };
    }
    const templateParams =
      input.templateParams != null ? String(input.templateParams).trim() || undefined : undefined;

    const params: SendSmsParams = { to, text, templateParams };

    const result = await emailSmsService.sendSms(params);
    if (!result.ok) {
      return { ok: false, error: result.error, retryable: result.retryable };
    }
    return {
      ok: true,
      messageId: result.messageId,
      bizId: result.bizId,
      to: result.to,
      summary: result.summary,
    };
  };
}
