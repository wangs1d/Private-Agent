import type { Page } from "playwright";
import { readFile } from "node:fs/promises";

import type { ToolContext, ToolMediaCard } from "../tools/tool-registry.js";

/**
 * 通用二维码/图片推送服务（「需要扫码的环节自动推」）。
 *
 * 任何服务端流程（购物登录、支付收银台、钱包绑定、微信接入、agent_browser
 * 撞登录页……）只要手里有二维码——页面截图、dataURL、本地 PNG 文件或原始
 * Buffer——一行调用即可把图片卡实时推到聊天流（chat.media_ready 通道，
 * 客户端现成渲染）。图片统一落盘到 data/images/{actorId}/ 并走
 * /agent/images/ 静态路由，持久可回看。
 *
 * 全程 best-effort：无聊天流上下文（ctx.pushMediaCards 为空）、图片服务未
 * 装配或落盘失败都返回 null，绝不抛错影响主流程。
 */
export class QrAssistService {
  constructor(
    private readonly deps: {
      /** PNG 落盘 + /agent/images/ 相对路径返回；未注入时推卡不可用。 */
      imageStore?: { savePng(actorId: string, png: Buffer): Promise<string> };
    } = {},
  ) {}

  /** 推送页面截图（如登录页/收银台上的二维码），返回 imageUrl（失败 null）。 */
  async pushPageCard(
    ctx: ToolContext,
    meta: { title: string; caption?: string },
    page: Page,
  ): Promise<string | null> {
    try {
      const png = await page.screenshot({ type: "png" });
      return await this.pushCard(ctx, meta, png);
    } catch {
      return null;
    }
  }

  /** 推送二维码图片（dataURL / 本地文件路径 / 原始 PNG Buffer 任一来源）。 */
  async pushQrImage(
    ctx: ToolContext,
    meta: { title: string; caption?: string },
    image: { dataUrl?: string; filePath?: string; png?: Buffer },
  ): Promise<string | null> {
    try {
      const png = await resolvePngBuffer(image);
      if (!png) return null;
      return await this.pushCard(ctx, meta, png);
    } catch {
      return null;
    }
  }

  /** 统一出口：落盘 → 组卡 → 经 ctx.pushMediaCards 推聊天流。 */
  private async pushCard(
    ctx: ToolContext,
    meta: { title: string; caption?: string },
    png: Buffer,
  ): Promise<string | null> {
    if (!ctx.pushMediaCards || !this.deps.imageStore) return null;
    const actorId = ctx.userId ?? ctx.sessionId;
    const imageUrl = await this.deps.imageStore.savePng(actorId, png);
    const card: ToolMediaCard = {
      type: "image",
      title: meta.title,
      thumbnailUrl: imageUrl,
      mediaUrl: imageUrl,
      ...(meta.caption ? { caption: meta.caption } : {}),
    };
    ctx.pushMediaCards([card]);
    return imageUrl;
  }
}

/** dataURL（data:image/png;base64,...）/ 本地 PNG 文件 / Buffer → Buffer。 */
async function resolvePngBuffer(
  image: { dataUrl?: string; filePath?: string; png?: Buffer },
): Promise<Buffer | null> {
  if (image.png) return image.png;
  if (image.dataUrl) {
    const commaIndex = image.dataUrl.indexOf(",");
    if (!image.dataUrl.startsWith("data:") || commaIndex < 0) return null;
    return Buffer.from(image.dataUrl.slice(commaIndex + 1), "base64");
  }
  if (image.filePath) {
    // 兼容 alipay-bot CLI 输出的 file:/// 本地路径
    const path = image.filePath.startsWith("file://")
      ? fileUrlToPath(image.filePath)
      : image.filePath;
    return await readFile(path);
  }
  return null;
}

function fileUrlToPath(fileUrl: string): string {
  // file:///C:/x/y.png → C:/x/y.png；file:///home/x.png → /home/x.png
  let p = fileUrl.slice("file://".length);
  while (p.startsWith("/")) p = p.slice(1);
  return /^[A-Za-z]:/.test(p) ? p : `/${p}`;
}
