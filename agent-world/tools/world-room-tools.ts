import type { ToolRegistryLike } from "../host-types.js";
import type { WorldService } from "../services/world-service.js";

/**
 * 共享房间：`roomId` 与 `ownerSessionId` 解耦（`wr-<uuid>`）。
 */
export function registerWorldRoomTools(registry: ToolRegistryLike, worldService: WorldService): void {
  registry.register("world.room.create", async (_input, context) => {
    worldService.assertAgentWorldRegistered(context.sessionId);
    const roomId = worldService.createSharedRoom(context.sessionId);
    return {
      ok: true,
      roomId,
      ownerSessionId: context.sessionId,
      message: "已创建共享世界房间；可将 roomId 传入 world.partition.attach、工具 roomId 与 HTTP roomId 参数",
    };
  });
}
