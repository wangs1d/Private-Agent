import { resolveActorId } from "../../agent/actor-id.js";
import type { VirtualPhoneService } from "../../services/virtual-phone-service.js";
import type { SkillDefinition } from "../types.js";

type Deps = {
  virtualPhoneService: VirtualPhoneService;
};

/**
 * 内置 Skill：虚拟电话管理
 * 提供虚拟号码申领和拨打功能
 */
export function createVirtualPhoneBuiltinSkills(deps: Deps): SkillDefinition[] {
  const { virtualPhoneService } = deps;

  /**
   * Skill 1: 申领或查询虚拟号码
   */
  const ensure_my_number: SkillDefinition = {
    metadata: {
      name: "virtual-phone.ensure-my-number",
      version: "1.0.0",
      displayName: "申领本 Agent 虚拟电话号码",
      description:
        "为用户（经本 Agent）分配或查询 6 位虚拟联络号码，号码登记在 Agent 名下、与用户一体。仅在用户明确要求办理时调用；禁止主动占号。",
      kind: "builtin",
      tags: ["phone", "communication", "identity"],
      icon: "📞",
      parameters: [],
      outputSchema: {
        actorId: "本 Agent 的唯一标识",
        virtualPhone: "与用户共用的 6 位虚拟号码",
        summary: "操作结果说明",
      },
      permissions: [],
      timeoutMs: 3000,
    },
    handler: async (_input, context) => {
      const actorId = resolveActorId(context);
      try {
        const number = virtualPhoneService.ensureNumber(actorId);
        return {
          ok: true,
          actorId,
          virtualPhone: number,
          summary: `您的站内号码为 ${number}（登记在 Agent 名下，与您共用）。申领后即可使用虚拟电话服务。`,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          error: message,
        };
      }
    },
  };

  /**
   * Skill 2: 查询虚拟号码状态
   */
  const get_number_status: SkillDefinition = {
    metadata: {
      name: "virtual-phone.get-status",
      version: "1.0.0",
      displayName: "查询虚拟号码状态",
      description:
        "查询本 Agent 是否已申领站内号码。申领后方可呼出虚拟电话；接收来电不要求对方有号码。",
      kind: "builtin",
      tags: ["phone", "query", "status"],
      icon: "🔍",
      parameters: [],
      outputSchema: {
        hasNumber: "是否已申领号码",
        virtualPhone: "虚拟号码（如有）",
        actorId: "用户/Agent标识",
      },
      permissions: [],
      timeoutMs: 2000,
    },
    handler: async (_input, context) => {
      const actorId = resolveActorId(context);
      const virtualPhone = virtualPhoneService.getPhoneForActor(actorId);
      return {
        ok: true,
        actorId,
        hasNumber: virtualPhone !== undefined,
        virtualPhone: virtualPhone || null,
        message: virtualPhone
          ? `您的虚拟号码为：${virtualPhone}（与 Agent 共用）`
          : "尚未申领站内号码；办理后即可使用虚拟电话呼出。App 内呼叫 Agent 无需另输号码。",
      };
    },
  };

  return [ensure_my_number, get_number_status];
}

/**
 * 注册虚拟电话内置Skills到SkillManager
 */
export function registerVirtualPhoneBuiltinSkills(
  register: (skill: SkillDefinition) => void,
  deps: Deps,
): void {
  for (const s of createVirtualPhoneBuiltinSkills(deps)) {
    register(s);
  }
}
