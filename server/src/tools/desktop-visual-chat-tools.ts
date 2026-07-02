import type { ChatCompletionTool } from "openai/resources/chat/completions";

function parseBooleanEnv(raw: string | undefined): boolean {
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/** 服务端是否开启「电脑桥接」相关能力（与是否在线无关） */
export function isDesktopBridgeEnvOn(env: NodeJS.ProcessEnv = process.env): boolean {
  if (parseBooleanEnv(env.DESKTOP_BRIDGE_ENABLED)) return true;
  return (env.DESKTOP_BRIDGE_TOKEN?.trim().length ?? 0) >= 8;
}

/** 本机 Python 执行 或 电脑桥接（手机经服务端调度到已绑定 PC）任一方可用时，向模型暴露工具。 */
function isLocalVisualEnabled(env: NodeJS.ProcessEnv): boolean {
  return (
    parseBooleanEnv(env.DESKTOP_VISUAL_ENABLED) ||
    parseBooleanEnv(env.DESKTOP_VISUAL_AGENT_ENABLED)
  );
}

export function isDesktopVisualControlChatToolsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isLocalVisualEnabled(env) || isDesktopBridgeEnvOn(env);
}

const DESKTOP_VISUAL_RUN_TASK_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "desktop.visual.run_task",
    description:
      "【桌面·纯视觉】在已用**同一 userId** 在线桥接的**个人电脑**上截屏并由多模态模型驱动键鼠完成 GUI 任务（默认无需配对码；可选 DESKTOP_BRIDGE_TOKEN 作额外校验）。若电脑未在线且服务端启用了 DESKTOP_VISUAL_ENABLED，则在**服务器本机**执行。须用户明确授权；电脑端运行桥接进程并保持连接。",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "用自然语言描述要完成的一系列界面操作目标" },
        maxSteps: {
          type: "integer",
          description: "视觉-动作循环最多步数，默认 40，上限建议不超过 80",
        },
        region: {
          type: "array",
          items: { type: "integer" },
          minItems: 4,
          maxItems: 4,
          description: "可选截屏区域 [left, top, width, height]；省略则全屏",
        },
        stub: {
          type: "boolean",
          description: "调试：为 true 时不调用真实 VLM（Python Stub），仅验证执行管线",
        },
      },
      required: ["task"],
      additionalProperties: false,
    },
  },
};

const DESKTOP_VISUAL_SCREENSHOT_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "desktop.visual.screenshot",
    description:
      "【桌面·截图】截取电脑屏幕（或指定区域）并返回 PNG 图片。可用于查看当前屏幕内容、获取界面信息、记录屏幕状态等场景。需要 DESKTOP_VISUAL_ENABLED=1 或电脑桥接在线。",
    parameters: {
      type: "object",
      properties: {
        region: {
          type: "array",
          items: { type: "integer" },
          minItems: 4,
          maxItems: 4,
          description: "可选截屏区域 [left, top, width, height]；省略则截取全屏",
        },
      },
      additionalProperties: false,
    },
  },
};

const DESKTOP_RUN_SHELL_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "desktop.run_shell",
    description:
      "【桌面·受控 Shell】在已绑定电脑（与 userId 一致）上执行一条 shell 命令（cmd / powershell / bash），返回 stdout / stderr / exitCode。" +
      "默认**白名单**模式：仅允许只读命令（dir / ls / cat / type / Get-ChildItem / Get-Process / systeminfo / ipconfig / Test-NetConnection 等）。" +
      "如需写入/删除/启停服务等操作，**必须**设置 allowDestructive=true（同时要求 server 端 DESKTOP_SHELL_ALLOWLIST=0、DESKTOP_BRIDGE_TOKEN ≥8 字符）。" +
      "高危命令（Remove-Item / del / rmdir / reg / Stop-Service / shutdown / sudo / chmod 0xxx / chown / dd / mkfs / kill -9 / |Out-File / Invoke-Expression）一律拒。",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "要执行的 shell 命令字符串；不要包含跨工具逃逸语法（Invoke-Expression / 编码命令 / 管道到 Out-File 等）",
        },
        shell: {
          type: "string",
          enum: ["cmd", "powershell", "bash"],
          description: "强制指定 shell；省略则按 OS 自动（Windows=powershell，Linux/Mac=bash）",
        },
        cwd: {
          type: "string",
          description: "可选工作目录（绝对路径）",
        },
        timeoutMs: {
          type: "integer",
          minimum: 1000,
          maximum: 300000,
          description: "命令超时（毫秒），默认 30000，上限 300000（5 分钟）",
        },
        allowDestructive: {
          type: "boolean",
          description:
            "允许非白名单但非黑名单的命令。**仅在 server 端显式设置 DESKTOP_SHELL_ALLOWLIST=0 时才生效**。",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
};

/** 完全访问模式下向模型暴露的定义（与 {@link getDesktopVisualChatTools} 环境门控无关）。 */
export const DESKTOP_VISUAL_CHAT_TOOL_DEFINITIONS: ChatCompletionTool[] = [
  DESKTOP_VISUAL_SCREENSHOT_TOOL,
  DESKTOP_VISUAL_RUN_TASK_TOOL,
  DESKTOP_RUN_SHELL_TOOL,
];

export function getDesktopVisualChatTools(env: NodeJS.ProcessEnv = process.env): ChatCompletionTool[] {
  if (!isDesktopVisualControlChatToolsEnabled(env)) return [];
  if (!parseBooleanEnv(env.DESKTOP_SHELL_ENABLED)) {
    return DESKTOP_VISUAL_CHAT_TOOL_DEFINITIONS.filter((t) => {
      if (t.type !== "function") return true;
      return t.function.name !== "desktop.run_shell";
    });
  }
  return DESKTOP_VISUAL_CHAT_TOOL_DEFINITIONS;
}
