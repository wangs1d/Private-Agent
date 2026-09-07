import type { MessagePlatformGateway } from "../message-platform-gateway.js";
import type { EmailSmsService } from "../email-sms-service.js";
import type { TicketPickupContact } from "../../skills/travel-planning/travel-ticket-store.js";
import type { PickupSendResult } from "./types.js";

/**
 * 接站人消息外发（真实通道）。
 *
 * 通道选择（按 contact 显式指定，缺省自动推断）：
 *   sms    → 阿里云短信（EmailSmsService.sendSms，需配置 ALIYUN_SMS_*）
 *   wechat → 微信发送桥（MessagePlatformGateway，需配置 WECHAT_BRIDGE_SEND_URL）
 *   qq     → QQ 发送桥
 *   feishu → 飞书发送桥
 *
 * 每个通道真实可用性由对应服务自查（缺配置返回明确错误），本层把首个
 * 成功通道返回给调用方；全部失败时返回带原因的失败结果，由上层决定
 * 是否回退成「给用户的确认提案」。
 */
export class PickupSender {
  constructor(
    private readonly emailSms: EmailSmsService | null,
    private readonly platformGateway: MessagePlatformGateway | null,
  ) {}

  async send(contact: TicketPickupContact, text: string, actorId: string): Promise<PickupSendResult> {
    const channel = contact.channel ?? (contact.phone ? "sms" : contact.channelTarget ? "wechat" : null);
    if (!channel) {
      return {
        ok: false,
        summary: "接站人缺少联系方式（手机号或平台会话 id）",
        error: "no_channel",
      };
    }

    if (channel === "sms") {
      if (!contact.phone) return { ok: false, channel, summary: "短信通道缺少手机号", error: "missing_phone" };
      if (!this.emailSms) return { ok: false, channel, summary: "短信服务未装配", error: "sms_unavailable" };
      const result = await this.emailSms.sendSms({ to: contact.phone, text });
      return result.ok
        ? { ok: true, channel, summary: `短信已发送至 ${contact.name}（${maskPhone(contact.phone)}）` }
        : { ok: false, channel, summary: `短信发送失败：${result.error}`, error: result.error };
    }

    if (!this.platformGateway) {
      return { ok: false, channel, summary: "平台消息桥未装配", error: "gateway_unavailable" };
    }
    if (!contact.channelTarget) {
      return { ok: false, channel, summary: `${channel} 通道缺少会话/接收 id`, error: "missing_target" };
    }
    const result = await this.platformGateway.send({
      actorId,
      platform: channel,
      channelId: contact.channelTarget,
      text,
    });
    return result.ok
      ? { ok: true, channel, summary: `已通过 ${channel} 通知 ${contact.name}` }
      : {
          ok: false,
          channel,
          summary: `${channel} 发送失败：${result.message ?? "未知原因（检查桥接配置是否可用）"}`,
          error: result.message,
        };
  }
}

function maskPhone(phone: string): string {
  return phone.length >= 7 ? `${phone.slice(0, 3)}****${phone.slice(-4)}` : phone;
}
