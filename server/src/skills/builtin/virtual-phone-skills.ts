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
      displayName: "申领虚拟电话号码",
      description:
        "为当前用户/Agent分配或查询6位虚拟电话号码。仅在用户明确要求办理时调用，禁止主动调用或帮用户提前占号。重复调用返回已有号码。",
      kind: "builtin",
      tags: ["phone", "communication", "identity"],
      icon: "📞",
      parameters: [],
      outputSchema: {
        actorId: "用户/Agent的唯一标识",
        virtualPhone: "6位数字虚拟号码",
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
          summary: `你的 6 位虚拟号码为 ${number}。仅在你明确要求办理时才会申领；其他 Agent 可用此号码拨打你（配对规则同中继）。`,
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
        "查询当前用户/Agent是否已申领虚拟号码，以及号码详情。用于确认是否需要先申领号码再拨打。",
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
          ? `您已申领虚拟号码：${virtualPhone}`
          : "您尚未申领虚拟号码，请先申领后再使用拨打功能",
      };
    },
  };

  /**
   * Skill 3: 通过号码查询Actor ID（内部工具，不直接暴露给用户）
   */
  const resolve_actor_by_phone: SkillDefinition = {
    metadata: {
      name: "virtual-phone.resolve-actor",
      version: "1.0.0",
      displayName: "解析号码对应的Actor",
      description:
        "根据6位虚拟号码查询对应的Actor ID。用于内部验证和调试，普通用户不应直接使用。",
      kind: "builtin",
      tags: ["phone", "internal", "debug"],
      parameters: [
        {
          name: "phone",
          type: "string",
          required: true,
          description: "6位数字虚拟号码",
        },
      ],
      outputSchema: {
        actorId: "对应的Actor ID",
        phone: "查询的号码",
      },
      permissions: [],
      timeoutMs: 2000,
    },
    handler: async (input, _context) => {
      const phone = String(input.phone ?? "").trim();
      if (!phone || phone.length !== 6 || !/^\d{6}$/.test(phone)) {
        return {
          ok: false,
          error: "无效的虚拟号码，必须是6位数字",
        };
      }
      const actorId = virtualPhoneService.resolveActorByPhone(phone);
      return {
        ok: true,
        phone,
        actorId: actorId || null,
        exists: actorId !== undefined,
      };
    },
  };

  return [ensure_my_number, get_number_status, resolve_actor_by_phone];
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
