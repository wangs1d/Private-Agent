/**
 * 路由专用模型解析（2026-10-07）：意图路由（L1 分类器）与主聊天模型解耦。
 *
 * 根因：routeTurnByLlm 此前直接复用主聊天 provider——用户把主模型切到
 * MiniMax M 系（思考模型）后，路由调用被思考链拖慢/饿死（路由 maxOutputTokens
 * 仅 192，M2.x 思考计入预算会把正文烧光；3s 超时也常跑不进来），或被思考型
 * 模型判偏（闲聊判成 realtime_lookup），「保守降级任务面」的兜底把日常对话
 * 整轮吸进任务面，任务失败再吐「这件事没办成」回执（2026-10-07 实测事故：
 * 「你知道我的老婆是谁吧」→ 任务面失败回执）。
 *
 * 契约：
 * - `LLM_ROUTE_PROVIDER` 显式指定路由模型（openai / moonshot-kimi / minimax；
 *   none=跟随主模型，向后兼容旧行为）；未设置时 auto 链优先无思考链的快模型：
 *   openai → moonshot-kimi → minimax，链上全部未配置则回退主 provider 保底。
 * - 路由实例独立构造：路由会话本就是 `llm-route::` 前缀 + ephemeral 单次调用，
 *   无线程状态，不依赖主聊天的上下文/缓存；主模型切换不再波及路由稳定性。
 */
import type { ExternalChatProvider } from "./types.js";
import { instantiateKnownProvider } from "./instantiate-provider.js";

/** auto 模式的路由优先链：无思考链的快模型优先，M 系思考模型最后。 */
const ROUTE_PREFERENCE_CHAIN = ["openai", "moonshot-kimi", "minimax"] as const;

/** 解析 `LLM_ROUTE_PROVIDER`：null=auto；"none"=显式跟随主模型。 */
function parsePinnedProvider(env: NodeJS.ProcessEnv): string | null | "none" {
  const raw = (env.LLM_ROUTE_PROVIDER ?? "").trim().toLowerCase();
  if (!raw || raw === "auto") return null;
  if (raw === "none" || raw === "off" || raw === "follow_main") return "none";
  if (raw === "moonshot-kimi" || raw === "moonshot" || raw === "kimi") return "moonshot-kimi";
  if (raw === "openai") return "openai";
  if (raw === "minimax") return "minimax";
  console.warn(
    `[route-chat-provider] Unknown LLM_ROUTE_PROVIDER="${raw}", falling back to auto.`,
  );
  return null;
}

/**
 * 解析路由专用 provider（进程启动时调用一次）。
 * 永不抛错：任何解析失败都回退主 provider（路由保底可用性优先）。
 */
export function resolveRouteChatProvider(
  main: ExternalChatProvider | null,
  env: NodeJS.ProcessEnv = process.env,
): ExternalChatProvider | null {
  const pinned = parsePinnedProvider(env);
  if (pinned === "none") {
    return main;
  }
  if (pinned) {
    const p = instantiateKnownProvider(pinned);
    if (p?.isEnabled()) {
      console.info(`[route-chat-provider] LLM_ROUTE_PROVIDER=${pinned} → 路由固定用 ${pinned}。`);
      return p;
    }
    console.warn(
      `[route-chat-provider] LLM_ROUTE_PROVIDER=${pinned} 但对应密钥未配置，回退 auto 链。`,
    );
  }
  for (const token of ROUTE_PREFERENCE_CHAIN) {
    const p = instantiateKnownProvider(token);
    if (p?.isEnabled()) {
      console.info(`[route-chat-provider] 路由固定用 ${token}（auto 链，独立于主模型切换）。`);
      return p;
    }
  }
  console.info(
    "[route-chat-provider] auto 链无可用 provider，路由跟随主模型（保底）。",
  );
  return main;
}
