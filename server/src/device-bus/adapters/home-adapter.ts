/**
 * 智能家居适配器 —— 把 SmartHomeService 包成 DeviceAdapter
 *
 * HomeAssistant 是本地 HTTP 服务（非 WS 远程设备），所以本适配器：
 *  - requiresConnection = false
 *  - invoke 直接同步调用 SmartHomeService
 *  - 不支持 openStream（HA 设备状态用轮询，不是推流）
 *
 * 能力映射：
 *  - actuator.light     → HA domain "light"
 *  - actuator.switch    → HA domain "switch"
 *  - actuator.climate   → HA domain "climate"
 *  - actuator.cover     → HA domain "cover"
 *  - actuator.lock      → HA domain "lock"
 *  - scene              → HA domain "scene"（用 CapabilityId "actuator.scene" 扩展）
 *
 * action 约定："<capability_action_prefix>.<ha_service>"
 *   如 "actuator.light.turn_on" / "actuator.light.toggle" / "scene.activate"
 *   适配器解析后调用 smartHomeService.callService(domain, service, data)
 */
import type {
  DeviceAdapter,
  DeviceAdapterFactory,
  DeviceAdapterInit,
  AdapterStaticInfo,
} from "../device-adapter.js";
import type {
  CapabilityDeclaration,
  DeviceInvokeResult,
  DeviceStreamChunk,
} from "../device-model.js";
import type { SmartHomeService } from "../../services/smart-home-service.js";

/** HA domain → 能力前缀映射。 */
const DOMAIN_TO_CAPABILITY: Record<string, string> = {
  light: "actuator.light",
  switch: "actuator.switch",
  climate: "actuator.climate",
  cover: "actuator.cover",
  lock: "actuator.lock",
  scene: "actuator.scene",
};

/** 反向：能力前缀 → HA domain。 */
const CAPABILITY_TO_DOMAIN: Record<string, string> = Object.fromEntries(
  Object.entries(DOMAIN_TO_CAPABILITY).map(([d, c]) => [c, d]),
);

/** 家居设备默认能力清单。 */
const HOME_DEFAULT_CAPABILITIES: CapabilityDeclaration[] = [
  {
    id: "actuator.light",
    actions: ["turn_on", "turn_off", "toggle", "set_brightness", "set_color"],
  },
  {
    id: "actuator.switch",
    actions: ["turn_on", "turn_off", "toggle"],
  },
  {
    id: "actuator.climate",
    actions: ["set_temperature", "set_hvac_mode", "set_fan_mode", "turn_on", "turn_off"],
  },
  {
    id: "actuator.cover",
    actions: ["open", "close", "stop", "set_position"],
  },
  {
    id: "actuator.lock",
    actions: ["lock", "unlock"],
  },
  {
    id: "actuator.scene",
    actions: ["activate"],
  },
];

/**
 * 家居适配器实例。
 *
 * 一台 HA 网关 = 一个 HomeAdapter 实例（deviceId 由注册方决定，如 "home:default"）。
 * 多用户共享同一 HA 时，可在 bootstrap 时按 ownerId 注册多个虚拟设备指向同一 service。
 */
class HomeAdapter implements DeviceAdapter {
  readonly deviceId: string;
  readonly kind = "home" as const;
  private smartHome: SmartHomeService | null = null;
  private enabled = false;

  constructor(init: DeviceAdapterInit) {
    this.deviceId = init.descriptor.deviceId;
  }

  initialize(init: DeviceAdapterInit): void {
    // smartHome 由工厂在创建时注入（闭包捕获），此处只校验
    if (!this.smartHome) {
      throw new Error("HomeAdapter 未注入 SmartHomeService");
    }
    this.enabled = this.smartHome.isEnabled();
  }

  async invoke(action: string, params: Record<string, unknown>): Promise<DeviceInvokeResult> {
    if (!this.smartHome || !this.enabled) {
      return {
        ok: false,
        error: { code: "HOME_DISABLED", message: "HomeAssistant 未配置（HA_BASE_URL / HA_TOKEN 缺失）" },
      };
    }
    const startedAt = Date.now();
    try {
      // 特殊 action：列出所有设备状态
      if (action === "list_devices" || action === "device.list") {
        const states = await this.smartHome.getAllStates();
        return { ok: true, data: states, elapsedMs: Date.now() - startedAt };
      }
      if (action === "get_state") {
        const entityId = String(params.entityId ?? "");
        if (!entityId) {
          return { ok: false, error: { code: "BAD_PARAMS", message: "缺少 entityId" } };
        }
        const state = await this.smartHome.getState(entityId);
        return { ok: true, data: state, elapsedMs: Date.now() - startedAt };
      }
      // 通用 action：解析 "<capability_prefix>.<service>"
      const parsed = parseHomeAction(action);
      if (!parsed) {
        return {
          ok: false,
          error: { code: "BAD_ACTION", message: `无法解析家居 action: ${action}` },
        };
      }
      const { domain, service } = parsed;
      const data = extractServiceData(params);
      const result = await this.smartHome.callService(domain, service, data);
      return { ok: true, data: result, elapsedMs: Date.now() - startedAt };
    } catch (err) {
      return {
        ok: false,
        error: { code: "HOME_INVOKE_ERROR", message: err instanceof Error ? err.message : String(err) },
        elapsedMs: Date.now() - startedAt,
      };
    }
  }

  async *openStream(): AsyncIterable<DeviceStreamChunk> {
    // HA 不支持推流；返回 end chunk 即可
    yield { streamId: "", kind: "end" };
  }

  dispose(): void {
    // 无资源需要释放
  }
}

/** 解析 "actuator.light.turn_on" → { domain: "light", service: "turn_on" }。 */
function parseHomeAction(action: string): { domain: string; service: string } | null {
  // 优先匹配已知能力前缀
  for (const [cap, domain] of Object.entries(CAPABILITY_TO_DOMAIN)) {
    if (action.startsWith(cap + ".")) {
      const service = action.slice(cap.length + 1);
      if (!service) return null;
      return { domain, service };
    }
  }
  // scene.activate 特殊处理
  if (action === "scene.activate" || action.startsWith("actuator.scene.")) {
    const service = action.startsWith("actuator.scene.")
      ? action.slice("actuator.scene.".length)
      : "turn_on";
    return { domain: "scene", service: service || "turn_on" };
  }
  return null;
}

/** 从 params 中剥离适配器元字段，剩下的作为 HA service data。 */
function extractServiceData(params: Record<string, unknown>): Record<string, unknown> | undefined {
  const data: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (k === "entityId" || k === "entity_id") {
      data.entity_id = v;
    } else if (k !== "action" && k !== "deviceId") {
      data[k] = v;
    }
  }
  return Object.keys(data).length > 0 ? data : undefined;
}

/**
 * 创建家居适配器工厂。
 * bootstrap 时注入 SmartHomeService 实例。
 */
export function createHomeAdapterFactory(smartHome: SmartHomeService): DeviceAdapterFactory & AdapterStaticInfo {
  const factory = Object.assign(
    (init: DeviceAdapterInit): DeviceAdapter => {
      const adapter = new HomeAdapter(init);
      // 注入 service（绕过 initialize 的参数限制）
      (adapter as unknown as { smartHome: SmartHomeService }).smartHome = smartHome;
      return adapter;
    },
    {
      kind: "home" as const,
      requiresConnection: false,
      defaultCapabilities: HOME_DEFAULT_CAPABILITIES,
    },
  );
  return factory;
}
