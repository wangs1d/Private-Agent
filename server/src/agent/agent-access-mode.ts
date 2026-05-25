import type { ChatCompletionTool } from "openai/resources/chat/completions";

import { VISION_SANDBOX_RESTRICTED_CHAT_TOOLS } from "../external-model/openai-compatible-tool-loop.js";
import { filterChatToolsByRegistryNames } from "../services/master-agent-tool-filter.js";
import { DESKTOP_VISUAL_CHAT_TOOL_DEFINITIONS } from "../tools/desktop-visual-chat-tools.js";
import { SELF_PROGRAMMING_CHAT_TOOLS } from "../tools/self-programming-chat-tools.js";

/** 客户端 `chat.user_message.agentAccessMode`：默认沙箱，仅 `full` 时开放高权限工具。 */
export type AgentAccessMode = "sandbox" | "full";

const FULL_ACCESS_MODE: AgentAccessMode = "full";

/** 沙箱下禁止 Agent 调用的工具（精确名）。 */
const SANDBOX_BLOCKED_EXACT = new Set<string>([
  "desktop.visual.screenshot",
  "desktop.visual.run_task",
  "vision.periodic_start",
  "vision.periodic_stop",
  "vision.periodic_stop_all",
  "vision.periodic_list",
  "vision.http_pull",
]);

/** 沙箱下禁止的工具前缀（如 self.* 自我编程）。钱包为宿主 Agent 常规能力，沙箱下仍可用。 */
const SANDBOX_BLOCKED_PREFIXES = ["self."] as const;

/** 用于 system prompt 幂等追加 */
export const AGENT_ACCESS_MODE_SYSTEM_MARKER = "【访问权限】";

/** 沙箱下不可用能力（面向用户说明，与 {@link SANDBOX_BLOCKED_EXACT} 对齐） */
export const SANDBOX_RESTRICTED_CAPABILITIES_USER_LINES = [
  "截取/操控个人电脑（desktop.visual.screenshot / desktop.visual.run_task：截图、订票、打开 App 等）",
  "摄像头/画面定时巡检（vision.periodic_*、vision.http_pull）",
  "自我编程与自定义 Skill（self.*）",
] as const;

export function parseAgentAccessMode(raw: unknown): AgentAccessMode {
  return raw === FULL_ACCESS_MODE ? FULL_ACCESS_MODE : "sandbox";
}

export function isSandboxMode(mode: AgentAccessMode): boolean {
  return mode !== FULL_ACCESS_MODE;
}

export function isToolAllowedInAccessMode(
  toolName: string,
  mode: AgentAccessMode,
  ctx?: ChatToolsAccessContext,
): boolean {
  if (ctx?.desktopBridgeOnline && isDesktopBridgeToolName(toolName)) return true;
  if (!isSandboxMode(mode)) return true;
  if (SANDBOX_BLOCKED_EXACT.has(toolName)) return false;
  return !SANDBOX_BLOCKED_PREFIXES.some((prefix) => toolName.startsWith(prefix));
}

/** 电脑桥接在线时可用的桌面工具（手机↔PC 通信路径，不依赖「完全访问」开关）。 */
export const DESKTOP_BRIDGE_TOOL_NAMES = new Set<string>([
  "desktop.visual.screenshot",
  "desktop.visual.run_task",
]);

export type ChatToolsAccessContext = {
  /** 与手机相同 userId 的电脑桥接 WebSocket 是否在线 */
  desktopBridgeOnline?: boolean;
};

export function isDesktopBridgeToolName(toolName: string): boolean {
  return DESKTOP_BRIDGE_TOOL_NAMES.has(toolName);
}

/** 桥接在线时向模型补发的桌面工具定义。 */
export function getDesktopBridgeChatTools(): ChatCompletionTool[] {
  return [...DESKTOP_VISUAL_CHAT_TOOL_DEFINITIONS];
}

/** 沙箱禁用、完全访问时应补发给模型的工具定义（含未启用桌面环境变量时的 desktop.visual.*）。 */
export function getSandboxRestrictedChatTools(): ChatCompletionTool[] {
  return [
    ...DESKTOP_VISUAL_CHAT_TOOL_DEFINITIONS,
    ...VISION_SANDBOX_RESTRICTED_CHAT_TOOLS,
    ...SELF_PROGRAMMING_CHAT_TOOLS,
  ];
}

function chatToolRegistryName(tool: ChatCompletionTool): string | undefined {
  return tool.type === "function" ? tool.function?.name : undefined;
}

export function sandboxDeniedToolMessage(toolName: string): string {
  if (isDesktopBridgeToolName(toolName)) {
    return `无法调用「${toolName}」：电脑桥接未在线。请在本机运行 desktop-visual-agent 桥接（userId 与手机一致），并保持连接。`;
  }
  return `当前为沙箱模式，无法调用「${toolName}」。请在对话输入框开启「完全访问」或在电脑上运行桥接后再试。`;
}

export function filterChatToolsForAccessMode(
  tools: ChatCompletionTool[],
  mode: AgentAccessMode,
  ctx?: ChatToolsAccessContext,
): ChatCompletionTool[] {
  if (!isSandboxMode(mode) && !ctx?.desktopBridgeOnline) return tools;
  const allowed = new Set<string>();
  for (const tool of tools) {
    const name = chatToolRegistryName(tool);
    if (!name) continue;
    if (isToolAllowedInAccessMode(name, mode, ctx)) {
      allowed.add(name);
    }
  }
  return filterChatToolsByRegistryNames(tools, allowed);
}

