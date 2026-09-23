// 剪贴板感知传感器（clipboard_sensor）—— "用户刚复制了什么"的实感来源。
//
// 数据链路：desktop-visual 子进程 clipboard(get) → 文本哈希比对 → 变化才产出
// Signal（经 SensorKernel 指纹去重/落盘/分发）。这是"把我刚复制的东西整理成
// 备忘/发出去"类主动协作的触发源——旧架构剪贴板只有拉取式工具，用户不提
// Agent 永远不知道剪贴板变了。
//
// 隐私边界（设计底线）：信号只含 长度 + 截断预览（默认 60 字符，去换行）+
// 内容哈希，不落全文；密码管理器等高敏内容无从区分，因此预览永远不足以
// 泄露秘密本体。AGENT_CLIPBOARD_SENSOR=0 一键关闭。
import { createHash } from "node:crypto";

import type { DesktopVisualPort } from "../../services/desktop-visual-port.js";
import type { ProactiveSensor, Signal } from "./types.js";

export const CLIPBOARD_POLL_MS = 30_000;
/** 预览截断长度（隐私：够模型理解"是什么类型的内容"，不足以承载秘密） */
const PREVIEW_MAX_CHARS = 60;

export function isClipboardSensorEnabled(): boolean {
  return process.env.AGENT_CLIPBOARD_SENSOR !== "0";
}

export type ClipboardSensorOptions = {
  visualPort: DesktopVisualPort | null;
  pollIntervalMs?: number;
  /** 测试注入：预览截断长度 */
  previewChars?: number;
};

export class ClipboardSensor implements ProactiveSensor {
  readonly id = "clipboard_watch";
  readonly stream = "clipboard" as const;
  readonly pollIntervalMs: number;
  private lastHash = "";
  private readonly previewChars: number;

  constructor(private readonly opts: ClipboardSensorOptions) {
    this.pollIntervalMs = opts.pollIntervalMs ?? CLIPBOARD_POLL_MS;
    this.previewChars = opts.previewChars ?? PREVIEW_MAX_CHARS;
  }

  async collect(_since: number): Promise<Signal[]> {
    if (!isClipboardSensorEnabled()) return [];
    const port = this.opts.visualPort;
    if (!port?.clipboard) throw new Error("clipboard_port_unavailable");
    const result = await port.clipboard({ op: "get" });
    if (!result.ok) throw new Error(result.error ?? "clipboard_get_failed");
    const text = (result.text ?? "").trim();
    if (!text) return [];
    const hash = createHash("sha1").update(text).digest("hex").slice(0, 16);
    if (hash === this.lastHash) return []; // 无变化不产出
    const first = this.lastHash === "";
    this.lastHash = hash;
    const preview = text.replace(/\s+/g, " ").slice(0, this.previewChars);
    return [
      {
        stream: this.stream,
        at: Date.now(),
        fingerprint: `clipboard:${hash}${first ? ":boot" : ""}`,
        salience: "low",
        delta: `剪贴板更新：${preview}${text.length > this.previewChars ? "…" : ""}（${text.length} 字符）`,
        payload: { hash, length: text.length, preview },
      },
    ];
  }
}
