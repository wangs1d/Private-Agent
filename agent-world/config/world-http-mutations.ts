import type { FastifyReply } from "fastify";

/**
 * 是否允许通过 HTTP 修改 Agent World（开桌、入座、休闲、购买等）。
 * 默认关闭：用户端仅观战；出牌等游戏操作仅由 Agent 经工具在进程内执行。
 * 本地/集成测试可设 `ALLOW_WORLD_HTTP_MUTATIONS=1`。
 */
export function allowWorldHttpMutations(): boolean {
  return process.env.ALLOW_WORLD_HTTP_MUTATIONS === "1";
}

/**
 * 五子棋面向终端用户（Web 开桌/加入/落子），始终允许 HTTP 写操作。
 * Agent 开桌走 `world.gomoku.create_table` 工具；用户打开 playUrl 后须能经 HTTP 执白落子。
 */
export function allowGomokuUserHttpMutations(): boolean {
  return true;
}

/** 若禁止 HTTP 写操作则回复 403 并返回 true（调用方应 `return`）。 */
export function replyIfWorldHttpMutationsForbidden(reply: FastifyReply): boolean {
  if (allowWorldHttpMutations()) return false;
  void reply.code(403).send({
    ok: false,
    reason: "VIEWER_ONLY",
    message:
      "Agent World 的写操作仅由 Agent 在服务端通过工具完成；HTTP 客户端为观战模式。调试可设置环境变量 ALLOW_WORLD_HTTP_MUTATIONS=1。",
  });
  return true;
}
