import type { DoudizhuService } from "../services/doudizhu-service.js";
import type { ToolRegistryLike } from "../host-types.js";
import { buildDoudizhuTableUrl } from "../config/world-game-url.js";
import { worldMutationOpts } from "./world-tool-input.js";

/**
 * Agent World 斗地主：游戏内有效操作仅由此处工具执行（LLM function calling / 进程内 execute）。
 * 终端用户不直连出牌；用户只在会话中提建议，由模型调用工具。前缀 `world.doudizhu.*`，见 `GET /chat/tools`。
 */
export function registerWorldDoudizhuTools(registry: ToolRegistryLike, doudizhu: DoudizhuService): void {
  // 🔴 注册状态连续性约束（见 .trae/rules/project_rules.md）
  if ('registerStatefulModule' in registry) {
    (registry as unknown as { registerStatefulModule: (config: import("../deps/tools/tool-registry.js").StatefulToolConfig) => void }).registerStatefulModule({
      modulePrefix: "world.doudizhu",
      snapshotToolName: "world.doudizhu.get_snapshot",
      validStatuses: ["waiting", "bidding", "playing", "finished"],
      mustReturnSnapshot: true,
    });
  }

  registry.register("world.doudizhu.list_tables", async (_input, context) => {
    doudizhu.assertAgentWorldEntry(context.sessionId);
    doudizhu.visitHall(context.sessionId);
    const tables = doudizhu.listTables();
    return {
      ok: true,
      summary: "已列出当前斗地主桌（内存态，重启清空）",
      tables,
      hint: "每名 Agent 使用独立 sessionId；三人各坐一桌需三个会话。",
    };
  });

  registry.register("world.doudizhu.create_table", async (input, context) => {
    doudizhu.assertAgentWorldEntry(context.sessionId);
    const stake = Number(input.stake ?? 0);
    const r = doudizhu.createTable(context.sessionId, stake);
    if (!r.ok) throw new Error(r.reason);
    const watchUrl = buildDoudizhuTableUrl(r.table.tableId);
    return {
      ok: true,
      table: r.table,
      watchUrl,
      message: `已开桌，创建者在座位 1。观战链接：${watchUrl}`,
    };
  });

  registry.register("world.doudizhu.join", async (input, context) => {
    doudizhu.assertAgentWorldEntry(context.sessionId);
    const tableId = String(input.tableId ?? "").trim();
    const role = String(input.role ?? "").trim();
    if (!tableId) throw new Error("缺少 tableId");
    if (role !== "player" && role !== "spectator") {
      throw new Error("role 须为 player 或 spectator");
    }
    const { expectedRevision } = worldMutationOpts(input as Record<string, unknown>);
    const r =
      role === "player"
        ? doudizhu.joinAsPlayer(tableId, context.sessionId, expectedRevision)
        : doudizhu.joinSpectator(tableId, context.sessionId);
    if (!r.ok) {
      const detail = "message" in r && typeof r.message === "string" ? r.message : r.reason;
      throw new Error(detail);
    }
    return {
      ok: true,
      table: r.table,
      watchUrl: buildDoudizhuTableUrl(tableId),
      message:
        role === "player"
          ? "已加入选手席；满三人且世界点数足够则自动开局并扣注。"
          : `已进入观战席。观战链接：${buildDoudizhuTableUrl(tableId)}`,
    };
  });

  registry.register("world.doudizhu.leave", async (input, context) => {
    doudizhu.assertAgentWorldEntry(context.sessionId);
    const tableId = String(input.tableId ?? "").trim();
    if (!tableId) throw new Error("缺少 tableId");
    const r = doudizhu.leave(tableId, context.sessionId);
    if (!r.ok) throw new Error(r.reason);
    return { ok: true, message: "已离开该桌（进行中离场会作废并退款）。" };
  });

  registry.register("world.doudizhu.get_snapshot", async (input, context) => {
    doudizhu.assertAgentWorldEntry(context.sessionId);
    const tableId = String(input.tableId ?? "").trim();
    if (!tableId) throw new Error("缺少 tableId");
    const r = doudizhu.getSnapshot(tableId, context.sessionId);
    if (!r.ok) throw new Error(r.reason);
    return { ok: true, snapshot: r.snapshot };
  });

  registry.register("world.doudizhu.play", async (input, context) => {
    doudizhu.assertAgentWorldEntry(context.sessionId);
    const tableId = String(input.tableId ?? "").trim();
    const action = String(input.action ?? "").trim() as "pass" | "play";
    if (!tableId) throw new Error("缺少 tableId");
    if (action !== "pass" && action !== "play") throw new Error("action 须为 pass 或 play");
    const rawCards = input.cards;
    const cards = Array.isArray(rawCards) ? rawCards.map((c) => String(c)) : undefined;
    const r = doudizhu.play(tableId, context.sessionId, action, cards);
    if (!r.ok) throw new Error(r.reason);
    return { ok: true, snapshot: r.snapshot };
  });

  registry.register("world.doudizhu.subscribe_table", async (input, context) => {
    doudizhu.assertAgentWorldEntry(context.sessionId);
    const tableId = String(input.tableId ?? "").trim();
    if (!tableId) throw new Error("缺少 tableId");
    const r = doudizhu.watchTable(tableId, context.sessionId);
    if (!r.ok) throw new Error(r.reason);
    return {
      ok: true,
      message: "已订阅该桌；若当前 WebSocket 已 session.init，将收到 world.doudizhu.snapshot 推送。",
      tableId,
    };
  });

  registry.register("world.doudizhu.unsubscribe_table", async (input, context) => {
    doudizhu.assertAgentWorldEntry(context.sessionId);
    const tableId = String(input.tableId ?? "").trim();
    if (!tableId) throw new Error("缺少 tableId");
    doudizhu.unwatchTable(tableId, context.sessionId);
    return { ok: true, message: "已取消订阅。" };
  });
}
