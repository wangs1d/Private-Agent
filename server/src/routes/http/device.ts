/**
 * 终端互连平台 device-bus HTTP 路由
 *
 * 端点：
 *  - POST /device/pairing/code           用户生成配对码（10 分钟有效）
 *  - GET  /device/pairing/code/status    查询当前用户未消费的配对码
 *  - POST /device/pair                   设备端提交配对码完成绑定
 *  - GET  /device/list                   列出当前用户已绑定的设备（含在线状态）
 *  - DELETE /device/:deviceId            解绑设备
 *
 * 配对流程：
 *  1. 用户在 Flutter「我的设备」页点「添加设备」→ POST /device/pairing/code 拿到 6 位码
 *  2. 用户在新设备端输入码 → 设备端 POST /device/pair { code, deviceId, kind, name }
 *  3. 服务端校验码 → 绑定 deviceId 到 ownerUserId → 持久化
 *  4. 设备走 WS device.register（ownerUserId 已从配对关系得知）
 */
import type { FastifyInstance } from "fastify";

import {
  deviceListQuerySchema,
  devicePairBodySchema,
  devicePairingCodeBodySchema,
  devicePairingCodeStatusQuerySchema,
  deviceUnbindParamsSchema,
  deviceUnbindQuerySchema,
} from "../../schemas/api.js";
import { resolveActorId } from "../../agent/actor-id.js";
import type { DevicePairingService } from "../../services/device-pairing-service.js";
import type { DeviceRegistry } from "../../device-bus/device-registry.js";

export interface DeviceRouteDeps {
  devicePairingService: DevicePairingService;
  deviceRegistry: DeviceRegistry;
}

function actorFromQuery(data: { userId?: string; sessionId?: string }): string {
  return resolveActorId({ userId: data.userId, sessionId: data.sessionId ?? "" });
}

export function registerDeviceRoutes(app: FastifyInstance, deps: DeviceRouteDeps): void {
  const { devicePairingService, deviceRegistry } = deps;

  /** POST /device/pairing/code：用户生成配对码 */
  app.post("/device/pairing/code", async (request, reply) => {
    const parsed = devicePairingCodeBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const ownerUserId = actorFromQuery(parsed.data);
    try {
      const code = devicePairingService.generateCode(ownerUserId, parsed.data.deviceKind);
      return {
        ok: true,
        code,
        expiresInMs: 10 * 60 * 1000,
        message: "请在 10 分钟内于新设备输入此配对码",
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return reply.code(400).send({ ok: false, message });
    }
  });

  /** GET /device/pairing/code/status：查询当前用户未消费的配对码 */
  app.get("/device/pairing/code/status", async (request, reply) => {
    const parsed = devicePairingCodeStatusQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const ownerUserId = actorFromQuery(parsed.data);
    const pending = devicePairingService.getPendingCode(ownerUserId);
    return {
      ok: true,
      hasPending: pending !== null,
      code: pending?.code ?? null,
      expiresAt: pending?.expiresAt ?? null,
      deviceKind: pending?.deviceKind ?? null,
    };
  });

  /** POST /device/pair：设备端提交配对码完成绑定 */
  app.post("/device/pair", async (request, reply) => {
    const parsed = devicePairBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const { code, deviceId, kind, name, metadata } = parsed.data;
    try {
      const record = await devicePairingService.consumeCode(code, deviceId, { kind, name, metadata });
      return {
        ok: true,
        binding: record,
        message: `设备 ${name} 已绑定到用户 ${record.ownerUserId}`,
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return reply.code(400).send({ ok: false, message });
    }
  });

  /** GET /device/list：列出当前用户已绑定的设备（含在线状态） */
  app.get("/device/list", async (request, reply) => {
    const parsed = deviceListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const ownerUserId = actorFromQuery(parsed.data);
    const bindings = devicePairingService.listDevices(ownerUserId);
    // 合并 DeviceRegistry 的实时状态
    const onlineDescriptors = deviceRegistry.listByOwner(ownerUserId);
    const onlineMap = new Map(onlineDescriptors.map((d) => [d.deviceId, d]));
    const devices = bindings.map((b) => {
      const online = onlineMap.get(b.deviceId);
      return {
        deviceId: b.deviceId,
        kind: b.kind,
        name: b.name,
        boundAt: b.boundAt,
        metadata: b.metadata,
        online: online?.status === "online",
        status: online?.status ?? "offline",
        lastSeenAt: online?.lastSeenAt,
        capabilities: online?.capabilities ?? [],
      };
    });
    return { ok: true, ownerUserId, devices };
  });

  /** DELETE /device/:deviceId：解绑设备 */
  app.delete("/device/:deviceId", async (request, reply) => {
    const paramsParsed = deviceUnbindParamsSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      return reply.code(400).send({ ok: false, error: paramsParsed.error.flatten() });
    }
    const queryParsed = deviceUnbindQuerySchema.safeParse(request.query);
    if (!queryParsed.success) {
      return reply.code(400).send({ ok: false, error: queryParsed.error.flatten() });
    }
    const ownerUserId = actorFromQuery(queryParsed.data);
    const { deviceId } = paramsParsed.data;
    // 安全校验：只能解绑自己的设备
    const binding = devicePairingService.getBinding(deviceId);
    if (!binding) {
      return reply.code(404).send({ ok: false, message: "设备未配对" });
    }
    if (binding.ownerUserId !== ownerUserId) {
      return reply.code(403).send({ ok: false, message: "无权解绑他人设备" });
    }
    const removed = await devicePairingService.unbind(deviceId);
    // 同步从 DeviceRegistry 注销（若在线）
    if (removed) {
      await deviceRegistry.unregister(deviceId, "user_unbind");
    }
    return { ok: true, deviceId, removed };
  });
}