/**
 * 按访问模式生成最终下发给模型的 tools：
 * - 沙箱：剔除高权限
 * - 电脑桥接在线：补全 desktop.visual.*（手机↔PC 路径）
 * - 完全访问：补全全部沙箱禁用工具
 */
export function mergeChatToolsForAccessMode(
  tools: ChatCompletionTool[],
  mode: AgentAccessMode,
  ctx?: ChatToolsAccessContext,
): ChatCompletionTool[] {
  const base = filterChatToolsForAccessMode(tools, mode, ctx);
  const exposeAllRestricted = !isSandboxMode(mode);
  const exposeDesktopViaBridge = isSandboxMode(mode) && ctx?.desktopBridgeOnline === true;
  if (!exposeAllRestricted && !exposeDesktopViaBridge) return base;

  const present = new Set(
    base.map((tool) => chatToolRegistryName(tool)).filter((name): name is string => Boolean(name)),
  );
  const pool = exposeAllRestricted
    ? getSandboxRestrictedChatTools()
    : getDesktopBridgeChatTools();
  const extras = pool.filter((tool) => {
    const name = chatToolRegistryName(tool);
    return Boolean(name && !present.has(name));
  });
  return extras.length > 0 ? [...base, ...extras] : base;
}

/** 注入 system / 子 Agent prompt：让模型知晓当前轮次的访问权限与用户操作方式。 */
export function buildAgentAccessModeSystemSuffix(
  mode: AgentAccessMode,
  ctx?: ChatToolsAccessContext,
): string {
  if (ctx?.desktopBridgeOnline) {
  const bridgeLine = isSandboxMode(mode)
    ? "电脑桥接已在线（与手机同 userId）。本轮已开放 desktop.visual.screenshot / desktop.visual.run_task，无需用户再点「完全访问」。"
    : "电脑桥接已在线，且用户已开启「完全访问」。";
    return `

${AGENT_ACCESS_MODE_SYSTEM_MARKER} · 电脑桥接（在线）
${bridgeLine}
用户要求截屏、看桌面、操控电脑时，**必须优先调用 desktop.visual.screenshot 或 desktop.visual.run_task**，禁止声称「没有截图工具」或仅建议 vision.http_pull。
执行转账、真实消费等仍须征得用户明确同意。`;
  }

  if (!isSandboxMode(mode)) {
    return `

${AGENT_ACCESS_MODE_SYSTEM_MARKER} · 完全访问（已开启）
用户已在对话输入框开启「完全访问」，你可调用 desktop.visual.screenshot / desktop.visual.run_task、视觉巡检、自我编程等高权限工具；截屏请优先调用 desktop.visual.screenshot。
执行转账、真实消费、桌面自动化等敏感操作前仍须征得用户明确同意。
若工具返回「电脑端未在线」或「未启用」，向用户说明需配置服务端桌面能力并在本机运行桥接客户端。`;
  }

  const restricted = SANDBOX_RESTRICTED_CAPABILITIES_USER_LINES.map((line) => `- ${line}`).join("\n");
  return `

${AGENT_ACCESS_MODE_SYSTEM_MARKER} · 常规沙箱（默认）
当前对话处于「常规/沙箱」模式（客户端未开启完全访问）。下列能力本轮不可用，勿假装已执行或委派成功：
${restricted}

需要上述能力时，你必须用自然语言告知用户：
1. 在对话输入框点击盾牌图标，切换为「完全访问」（开锁图标）后再发同一条指令；
2. 若涉及操控个人电脑，还需在本机运行桌面桥接并保持与服务端连接。

沙箱下仍可用：联网搜索、日程天气、钱包记账类工具、子 Agent 委派（子 Agent 同样受沙箱限制，无 desktop.visual.run_task）。
用户问「为什么不能操作电脑」时，优先解释沙箱与完全访问，而非只说「工具坏了」。`;
}

/** 子 Agent / 能力查询用的简短一行说明 */
export function buildAgentAccessModePromptLine(
  mode: AgentAccessMode,
  ctx?: ChatToolsAccessContext,
): string {
  if (ctx?.desktopBridgeOnline) {
    return "【本轮权限】电脑桥接在线：desktop.visual.screenshot / run_task 可用；截屏请调用 screenshot。";
  }
  return isSandboxMode(mode)
    ? "【本轮权限】沙箱模式：desktop.visual.run_task、vision.periodic_*、self.* 不可用；请提醒用户开启「完全访问」或运行电脑桥接。"
    : "【本轮权限】完全访问：高权限工具已开放，敏感操作仍须用户同意。";
}

export function appendAgentAccessModeSystemSuffix(
  systemContent: string,
  mode: AgentAccessMode,
  ctx?: ChatToolsAccessContext,
): string {
  if (systemContent.includes(AGENT_ACCESS_MODE_SYSTEM_MARKER)) return systemContent;
  return systemContent + buildAgentAccessModeSystemSuffix(mode, ctx);
}
