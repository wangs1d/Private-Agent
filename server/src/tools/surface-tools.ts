import { randomUUID } from "node:crypto";

import { resolveActorId } from "../agent/actor-id.js";
import { ServerEventType } from "../protocol.js";
import type { ToolRegistry } from "./tool-registry.js";

/**
 * Surface-on-Demand 工具族：让 LLM 能「召唤」客户端上的按需信息面板。
 *
 * 语音模式的核心体验：主窗口已隐藏、桌面上只有声纹波形，此时信息不能
 * 只靠"念"——用户说"看看今天安排"，Agent 除文本回答（会被 TTS 朗读，
 * 即"念"的通道）外，还应把「今日安排」悬浮窗召唤到桌面上（"显"的通道）。
 *
 * 通道约定：
 *   工具 → WS `surface.show` 事件（ServerEventType.SurfaceShow）→ 客户端
 *   main.dart 按 surface 名执行（today_schedule → ScheduleFloatingLauncher）。
 *   客户端不支持的 surface 静默忽略；ttlSeconds 后自动淡出（客户端负责）。
 *
 * 设计取舍：数据由客户端自己取（客户端已有 _loadTodayScheduleFuture 与
 * 原生映射），服务端只发"指令"，不在 payload 里搬日程数据——避免在
 * 服务端复刻一份 ScheduleFloatingItem 形状。
 *
 * 沙箱可用：仅 WS 推送指令，无写操作，无需「完全访问」。
 */

const SURFACE_TTL_MIN_SECONDS = 5;
const SURFACE_TTL_MAX_SECONDS = 300;
const SURFACE_TTL_DEFAULT_SECONDS = 30;

/** 已定义的 surface 清单（与客户端 main.dart _handleSurfaceShow 对齐） */
const KNOWN_SURFACES = new Set<string>(["today_schedule"]);

export type SurfaceToolsDeps = {
  /** 按 actorId 直推 WS 消息（与 delivery-service 同一通道语义） */
  trySend: (actorId: string, data: string) => boolean;
};

export function registerSurfaceTools(
  registry: ToolRegistry,
  deps: SurfaceToolsDeps,
): void {
  registry.register("surface.show", async (input, context) => {
    const actorId = resolveActorId(context);
    const surface = String(input.surface ?? input.name ?? "").trim();

    if (!surface) {
      return { ok: false, error: "缺少 surface（要召唤的面板名）" };
    }
    if (!KNOWN_SURFACES.has(surface)) {
      return {
        ok: false,
        error: `未知的 surface: ${surface}（可选：${Array.from(KNOWN_SURFACES).join("、")}）`,
      };
    }

    const ttlRaw = Number(input.ttlSeconds);
    const ttlSeconds = Number.isFinite(ttlRaw) && ttlRaw > 0
      ? Math.min(
          SURFACE_TTL_MAX_SECONDS,
          Math.max(SURFACE_TTL_MIN_SECONDS, Math.round(ttlRaw)),
        )
      : SURFACE_TTL_DEFAULT_SECONDS;

    const pushed = deps.trySend(
      actorId,
      JSON.stringify({
        type: ServerEventType.SurfaceShow,
        payload: { surface, ttlSeconds, jobId: randomUUID() },
      }),
    );

    return {
      ok: true,
      surface,
      pushed,
      summary: pushed
        ? `已通知客户端在桌面展示「${surface}」悬浮卡（${ttlSeconds} 秒后自动淡出）。` +
          `文本回答请给出口头摘要，与悬浮卡形成"念+显"双通道。`
        : `指令已生成，但用户当前不在线（未连接 WebSocket），悬浮卡未展示。请直接用文本回答。`,
    };
  });

  // 对话移除：用户说"把图片收了/关掉这个页面"→ LLM 调用，客户端收起对应面板。
  // 与 surface.show 对称；media = 中央媒体展示页（不会自动消失，靠本工具或
  // 用户手动 ✕ 关闭），all = 全部浮层。
  registry.register("surface.dismiss", async (input, context) => {
    const actorId = resolveActorId(context);
    const surface = String(input.surface ?? "").trim().toLowerCase();

    const pushed = deps.trySend(
      actorId,
      JSON.stringify({
        type: ServerEventType.SurfaceDismiss,
        payload: { surface, jobId: randomUUID() },
      }),
    );

    const target = surface === "all" ? "全部浮层面板" : `「${surface || "media"}」`;
    return {
      ok: true,
      surface,
      pushed,
      summary: pushed
        ? `已通知客户端收起${target}。`
        : `指令已生成，但用户当前不在线（未连接 WebSocket），未生效。`,
    };
  });
}
