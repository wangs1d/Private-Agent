/**
 * 旅游规划进度事件总线（进程内，轻量发布订阅）
 *
 * 背景：travel.plan-itinerary 冷启动 10~30s，此前用户只看到转圈。
 * PlanningService 在各阶段（解析/定位/搜索/编排/计价/媒体）调用 emitTravelProgress
 * 携带 sessionId 发布进度；聊天 WS handler（chat-user-message）在本轮开始时按
 * sessionId 订阅，把进度转成 ChatAgentStatus 下发，结束时退订。
 *
 * 设计取舍：不把 send 通道深穿进 ToolContext/SkillExecutionContext（侵入面太大），
 * 用进程内总线按 sessionId 键控即可——规划是单机低频事件，无需跨进程。
 */

export interface TravelProgressEvent {
  /** 目标会话（chat actorId） */
  sessionId: string;
  /** 阶段标识（resolve/geocode/search/schedule/price/media/done） */
  stage: string;
  /** 用户可读进度文案（直接展示在状态行） */
  message: string;
  /** 发布时间（epoch ms） */
  ts: number;
}

type TravelProgressListener = (event: TravelProgressEvent) => void;

const listeners = new Set<TravelProgressListener>();

/** 发布一条进度（无订阅者时静默） */
export function emitTravelProgress(
  sessionId: string | undefined,
  stage: string,
  message: string,
): void {
  if (!sessionId) return;
  const event: TravelProgressEvent = { sessionId, stage, message, ts: Date.now() };
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // 单个订阅者异常不影响其他订阅者与规划主流程
    }
  }
}

/** 订阅进度，返回退订函数 */
export function subscribeTravelProgress(listener: TravelProgressListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
