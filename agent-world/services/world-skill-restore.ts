import type { AuditServiceLike, SkillManagerLike } from "../host-types.js";
import type { WorldService } from "./world-service.js";

/**
 * 进程启动后根据 `world-state.json` 中各会话的 `ownedSkillIds` 并集，重新 `setEnabled` 并授予元数据中的权限。
 * （与 `purchaseSkill` 行为对齐；Skill 注册表须已加载含社区技能。）
 */
export async function restorePurchasedSkillsFromWorldState(
  world: WorldService,
  skillManager: SkillManagerLike,
  audit?: AuditServiceLike,
): Promise<{ restored: string[]; missingFromRegistry: string[] }> {
  const union = new Set<string>();
  for (const roomId of world.listRoomIds()) {
    const s = world.getOrCreate(roomId);
    for (const id of s.ownedSkillIds) {
      union.add(id);
    }
  }

  const restored: string[] = [];
  const missingFromRegistry: string[] = [];

  for (const skillId of union) {
    const manifest = skillManager.get(skillId);
    if (!manifest) {
      missingFromRegistry.push(skillId);
      continue;
    }
    try {
      skillManager.setEnabled(skillId, true);
      if (manifest.permissions?.length) {
        skillManager.grantPermissions(skillId, manifest.permissions);
      }
      restored.push(skillId);
    } catch (e) {
      missingFromRegistry.push(skillId);
      console.warn(`[WorldState] 恢复技能启用失败: ${skillId}`, e);
    }
  }

  if (audit) {
    await audit.record({
      type: "world.skills_restore",
      at: new Date().toISOString(),
      restoredCount: restored.length,
      restored,
      missingFromRegistry,
    });
  }

  return { restored, missingFromRegistry };
}
