import type { ChatCompletionTool } from "openai/resources/chat/completions";

const toolDefinitions: { name: string; description: string; parameters: Record<string, unknown> }[] = [
  {
    name: "phone.battery",
    description: "查询已连接真实手机的电量和充电状态。",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
      required: [],
    },
  },
  {
    name: "phone.notifications",
    description: "获取真实手机上最近的通知列表（微信/短信/系统等）。",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "integer", description: "最多返回条数，默认 20" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "phone.camera_capture",
    description: "远程控制真实手机拍照。",
    parameters: {
      type: "object",
      properties: {
        camera: { type: "string", enum: ["back", "front"], description: "使用前置或后置摄像头，默认 back" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "phone.screen_record",
    description: "远程控制真实手机录屏指定秒数。",
    parameters: {
      type: "object",
      properties: {
        durationSec: { type: "integer", description: "录屏时长（秒），默认 15" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "phone.locate",
    description: "定位真实手机当前位置（兼容华为无 GMS 设备）。",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
      required: [],
    },
  },
  {
    name: "phone.ring",
    description: "让真实手机响铃并振动，用于寻找手机或事项提醒。",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string", description: "响铃原因" },
        durationSec: { type: "integer", description: "响铃秒数，默认 15" },
        volume: { type: "integer", description: "音量百分比 0-100，默认 100" },
        vibrate: { type: "boolean", description: "是否振动，默认 true" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "phone.sms_list",
    description: "获取真实手机最近短信列表。",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "integer", description: "最多返回条数，默认 20" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "phone.call_log",
    description: "获取真实手机最近通话记录。",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "integer", description: "最多返回条数，默认 20" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "phone.dial",
    description:
      "用用户的真实手机拨打电话给第三方。调用前必须已在对话中向用户确认被叫号码与拨打意图；" +
      "手机端会弹出确认窗，用户可取消。紧急号码（110/119/120 等）会被服务端拒绝。" +
      "仅负责拨出，通话由用户本人进行。",
    parameters: {
      type: "object",
      properties: {
        number: { type: "string", description: "被叫号码，支持 +86 等国际区号前缀" },
        contactName: { type: "string", description: "联系人名，显示在手机端确认弹窗上" },
        reason: { type: "string", description: "拨打原因（一句话），显示在确认弹窗上" },
        mode: {
          type: "string",
          enum: ["direct", "draft"],
          description:
            "direct=用户在手机端确认后直接拨出；draft=仅打开拨号盘预填号码，由用户手动按拨号键。默认 direct",
        },
      },
      required: ["number"],
      additionalProperties: false,
    },
  },
];

export function isPhoneBridgeEnvOn(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.PHONE_BRIDGE_ENABLED;
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export function getPhoneBridgeChatTools(env: NodeJS.ProcessEnv = process.env): ChatCompletionTool[] {
  if (!isPhoneBridgeEnvOn(env)) return [];
  return toolDefinitions.map((def) => ({
    type: "function" as const,
    function: {
      name: def.name,
      description: def.description,
      parameters: def.parameters as any,
    },
  }));
}

export const PHONE_BRIDGE_CHAT_TOOL_DEFINITIONS: ChatCompletionTool[] = toolDefinitions.map((def) => ({
  type: "function" as const,
  function: {
    name: def.name,
    description: def.description,
    parameters: def.parameters as any,
  },
}));
