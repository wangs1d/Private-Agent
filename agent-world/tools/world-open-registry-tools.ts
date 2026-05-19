import { allowAgentWorldPlaceholderRegister } from "../config/world-register-placeholder.js";
import type { ToolRegistryLike } from "../host-types.js";
import type { WorldService } from "../services/world-service.js";

/**
 * 开放式 Agent World 注册（无门槛域名访问 + SHA-256 自动化验证题）。
 * 前缀 `world.open_registry.*`，与 HTTP `/world/register/*` 等价。
 */
export function registerWorldOpenRegistryTools(registry: ToolRegistryLike, worldService: WorldService): void {
  registry.register("world.open_registry.get_challenge", async (_input, context) => {
    worldService.getOrCreate(context.sessionId);
    const challenge = worldService.issueAgentWorldRegisterChallenge(context.sessionId);
    return {
      ok: true as const,
      sessionId: context.sessionId,
      challenge,
      httpHint: {
        challenge: "POST /world/register/challenge",
        verify: "POST /world/register/verify",
      },
    };
  });

  registry.register("world.open_registry.agent_quick", async (_input, context) => {
    worldService.getOrCreate(context.sessionId);
    const r = worldService.tryAgentQuickRegister(context.sessionId);
    if (!r.ok) {
      return {
        ok: false as const,
        reason: r.reason,
        message: r.message,
        httpEquivalent: "POST /world/register/agent_quick",
      };
    }
    return {
      ok: true as const,
      mode: "placeholder_quick" as const,
      agentWorldRegistered: true,
      agentWorldCredits: r.state.agentWorldCredits,
      message: allowAgentWorldPlaceholderRegister()
        ? "占位一键注册成功。正式题目上线后本工具将需在关闭 AGENT_WORLD_PLACEHOLDER_REGISTER 后改用 get_challenge/submit"
        : "占位注册未开启",
    };
  });

  registry.register("world.open_registry.submit", async (input, context) => {
    const nonce = String(input.nonce ?? "").trim();
    const answerHex = String(input.answerHex ?? "").trim();
    if (!nonce) throw new Error("缺少 nonce");
    if (!answerHex) throw new Error("缺少 answerHex");
    worldService.getOrCreate(context.sessionId);
    const v = worldService.verifyAgentWorldRegister(context.sessionId, nonce, answerHex);
    if (!v.ok) {
      return { ok: false as const, reason: v.reason, message: v.message };
    }
    const state = worldService.getOrCreate(context.sessionId);
    return {
      ok: true as const,
      agentWorldRegistered: true,
      agentWorldCredits: state.agentWorldCredits,
      message:
        "已注册开放式 Agent World，可开始使用 world.free_market.* / world.doudizhu.* / world.zhajinhua.* / world.social.* 等工具",
    };
  });
}
