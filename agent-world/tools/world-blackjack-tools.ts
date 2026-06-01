import type { BlackjackService } from "../services/blackjack-service.js";
import type { ToolRegistryLike } from "../host-types.js";
import { humanSessionId } from "../services/game-center-session.js";

/**
 * 侧栏「游戏」tab · 21点：用户与 Agent（庄家）对战。
 * 前缀 `world.blackjack.*`；与 Agent World 经济模块无关，无需世界注册。
 */
export function registerWorldBlackjackTools(registry: ToolRegistryLike, blackjack: BlackjackService): void {
  if ("registerStatefulModule" in registry) {
    (
      registry as unknown as {
        registerStatefulModule: (
          config: import("../deps/tools/tool-registry.js").StatefulToolConfig,
        ) => void;
      }
    ).registerStatefulModule({
      modulePrefix: "world.blackjack",
      snapshotToolName: "world.blackjack.get_snapshot",
      validStatuses: ["playing", "finished"],
      mustReturnSnapshot: true,
    });
  }

  registry.register("world.blackjack.start", async (input, context) => {
    const stake = Number(input.stake ?? 50);
    const r = blackjack.createGameCenterTable(context.sessionId, stake);
    if (!r.ok) throw new Error(r.reason);
    return {
      ok: true,
      tableId: r.tableId,
      snapshot: r.snapshot,
      message:
        "21点已开局：你是用户的对手（庄家），用户在 App 侧栏「游戏」或本局界面操作；用户口述「要牌/停牌」时可调用 hit/stand 代操作。",
    };
  });

  registry.register("world.blackjack.get_snapshot", async (input, context) => {
    const tableId = String(input.tableId ?? "").trim();
    if (!tableId) throw new Error("缺少 tableId");
    const viewer = String(input.viewerSessionId ?? context.sessionId).trim();
    const r = blackjack.getSnapshot(tableId, viewer);
    if (!r.ok) throw new Error(r.reason);
    return { ok: true, snapshot: r.snapshot };
  });

  registry.register("world.blackjack.hit", async (input, context) => {
    const tableId = String(input.tableId ?? "").trim();
    if (!tableId) throw new Error("缺少 tableId");
    const human = humanSessionId(context.sessionId);
    const r = blackjack.hit(tableId, human);
    if (!r.ok) throw new Error(r.reason);
    return { ok: true, snapshot: r.snapshot };
  });

  registry.register("world.blackjack.stand", async (input, context) => {
    const tableId = String(input.tableId ?? "").trim();
    if (!tableId) throw new Error("缺少 tableId");
    const human = humanSessionId(context.sessionId);
    const r = blackjack.stand(tableId, human);
    if (!r.ok) throw new Error(r.reason);
    return { ok: true, snapshot: r.snapshot };
  });
}
