import type { ToolHandler, ToolContext } from "../../tool-registry.js";
import { resolveActorId } from "../../../agent/actor-id.js";
import { maskPhone, type SafetyGuardService } from "../../../services/safety-guard-service.js";

/**
 * safety.* 工具 handler 集合。
 *
 * handler 只做入参清洗 + actorId 解析；SOS 结果的 summary 已包含给 LLM 的
 * 转述要求（联系人送达情况 + 「110/120 永远优先」提醒），避免 LLM 漏说。
 */

export function createSafetySetContactHandler(service: SafetyGuardService): ToolHandler {
  return async (input, context) => {
    const actorId = resolveActorId(context);
    const settings = input.settings as Record<string, unknown> | undefined;

    // 纯偏好设置（无联系人字段）与联系人增改共用入口
    const hasContact = input.name != null || input.phone != null;
    const settingsPatch: Record<string, unknown> = {};
    if (settings && typeof settings === "object") {
      if (typeof settings.my_mobile_number === "string") settingsPatch.myMobileNumber = settings.my_mobile_number;
      if (typeof settings.sos_note === "string") settingsPatch.sosNote = settings.sos_note;
      if (typeof settings.fake_call_script === "string") settingsPatch.fakeCallScript = settings.fake_call_script;
    }

    const out: Record<string, unknown> = {};
    if (hasContact) {
      const name = String(input.name ?? "").trim();
      const phone = String(input.phone ?? "").trim();
      if (!name || !phone) {
        return { ok: false, error: "新增/更新紧急联系人需要 name 与 phone" };
      }
      try {
        const { contact, merged } = await service.setContact(actorId, {
          ...(typeof input.contact_id === "string" && input.contact_id.trim()
            ? { id: input.contact_id.trim() }
            : {}),
          name,
          phone,
          ...(typeof input.relationship === "string" && input.relationship.trim()
            ? { relationship: input.relationship }
            : {}),
          ...(typeof input.is_primary === "boolean" ? { isPrimary: input.is_primary } : {}),
        });
        out.contact = { ...contact, phone: maskPhone(contact.phone) };
        out.contact_id = contact.id;
        out.merged = merged;
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    if (Object.keys(settingsPatch).length > 0) {
      out.settings = await service.updateSettings(actorId, settingsPatch);
    }
    if (!hasContact && Object.keys(settingsPatch).length === 0) {
      return { ok: false, error: "缺少内容：请提供联系人（name/phone）或 settings（my_mobile_number 等）" };
    }
    out.ok = true;
    out.summary = hasContact
      ? `紧急联系人已${out.merged ? "更新" : "保存"}（${String(input.name)}）`
      : "安全设置已更新";
    return out;
  };
}

export function createSafetyGetContactsHandler(service: SafetyGuardService): ToolHandler {
  return async (_input, context) => {
    const actorId = resolveActorId(context);
    const contacts = service.listContacts(actorId);
    const settings = service.getSettings(actorId);
    return {
      ok: true,
      contacts,
      settings,
      count: contacts.length,
      summary:
        contacts.length === 0
          ? "还没有紧急联系人；可以说「把 XX（手机号）设为我的紧急联系人」"
          : `共 ${contacts.length} 位紧急联系人：${contacts
              .map((c) => `${c.name}${c.isPrimary ? "（主）" : ""}`)
              .join("、")}`,
    };
  };
}

export function createSafetyRemoveContactHandler(service: SafetyGuardService): ToolHandler {
  return async (input, context) => {
    const actorId = resolveActorId(context);
    const contactId = String(input.contact_id ?? "").trim();
    if (!contactId) {
      return { ok: false, error: "缺少 contact_id（先调 safety.get_contacts 获取）" };
    }
    const removed = await service.removeContact(actorId, contactId);
    return removed
      ? { ok: true, removed, summary: "已移除该紧急联系人" }
      : { ok: false, error: "没有找到这个联系人 id，请先调 safety.get_contacts 核对" };
  };
}

export function createSafetySosHandler(service: SafetyGuardService): ToolHandler {
  return async (input, context) => {
    const actorId = resolveActorId(context);
    const reason =
      typeof input.reason === "string" && input.reason.trim() ? input.reason.trim() : undefined;
    const result = await service.triggerSos(actorId, { ...(reason ? { reason } : {}) });
    if (!result.ok) {
      return {
        ok: false,
        needsSetup: result.needsSetup,
        emergencyHint: result.emergencyHint,
        error: result.error,
        // 未配置联系人时的转述纪律：第一句话永远是「直接打 110」
        summary:
          "紧急求助未能代发：未配置紧急联系人。请第一句话就告诉用户「现在直接拨打 110」，之后再引导配置紧急联系人",
      };
    }
    return { ...result, ok: true };
  };
}

export function createSafetyFakeCallHandler(service: SafetyGuardService): ToolHandler {
  return async (input, context) => {
    const actorId = resolveActorId(context);
    const result = await service.requestFakeCall(actorId, {
      ...(typeof input.goal === "string" && input.goal.trim() ? { goal: input.goal } : {}),
      ...(typeof input.script === "string" && input.script.trim() ? { script: input.script } : {}),
    });
    return result;
  };
}
