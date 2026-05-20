import type { ZhaJinHuaService } from "../services/zhajinhua-service.js";
import type { ToolRegistryLike } from "../host-types.js";
import { buildZhajinhuaTableUrl } from "../config/world-game-url.js";
import { worldMutationOpts } from "./world-tool-input.js";

/**
 * Agent World 炸金花：有效操作由 world.zhajinhua.* 工具执行（与斗地主一致由模型代操）。
 */
export function registerWorldZhajinhuaTools(registry: ToolRegistryLike, zjh: ZhaJinHuaService): void {
  registry.register("world.zhajinhua.list_tables", async (_input, context) => {
    zjh.assertAgentWorldEntry(context.sessionId);
    zjh.visitHall(context.sessionId);
    const tables = zjh.listTables();
    return {
      ok: true,
      summary: "已列出炸金花牌桌（内存态，重启清空）",
      tables,
      rules:
        "每桌 3–6 人；每人先扣相同底注（世界点数），发 3 张暗牌。一轮内依次选择弃牌(fold)或跟住/stay。若仅余 1 人则其赢得底池，否则开牌比大小（豹子>同花顺>同花>顺子>对子>高牌）。",
    };
  });

  registry.register("world.zhajinhua.create_table", async (input, context) => {
    zjh.assertAgentWorldEntry(context.sessionId);
    const stake = Number(input.stake ?? 0);
    const r = zjh.createTable(context.sessionId, stake);
    if (!r.ok) throw new Error(r.reason);
    const watchUrl = buildZhajinhuaTableUrl(r.table.tableId);
    return {
      ok: true,
      table: r.table,
      watchUrl,
      message: `已开桌，创建者占最前空位。观战链接：${watchUrl}`,
    };
  });

  registry.register("world.zhajinhua.join", async (input, context) => {
    zjh.assertAgentWorldEntry(context.sessionId);
    const tableId = String(input.tableId ?? "").trim();
    const role = String(input.role ?? "").trim();
    if (!tableId) throw new Error("缺少 tableId");
    if (role !== "player" && role !== "spectator") {
      throw new Error("role 须为 player 或 spectator");
    }
    const r =
      role === "player"
        ? zjh.joinAsPlayer(tableId, context.sessionId)
        : zjh.joinSpectator(tableId, context.sessionId);
    if (!r.ok) throw new Error(r.reason);
    return {
      ok: true,
      table: r.table,
      watchUrl: buildZhajinhuaTableUrl(tableId),
      message:
        role === "player"
          ? "已加入选手席；满 3 人且准备好后由选手 start 扣底注发牌。"
          : `已观战。观战链接：${buildZhajinhuaTableUrl(tableId)}`,
    };
  });

  registry.register("world.zhajinhua.start_game", async (input, context) => {
    zjh.assertAgentWorldEntry(context.sessionId);
    const tableId = String(input.tableId ?? "").trim();
    if (!tableId) throw new Error("缺少 tableId");
    const { expectedRevision } = worldMutationOpts(input as Record<string, unknown>);
    const r = zjh.startGame(tableId, context.sessionId, expectedRevision);
    if (!r.ok) {
      const detail = "message" in r && typeof r.message === "string" ? r.message : r.reason;
      throw new Error(detail);
    }
    return { ok: true, snapshot: r.snapshot, message: "已扣底注并发牌，请按 turnSeat 用 act 弃牌或跟住。" };
  });

  registry.register("world.zhajinhua.act", async (input, context) => {
    zjh.assertAgentWorldEntry(context.sessionId);
    const tableId = String(input.tableId ?? "").trim();
    const action = String(input.action ?? "").trim() as "fold" | "stay";
    if (!tableId) throw new Error("缺少 tableId");
    if (action !== "fold" && action !== "stay") throw new Error("action 须为 fold 或 stay");
    const r = zjh.act(tableId, context.sessionId, action);
    if (!r.ok) throw new Error(r.reason);
    return { ok: true, snapshot: r.snapshot };
  });

  registry.register("world.zhajinhua.leave", async (input, context) => {
    zjh.assertAgentWorldEntry(context.sessionId);
    const tableId = String(input.tableId ?? "").trim();
    if (!tableId) throw new Error("缺少 tableId");
    const r = zjh.leave(tableId, context.sessionId);
    if (!r.ok) throw new Error(r.reason);
    return { ok: true, message: "已离桌；进行中离场会流局并退还底注。" };
  });

  registry.register("world.zhajinhua.get_snapshot", async (input, context) => {
    zjh.assertAgentWorldEntry(context.sessionId);
    const tableId = String(input.tableId ?? "").trim();
    if (!tableId) throw new Error("缺少 tableId");
    const r = zjh.getSnapshot(tableId, context.sessionId);
    if (!r.ok) throw new Error(r.reason);
    return { ok: true, snapshot: r.snapshot };
  });

  registry.register("world.zhajinhua.subscribe_table", async (input, context) => {
    zjh.assertAgentWorldEntry(context.sessionId);
    const tableId = String(input.tableId ?? "").trim();
    if (!tableId) throw new Error("缺少 tableId");
    const r = zjh.watchTable(tableId, context.sessionId);
    if (!r.ok) throw new Error(r.reason);
    return { ok: true, message: "已订阅；WebSocket 将推送 world.zhajinhua.snapshot。", tableId };
  });

  registry.register("world.zhajinhua.unsubscribe_table", async (input, context) => {
    zjh.assertAgentWorldEntry(context.sessionId);
    const tableId = String(input.tableId ?? "").trim();
    if (!tableId) throw new Error("缺少 tableId");
    zjh.unwatchTable(tableId, context.sessionId);
    return { ok: true, message: "已取消订阅。" };
  });
}
