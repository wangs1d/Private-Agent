import type { LlmExecutionMode } from "./task-router.js";

// ==================== 常量 ====================

const NOISE_PREFIXES = /^(你好|hi|hello|hey|谢谢|thanks|thank you|再见|bye)[!，,。？?\s]*$/i;

/**
 * 判断本轮消息是否需要"分阶段异步对话"（垫词 + 主回复）。
 *
 * 设计说明（2026-08-20 模块合并）：
 * 垫词已统一由 StreamSegmenter 产出——垫词 = 主回复的首个分句，与正文同源。
 * 本模块仅保留"是否需要分阶段"的纯判定，供上层决定是否启用 turn 面板/分段开关，
 * 不再承担任何垫词生成职责（原 LivingInterimController 已移除并并入 StreamSegmenter）。
 */
export function shouldEmitInterimAck(
  text: string,
  _mode: LlmExecutionMode,
  opts: { enabled: boolean } = { enabled: true },
): boolean {
  if (!opts.enabled) return false;
  const t = text.trim();
  if (!t) return false;
  if (t.length > 2000) return false;
  if (t.length < 4) return false;
  if (NOISE_PREFIXES.test(t)) return false;
  return true;
}

export function shouldUsePhasedAsyncConversation(
  text: string,
  mode: LlmExecutionMode,
  opts: { enabled: boolean } = { enabled: true },
): boolean {
  return shouldEmitInterimAck(text, mode, opts);
}