/**
 * 桌宠实时动态语音 — 纯 LLM 实时反应模式（无本地词库）。
 *
 * 核心思路：
 * - 跟踪最近一次交互的上下文（动作、强度、累计量、距上次说话的间隔）
 * - 当用户拖动/旋转/点按桌宠时，把上下文通过 WebSocket 发送给 LLM Agent（类型：pet.reaction），
 *   LLM 即兴回复后以 pet.reaction.ack 事件返回台词，直接显示在 caption 中。
 * - 不使用任何本地词库/固定语句，所有反馈文本均来自主 Agent 人格。
 */

import { useCallback, useRef } from "react";

export type SpeechTrigger =
  | "drag_start"
  | "drag_release"
  | "rotate_start"
  | "rotate_release"
  | "spin"
  | "shake"
  | "tap"
  | "vertical_bounce"
  | "long_idle";

export interface DynamicSpeechContext {
  trigger: SpeechTrigger;
  /** 0~1 强度 */
  intensity: number;
  /** 累计量：拖动总距离 / 旋转总角度等 */
  totalMagnitude: number;
  /** 离最近一次说话过去了多久 (ms) */
  silenceMs: number;
  /** 桌宠当前所在屏幕区域（top/middle/bottom × left/center/right），用于空间感 */
  region?: { v: "top" | "middle" | "bottom"; h: "left" | "center" | "right" };
  /** 当前时间（小时） */
  hour: number;
  /** 当前心情字符串（idle/listening/thinking/happy/alert） */
  mood: string;
}

export interface UseDynamicSpeechOptions {
  /** WebSocket 发送函数；undefined 时不发送任何事件 */
  send?: (payload: { type: string; payload: Record<string, unknown> }) => boolean;
  /** 切换到对应 mood 的回调（用于驱动脸部表情动画） */
  setMood?: (mood: "listening" | "happy" | "alert" | "thinking" | "idle", energy?: number) => void;
  /** 最短两次说话间隔（默认 220ms — 太密会刷屏） */
  minIntervalMs?: number;
}

/** 触发 LLM 实时生成短句：发送 pet.reaction 事件 */
function tryRequestLlmReaction(
  send: ((payload: { type: string; payload: Record<string, unknown> }) => boolean) | undefined,
  ctx: DynamicSpeechContext,
): void {
  if (!send) return;
  send({
    type: "pet.reaction",
    payload: {
      trigger: ctx.trigger,
      intensity: ctx.intensity,
      totalMagnitude: ctx.totalMagnitude,
      silenceMs: ctx.silenceMs,
      region: ctx.region,
      hour: ctx.hour,
      mood: ctx.mood,
      ts: Date.now(),
    },
  });
}

export function useDynamicSpeech(options: UseDynamicSpeechOptions) {
  const { send, setMood, minIntervalMs = 220 } = options;

  const lastSpokenAtRef = useRef(0);
  const lastTriggerRef = useRef<SpeechTrigger | null>(null);

  /**
   * 触发一次动态语音。
   * - 仅通过 WebSocket 发送交互上下文给 LLM，由 LLM 生成即兴回复并通过 pet.reaction.ack 返回
   * - 本地不生成任何文本（无词库），仅更新情绪状态驱动脸部动画
   * - 太密时（小于 minIntervalMs）会丢弃，避免刷屏
   */
  const speak = useCallback(
    (rawCtx: Omit<DynamicSpeechContext, "silenceMs" | "hour"> & { force?: boolean }) => {
      const now = Date.now();
      const silence = now - lastSpokenAtRef.current;
      const force = !!rawCtx.force;

      // 节流：相同 trigger 且时间太短 → 丢弃
      if (!force) {
        if (silence < minIntervalMs) return;
        if (
          lastTriggerRef.current === rawCtx.trigger &&
          silence < minIntervalMs * 4
        ) {
          return;
        }
      }

      const ctx: DynamicSpeechContext = {
        ...rawCtx,
        silenceMs: silence,
        hour: new Date().getHours(),
      };
      lastSpokenAtRef.current = now;
      lastTriggerRef.current = ctx.trigger;

      // 更新 mood 驱动脸部表情动画（不设 caption，文本由 LLM 通过 pet.reaction.ack 返回）
      if (setMood) {
        if (ctx.intensity > 0.6) setMood("happy", Math.min(1, 0.6 + ctx.intensity * 0.3));
        else if (ctx.trigger === "tap") setMood("alert", 0.6);
        else if (ctx.intensity > 0.2) setMood("listening", 0.5 + ctx.intensity * 0.2);
        else setMood("idle", 0.4);
      }

      // 发送上下文给 LLM Agent，等待即兴回复
      tryRequestLlmReaction(send, ctx);
    },
    [minIntervalMs, send, setMood],
  );

  return { speak };
}
