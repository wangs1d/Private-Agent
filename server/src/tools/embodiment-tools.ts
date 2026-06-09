import type { ChatCompletionTool } from "openai/resources/chat/completions";

import { resolveActorId } from "../agent/actor-id.js";
import {
  emitEmbodimentPatch,
  pushEmbodimentCommand,
  type EmbodimentMood,
} from "../services/agent-embodiment.js";
import type { DesktopBridgeCoordinator } from "../services/desktop-bridge-coordinator.js";
import type { DesktopVisualPort } from "../services/desktop-visual-port.js";
import { getEmbodimentObserveService } from "../services/embodiment-observe-service.js";
import type { WsConnectionRegistry } from "../services/ws-connection-registry.js";
import type { VisionFrame } from "../external-model/types.js";
import type { ToolRegistry } from "./tool-registry.js";

const INJECT_KEY = "_injectVisionUserMessage";

const EMBODIMENT_MOODS: EmbodimentMood[] = [
  "idle",
  "listening",
  "thinking",
  "happy",
  "alert",
];

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function sendPatch(
  wsRegistry: WsConnectionRegistry,
  sessionId: string,
  patch: Parameters<typeof emitEmbodimentPatch>[2],
): { delivered: boolean } {
  const delivered = wsRegistry.trySend(
    sessionId,
    JSON.stringify({
      type: "agent.embodiment.patch",
      payload: { sessionId, ...patch },
    }),
  );
  return { delivered };
}

export type EmbodimentToolsDeps = {
  wsRegistry: WsConnectionRegistry;
  localVisual?: DesktopVisualPort;
  bridge?: DesktopBridgeCoordinator;
};

