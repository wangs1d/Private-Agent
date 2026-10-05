import { resolveActorId } from "../agent/actor-id.js";
import type { WechatClawBindingService } from "../services/wechat-claw-binding-service.js";
import type { QrAssistService } from "../services/qr-assist-service.js";
import type { ToolRegistry } from "./tool-registry.js";

/**
 * 微信接入（wechat-claw）聊天工具族。
 *
 * - wechat.login_qr：发起扫码登录。服务端生成/复用登录二维码，经通用推卡
 *   通道（QrAssistService → chat.media_ready）实时推到聊天流，用户直接扫。
 * - wechat.login_check：轮询一次扫码结果（默认阻塞最长 20s，可调）。
 *
 * HTTP 入口（/integrations/wechat-claw/login/*）保留兼容；本工具族是聊天侧
 * 等价包装——用户说「帮我登录微信」即可走通，无需手动调接口。
 */
export function registerWechatClawTools(
  registry: ToolRegistry,
  wechatClawBindingService: WechatClawBindingService,
  qrAssist?: QrAssistService,
): void {
  registry.register("wechat.login_qr", async (input, context) => {
    const actorId = resolveActorId(context);
    const force = input.force === true;
    const result = await wechatClawBindingService.startLogin(actorId, force);

    let qrImageUrl: string | undefined;
    if (qrAssist && result.qrDataUrl) {
      qrImageUrl =
        (await qrAssist.pushQrImage(
          context,
          { title: "请扫码登录微信", caption: "扫码后说一声「微信登录好了」，我来确认连接状态" },
          { dataUrl: result.qrDataUrl },
        )) ?? undefined;
    }

    return {
      ok: true,
      summary:
        `已生成微信登录二维码${qrImageUrl ? "并推送到聊天" : ""}` +
        (result.qrLink ? `；也可在浏览器打开链接扫码：${result.qrLink}` : ""),
      connected: result.connected ?? false,
      message: result.message,
      qrLink: result.qrLink,
      ...(qrImageUrl ? { qrImageUrl } : {}),
      instruction: "用户扫码后调用 wechat.login_check 确认连接状态",
      actorId,
    };
  });

  registry.register("wechat.login_check", async (input, context) => {
    const actorId = resolveActorId(context);
    const timeoutMs =
      typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0
        ? Math.min(input.timeoutMs, 60_000)
        : 20_000;
    const result = await wechatClawBindingService.waitLogin(actorId, { timeoutMs });
    return {
      ok: true,
      summary: result.connected
        ? "微信已连接"
        : (result.message ?? "仍在等待扫码，请用户扫码后再试"),
      connected: result.connected ?? false,
      message: result.message,
      actorId,
    };
  });
}
