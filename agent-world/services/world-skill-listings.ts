import type { SkillManagerLike } from "../host-types.js";
import { mockSkillPrice, type WorldService } from "./world-service.js";

export function skillMarketListingsForSession(
  roomId: string,
  worldService: WorldService,
  skillManager: SkillManagerLike,
): {
  state: ReturnType<WorldService["getOrCreate"]>;
  items: Array<{
    skillId: string;
    displayName: string;
    description: string;
    version: string;
    tags: string[];
    icon?: string;
    kind: string;
    author?: string;
    price: number;
    owned: boolean;
  }>;
} {
  const state = roomId.startsWith("wr-")
    ? worldService.getExisting(roomId)
    : worldService.getOrCreate(roomId);
  if (!state) {
    throw new Error(`ROOM_NOT_FOUND: ${roomId}`);
  }
  const manifests = skillManager.list(true);
  const items: Array<{
    skillId: string;
    displayName: string;
    description: string;
    version: string;
    tags: string[];
    icon?: string;
    kind: string;
    author?: string;
    price: number;
    owned: boolean;
  }> = [];
  return { state, items };
}
