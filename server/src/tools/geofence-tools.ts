/**
 * 位置方案 C 工具面：geofence.* 显式工具（Agent 调用）。
 *
 * 用途：用户对 Agent 说「我到家附近时提醒我拿快递」「每次离开公司给我跑 xx」
 * 时创建围栏；geofence.list / delete 供查询与撤销。围栏是用户显式授权的
 * 位置触发器——创建/删除全量审计，事件触发审计在装配层 notifier 统一落账。
 *
 * 工具集（并入 getBuiltinAgentChatTools + ToolRegistry）：
 *   geofence.create / geofence.list / geofence.delete
 */

import type { ChatCompletionTool } from "openai/resources/chat/completions";

import { resolveActorId } from "../agent/actor-id.js";
import type { AuditService } from "../services/audit-service.js";
import type {
  GeofenceActionType,
  GeofenceDefinition,
  GeofenceEventKind,
  GeofenceService,
} from "../services/geofence-service.js";
import type { ToolRegistry } from "./tool-registry.js";

export const GEOFENCE_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "geofence.create",
      description: [
        "创建一个地理围栏：当用户到达（enter）或离开（leave）指定地点时自动触发动作。",
        "仅当用户明确提出位置提醒/位置自动化需求时调用（如「到家提醒我…」「每次到公司…」）。",
        "必须先向用户复述围栏参数（地点、半径、触发方向、动作）确认后再创建。",
      ].join(" "),
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "围栏名称，如「家」「公司」" },
          latitude: { type: "number", description: "围栏中心纬度（-90..90）" },
          longitude: { type: "number", description: "围栏中心经度（-180..180）" },
          radiusMeters: {
            type: "number",
            description: "围栏半径（米），20..10000；家/办公定点建议 100-300",
          },
          event: {
            type: "string",
            enum: ["enter", "leave", "both"],
            description: "触发方向：enter 到达 / leave 离开 / both 两者",
          },
          actionType: {
            type: "string",
            enum: ["reminder", "agent_task", "webhook"],
            description: "触发动作类型：reminder 提醒 / agent_task 让 Agent 执行任务 / webhook 回调外部系统",
          },
          actionConfig: {
            type: "object",
            description: [
              "动作参数（按 actionType）：",
              "reminder → { title: 提醒标题, note?: 补充说明 }；",
              "agent_task → { goal: 任务目标描述 }；",
              "webhook → { url: 回调地址, headers?: 自定义请求头, secret?: 签名密钥 }",
            ].join(" "),
          },
        },
        required: ["name", "latitude", "longitude", "radiusMeters", "event", "actionType", "actionConfig"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "geofence.list",
      description: "列出当前用户的地理围栏。用户问「我有哪些位置提醒」时调用。",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "geofence.delete",
      description: "删除一个地理围栏。用户说「取消到家提醒」「删掉公司围栏」时调用。",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "围栏 id（geofence.list 查到）" },
        },
        required: ["id"],
        additionalProperties: false,
      },
    },
  },
];

function summarize(f: GeofenceDefinition): Record<string, unknown> {
  return {
    id: f.id,
    name: f.name,
    latitude: f.latitude,
    longitude: f.longitude,
    radiusMeters: f.radiusMeters,
    event: f.event,
    actionType: f.actionType,
    actionConfig: f.actionConfig,
    enabled: f.enabled,
    createdAt: f.createdAt,
  };
}

/** 注册 geofence.* 工具执行器（create-app-services 装配时调用） */
export function registerGeofenceTools(
  registry: ToolRegistry,
  deps: { service: GeofenceService; audit?: AuditService | null },
): void {
  const { service, audit } = deps;

  registry.register("geofence.create", async (input, context) => {
    const actorId = resolveActorId(context);
    const actionConfig =
      input.actionConfig && typeof input.actionConfig === "object"
        ? (input.actionConfig as Record<string, unknown>)
        : {};

    const result = service.create(actorId, {
      name: String(input.name ?? ""),
      latitude: Number(input.latitude),
      longitude: Number(input.longitude),
      radiusMeters: Number(input.radiusMeters),
      event: String(input.event ?? "") as GeofenceEventKind,
      actionType: String(input.actionType ?? "") as GeofenceActionType,
      actionConfig,
    });
    if ("error" in result) return { ok: false, error: result.error };

    void audit
      ?.record({
        type: "geofence.create",
        actorId,
        fenceId: result.id,
        name: result.name,
        latitude: result.latitude,
        longitude: result.longitude,
        radiusMeters: result.radiusMeters,
        event: result.event,
        actionType: result.actionType,
        at: result.createdAt,
      })
      .catch(() => {});
    return { ok: true, geofence: summarize(result) };
  });

  registry.register("geofence.list", async (_input, context) => {
    const actorId = resolveActorId(context);
    const items = service.list(actorId);
    return { ok: true, count: items.length, geofences: items.map(summarize) };
  });

  registry.register("geofence.delete", async (input, context) => {
    const actorId = resolveActorId(context);
    const id = String(input.id ?? "").trim();
    const removed = service.delete(actorId, id);
    if (!removed) return { ok: false, error: `围栏不存在: ${id}` };
    void audit?.record({ type: "geofence.delete", actorId, fenceId: id, at: new Date().toISOString() }).catch(() => {});
    return { ok: true, deleted: id };
  });
}
