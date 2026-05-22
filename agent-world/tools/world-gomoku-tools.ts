import type { GomokuService } from "../services/gomoku-service.js";
import type { ToolRegistryLike } from "../host-types.js";
import { buildGomokuTableUrl } from "../config/world-game-url.js";

/**
 * Agent World 五子棋：用户与 Agent 对战工具。
 * 前缀 `world.gomoku.*`，见 `GET /chat/tools`。
 */
export function registerWorldGomokuTools(registry: ToolRegistryLike, gomoku: GomokuService): void {
  // 🔴 注册状态连续性约束（见 .trae/rules/project_rules.md）
  if ('registerStatefulModule' in registry) {
    (registry as unknown as { registerStatefulModule: (config: import("../deps/tools/tool-registry.js").StatefulToolConfig) => void }).registerStatefulModule({
      modulePrefix: "world.gomoku",
      snapshotToolName: "world.gomoku.get_snapshot",
      validStatuses: ["waiting", "playing", "finished"],
      mustReturnSnapshot: true,
    });
  }

  registry.register("world.gomoku.list_tables", async (_input, context) => {
    gomoku.assertAgentWorldEntry(context.sessionId);
    gomoku.visitHall(context.sessionId);
    const tables = gomoku.listTables();
    return {
      ok: true,
      summary: "已列出当前五子棋桌（内存态，重启清空）",
      tables,
      hint: "双人游戏：开桌时 userColor 定用户黑白，另一人加入后自动开始。",
    };
  });

  registry.register("world.gomoku.create_table", async (input, context) => {
    gomoku.assertAgentWorldEntry(context.sessionId);
    const raw = String(input.userColor ?? input.humanColor ?? "random").trim().toLowerCase();
    const userColor =
      raw === "black" || raw === "white" || raw === "random"
        ? (raw as "black" | "white" | "random")
        : "random";
    const r = gomoku.createTable(context.sessionId, { userColor });
    if (!r.ok) throw new Error(r.reason);
    const playUrl = buildGomokuTableUrl(r.table.tableId);
    const human = r.table.humanColor === "black" ? "黑棋（先手）" : "白棋（后手）";
    const agent = r.table.agentColor === "black" ? "黑棋（先手）" : "白棋（后手）";
    return {
      ok: true,
      table: r.table,
      playUrl,
      message: `棋局已开好：用户${human}，Agent${agent}。客户端会展示「在 App 内进入对局」按钮，勿在回复中重复粘贴 playUrl。`,
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
    const playUrl = buildGomokuTableUrl(tableId);
    return {
      ok: true,
      table: r.table,
      playUrl,
      message:
        role === "player"
          ? "已加入对局，你执白棋（后手）。点击下方按钮进入对局。"
          : "已进入观战席。点击下方按钮进入观战。",
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
