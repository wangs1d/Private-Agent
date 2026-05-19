import { resolveActorId } from "../agent/actor-id.js";
import type { AgentAccountService } from "../services/agent-account-service.js";
import type { ToolRegistry } from "./tool-registry.js";

/**
 * Agent 自助注册：创建绑定到当前会话的账号，并一步完成「上线」自检清单（自导任务）。
 */
export function registerAgentAccountTools(
  registry: ToolRegistry,
  accounts: AgentAccountService,
): void {
  registry.register("agent.register_account", async (input, context) => {
    const displayName = String(input.displayName ?? "").trim();
    if (!displayName) {
      throw new Error("缺少 displayName");
    }

    const actorId = resolveActorId({ userId: context.userId, sessionId: context.sessionId });
    const record = await accounts.register(actorId, displayName);
    await accounts.markSetupComplete(actorId);

    return {
      summary: "Agent 账号已创建并完成初始化任务",
      accountId: record.accountId,
      displayName: record.displayName,
      userId: record.userId,
      sessionId: record.userId,
      createdAt: record.createdAt,
      setupComplete: true,
      stepsDone: [
        "创建 Agent 账号并绑定当前登录主体",
        "写入服务端持久化存储",
        "标记自导上线检查完成",
      ],
    };
  });
}
