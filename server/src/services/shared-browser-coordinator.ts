import { randomUUID } from "node:crypto";

import type { AuditService } from "./audit-service.js";

/**
 * 共用浏览器桥协调器（用户与 Agent 共用同一个客户端内嵌浏览器）。
 *
 * 浏览器本体是客户端（Flutter Windows）里的 WebView2：用户在「常用工具 → 浏览器」
 * 里正常浏览，Agent 经 shared_browser.* 工具下发动作，由本协调器经聊天主通道
 * WS 转发到客户端执行（navigate/click/type/scroll/read_page 等），结果按
 * jobId 配对回传。客户端登录态天然可用，无需 Cookie 导入。
 *
 * 通道契约：
 *   - 绑定：客户端 session.init 带 `browserBridge: true`（聊天主连接自身即执行器）
 *   - 下发：server → client `shared.browser.invoke` { jobId, action, params }
 *   - 回传：client → server `browser.bridge.result` { jobId, ...result }
 *   - 清理：socket 断开时解绑并快速失败所有挂起任务
 *
 * 安全：所有 invoke 写审计日志（AuditService，category "shared_browser"），
 * timeout 兜底防止工具循环挂起。
 */

export type WsSendLike = {
  send(data: string): void;
  readyState?: number;
};

export type SharedBrowserResult = {
  ok: boolean;
  [key: string]: unknown;
};

type PendingJob = {
  resolve: (r: SharedBrowserResult) => void;
  timer: NodeJS.Timeout;
  socket: WsSendLike;
  jobId: string;
  actorId: string;
  action: string;
};

function safeSend(socket: WsSendLike, payload: object) {
  try {
    if (socket.readyState !== undefined && socket.readyState > 1) return;
    socket.send(JSON.stringify(payload));
  } catch {
    // ignore
  }
}

export class SharedBrowserCoordinator {
  private readonly executors = new Map<string, WsSendLike>();
  private readonly pending = new Map<string, PendingJob>();

  /** 审计；缺省时跳过（单测场景）。 */
  constructor(private readonly audit?: AuditService) {}

  /** session.init 带 browserBridge:true 时由 ws 连接层调用（幂等，重连即重绑）。 */
  bindExecutor(actorId: string, socket: WsSendLike) {
    this.executors.set(actorId, socket);
  }

  unbindIfSocket(actorId: string, socket: WsSendLike): boolean {
    if (this.executors.get(actorId) !== socket) return false;
    this.executors.delete(actorId);
    for (const [id, job] of this.pending.entries()) {
      if (job.socket === socket) {
        clearTimeout(job.timer);
        job.resolve({ ok: false, error: "socket disconnected" });
        this.pending.delete(id);
      }
    }
    return true;
  }

  /** Agent 工具下发前判断共用浏览器是否在线。 */
  hasExecutor(actorId: string): boolean {
    return this.executors.has(actorId);
  }

  /** 未绑定时的调用返回立即失败（不抛错），工具层据此回退提示。 */
  invoke(
    actorId: string,
    action: string,
    params: Record<string, unknown> = {},
    timeoutMs = 30_000,
  ): Promise<SharedBrowserResult> {
    const socket = this.executors.get(actorId);
    if (!socket) {
      return Promise.resolve({ ok: false, error: "shared browser bridge offline" });
    }

    const jobId = randomUUID();
    void this.audit?.record({
      category: "shared_browser",
      action: `invoke:${action}`,
      actorId,
      jobId,
      params,
      timestamp: Date.now(),
    }).catch(() => {});

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(jobId);
        resolve({ ok: false, error: "shared browser invoke timeout", retryable: true });
      }, timeoutMs);

      this.pending.set(jobId, { resolve, timer, socket, jobId, actorId, action });

      safeSend(socket, {
        type: "shared.browser.invoke",
        payload: { jobId, action, params },
      });
    });
  }

  completeFromSocket(
    actorId: string,
    socket: WsSendLike,
    jobId: string,
    result: SharedBrowserResult,
  ): boolean {
    const job = this.pending.get(jobId);
    if (!job || job.actorId !== actorId || job.socket !== socket) return false;

    clearTimeout(job.timer);
    this.pending.delete(jobId);
    if (!result.ok) {
      void this.audit?.record({
        category: "shared_browser",
        action: `failed:${job.action}`,
        actorId,
        jobId,
        error: String(result.error ?? "unknown"),
        timestamp: Date.now(),
      }).catch(() => {});
    }
    job.resolve(result);
    return true;
  }
}
