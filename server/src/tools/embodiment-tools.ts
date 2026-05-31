import type { ChatCompletionTool } from "openai/resources/chat/completions";

import { resolveActorId } from "../agent/actor-id.js";
import {
  emitEmbodimentPatch,
  pushEmbodimentCommand,
  type EmbodimentMood,
} from "../services/agent-embodiment.js";
import type { WsConnectionRegistry } from "../services/ws-connection-registry.js";
import type { ToolRegistry } from "./tool-registry.js";

const EMBODIMENT_MOODS: EmbodimentMood[] = [
  "idle",
  "listening",
  "thinking",
  "speaking",
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

/** LLM 可见的具身工具定义 */
export const EMBODIMENT_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "embodiment.roam",
      description:
        "驱动你的球形身体漫游：3D 场景内随机移动，并同时驱动 Web/桌面悬浮层在屏幕上换位置。用户要求走动、逛逛、动一动时使用；仅移动屏幕位置可用 embodiment.window_roam。",
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
        "将球形身体移动到 3D 场景中的目标坐标（米级，原点附近）。x/z 约 -2.4～2.4，y 约 1.0～2.4。",
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
            description: "idle|listening|thinking|speaking|happy|alert",
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
        "主 Agent 突然兴奋，驱动球形身体乱飞、弹边界、做夸张动作。聊嗨了、说到激动处、想表达强烈情绪时使用；比 embodiment.roam 更狂。",
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
      description:
        "将球形悬浮体随机移动到屏幕/页面可视区域的另一位置（Web 浮层、桌面透明悬浮窗均有效）。",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
];

export function registerEmbodimentTools(
  toolRegistry: ToolRegistry,
  wsRegistry: WsConnectionRegistry,
): void {
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
    return { ok: true, delivered, strength };
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
    return { ok: true, delivered, x, y, z };
  });

  toolRegistry.register("embodiment.stop", async (_input, context) => {
    const actorId = resolveActorId(context);
    const delivered = pushEmbodimentCommand(wsRegistry, actorId, {
      action: "stop",
      source: "tool:embodiment.stop",
    });
    return { ok: true, delivered };
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
    return { ok: true, delivered, mood, energy, caption };
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
    return { ok: true, delivered, strength };
  });

  toolRegistry.register("embodiment.window_roam", async (_input, context) => {
    const actorId = resolveActorId(context);
    const delivered = pushEmbodimentCommand(wsRegistry, actorId, {
      action: "window_roam",
      source: "tool:embodiment.window_roam",
    });
    return { ok: true, delivered };
  });
}
