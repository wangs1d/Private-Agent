/**
 * desktop_visual 本机执行体的纯 env 判定（叶子模块：不 import 任何项目内模块）。
 *
 * 独立成模块的原因：external-model/resolve-chat-tools 只需要 env 开关判定，
 * 但若从 desktop-visual-subprocess 引入（→ desktop-visual-vlm-config →
 * resolve-provider → 具体 providers → abstract-chat-provider → resolve-chat-tools）
 * 会形成静态 import 环，ESM 求值顺序下触发
 * "Cannot access 'AbstractChatProvider' before initialization"。
 */

function parseBooleanEnv(raw: string | undefined): boolean {
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/** 与 SubprocessDesktopVisual.isEnabled 同源（desktop-visual-subprocess 复用本函数）。 */
export function isVisualEnabled(env: NodeJS.ProcessEnv): boolean {
  return (
    parseBooleanEnv(env.DESKTOP_VISUAL_ENABLED) ||
    parseBooleanEnv(env.DESKTOP_VISUAL_AGENT_ENABLED)
  );
}

/**
 * 本机视觉执行体是否启用（env 判定）。
 *
 * desktop.* 工具在 WS 桥离线时仍可经本机 Python 执行体落地的兜底路径
 * （desktop-visual-tools.ts：bridge.hasExecutor → localVisual 兜底）。
 * 「桥离线 = desktop.* 必然失败」的裁剪判定必须同时看这条兜底是否可用，
 * 否则会把实际能执行的工具从规划目录/可见集中整体剔除。
 */
export function isLocalDesktopVisualEnabledFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isVisualEnabled(env);
}