/** LLM 可见的具身工具定义 */
export const EMBODIMENT_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "embodiment.observe",
      description:
        "观察你的球形身体在屏幕上的位置（客户端回报坐标；可选附带全屏截图注入视觉上下文）。用户要求挪动、说挡路、或需确认移动结果时，必须先调用本工具分析，再调用 embodiment.window_place。可在一轮对话中多次 observe→place 闭环。",
      parameters: {
        type: "object",
        properties: {
          includeScreenshot: {
            type: "boolean",
            description: "是否附带全屏截图供视觉分析，默认 true（需电脑桥接在线或服务端 DESKTOP_VISUAL_ENABLED）",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "embodiment.window_place",
      description:
        "将球形悬浮窗中心移动到屏幕归一化坐标 screenX/screenY（0～1）。根据 embodiment.observe 或截图分析结果计算目标点；delivered 为 false 时勿声称已移动。",
      parameters: {
        type: "object",
        properties: {
          screenX: { type: "number", description: "横向 0=最左，1=最右" },
          screenY: { type: "number", description: "纵向 0=最上，1=最下" },
        },
        required: ["screenX", "screenY"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "embodiment.roam",
      description:
        "驱动球形身体在 3D 场景内随机漫游，并带动悬浮层换位置（无明确目标时用）。有明确屏幕目标时请 observe + window_place。",
      parameters: {
        type: "object",
        properties: {
          strength: {
            type: "number",
            description: "漫游强度 0.2～2，默认 1",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "embodiment.move",
      description:
        "将球形身体移动到 3D 场景中的目标坐标（米级）。屏幕位置请用 window_place。",
      parameters: {
        type: "object",
        properties: {
          x: { type: "number", description: "目标 x" },
          y: { type: "number", description: "目标 y（高度）" },
          z: { type: "number", description: "目标 z" },
        },
        required: ["x", "z"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "embodiment.stop",
      description: "停止球形身体的自主漫游与移动，恢复平稳悬浮。",
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
      name: "embodiment.set_state",
      description:
        "设置球形身体的表情与屏幕文案（mood/energy/caption）。用于表达情绪、提示用户当前在做什么。",
      parameters: {
        type: "object",
        properties: {
          mood: {
            type: "string",
            enum: EMBODIMENT_MOODS,
            description: "idle|listening|thinking|happy|alert",
          },
          energy: { type: "number", description: "0～1 呼吸灯强度" },
          caption: { type: "string", description: "玻璃屏短文案；传空字符串清除" },
        },
        required: ["mood"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "embodiment.excite",
      description:
        "主 Agent 突然兴奋，驱动球形身体乱飞、弹边界、做夸张动作。",
      parameters: {
        type: "object",
        properties: {
          strength: {
            type: "number",
            description: "兴奋强度 0.5～2，默认 1.4",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "embodiment.window_roam",
      description: "将球形悬浮体随机移动到屏幕另一位置（无明确目标、不需精调时用）。",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
];

async function tryCaptureScreenshot(
  actorId: string,
  deps: EmbodimentToolsDeps,
): Promise<{ frames?: VisionFrame[]; screenshotMeta?: Record<string, unknown> }> {
  const bridge = deps.bridge;
  const local = deps.localVisual;

  if (bridge?.hasExecutor(actorId)) {
    const remote = await bridge.invoke(actorId, { action: "screenshot", region: null }, 45_000);
    if (remote?.ok && remote.imageBase64) {
      const frame: VisionFrame = {
        sourceKind: "agent_attachment",
        sourceId: "embodiment.observe",
        mimeType: remote.mimeType ?? "image/png",
        dataBase64: remote.imageBase64,
        capturedAt: remote.capturedAt,
      };
      return {
        frames: [frame],
        screenshotMeta: {
          screenshot: true,
          width: remote.width,
          height: remote.height,
          via: "desktop_bridge",
        },
      };
    }
  }

  if (local?.isEnabled() && local.screenshot) {
    const result = await local.screenshot();
    if (result.ok && result.imageBase64) {
      const frame: VisionFrame = {
        sourceKind: "agent_attachment",
        sourceId: "embodiment.observe",
        mimeType: result.mimeType ?? "image/png",
        dataBase64: result.imageBase64,
        capturedAt: result.capturedAt,
      };
      return {
        frames: [frame],
        screenshotMeta: {
          screenshot: true,
          width: result.width,
          height: result.height,
          via: "local_desktop_visual",
        },
      };
    }
  }

  return {
    screenshotMeta: {
      screenshot: false,
      reason:
        "截图不可用：请设置 DESKTOP_BRIDGE_ENABLED=1 并保持 Windows Flutter 客户端在线，或运行 Python 桥接 / DESKTOP_VISUAL_ENABLED",
    },
  };
}

export function registerEmbodimentTools(
  toolRegistry: ToolRegistry,
  deps: EmbodimentToolsDeps,
): void {
  const { wsRegistry } = deps;
  const observeSvc = getEmbodimentObserveService();

  toolRegistry.register("embodiment.observe", async (input, context) => {
    const actorId = resolveActorId(context);
    const includeScreenshot = input.includeScreenshot !== false;

    const querySent = observeSvc.requestClientState(wsRegistry, actorId);
    const state = querySent ? await observeSvc.waitForState(actorId) : null;

    const shot = includeScreenshot ? await tryCaptureScreenshot(actorId, deps) : {};

    const body: Record<string, unknown> = {
      ok: Boolean(state) || Boolean(shot.frames?.length),
      querySent,
      clientState: state,
      hint:
        "根据 centerScreenX/Y 或截图判断身体在屏幕何处；需要挪动时调用 embodiment.window_place(screenX, screenY)。可再次 observe 验证。",
      ...shot.screenshotMeta,
    };

    if (shot.frames?.length) {
      body[INJECT_KEY] = shot.frames;
    }

    if (!state && !shot.frames?.length) {
      body.ok = false;
      body.error =
        "无法观察身体位置：客户端未回报坐标且截图不可用。请确认 App 已连接 WebSocket、桌宠已启动，或开启电脑桥接/桌面截图。";
    }

    return body;
  });

  toolRegistry.register("embodiment.window_place", async (input, context) => {
    const actorId = resolveActorId(context);
    const screenX =
      typeof input.screenX === "number" && Number.isFinite(input.screenX)
        ? clamp(input.screenX, 0, 1)
        : undefined;
    const screenY =
      typeof input.screenY === "number" && Number.isFinite(input.screenY)
        ? clamp(input.screenY, 0, 1)
        : undefined;
    if (screenX === undefined || screenY === undefined) {
      return { ok: false, delivered: false, error: "需要 screenX 与 screenY（0～1）" };
    }
    const delivered = pushEmbodimentCommand(wsRegistry, actorId, {
      action: "window_place",
      screenX,
      screenY,
      source: "tool:embodiment.window_place",
    });
    return embodimentCommandResult(delivered, { screenX, screenY });
  });

  toolRegistry.register("embodiment.roam", async (input, context) => {
    const actorId = resolveActorId(context);
    const strength =
      typeof input.strength === "number" && Number.isFinite(input.strength)
        ? clamp(input.strength, 0.2, 2)
        : 1;
    const delivered = pushEmbodimentCommand(wsRegistry, actorId, {
      action: "roam",
      strength,
      source: "tool:embodiment.roam",
    });
    return { ok: delivered, delivered, strength };
  });

  toolRegistry.register("embodiment.move", async (input, context) => {
    const actorId = resolveActorId(context);
    const x = typeof input.x === "number" && Number.isFinite(input.x) ? input.x : 0;
    const z = typeof input.z === "number" && Number.isFinite(input.z) ? input.z : 0;
    const y =
      typeof input.y === "number" && Number.isFinite(input.y)
        ? clamp(input.y, 0.8, 2.6)
        : 1.6;
    const delivered = pushEmbodimentCommand(wsRegistry, actorId, {
      action: "move",
      x: clamp(x, -2.4, 2.4),
      y,
      z: clamp(z, -2.4, 2.4),
      source: "tool:embodiment.move",
    });
    return { ok: delivered, delivered, x, y, z };
  });

  toolRegistry.register("embodiment.stop", async (_input, context) => {
    const actorId = resolveActorId(context);
    const delivered = pushEmbodimentCommand(wsRegistry, actorId, {
      action: "stop",
      source: "tool:embodiment.stop",
    });
    return { ok: delivered, delivered };
  });

  toolRegistry.register("embodiment.set_state", async (input, context) => {
    const actorId = resolveActorId(context);
    const moodRaw = String(input.mood ?? "idle").trim() as EmbodimentMood;
    const mood = EMBODIMENT_MOODS.includes(moodRaw) ? moodRaw : "idle";
    const energy =
      typeof input.energy === "number" && Number.isFinite(input.energy)
        ? clamp(input.energy, 0, 1)
        : undefined;
    const captionRaw = input.caption;
    const caption =
      captionRaw === "" || captionRaw === null
        ? null
        : typeof captionRaw === "string"
          ? captionRaw.slice(0, 120)
          : undefined;
    const { delivered } = sendPatch(wsRegistry, actorId, {
      mood,
      energy,
      caption,
      source: "tool:embodiment.set_state",
    });
    return { ok: delivered, delivered, mood, energy, caption };
  });

  toolRegistry.register("embodiment.excite", async (input, context) => {
    const actorId = resolveActorId(context);
    const strength =
      typeof input.strength === "number" && Number.isFinite(input.strength)
        ? clamp(input.strength, 0.5, 2)
        : 1.4;
    const delivered = pushEmbodimentCommand(wsRegistry, actorId, {
      action: "excite",
      strength,
      source: "tool:embodiment.excite",
    });
    return { ok: delivered, delivered, strength };
  });

  toolRegistry.register("embodiment.window_roam", async (_input, context) => {
    const actorId = resolveActorId(context);
    const delivered = pushEmbodimentCommand(wsRegistry, actorId, {
      action: "window_roam",
      source: "tool:embodiment.window_roam",
    });
    return embodimentCommandResult(delivered);
  });
}

function embodimentCommandResult(
  delivered: boolean,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ok: delivered,
    delivered,
    ...(delivered
      ? extra
      : {
          ...extra,
          error:
            "具身指令未送达客户端（请确认 App 已连接 WebSocket 且球形桌宠/浮层在线）",
        }),
  };
}
