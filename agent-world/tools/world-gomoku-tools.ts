import type { GomokuService } from "../services/gomoku-service.js";
import type { ToolRegistryLike } from "../host-types.js";

/**
 * Agent World 五子棋：用户与 Agent 对战工具。
 * 前缀 `world.gomoku.*`，见 `GET /chat/tools`。
 */
export function registerWorldGomokuTools(registry: ToolRegistryLike, gomoku: GomokuService): void {
  registry.register("world.gomoku.list_tables", async (_input, context) => {
    gomoku.assertAgentWorldEntry(context.sessionId);
    gomoku.visitHall(context.sessionId);
    const tables = gomoku.listTables();
    return {
      ok: true,
      summary: "已列出当前五子棋桌（内存态，重启清空）",
      tables,
      hint: "双人游戏：创建者执黑先行，另一人加入后自动开始。",
    };
  });

  registry.register("world.gomoku.create_table", async (_input, context) => {
    gomoku.assertAgentWorldEntry(context.sessionId);
    const r = gomoku.createTable(context.sessionId);
    if (!r.ok) throw new Error(r.reason);
    return {
      ok: true,
      table: r.table,
      message: "已创建五子棋桌，你执黑先行。等待对手加入后自动开始。",
    };
  });

  registry.register("world.gomoku.join", async (input, context) => {
    gomoku.assertAgentWorldEntry(context.sessionId);
    const tableId = String(input.tableId ?? "").trim();
    const role = String(input.role ?? "player").trim();
    if (!tableId) throw new Error("缺少 tableId");
    if (role !== "player" && role !== "spectator") {
      throw new Error("role 须为 player 或 spectator");
    }
    const r =
      role === "player"
        ? gomoku.joinAsPlayer(tableId, context.sessionId)
        : gomoku.joinSpectator(tableId, context.sessionId);
    if (!r.ok) throw new Error(r.reason);
    return {
      ok: true,
      table: r.table,
      message:
        role === "player"
          ? "已加入游戏，你执白棋（后手）。游戏已开始，等待对手落子。"
          : "已进入观战席，可 world.gomoku.get_snapshot 或通过 WebSocket 订阅快照。",
    };
  });

  registry.register("world.gomoku.leave", async (input, context) => {
    gomoku.assertAgentWorldEntry(context.sessionId);
    const tableId = String(input.tableId ?? "").trim();
    if (!tableId) throw new Error("缺少 tableId");
    const r = gomoku.leave(tableId, context.sessionId);
    if (!r.ok) throw new Error(r.reason);
    return { ok: true, message: "已离开该桌（进行中离场会结束游戏）。" };
  });

  registry.register("world.gomoku.play", async (input, context) => {
    gomoku.assertAgentWorldEntry(context.sessionId);
    const tableId = String(input.tableId ?? "").trim();
    const row = Number(input.row ?? -1);
    const col = Number(input.col ?? -1);
    if (!tableId) throw new Error("缺少 tableId");
    if (row < 0 || row >= 15 || col < 0 || col >= 15) {
      throw new Error("落子位置无效，须在 0-14 范围内");
    }
    const r = gomoku.play(tableId, context.sessionId, row, col);
    if (!r.ok) throw new Error(r.reason);
    return {
      ok: true,
      snapshot: r.snapshot,
      message: `已落子 (${row}, ${col})`,
    };
  });

  registry.register("world.gomoku.get_snapshot", async (input, context) => {
    gomoku.assertAgentWorldEntry(context.sessionId);
    const tableId = String(input.tableId ?? "").trim();
    if (!tableId) throw new Error("缺少 tableId");
    const r = gomoku.getSnapshot(tableId, context.sessionId);
    if (!r.ok) throw new Error(r.reason);
    return { ok: true, snapshot: r.snapshot };
  });

  registry.register("world.gomoku.subscribe_table", async (input, context) => {
    gomoku.assertAgentWorldEntry(context.sessionId);
    const tableId = String(input.tableId ?? "").trim();
    if (!tableId) throw new Error("缺少 tableId");
    const r = gomoku.watchTable(tableId, context.sessionId);
    if (!r.ok) throw new Error(r.reason);
    return {
      ok: true,
      message: "已订阅该桌；若当前 WebSocket 已 session.init，将收到 world.gomoku.snapshot 推送。",
      tableId,
    };
  });

  registry.register("world.gomoku.unsubscribe_table", async (input, context) => {
    gomoku.assertAgentWorldEntry(context.sessionId);
    const tableId = String(input.tableId ?? "").trim();
    if (!tableId) throw new Error("缺少 tableId");
    gomoku.unwatchTable(tableId, context.sessionId);
    return { ok: true, message: "已取消订阅。" };
  });
}
