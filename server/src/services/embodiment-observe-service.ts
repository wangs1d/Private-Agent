import { ServerEventType } from "../protocol.js";
import type { WsConnectionRegistry } from "./ws-connection-registry.js";

/** 客户端上报的球形窗口在屏幕上的位置（逻辑/物理坐标由客户端说明）。 */
export type EmbodimentClientState = {
  /** 窗口左上角 x（与 workArea 同坐标系，通常为物理像素） */
  x: number;
  y: number;
  width: number;
  height: number;
  /** 窗口中心归一化坐标 0～1（相对工作区） */
  centerScreenX: number;
  centerScreenY: number;
  workAreaWidth?: number;
  workAreaHeight?: number;
  mode?: "docked" | "overflow";
  overlayReady?: boolean;
  reportedAt: string;
};

type PendingWait = {
  resolve: (state: EmbodimentClientState | null) => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * 具身观察：服务端下发 query，客户端回传 agent.embodiment.state，供 observe 工具等待。
 */
export class EmbodimentObserveService {
  private readonly lastBySession = new Map<string, EmbodimentClientState>();
  private readonly pending = new Map<string, PendingWait>();

  getLast(sessionId: string): EmbodimentClientState | undefined {
    return this.lastBySession.get(sessionId);
  }

  reportState(sessionId: string, state: EmbodimentClientState): void {
    this.lastBySession.set(sessionId, state);
    const pending = this.pending.get(sessionId);
    if (pending) {
      clearTimeout(pending.timer);
      this.pending.delete(sessionId);
      pending.resolve(state);
    }
  }

  requestClientState(wsRegistry: WsConnectionRegistry, sessionId: string): boolean {
    return wsRegistry.trySend(
      sessionId,
      JSON.stringify({
        type: ServerEventType.AgentEmbodimentCommand,
        payload: { sessionId, action: "query_state", source: "tool:embodiment.observe" },
      }),
    );
  }

  waitForState(sessionId: string, timeoutMs = 2800): Promise<EmbodimentClientState | null> {
    const existing = this.lastBySession.get(sessionId);
    if (existing && Date.now() - Date.parse(existing.reportedAt) < 1200) {
      return Promise.resolve(existing);
    }

    return new Promise((resolve) => {
      const prev = this.pending.get(sessionId);
      if (prev) {
        clearTimeout(prev.timer);
        prev.resolve(null);
      }
      const timer = setTimeout(() => {
        this.pending.delete(sessionId);
        resolve(this.lastBySession.get(sessionId) ?? null);
      }, timeoutMs);
      this.pending.set(sessionId, { resolve, timer });
    });
  }
}

let singleton: EmbodimentObserveService | null = null;

export function getEmbodimentObserveService(): EmbodimentObserveService {
  if (!singleton) singleton = new EmbodimentObserveService();
  return singleton;
}
