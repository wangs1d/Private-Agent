/**
 * 语音模式状态（per-actor，内存态）。
 *
 * 客户端进入/退出纯语音模式时经 WS `mode.changed` 上报，本模块记录
 * actor 当前是否处于语音模式。Phase 1 仅供诊断；Phase 2 由投递层消费：
 * 语音模式下主动消息从"原生弹窗"切换为"TTS 播报 + 轻量悬浮卡"。
 *
 * 状态不落盘：语音模式是瞬时 UI 状态，服务重启后客户端重连/再次切换会重新上报，
 * 持久化反而会引入"幽灵语音模式"（窗口已恢复但服务端仍以为在语音模式）。
 */

export type VoiceModeState = {
  active: boolean;
  /** 最近一次切换来源（如 voice_orb / client_ui） */
  source: string;
  since: string; // ISO 时间
};

const voiceModeByActor = new Map<string, VoiceModeState>();

export function setVoiceMode(actorId: string, active: boolean, source = "client"): void {
  const id = actorId.trim();
  if (!id) return;
  if (!active) {
    // 退出语音模式：删除条目而非保留 active=false，避免 Map 无限增长
    const prev = voiceModeByActor.get(id);
    if (prev && !prev.active) return;
    voiceModeByActor.set(id, { active: false, source, since: new Date().toISOString() });
    return;
  }
  voiceModeByActor.set(id, { active: true, source, since: new Date().toISOString() });
}

export function isVoiceMode(actorId: string): boolean {
  return voiceModeByActor.get(actorId.trim())?.active ?? false;
}

export function getVoiceModeState(actorId: string): VoiceModeState | undefined {
  return voiceModeByActor.get(actorId.trim());
}

/** 诊断用快照（GET /api/proactivity/diagnostics 可挂载） */
export function listVoiceModeStates(): Array<Record<string, unknown>> {
  return Array.from(voiceModeByActor.entries()).map(([actorId, state]) => ({
    actorId,
    ...state,
  }));
}
