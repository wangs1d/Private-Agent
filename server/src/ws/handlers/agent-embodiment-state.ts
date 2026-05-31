import type { EmbodimentClientState } from "../../services/embodiment-observe-service.js";
import { getEmbodimentObserveService } from "../../services/embodiment-observe-service.js";

function readNum(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * 处理客户端 `agent.embodiment.state` — 回报球形桌宠窗口位置，供 embodiment.observe 闭环。
 */
export function handleAgentEmbodimentStateEvent(
  actorId: string,
  payload: Record<string, unknown>,
): boolean {
  const x = readNum(payload.x);
  const y = readNum(payload.y);
  const width = readNum(payload.width);
  const height = readNum(payload.height);
  const centerScreenX = readNum(payload.centerScreenX);
  const centerScreenY = readNum(payload.centerScreenY);
  if (
    x === undefined ||
    y === undefined ||
    width === undefined ||
    height === undefined ||
    centerScreenX === undefined ||
    centerScreenY === undefined
  ) {
    return false;
  }

  const modeRaw = payload.mode;
  const mode =
    modeRaw === "docked" || modeRaw === "overflow" ? modeRaw : undefined;

  const state: EmbodimentClientState = {
    x,
    y,
    width,
    height,
    centerScreenX,
    centerScreenY,
    workAreaWidth: readNum(payload.workAreaWidth),
    workAreaHeight: readNum(payload.workAreaHeight),
    mode,
    overlayReady: payload.overlayReady === true,
    reportedAt: new Date().toISOString(),
  };

  getEmbodimentObserveService().reportState(actorId, state);
  return true;
}
