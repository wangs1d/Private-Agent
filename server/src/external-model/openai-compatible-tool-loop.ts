import type OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from "openai/resources/chat/completions";

import { AGENT_WORLD_CHAT_TOOLS } from "@private-ai-agent/agent-world";
import { AIP_CHAT_TOOLS } from "../aip/aip-chat-completion-tools.js";
import { getDesktopVisualChatTools } from "../tools/desktop-visual-chat-tools.js";
import { getPhoneBridgeChatTools } from "../tools/phone-bridge-chat-tools.js";
import { BROWSER_SESSION_LIST_CHAT_TOOL } from "../tools/browser-session-chat-tools.js";
import { INTERNET_INTELLIGENCE_CHAT_TOOLS } from "../tools/internet-intelligence-chat-tools.js";
import { EMBODIMENT_CHAT_TOOLS } from "../tools/embodiment-tools.js";
import { SMART_HOME_CHAT_TOOLS } from "../tools/smart-home-tools.js";
import { DEVICE_CHAT_TOOLS } from "../tools/device-tools.js";
import { SELF_PROGRAMMING_CHAT_TOOLS } from "../tools/self-programming-chat-tools.js";
import { openAiUserContentFromTurn } from "./build-user-message-content.js";
import { getAgentRuntimeConfig } from "../agent/agent-runtime-config.js";
import {
  MASTER_INVOKE_SUB_AGENT_REGISTRY,
  MASTER_POLL_SUB_AGENT_TASKS_REGISTRY,
  SUBAGENT_ASK_PEER_REGISTRY,
} from "../agent/master-subagent-delegate-tools.js";
import { compactToolOutputForLlm } from "../tokenjuice/compactor.js";
import {
  executeBridge,
  isFastLaneTool,
  isToolSearchBridgeName,
  prepareTools,
} from "../gateway/index.js";
import {
  getCapabilityModuleCategoryMappings,
  getCapabilityModuleChatTools,
  type CapabilityModuleDeps,
} from "../tools/capability-modules/index.js";
import { isExplicitPhoneCallRequest } from "../agent/phone-call-intent.js";
import {
  FRESH_FACT_TOOL_NAMES,
  resolveForcedToolChoice,
  shouldRequireFreshWebLookup,
} from "../gateway/forced-tool.js";
import { buildRecoveryHint } from "../agent/loop/tool-metadata.js";
import {
  isAssistantWithToolCalls,
  isToolCallIdNotFoundError,
  sanitizeChatMessagesForApi,
} from "./chat-thread-sanitize.js";
import {
  applyPromptCacheMessages,
  type PrefixCacheRequest,
} from "./prefix-cache.js";
import {
  adaptOpenAiChatCompletionStream,
  consumeNormalizedStream,
  materializeOpenAiToolCalls,
  StreamIdleTimeoutError,
  stripInternalControlTags,
  type NormalToolCall,
} from "./stream-chat-helpers.js";
import type {
  ChatToolExecutionContext,
  StreamDeltaHandler,
  ToolLoopAfterBatchInfo,
  VisionFrame,
} from "./types.js";
import { executeWithToolLimit } from "../services/concurrency-limiter.js";
import { evaluateAndSelectStrategy } from "../agent/synthesis-strategy.js";

const TOOL_RESULT_VISION_INJECT_KEY = "_injectVisionUserMessage";

/** 检测模型是否支持视觉(多模态图片输入)。
 *  deepseek-chat / gpt-3.5 等纯文本模型不支持,注入 image_url 会导致 API 报错。 */
function modelSupportsVision(model: string): boolean {
  const m = model.toLowerCase();
  // 已知支持视觉的模型系列
  const visionPatterns = [
    "gpt-4o", "gpt-4-turbo", "gpt-4-vision", "gpt-4.1",
    "claude-3", "claude-sonnet", "claude-opus", "claude-haiku",
    "qwen-vl", "qwen2-vl", "qwen2.5-vl", "qvq",
    "glm-4v", "glm-4.6v", "glm-4-plus",
    "moonshot-v1", "kimi",
    "gemini", "llava", "internvl",
    "deepseek-vl", "deepseek-vl2",
  ];
  return visionPatterns.some((p) => m.includes(p));
}

/** 调用 PaddleOCR 服务识别截图中的文本和位置。
 *  非视觉模型(deepseek-chat 等)看不到图片,用 OCR 文本+坐标作为视觉替代。 */
async function ocrScreenshot(imageBase64: string, mimeType: string): Promise<string | null> {
  const port = process.env.PADDLE_OCR_PORT?.trim() || "8765";
  const url = `http://127.0.0.1:${port}/ocr`;
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imageBase64, mimeType, mergeLines: true }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      ok: boolean;
      text?: string;
      lines?: Array<{ text: string; confidence: number; box: number[][] }>;
      width?: number;
      height?: number;
      error?: string;
    };
    if (!data.ok || !data.lines?.length) return null;
    // 格式化:每个文本元素 + 中心坐标(用于 desktop.run_input 点击)
    const lines = data.lines.map((ln, i) => {
      const box = ln.box || [];
      if (box.length >= 2) {
        const xs = box.map((p) => p[0]);
        const ys = box.map((p) => p[1]);
        const cx = Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
        const cy = Math.round(ys.reduce((a, b) => a + b, 0) / ys.length);
        return `${i + 1}. "${ln.text}" → 点击坐标 (${cx}, ${cy}) [置信度: ${ln.confidence}]`;
      }
      return `${i + 1}. "${ln.text}" [置信度: ${ln.confidence}]`;
    });
    return `屏幕 OCR 识别结果 (${data.width}x${data.height},共 ${data.lines.length} 个文本元素,坐标可用于 desktop.run_input 点击):\n${lines.join("\n")}`;
  } catch {
    return null;
  }
}
// 工具结果字符预算：在信息完整性和 token 节省之间取平衡。
// search_web 1200：保留足够 title+snippet（约 5-6 条结果）让 LLM 判断哪些值得 fetch_web。
// fetch_web 2000：正文摘要足够 LLM 提取关键信息，不过度截断导致信息丢失。
const TOOL_RESULT_PRESET_MAX_CHARS: Record<string, number> = {
  "search_web": 600,
  "search_images": 1200,
  "search_videos": 1200,
  "fetch_web": 1000,
  // deep_search 返回正文，限制注入量避免整页内容灌给 LLM
  "deep_search": 2200,
  // hot_rankings 榜单项字段少，给足即可
  "hot_rankings": 1400,
  "info.search": 600,
  "info.inspect_webpage": 1000,
  "info.navigate_site": 1200,
  "browser.session.list": 600,
  "browser.fetch_page": 1000,
  "calendar.list_tasks": 800,
  "aip.list_my_state": 800,
  "self.list_custom_skills": 800,
  "agent.query_capabilities": 900,
  "search": 600,
  "describe": 800,
  "tool_search": 800,
  "tool_discover": 800,
  "tool_call": 1200,
  "shopping.order.search": 1500,
  "shopping.order.place": 1000,
  "shopping.order.track": 1000,
  "shopping.order.cancel": 800,
  // agent_browser.* —— extract_text 是主要信息获取工具（文本+可交互元素），给充足 budget；
  // screenshot 的 base64 已在 service 层截断到 2000 字符，budget 覆盖元数据即可。
  "agent_browser.open": 600,
  "agent_browser.click": 300,
  "agent_browser.type": 300,
  "agent_browser.scroll": 300,
  "agent_browser.screenshot": 2500,
  "agent_browser.extract_text": 5000,
  "agent_browser.wait_for": 300,
  "agent_browser.close": 200,
};

// strip_keys：只去掉纯元数据字段，保留 LLM 决策需要的字段。
// 注意：url 必须保留（LLM 需要判断哪些结果值得 fetch_web 深读）。
const TOOL_RESULT_STRIP_KEYS: Record<string, string[]> = {
  search_web: ["provider", "fetchedAt", "notes"],
  search_images: ["provider", "notes"],
  search_videos: ["provider", "notes"],
  deep_search: ["provider", "notes"],
  hot_rankings: ["fetchedSources", "notes"],
  fetch_web: ["url"],
  "info.inspect_webpage": ["sameHostLinks"],
  "info.navigate_site": ["startUrl"],
};

/**
 * 元工具 / 能力查询类工具：输出是结构化 JSON（工具 schema、能力清单、匹配列表），
 * 不是用户可读的自然语言内容。
 *
 * 这些工具的输出绝不能进入 `roundToolOutputs`（→ `lastToolOutputFallback`）：
 * 否则当 LLM 末轮输出道歉式/空回复时，兜底逻辑会把工具 JSON 原样拼成回复推给前端，
 * 用户会看到「reminder.plan 参数 schema」「availableDomains 数组」这类内部数据。
 *
 * 过滤后这些工具的结果仍会作为 tool message 回填给 LLM 供其理解，
 * 只是不再可能成为面向用户的兜底回复文本。
 */
const META_TOOL_NAMES = new Set<string>([
  "tool_discover",
  "tool_search",
  "tool_describe",
  "tool_call",
  "agent.query_capabilities",
  "brain.list_capabilities",
  "brain.identify_capability_gap",
  "self.list_custom_skills",
  "aip.list_my_state",
]);

function getToolResultBudget(toolName: string): number | undefined {
  return TOOL_RESULT_PRESET_MAX_CHARS[toolName];
}

function getToolResultStripKeys(toolName: string): string[] | undefined {
  return TOOL_RESULT_STRIP_KEYS[toolName];
}

function buildFallbackAnswerFromToolOutputs(outputs: string[]): string {
  const lines = outputs
    .map((item) => item.replace(/^\[ts:[^\]]*\]\s*/gm, "").trim())
    .filter(Boolean);
  if (lines.length === 0) return "";
  const unique: string[] = [];
  for (const line of lines) {
    if (!unique.includes(line)) unique.push(line);
  }
  return unique.join("\n\n").trim();
}

/**
 * Fix3(加固 fast 轻工具链路)：当最终回复是"没查到/道歉式兜底"且没有成功工具数据时，
 * 用一次反道歉重建调用，让主力 LLM 基于既有上下文给出尽量有帮助、具体的回答，
 * 而不是把"没查到"式空话直接透出给用户。
 * 本函数仅缓冲重建结果并返回（不在内部 onDelta），由调用方统一推送一次；
 * 重建仍为空/道歉时返回 ""，不再下发任何固定道歉文案，交由上层自然处理。
 */
async function rebuildWithoutFallback(
  client: OpenAI,
  model: string,
  messages: ChatCompletionMessageParam[],
): Promise<string> {
  let rebuilt = "";
  try {
    const rebuiltMessages: ChatCompletionMessageParam[] = [
      ...messages,
      {
        role: "user",
        content:
          "请不要道歉，也不要声称「没查到/没找到/做不到/信息不足无法回答/稍后重试」。\n" +
          "请基于当前对话里所有内容和你的知识，直接给出最有用、尽可能具体的回复；" +
          "如果确实还缺关键信息，就明确指出你缺哪一条线索，并建议用户如何补充。请直接输出内容。",
      },
    ];
    const resp = await client.chat.completions.create({
      model,
      messages: rebuiltMessages,
      temperature: 0.6,
      max_tokens: 600,
      stream: true,
    });
    await consumeNormalizedStream(
      adaptOpenAiChatCompletionStream(resp as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>),
      { onContentDelta: (d) => { rebuilt += d; }, providerId: "openai-compatible", model },
    );
  } catch (err) {
    console.log(
      `[tool-loop] 反道歉重建失败，回退引导兜底: ${err instanceof Error ? err.message : String(err)}`,
    );
    return "";
  }
  return (rebuilt || "").trim();
}

/**
 * 检测 LLM 最终回复是否是「道歉式兜底」（无法整合工具结果/道歉重试）。
 * 当工具结果已有真实数据时，这种 apology 不应替代搜索结果 — 应回退到工具结果拼接。
 *
 * 触发条件（任一即视为兜底）：
 *  - 含"抱歉/请稍后重试/无法生成回复/不太清楚/我不太确定"等认错短语
 *  - 长度很短（< 60 字符）且不含任何事实/数字/链接（说明 LLM 没尝试整合）
 */
function isApologyStyleFallback(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  const apologyPatterns = [
    /抱歉.*(?:无法|不能|暂时)/,
    /请稍后重试/,
    /换个(?:问法|方式)/,
    /我(?:不太|没有)?(?:清楚|了解|知道|听说过)/,
    /没(?:太|有)?(?:听过|见过|找到|搜到|查到|听清|听到|收到)/,
    /再说一遍/,
    /网络(?:那边)?(?:卡住|异常|繁忙|问题)/,
    /刚走神/, // 用户明确要求删除"哈?刚走神了"风格的兜底
    /没反应过来/, // 用户明确要求删除"没反应过来"风格的兜底
    /我这会儿/, // 用户明确要求删除"我这会儿没反应过来"风格的兜底
  ];
  if (apologyPatterns.some((re) => re.test(t))) {
    // 仅当 LLM 没有在回复里整合任何事实（数字/链接/标题/日期）时，才判定为兜底
    const hasFactAnchors =
      /\d/.test(t) ||
      /https?:\/\//.test(t) ||
      /Kimi|Moonshot|月之暗面|大模型|发布|开源|参数|刷新/.test(t);
    return !hasFactAnchors;
  }
  return false;
}

const DEFAULT_MAX_ROUNDS = 12;

function resolveToolExecutionTimeoutMs(registryToolName: string): number {
  const fallback = Number.parseInt(process.env.TOOL_EXECUTION_TIMEOUT_MS ?? "30000", 10);
  const defaultMs = Number.isFinite(fallback) && fallback > 0 ? fallback : 30_000;
  if (registryToolName === MASTER_INVOKE_SUB_AGENT_REGISTRY) {
    const rt = getAgentRuntimeConfig().masterDelegation;
    return (
      Math.max(
        rt.subtaskTimeoutMs,
        rt.techSubtaskTimeoutMs,
        rt.infoSubtaskTimeoutMs,
      ) + 5_000
    );
  }
  if (registryToolName === MASTER_POLL_SUB_AGENT_TASKS_REGISTRY) {
    return Math.max(defaultMs, 10_000);
  }
  // subagent.ask_peer 内部跑一次完整子 Agent 执行，需与 master.invoke_sub_agent 同级超时
  if (registryToolName === SUBAGENT_ASK_PEER_REGISTRY) {
    const rt = getAgentRuntimeConfig().masterDelegation;
    return (
      Math.max(
        rt.subtaskTimeoutMs,
        rt.techSubtaskTimeoutMs,
        rt.infoSubtaskTimeoutMs,
      ) + 5_000
    );
  }
  // code.run 内部 spawn 超时上限 120s，外层需 ≥ 内层，避免外层先超时产生孤儿进程
  if (registryToolName === "code.run") {
    const sandboxMax = Number.parseInt(process.env.CODE_SANDBOX_TIMEOUT_MS ?? "30000", 10);
    const sandboxClamped = Math.min(Math.max(sandboxMax, 30_000), 120_000);
    return Math.max(defaultMs, sandboxClamped + 2_000);
  }
  // code.shell 与 code.run 同样 spawn 子进程，复用相同超时上限
  if (registryToolName === "code.shell") {
    const sandboxMax = Number.parseInt(process.env.CODE_SANDBOX_TIMEOUT_MS ?? "30000", 10);
    const sandboxClamped = Math.min(Math.max(sandboxMax, 30_000), 120_000);
    return Math.max(defaultMs, sandboxClamped + 2_000);
  }
  // shopping.order.* 走 Playwright 多步浏览器操作，耗时长，须独立超时不被 30s 默认截断
  if (registryToolName === "shopping.order.search") return 90_000;
  if (registryToolName === "shopping.order.place") return 180_000;
  if (registryToolName === "shopping.order.track") return 60_000;
  if (registryToolName === "shopping.order.cancel") return 90_000;
  // agent_browser.* 走 Playwright 无头浏览器操作，open 须启动浏览器 + 导航给充足超时，
  // wait_for 用户可设 60s 等待，其余操作默认 15s（service 层）+ 余量
  if (registryToolName === "agent_browser.open") return 60_000;
  if (registryToolName === "agent_browser.wait_for") return 65_000;
  if (registryToolName.startsWith("agent_browser.")) return 30_000;
  // 按工具类别分级超时：快工具给短超时，防止上游慢响应把整个 turn 卡到 30s
  const classTimeouts: Record<string, number> = {
    "weather": Number.parseInt(process.env.TOOL_TIMEOUT_WEATHER_MS ?? "8000", 10),
    "weather.get_local": Number.parseInt(process.env.TOOL_TIMEOUT_WEATHER_MS ?? "8000", 10),
    "search_web": Number.parseInt(process.env.TOOL_TIMEOUT_SEARCH_MS ?? "12000", 10),
    "search_images": Number.parseInt(process.env.TOOL_TIMEOUT_SEARCH_MS ?? "12000", 10),
    "search_videos": Number.parseInt(process.env.TOOL_TIMEOUT_SEARCH_MS ?? "12000", 10),
    "video.grab": Number.parseInt(process.env.TOOL_TIMEOUT_VIDEO_GRAB_MS ?? "25000", 10),
    "fetch_web": Number.parseInt(process.env.TOOL_TIMEOUT_FETCH_MS ?? "15000", 10),
    "info.inspect_webpage": Number.parseInt(process.env.TOOL_TIMEOUT_FETCH_MS ?? "15000", 10),
    "info.navigate_site": Number.parseInt(process.env.TOOL_TIMEOUT_NAVIGATE_MS ?? "20000", 10),
    "info.search": Number.parseInt(process.env.TOOL_TIMEOUT_SEARCH_MS ?? "12000", 10),
    "voice.speak": Number.parseInt(process.env.TOOL_TIMEOUT_VOICE_MS ?? "20000", 10),
    "voice.send_message": Number.parseInt(process.env.TOOL_TIMEOUT_VOICE_MS ?? "20000", 10),
    "voice.transcribe": Number.parseInt(process.env.TOOL_TIMEOUT_VOICE_MS ?? "20000", 10),
    "image.generate": Number.parseInt(process.env.TOOL_TIMEOUT_IMAGE_GEN_MS ?? "60000", 10),
  };
  const classMs = classTimeouts[registryToolName];
  if (Number.isFinite(classMs) && classMs > 0) {
    // 快工具超时不大于全局默认，避免短任务被卡到 30s
    return Math.min(classMs, defaultMs);
  }
  return defaultMs;
}

/**
 * 动态工具轮次配置：基于任务复杂度自动调整最大工具调用轮次
 * 预期效果：简单任务总耗时 -30%，复杂任务保持完整能力
 */
interface TaskComplexityConfig {
  maxRounds: number;
  description: string;
}

function analyzeTaskComplexity(userText: string, messageCount: number): TaskComplexityConfig {
  const textLength = userText.length;
  const hasMultipleQuestions = (userText.match(/[？?。]/g) || []).length > 2;
  const hasComplexKeywords = ['分析', 'analyze', '比较', 'compare', '总结', 'summarize', '优化', 'optimize', '设计', 'design', '实现', 'implement']
    .some(kw => userText.toLowerCase().includes(kw));
  const isLongContext = messageCount > 8;
  
  let complexityScore = 0;
  
  // 文本长度评分 (0-3)
  if (textLength > 500) complexityScore += 3;
  else if (textLength > 200) complexityScore += 2;
  else if (textLength > 50) complexityScore += 1;
  
  // 问题数量评分 (0-2)
  if (hasMultipleQuestions) complexityScore += 2;
  
  // 关键词评分 (0-2)
  if (hasComplexKeywords) complexityScore += 2;
  
  // 上下文长度评分 (0-2)
  if (isLongContext) complexityScore += 2;
  else if (messageCount > 4) complexityScore += 1;
  
  // 根据分数返回配置
  if (complexityScore <= 2) {
    return { 
      maxRounds: Math.max(2, parseInt(process.env.TOOL_LOOP_MIN_ROOUNDS ?? '3')), 
      description: '简单任务' 
    };
  } else if (complexityScore <= 5) {
    return { 
      maxRounds: parseInt(process.env.TOOL_LOOP_MEDIUM_ROOUNDS ?? '6'), 
      description: '中等任务' 
    };
  } else if (complexityScore <= 7) {
    return { 
      maxRounds: parseInt(process.env.TOOL_LOOP_COMPLEX_ROOUNDS ?? '9'), 
      description: '复杂任务' 
    };
  } else {
    return { 
      maxRounds: DEFAULT_MAX_ROUNDS, 
      description: '高度复杂任务' 
    };
  }
}

export function getOptimalMaxRounds(userText: string, messageCount: number): number {
  const config = analyzeTaskComplexity(userText, messageCount);
  return config.maxRounds;
}

/**
 * tool loop 内消息历史滑动窗口压缩。
 *
 * 问题：tool loop 每轮 push assistant(tool_calls) + N 条 tool(result)，N 轮后 messages
 * 单调增长。第 3 轮以后，前几轮的 tool 结果对 LLM 决策价值递减，但仍消耗大量 token。
 *
 * 策略：保留最近 `keepRounds` 轮的完整 tool 对（assistant+tool_messages），更早的 tool
 * 消息 content 替换为摘要（前 400 字符），保留关键信息（工具名、状态、核心数据）。
 * system/user 消息不动，保持 prefix cache 稳定。
 *
 * 安全性：只压缩 tool message content，不删除消息（保持 tool_call_id 链完整），
 * 避免 Kimi/OpenAI API 报 tool_call_id 不匹配。400 字符足够保留关键结论。
 */
function compactToolLoopHistory(
  messages: ChatCompletionMessageParam[],
  keepRounds: number = 2,
): void {
  if (messages.length <= 4) return; // 太少不压缩

  // 找到所有 tool message 的 index（role === "tool"）
  const toolMsgIndexes: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "tool") toolMsgIndexes.push(i);
  }

  // tool 消息总数 ≤ keepRounds 时不压缩（每轮可能有多个 tool result）
  if (toolMsgIndexes.length <= keepRounds) return;

  // 从第 keepRounds 个 tool 消息（从后往前数）开始，之前的都压缩
  const cutoffIndex = toolMsgIndexes.length - keepRounds;
  const firstOldToolIdx = toolMsgIndexes[0];
  const lastOldToolIdx = toolMsgIndexes[cutoffIndex - 1];

  if (lastOldToolIdx === undefined || firstOldToolIdx === undefined) return;

  // 压缩 cutoff 之前的 tool message content
  // 保留 400 字符：足够保留工具名、状态、核心数据，避免信息丢失影响后续决策
  for (let i = firstOldToolIdx; i <= lastOldToolIdx; i++) {
    const msg = messages[i];
    if (msg.role !== "tool") continue;
    const content = typeof msg.content === "string" ? msg.content : "";
    if (content.length <= 400) continue; // 已经很短不压缩
    // 保留前 400 字符作为摘要，加压缩标记
    const summary = content.slice(0, 400).replace(/\n/g, " ").trim();
    (msg as { content: string }).content = `[已压缩·${content.length}字符→400] ${summary}...`;
  }
}

/**
 * 为工具结果追加信息充分性提示，减少 LLM 不必要的二次调用。
 *
 * 不同工具的结果有不同的「完整度」信号：
 * - search_web: 有 N 条结果，告诉 LLM 已有足够信息判断哪些值得深读
 * - weather: 数据已包含当前温度+未来预报，无需再查
 * - code.run: 执行结果已包含 stdout/stderr，无需重跑
 * - fetch_web: 正文已提取，无需再抓
 *
 * 提示是轻量的（一行），只追加到成功的工具结果末尾。
 */
function buildToolSufficiencyHint(toolName: string, content: string): string {
  // 如果结果太短，不需要加提示
  if (!content || content.length < 50) return "";

  // 检测结果中是否已有足够信息（按工具类型判断）
  switch (toolName) {
    case "search_web": {
      // 统计结果条数（items 数组）
      const itemMatch = content.match(/"title"\s*:/g);
      const itemCount = itemMatch ? itemMatch.length : 0;
      if (itemCount >= 3) {
        return `\n[提示] 已返回 ${itemCount} 条搜索结果，含标题/链接/摘要。如需深入某条结果请用 fetch_web 读取该 URL，否则可直接基于已有摘要回答。不要用相同 query 重复搜索。若用户问的是单一事实判断，请直接给结论和一条依据，不要做第二遍总结。`;
      }
      return "";
    }
    case "search_images":
    case "search_videos": {
      const itemMatch = content.match(/"title"\s*:/g);
      const itemCount = itemMatch ? itemMatch.length : 0;
      if (itemCount > 0) {
        return `\n[提示] 已返回 ${itemCount} 条媒体结果，含标题、预览图/媒体链接和来源页。请直接把最相关的 3-6 条返回给用户；图片可展示 mediaUrl 或 thumbnailUrl，视频请给 pageUrl 供用户打开观看。不要重复搜索相同 query。`;
      }
      return "";
    }
    case "weather.get_local": {
      return "\n[提示] 天气数据已包含当前温度、体感温度、湿度、风力、降水概率和穿衣建议。信息已完整，可直接回答用户，无需再搜索。";
    }
    case "code.run": {
      // 如果执行成功且 stdout 非空
      if (content.includes('"ok":true') || content.includes('"ok": true')) {
        return "\n[提示] 代码已执行完成，stdout/stderr 已返回。如需读取文件产物请用 code.read_file，不要用相同代码重跑。";
      }
      return "";
    }
    case "code.shell": {
      if (content.includes('"ok":true') || content.includes('"ok": true')) {
        return "\n[提示] shell 命令已执行完成，stdout/stderr 已返回。如被策略拒绝请改用白名单内命令，或用 code.run 写脚本实现等效逻辑。";
      }
      return "";
    }
    case "fetch_web": {
      return "\n[提示] 网页正文已提取完成。如已有足够信息可直接回答，无需重复抓取同一页面。";
    }
    default:
      return "";
  }
}

/**
 * 失败工具结果的强约束 reminder。
 *
 * 为什么需要：LLM 在面对 user 期待型请求（如"打开微信"）时，训练倾向会让它
 * 即使看到 ok:false 的 tool result 也对用户宣称"已打开"，造成"假成功"。
 * 这里在 tool result content 后追加一条 system 级强约束，让 LLM 必须如实承认失败。
 *
 * P2 升级（2026-07-14）：
 * - 从硬编码 desktop.open 单例，改为调 tool-metadata.buildRecoveryHint，
 *   覆盖所有有 alternatives 的工具（desktop/web/shopping 等）。
 * - desktop.open 保留原有的兜底路径建议（跨盘符扫描/截图确认）。
 *
 * 设计原则：
 * - 仅对"用户易感知成败"或"有确定性替代"的工具生效
 * - 文案直白：禁止宣称成功 + 引用 error + 给出兜底路径
 * - 不替代 error 字段，是补充提示
 */
function buildToolFailureReminder(toolName: string, content: string): string {
  // 提取 error 字段供 LLM 引用（避免它编造）
  const errMatch = content.match(/"error"\s*:\s*"([^"]+)"/);
  const errSnippet = errMatch ? errMatch[1].slice(0, 120) : "见上方 error 字段";

  // 通用恢复提示（覆盖所有有 alternatives / requireHonestFailure 的工具）
  const genericHint = buildRecoveryHint(toolName, errSnippet);
  if (genericHint) {
    // desktop.open 追加原有的具体兜底路径建议
    if (toolName === "desktop.open") {
      return (
        genericHint +
        `或改用 desktop.open 重试(自动跨盘符扫描)、` +
        `desktop.visual.screenshot 截图确认当前屏幕状态后重试。`
      );
    }
    return genericHint;
  }

  // 无 alternatives 且非 honest 的工具：不加提示（fallthrough 到原行为）
  return "";
}

/**
 * 清理消息数组中的孤立 tool 消息（tool_call_id 不匹配任何 assistant 消息的 tool_calls）。
 * 同时清理有 tool_calls 但缺少对应 tool 结果的孤立 assistant 消息。
 * 防止 Kimi/Moonshot 等 API 返回 "tool_call_id is not found" 错误。
 */
/** Moonshot `extra_body.thinking.type === "disabled"` 时须从历史消息中剥离 reasoning_content。 */
export function isThinkingDisabled(extraBody?: Record<string, unknown>): boolean {
  const thinking = extraBody?.thinking as { type?: string } | undefined;
  return thinking?.type === "disabled";
}

function repairMessagesAfterToolCallIdError(
  messages: ChatCompletionMessageParam[],
  stripReasoning: boolean,
): ChatCompletionMessageParam[] {
  const before = messages.length;
  const repaired = sanitizeChatMessagesForApi(messages, {
    stripReasoning,
    logPrefix: "[openai-tool-loop-repair]",
  });
  messages.length = 0;
  messages.push(...repaired);
  if (repaired.length !== before) {
    console.warn(
      `[openai-tool-loop] Repaired message history after tool_call_id error: ` +
      `${before} → ${repaired.length} messages`,
    );
  }
  return repaired;
}

/** Moonshot Kimi 等端点仅允许字母数字下划线连字符，将 registry 名 `a.b` 映射为 `a_b`。 */
function registryNameToApiToolName(name: string): string {
  return name.replace(/\./g, "_");
}

function prepareToolsForChatApi(tools: ChatCompletionTool[]): {
  apiTools: ChatCompletionTool[];
  resolveRegistryToolName: (apiName: string) => string;
} {
  const apiToRegistry = new Map<string, string>();
  const apiTools = tools.map((tool) => {
    if (tool.type !== "function" || !tool.function?.name) return tool;
    const registryName = tool.function.name;
    const apiName = registryNameToApiToolName(registryName);
    apiToRegistry.set(apiName, registryName);
    return {
      ...tool,
      function: {
        ...tool.function,
        name: apiName,
      },
    };
  });
  return {
    apiTools,
    resolveRegistryToolName: (apiName) => apiToRegistry.get(apiName) ?? apiName,
  };
}

// 强制工具路由（forced tool choice）统一收口到 gateway/forced-tool.ts：
//   1. 显式电话请求 → phone_call_user
//   2. 直接时间/日期/位置问题 → clock_get_current_time（Fast 模式跳过）
//   3. 时效性事实查询 → search_web
// 注：weather_get_local 已并入 tool-router 延迟目录，由检索召回，不再强制路由。

const INFO_WEB_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "search_web",
      description:
        "联网搜索公开网页信息（按发布时间从新到旧，默认剔除超过约 120 天的旧条目）。query 请简短（2-6 个核心词），时效话题请加当前年月或「最新」，如「科技新闻 2026年5月 最新」「兴义 梦乐城 电影 热映」。\n如果有多个独立的查询维度（例如对比多个商品 / 多个主题），请在同一轮内并行发起多个 search_web 调用，每个 tool_call 用不同的 query，避免串行等待。\n【强制调用规则】涉及时事、新闻、股价、排片、票价、天气、价格、公告等时效信息时必须先调用本工具，禁止仅凭训练数据作答；本地消费（电影票、外卖等）同样须先搜索再试。整合结果时优先引用发布时间最新的条目并注明日期；用简短编号句或自然段口语化呈现，禁止使用 Markdown 表格、管道符、简报格式。若用户只问单一事实判断，默认输出“结论 + 1句依据”，不要再把同一判断换句式复述一遍。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "integer", description: "返回数量，1-20，默认 8" },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_web",
      description: "读取指定网页正文并返回标题、摘要与纯文本内容。自动移除导航栏、页脚、广告等噪音，提取核心正文。\n如果已经从 search_web 拿到多个需要深读的独立 URL，请在同一轮内并行发起多个 fetch_web 调用，每个 tool_call 用不同的 url，避免串行等待。",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "要读取的网页 URL" },
          include_links: { type: "boolean", description: "是否同时返回页面中的链接列表（默认 false）" },
        },
        required: ["url"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_images",
      description:
        "搜索公开图片结果，下载并转存为服务端本地 PNG，返回可在对话中直接预览的 mediaUrl/thumbnailUrl（形如 /agent/images/...png），以及可打开来源页的 pageUrl。\n" +
        "适用场景：用户**主动表达**想看/找图/照片/实拍图/长什么样/配图/壁纸/风景照/表情包/给我看看等视觉诉求时，并行调用本工具（可与 search_web 并行），直接出图，不要建议用户去其他平台。\n" +
        "不要误触发：仅当**当前轮**用户明确要图时才调用。若只是普通提及某事物（如聊天里带\"图\"字、或前面轮次搜过图），且本轮用户并未索图，不要调用本工具——宁缺勿滥，避免无关照片刷屏。\n" +
        "回答时优先展示 3-6 条最相关图片 PNG，附来源页链接；不要把图片搜索误用成 image.generate（生成图）。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "图片搜索关键词，尽量短而具体" },
          limit: { type: "integer", description: "返回数量，1-8，默认 4" },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_images_batch",
      description:
        "多维对比出图：一次调用同时搜索多个维度、每个维度两侧的对比图，返回按维度分组的 mediaGroups（每个 group 含维度标题 + 左/右两侧图片列表），供前端「一段文字介绍后放一组对比照片」交错渲染。\n" +
        "适用场景：用户要求对比两类事物（如「A 与 B 的区别」「A vs B 哪个好」），或要求从多个方面/维度找图（如「颜色持久度、价格、色号对比」）时，**优先**用本工具代替普通 search_images，以实现多维度、两侧对比而非单批平铺。\n" +
        "用法：query 写「A 对比 B」（自动拆两侧）；可选 dimensions 数组指定要对比的维度（如 [\"持久度\",\"防水\",\"色号\"]），不传时自动按两侧共同点推断维度标题。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "对比关键词，含「A 对比 B / A vs B / A 和 B 区别」等对比语义" },
          dimensions: {
            type: "array",
            items: { type: "string" },
            description: "对比维度列表（可选），如 [\"持久度\",\"防水\",\"色号\"]；缺省时按两侧共同点自动推断",
          },
          limit_per_group: { type: "integer", description: "每组每侧返回张数，1-4，默认 3" },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_videos",
      description:
        "搜索公开视频结果并返回标题、播放页 pageUrl、缩略图 thumbnailUrl 与来源。\n" +
        "适用场景：用户明确要「搜视频」「找视频」「教程视频」「B站/YouTube 视频」「视频素材」等。回答时给出可点击播放页，必要时附缩略图；不要重复用普通 search_web 搜同一视频需求。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "视频搜索关键词，尽量短而具体" },
          limit: { type: "integer", description: "返回数量，1-12，默认 8" },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "info.inspect_webpage",
      description: "巡检网页：返回标题、摘要、内容预览、主要链接和同域链接，便于继续导航。",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "info.navigate_site",
      description: "从起始 URL 自动多层跟进链接，直到命中目标关键词页面（如注册入口）。",
      parameters: {
        type: "object",
        properties: {
          startUrl: { type: "string" },
          goalKeywords: { type: "array", items: { type: "string" } },
          maxDepth: { type: "integer", description: "默认 2，最大 5" },
          maxPages: { type: "integer", description: "默认 20，最大 80" },
          sameHostOnly: { type: "boolean", description: "默认 true" },
        },
        required: ["startUrl"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "deep_search",
      description:
        "深度搜索：一次调用完成「搜索 + 抓取 Top 网页正文」。先按 query 搜索，再并行读取前 N 条结果的完整正文（自动去导航栏/广告噪音），每条结果同时带 snippet 摘要与 content 全文。\n" +
        "适用场景：需要深入了解某个主题、扒取细节/数据/结论（如产品详情、事件经过、技术细节、行情解读）时，优先用本工具而不是 search_web + 逐个 fetch_web 来回多次。\n" +
        "若只需快速浏览话题就继续用 search_web。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "搜索关键词，简短具体（2-6 个核心词）" },
          limit: { type: "integer", description: "搜索返回条数，1-20，默认 8" },
          fetch_pages: { type: "integer", description: "抓取完整正文的 Top 条数，1-10，默认 3" },
          content_limit: { type: "integer", description: "单条正文最大字符数，1000-8000，默认 3000" },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "hot_rankings",
      description:
        "实时热点榜单：聚合微博/百度/知乎/B站 当前热门话题，每条含平台、排名、话题与热度。\n" +
        "适用场景：用户问「今天有什么热点/大家都在看什么/热搜」「最近关注什么」等要掌握当下时事话题，或需要补充实时热点素材时调用；可指定 platforms（weibo/baidu/zhihu/bilibili）只看特定平台。",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "integer", description: "返回条数，1-60，默认 20" },
          platforms: { type: "array", items: { type: "string" }, description: "可选平台：weibo/baidu/zhihu/bilibili，默认全部" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "weather.get_local",
      description:
        "获取当地天气与穿衣建议（Open-Meteo）。\n" +
        "⚠️ 不要猜测用户所在城市——如果用户未明确说城市名，不要传 city/latitude/longitude，工具会自动获取用户真实位置。\n" +
        "用户明确说了城市名时才传 city（如「上海天气」→ city:'上海'）。\n" +
        "可选 timezone（IANA，默认 Asia/Shanghai）。",
      parameters: {
        type: "object",
        properties: {
          latitude: { type: "number" },
          longitude: { type: "number" },
          city: { type: "string", description: "城市名（与坐标二选一）" },
          timezone: { type: "string" },
          locationLabel: { type: "string", description: "展示用地点名" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "http.request",
      description:
        "发起任意 HTTP 请求（等价 curl），对接外部 API / Webhook / 自建服务。自动 SSRF 防护（拒绝内网地址），响应 body 默认截断 8KB。method 默认 GET；headers/body 可选；超时默认 15s 上限 60s。",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "完整 http(s) URL（内网地址会被拒绝）" },
          method: {
            type: "string",
            enum: ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"],
            description: "默认 GET",
          },
          headers: {
            type: "object",
            description: "请求头，如 {\"Authorization\":\"Bearer xxx\",\"Content-Type\":\"application/json\"}",
            additionalProperties: { type: "string" },
          },
          body: { type: "string", description: "请求体（POST/PUT/PATCH 时使用）。JSON 请序列化为字符串" },
          timeoutMs: { type: "integer", description: "超时毫秒，默认 15000，上限 60000" },
          maxBytes: { type: "integer", description: "响应 body 截断字节数，默认 8192，上限 65536" },
          followRedirects: { type: "boolean", description: "是否跟随重定向，默认 true（最多 5 次）" },
        },
        required: ["url"],
        additionalProperties: false,
      },
    },
  },
];

const LIFE_ASSISTANT_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "budget.calculate",
      description: "根据收入与各项支出计算剩余预算并给出建议。",
      parameters: {
        type: "object",
        properties: {
          income: { type: "number", description: "月收入" },
          rent: { type: "number", description: "房租" },
          food: { type: "number", description: "餐饮" },
          transport: { type: "number", description: "交通" },
        },
        required: ["income"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "shopping.suggest",
      description: "根据商品与预算给出购物建议（比价决策辅助，不执行购买）。",
      parameters: {
        type: "object",
        properties: {
          item: { type: "string", description: "商品名称或品类" },
          budget: { type: "number", description: "预算上限（元）" },
        },
        required: ["item"],
        additionalProperties: false,
      },
    },
  },
];

/** 宿主 Agent 真实资金钱包（与 Agent World 世界点数无关）。 */
const WALLET_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "wallet.get_balance",
      description: "查询当前用户绑定的真实资金钱包余额（CNY，只读）。",
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
      name: "wallet.get_transactions",
      description: "查询用户钱包交易记录，支持分页与类型过滤。",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "integer", description: "返回条数，默认 20" },
          offset: { type: "integer", description: "偏移，默认 0" },
          type: {
            type: "string",
            enum: ["all", "income", "expense", "transfer"],
            description: "交易类型过滤，默认 all",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "wallet.transfer",
      description: "在用户明确同意后，代其向其他 Agent 转账（recipientId 为对方 session/user id）。",
      parameters: {
        type: "object",
        properties: {
          recipientId: { type: "string", description: "收款方 Agent id" },
          amount: { type: "number", description: "转账金额（CNY，须 > 0）" },
          remark: { type: "string", description: "可选备注" },
        },
        required: ["recipientId", "amount"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "wallet.recharge",
      description: "在用户明确要求后，代其向钱包充值（演示/测试用）。",
      parameters: {
        type: "object",
        properties: {
          amount: { type: "number", description: "充值金额（CNY，须 > 0）" },
        },
        required: ["amount"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "wallet.purchase",
      description:
        "代用户消费/购物（须用户授权）。覆盖外卖、打车、酒店、电影票、网购、缴费、红包等50+类别。category 示例：food_delivery/taxi/hotel/movie/shopping/phone_bill/red_packet 等。",
      parameters: {
        type: "object",
        properties: {
          category: {
            type: "string",
            description:
              "消费类别，如 food_delivery, taxi, hotel, movie, shopping, train, flight, phone_bill, red_packet, other 等",
          },
          amount: { type: "number", description: "消费金额（CNY，须 > 0）" },
          description: { type: "string", description: "消费描述（订单摘要）" },
          merchant: { type: "string", description: "商户/平台名称，如美团、滴滴、京东" },
          orderDetails: {
            type: "object",
            description: "可选订单细节（商品名、数量等）",
          },
        },
        required: ["category", "amount", "description"],
        additionalProperties: false,
      },
    },
  },
];

/** Agent Link：好友列表、好友请求（与 App 侧栏「Agent Link」/ MailboxPage 对齐）。 */
const AGENT_LINK_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "agent.link.list_friends",
      description: "列出当前用户的好友（Agent Link）。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "agent.link.list_friend_requests",
      description: "列出好友请求。scope: all（默认）| incoming | outgoing。",
      parameters: {
        type: "object",
        properties: {
          scope: { type: "string", enum: ["all", "incoming", "outgoing"] },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "agent.link.send_friend_request",
      description: "向另一用户发送好友请求（须用户明确要求）。",
      parameters: {
        type: "object",
        properties: {
          toActorId: { type: "string", description: "对方 userId/sessionId" },
          message: { type: "string", description: "可选附言" },
        },
        required: ["toActorId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "agent.link.respond_friend_request",
      description: "接受或拒绝收到的好友请求。",
      parameters: {
        type: "object",
        properties: {
          requestId: { type: "string" },
          accept: { type: "boolean" },
        },
        required: ["requestId", "accept"],
        additionalProperties: false,
      },
    },
  },
];

const AGENT_RELAY_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "agent.send_to_peer",
      description: "向好友或其它已配对 Agent 发送中继消息（可与 agent.link 好友配合）。",
      parameters: {
        type: "object",
        properties: {
          targetSessionId: { type: "string", description: "对方 sessionId" },
          body: { type: "string", description: "消息正文" },
          subject: { type: "string", description: "可选主题" },
          traceId: { type: "string", description: "可选追踪 id" },
        },
        required: ["targetSessionId", "body"],
        additionalProperties: false,
      },
    },
  },
];

/** 对话中自动创建/查询日程与提醒的内置工具组（写入定时任务，非独立日历应用）。 */
const CALENDAR_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "reminder.plan",
      description:
        "【生活助手】根据用户原句创建定时提醒并写入服务端日程。若用户只说时刻与事项、未说明「单次/每天/每周/连续」，返回 needsRecurrenceConfirm=true，须先追问用户，确认后再调用。系统会智能分析任务内容（如「开会」→建议单次、「吃药」→建议每天、「接下来3天」→建议连续），并在结果中返回 suggestedQuestion、suggestedType、confidence、reason 和 examples 供你参考。请根据这些建议向用户提问，提供清晰的选项让用户选择。例：「明天 9:00 提醒我开会」可直接创建；「早上七点叫我起床」「提醒我每天喝水」须先根据建议询问用户重复方式。成功返回 taskId、nextRunAt（UTC）、nextRunAtLocal（本地时间，展示给用户时必须用此字段）、recurrence。\n**提醒方式规则（重要）**：默认使用弹窗（popup）方式通知用户。仅当用户明确要求时才使用 TTS 语音闹钟或电话呼叫方式，例如用户说「打电话提醒我」「语音喊我」「电话叫醒我」。不要主动升级到 TTS 或电话方式，除非用户有明确偏好或主动提出需求。",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "用户原句，须含时间与提醒事项" },
          subject: { type: "string", description: "可选，与 date 组合解析（无 text 时）" },
          date: { type: "string", description: "可选，如「明天 09:00」（无 text 时）" },
          runAt: { type: "string", description: "可选 ISO-8601，与 subject 结构化创建" },
          recurrence: {
            type: "string",
            enum: ["none", "daily", "weekly", "yearly"],
            description: "默认 none；仅用户明确要每天/每周/每年重复时才填 daily/weekly/yearly",
          },
          shortTitle: { type: "string", description: "简洁展示标题（用于「今日安排」紧凑列表）：去掉「记得/提醒我/帮我」等指令词与所有时间词，只保留核心事项，如用户说「明天9点提醒我吃药」→shortTitle=\"吃药\"。可选，缺省时服务端按核心事项自动生成。" },
          reminderMessage: { type: "string", description: "到点时展示给用户的友好提醒文案，如「该睡觉啦！」而非「喊我睡觉」" },
          timezone: { type: "string", description: "IANA 时区，默认 Asia/Shanghai" },
        },
        required: ["text"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "calendar.create_from_text",
      description:
        "【内置 Calendar】在对话中根据用户原句自动创建日程/提醒。提醒类若未说明单次或每天/每周/连续，返回 needsRecurrenceConfirm=true，须向用户确认后再创建。系统会智能分析任务类型并提供建议（含 suggestedQuestion、examples 等），请据此向用户提问。例「明天 9:00 提醒我开会」「每天 7 点天气提醒」「接下来3天提醒我复习」。成功返回 taskId、nextRunAt（UTC）、nextRunAtLocal（本地格式化时间，向用户展示时间时必须使用此字段）；解析失败则 matched=false。",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "用户原句，含时间与事项" },
          timezone: { type: "string", description: "IANA 时区，默认 Asia/Shanghai" },
        },
        required: ["text"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "calendar.create_task",
      description:
        "【内置 Calendar】在对话中按结构化字段自动创建定时任务：提醒（reminder）、HTTP 动作（action）、天气简报（weather_brief）、Agent 自动化任务（agent_task）。runAt 须为 ISO-8601 且为未来时间。用户已说清楚时间/类型时优先用本工具；含糊时可用 calendar.create_from_text。成功返回 taskId、nextRunAt（UTC）、nextRunAtLocal（本地格式化时间，向用户展示时间时必须使用此字段）。",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "完整任务标题（用于日程页完整列表；reminder 类型可选，由 reminderMessage 兜底）" },
          shortTitle: { type: "string", description: "简洁展示标题（用于「今日安排」紧凑列表）：必须去掉「记得/提醒我/帮我/给我」等指令词和所有时间词，只保留核心事项，如用户说「明天9点提醒我吃药」→shortTitle=\"吃药\"。reminder 类型必填；其他类型缺省时服务端用 title 兜底。" },
          description: { type: "string" },
          kind: {
            type: "string",
            enum: ["reminder", "action", "weather_brief", "agent_task"],
            description: "weather_brief 需用户已在天气页保存定位；agent_task 会在到点后让 Agent 执行 prompt",
          },
          runAt: { type: "string", description: "ISO-8601" },
          recurrence: {
            type: "string",
            enum: ["none", "daily", "weekly", "yearly"],
            description: "默认 none；勿在用户未要求时填 daily",
          },
          timezone: { type: "string" },
          reminderMessage: { type: "string", description: "仅 kind=reminder。到点时展示给用户的友好提醒文案，如「该睡觉啦！」而非「喊我睡觉」" },
          action: {
            type: "object",
            description: "仅 kind=action",
            properties: {
              url: { type: "string" },
              method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
            },
          },
          actionUrl: { type: "string", description: "与 action.url 二选一" },
          agentTask: {
            type: "object",
            description: "仅 kind=agent_task",
            properties: {
              prompt: { type: "string", description: "到点后交给 Agent 执行的自然语言任务" },
              accessMode: { type: "string", enum: ["sandbox", "full"], description: "已废弃，Agent 始终以 full 运行；保留字段仅为协议兼容" },
            },
          },
          prompt: { type: "string", description: "agent_task 的快捷 prompt 字段" },
        },
        required: ["description", "kind", "runAt"],
        additionalProperties: true,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "calendar.list_tasks",
      description:
        "【内置 Calendar】查询当前用户已创建的定时日程/提醒（含下次执行时间）。仅当用户**明确**要查看/确认日程或定时任务时调用；禁止用于「你确定？」「真的吗？」等短句追问（应结合对话线程上一轮回复作答）。",
      parameters: {
        type: "object",
        properties: {
          from: { type: "string", description: "范围起点 ISO，可选" },
          to: { type: "string", description: "范围终点 ISO，可选" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "calendar.delete_task",
      description:
        "【内置 Calendar】删除用户已创建的定时日程/提醒。仅当用户明确要求删除/取消某个日程或提醒时调用；可先用 calendar.list_tasks 找到 taskId。",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "要删除的日程/提醒 taskId（list_tasks 返回）" },
        },
        required: ["taskId"],
        additionalProperties: false,
      },
    },
  },
];

const PHONE_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "phone.ensure_my_number",
      description:
        "仅当用户明确要求办理虚拟电话时调用：分配或查询用户与 Agent 共用的 6 位虚拟号码（登记在 Agent 名下）。禁止未要求时主动占号。Agent 互拨前须已申领；对用户可说「您的虚拟号码」。App 内用户呼叫 Agent 不必再输 6 位号。跨 Agent 配对规则同中继。",
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
      name: "phone.virtual_call",
      description:
        "Agent 互拨：拨打另一 Agent 的 6 位虚拟号码（被叫须已申领）。主叫 Agent 须已申领号码（用户明确要求时用 phone.ensure_my_number 办理）。向目标 Agent 推送虚拟来电并朗读 spokenMessage。ringStyle：reminder=自提醒；peer=联络其他 Agent（默认）。与用户通话请用 phone.call_user，勿用本工具。",
      parameters: {
        type: "object",
        properties: {
          toPhone: { type: "string", description: "6 位数字虚拟号码" },
          spokenMessage: { type: "string", description: "对方将听到的播报正文（尽量简短清晰）" },
          ringStyle: {
            type: "string",
            enum: ["peer", "reminder"],
            description: "peer=联络其他 Agent；reminder=提醒风格",
          },
        },
        required: ["toPhone", "spokenMessage"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "phone.call_user",
      description:
        "Agent 呼叫当前用户：通过 WebSocket 向用户客户端推送语音来电（含 TTS），用户可接听并文字/语音回复。用户不需要虚拟号码。spokenMessage 为播报正文。ringStyle：reminder=提醒；peer=联络（默认）。\n【绝对禁止】\n- 一轮只许调用一次，多次调用系统只认第一次。\n- 禁止回复「马上给你打过去」「好的我给您打个电话」「现在给你打确认」「再打一次」「马上去设」等任何提前告知或重复承诺——用户不需要知道你要打，直接打就是。\n- 别一上来就甩「我是 AI 打不了电话」「没法拨号」这种话。\n- 打电话是后台事儿，跟用户说话时别提倒计时、别说「到时候接一下」、别提「准时喊你」这种内部细节。",
      parameters: {
        type: "object",
        properties: {
          toUserId: { type: "string", description: "被叫用户 ID，通常省略则使用当前会话用户" },
          spokenMessage: { type: "string", description: "用户将听到的播报正文" },
          ringStyle: {
            type: "string",
            enum: ["peer", "reminder"],
            description: "peer=联络；reminder=提醒",
          },
        },
        required: ["spokenMessage"],
        additionalProperties: false,
      },
    },
  },
];

/** 沙箱模式下从模型 tools 列表移除、完全访问时须下发的视觉高权限工具。 */
export const VISION_SANDBOX_RESTRICTED_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "vision.http_pull",
      description:
        "【服务端视觉】通过 HTTP(S) 抓取远程快照图像（如摄像头 MJPEG/快照接口）。抓取成功后图像会注入当前对话下一轮模型上下文用于识别场景。**请勿用于探测内网**（服务端默认阻断 localhost 与私网 IP；可对可信域名配置 AGENT_VISION_HTTP_PULL_ALLOW_HOSTS）。",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "http(s) 图像快照完整 URL" },
          sourceId: { type: "string", description: "可选稳定源标记（telemetry）" },
        },
        required: ["url"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "vision.periodic_start",
      description:
        "【服务端定时视觉】按固定间隔从给定 HTTP(S) 快照 URL 拉帧并向模型推送一轮「配图」巡检推理。**客户端 WebSocket 需在线**才能收到助手的 chunk/done。与单次 vision.http_pull 不同：此为服务端调度无需用户每次手动发送图像。",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "快照 URL（同上约束）" },
          intervalSeconds: {
            type: "integer",
            description: "间隔秒数（下限约 30s，可由环境变量收紧）",
          },
          prompt: {
            type: "string",
            description: "每轮发给模型的巡检文案（可选）",
          },
        },
        required: ["url", "intervalSeconds"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "vision.periodic_stop",
      description: "停止指定的定时视觉任务（需提供 vision.periodic_start 返回的 jobId）。",
      parameters: {
        type: "object",
        properties: { jobId: { type: "string" } },
        required: ["jobId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "vision.periodic_stop_all",
      description: "停止当前会话用户的全部定时视觉任务。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "vision.periodic_list",
      description: "列出当前会话用户的定时视觉任务（jobId、url、间隔与巡检文案）。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "vision.list_cameras",
      description:
        "【视觉设备清单】列出当前用户所有「能看」的在线设备：IP 摄像头（camera.*）、手机/电脑摄像头、电脑屏幕（screen_capture.*）、智能眼镜（glasses.display.*）等。" +
        "返回每个设备的 deviceId / kind / name / 在线状态 / 视觉 capability（含可调 action 清单，如 camera.take_photo）。" +
        "用户说「我有哪些摄像头」「能看哪里」「监控一下家里」「看看门口」时先调本工具知道有哪些设备可看，再调 vision.see_device 取画面。" +
        "与 device.list 区别：device.list 返回所有设备（含纯传感器/智能家居等），本工具只返回具备视觉能力的设备。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "vision.see_device",
      description:
        "【从设备取实时画面】从指定设备取一帧当前画面并注入下一轮模型上下文（让 Agent「看到真实世界」）。" +
        "用户说「看一下门口」「看下家里」「看看我面前」「实时看下摄像头」「看看我电脑屏幕」「看一下我桌面」时调用本工具。" +
        "参数：device_id（从 vision.list_cameras 结果中选取）+ 可选 action（默认按设备 capability 自动选 camera.take_photo / screen_capture.screenshot / glasses.display.capture）。" +
        "特殊 device_id='desktop:bridge'：走 desktop-bridge-coordinator 路径截取本机桌面（用户电脑通过 desktop_bridge_register 注册的桌面），" +
        "支持可选 region=[x,y,w,h] 截取区域。" +
        "与 vision.http_pull 区别：http_pull 拉远程 URL（公网/局域网快照接口）；see_device 调 device-bus 接入的真实设备（IP 摄像头/手机/眼镜）或 desktop-bridge 桌面，是真正的「看真实世界」。" +
        "返回简要元数据（mimeType/byteLength/capturedAt），图像已注入模型上下文，请基于图像描述场景并回答。",
      parameters: {
        type: "object",
        properties: {
          device_id: {
            type: "string",
            description: "设备 ID（从 vision.list_cameras 结果中选取，如 camera:front / phone:abc / glasses:xyz / desktop:bridge）",
          },
          action: {
            type: "string",
            description: "可选：指定调用的 action（如 camera.take_photo / screen_capture.screenshot / glasses.display.capture）。留空则按设备 capability 自动选择。",
          },
          params: {
            type: "object",
            description: "可选：action 的额外参数（如 PTZ 预设位、摄像头选择等）",
            additionalProperties: true,
          },
          region: {
            type: "array",
            items: { type: "number" },
            description: "可选：仅 desktop:bridge 路径生效，截取区域 [x, y, width, height]",
          },
          timeoutMs: {
            type: "number",
            description: "可选：仅 desktop:bridge 路径生效，截图超时毫秒（默认 60000，上限 120000）",
          },
        },
        required: ["device_id"],
        additionalProperties: false,
      },
    },
  },
];

const VISION_CHAT_TOOLS: ChatCompletionTool[] = VISION_SANDBOX_RESTRICTED_CHAT_TOOLS;

/**
 * Agent 底层语音能力 ChatCompletionTool schema（说 + 听）。
 *
 * 之前 voice.speak / voice.send_message 已在 ToolRegistry 注册 handler，
 * 但缺这份 schema，导致 LLM 看不到这两个工具——是个真正的盲点。
 * 本数组把它们正式暴露给 LLM，并新增 voice.transcribe（主动 ASR）。
 *
 * 与 phone.call_user 的区别：phone 走 `isExplicitPhoneCallRequest` 旁路注入，
 * voice 工具族走常规 tool-search 选择 + 关键词分类。
 */
const VOICE_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "voice.speak",
      description:
        "【语音播报·即时模式】合成语音并立即对用户播报（无来电 UI、无振铃，客户端后台一次性播放）。适用于：状态告知、提醒、即时反馈、不需要用户回应的简短播报。与 phone.call_user 区别：phone 是来电体验（振铃+接通+通话 UI），voice.speak 是轻量后台播报。用户问「能不能说话」「用语音告诉我」时调用本工具。\n【绝对禁止】调用后不要在文本回复里复述语音内容，工具会替你落地。禁止回复「马上给你播报」「好的我给您念」等提前告知。",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "要朗读的文字内容（建议 200 字以内，过长会被截断）" },
          mode: {
            type: "string",
            enum: ["instant", "reminder"],
            description: "instant=即时播报（默认），reminder=提醒式播报（带标题/优先级，客户端可显示卡片）",
          },
          title: { type: "string", description: "reminder 模式下的标题（仅 mode=reminder 生效）" },
          priority: {
            type: "string",
            enum: ["low", "medium", "high", "urgent"],
            description: "reminder 模式下的优先级（默认 medium）",
          },
        },
        required: ["text"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "voice.send_message",
      description:
        "【语音消息·微信式】合成语音并落地为可重播的语音消息（客户端渲染为微信式语音气泡，用户可多次点击重播）。适用于：用户明确要求「发语音」「发条语音消息」、长文本回复用语音更自然、朋友式聊天场景。与 voice.speak 区别：speak 是一次性即时播报无 UI，send_message 是落地可重播语音消息。短指令回复（如「好的」「知道了」）请用文本，不要滥用本工具。\n【绝对禁止】调用后不要在文本回复里复述语音内容，工具会替你落地。",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "语音消息要朗读的内容" },
          replyToMessageId: {
            type: "string",
            description: "可选：要回复的历史消息 ID（用于上下文关联）",
          },
        },
        required: ["text"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "voice.transcribe",
      description:
        "【ASR 主动识别】把已落地的语音消息文件转写为文本，让 Agent 能「听」用户发来的语音。mediaUrl 形如 /agent/voice/messages/{actorId}/{msgId}.mp3（用户上传或 voice.send_message 落地后产生）。适用于：用户引用了某条历史语音要求重新理解、多轮对话中需要复核语音内容、跨模态推理。注意：通常用户发来 voice 消息时 chat-user-message 已自动调 ASR 把 transcript 喂给模型，本工具主要用于「重听」或「主动检查」历史语音。",
      parameters: {
        type: "object",
        properties: {
          mediaUrl: {
            type: "string",
            description: "语音消息的访问 URL，形如 /agent/voice/messages/{actorId}/{msgId}.mp3",
          },
          language: {
            type: "string",
            description: "语言提示（如 zh、en），默认 zh",
          },
        },
        required: ["mediaUrl"],
        additionalProperties: false,
      },
    },
  },
];

/** 时钟工具：获取当前时间和日期信息（通过IP地址查询用户时区）。 */
export const CLOCK_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "clock.get_current_time",
      description:
        "获取当前时间（注册名 clock.get_current_time）。通过 IP 查询时区与城市，返回本地时间（精确到秒）、星期。\n【强制调用规则】用户询问时间或所在城市/当前位置时必须调用本工具或 clock.get_user_location；禁止使用 IP 或训练数据臆测位置。",
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
      name: "clock.get_user_location",
      description:
        "通过 IP 识别用户当前所在城市、省份/州、国家和时区。用户问「我在哪个城市」「我在哪」「当前位置」时必须调用。",
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
      name: "clock.get_date",
      description: "获取当前日期和星期。通过IP地址查询自动识别用户所在城市，返回当地日期信息。当用户询问今天几号、今天星期几时使用此工具。",
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
      name: "clock.format_timestamp",
      description: "将 Unix 时间戳格式化为可读的本地时间（通过IP地址识别用户时区）。",
      parameters: {
        type: "object",
        properties: {
          timestamp: { type: "number", description: "Unix 时间戳（秒）" },
        },
        required: ["timestamp"],
        additionalProperties: false,
      },
    },
  },
];

/**
 * Fast 车道轻量工具集：从 builtin 全量工具集中动态筛选 fastLane 工具
 * + 合并自我进化生成的动态 fastLane Skill 工具。
 *
 * 筛选规则：{@link isFastLaneTool}（静态 CORE_TOOL_LIBRARY.fastLane + 动态名单）。
 * 新增内置工具时在 CORE_TOOL_LIBRARY.fastLane 里声明即可自动收编；
 * 自我进化生成的 Skill 通过 setDynamicFastLaneSkillTools() 注入后自动收编。
 */
let _fastLaneToolsCache: ChatCompletionTool[] | null = null;

/**
 * 动态 fastLane Skill 工具（自我进化生成的轻量查询类 Skill）。
 *
 * 由 setDynamicFastLaneSkillTools() 注入，getFastLaneTools() 会把它们合并到
 * Fast 模式工具集中。注入后自动清缓存重建。
 */
let _dynamicFastLaneSkillTools: ChatCompletionTool[] = [];

/**
 * 注入动态 fastLane Skill 工具列表（自我进化装载 Skill 后调用）。
 *
 * 调用后清除 fastLane 缓存，下次 getFastLaneTools() 会重新合并 builtin + 动态。
 */
export function setDynamicFastLaneSkillTools(tools: ChatCompletionTool[]): void {
  _dynamicFastLaneSkillTools = tools;
  _fastLaneToolsCache = null;
}

export function getFastLaneTools(): ChatCompletionTool[] {
  if (_fastLaneToolsCache) return _fastLaneToolsCache;
  const builtinFastLane = getBuiltinAgentChatTools().filter((t) => {
    if (!("function" in t) || !t.function?.name) return false;
    return isFastLaneTool(t.function.name);
  });
  // 合并动态 fastLane Skill（去重：builtin 已有的不重复加入）
  const seen = new Set<string>();
  for (const t of builtinFastLane) {
    if ("function" in t && t.function?.name) seen.add(t.function.name);
  }
  const dynamicUnique = _dynamicFastLaneSkillTools.filter((t) => {
    if (!("function" in t) || !t.function?.name) return false;
    return !seen.has(t.function.name);
  });
  _fastLaneToolsCache = [...builtinFastLane, ...dynamicUnique];
  return _fastLaneToolsCache;
}

/** Agent 能力详细查询工具（Layer 3）：system prompt 已包含行为规则和路由表（Layer 2），本工具用于获取某领域的完整能力描述和运行时状态。 */
const AGENT_CAPABILITY_QUERY_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "agent.query_capabilities",
      description:
        "查询指定领域的完整能力描述和运行时状态。system prompt 中已有基础规则和路由表，本工具用于：①用户问「你能做什么」需展示完整清单时 ②需要某领域的详细工具说明/参数提示时 ③查看Agent World完整状态(社交推文站/技能商店/world.*工具族)时 ④确认虚拟电话号码等动态信息时。结果会保留在对话上下文供后续参考。",
      parameters: {
        type: "object",
        properties: {
          domain: {
            type: "string",
            enum: ["wallet", "agent_link", "calendar", "weather", "sub_agent", "aip", "vision", "desktop", "web", "life_assistant", "phone", "entertainment", "social_feed", "self_programming", "agent_account", "world", "embodiment", "all"],
            description:
              "能力领域过滤。不传或传 'all' 返回全部；传具体域名仅返回该领域。建议优先指定领域以减少 token 消耗：wallet=钱包, agent_link=好友, calendar=日程, weather=天气, sub_agent=子Agent委派, aip=AIP协议, vision=视觉, desktop=桌面自动化, web=网页浏览, life_assistant=生活助手, phone=虚拟电话, entertainment=娱乐互动, self_programming=自我编程, agent_account=账号注册, embodiment=具身身体, world=Agent World。",
          },
        },
        additionalProperties: false,
      },
    },
  },
];

/** world.* / AIP / 内置联网工具等（不含按会话合并的 Skill function 列表）。结果带模块级缓存。 */
let _builtinToolsCache: ChatCompletionTool[] | null = null;

/** 动态注入的 MCP 工具（由 bootstrap 阶段设置） */
let _mcpChatTools: ChatCompletionTool[] = [];

/** 能力模块依赖（由 bootstrap 阶段设置；为 null 时能力模块工具不并入） */
let _capabilityModuleDeps: CapabilityModuleDeps | null = null;

/** 动态注入的 Brain Center 工具（由 bootstrap 阶段设置；brain 未启用时为空数组） */
let _brainChatTools: ChatCompletionTool[] = [];

/** 动态注入的 Body Center 工具（由 bootstrap 阶段设置；body 未启用时为空数组） */
let _bodyChatTools: ChatCompletionTool[] = [];

/** 注入 MCP ChatCompletionTool 列表（启动时调用一次） */
export function setMcpChatTools(tools: ChatCompletionTool[]): void {
  _mcpChatTools = tools;
  // 清除缓存，下次 getBuiltinAgentChatTools 调用会重新构建
  _builtinToolsCache = null;
  _fastLaneToolsCache = null;
}

/**
 * 注入能力模块依赖（启动时调用一次）。
 *
 * 注入后：
 *   - {@link getBuiltinAgentChatTools} 会把所有能力模块的 ChatCompletionTool 合并进总列表
 *   - {@link selectRelevantTools} 会把能力模块的 category mappings 合并到关键词分类
 *
 * 与 {@link setMcpChatTools} 类似，调用后清缓存重建。
 */
export function setCapabilityModuleDeps(deps: CapabilityModuleDeps): void {
  _capabilityModuleDeps = deps;
  _builtinToolsCache = null;
  _fastLaneToolsCache = null;
}

/**
 * 注入 Brain Center 工具 schema 列表（启动时调用一次）。
 *
 * 仅当 BrainCenter 启用时由 bootstrap 传入 BRAIN_TOOLS；否则保持空数组，
 * brain.* 工具不会出现在 LLM 可见工具列表中。调用后清缓存重建。
 */
export function setBrainChatTools(tools: ChatCompletionTool[]): void {
  _brainChatTools = tools;
  _builtinToolsCache = null;
  _fastLaneToolsCache = null;
}

/**
 * 注入 Body Center 工具 schema 列表（启动时调用一次）。
 *
 * 仅当 BodyCenter 启用时由 bootstrap 传入 BODY_CHAT_TOOLS；否则保持空数组，
 * body.* 工具不会出现在 LLM 可见工具列表中。调用后清缓存重建。
 */
export function setBodyChatTools(tools: ChatCompletionTool[]): void {
  _bodyChatTools = tools;
  _builtinToolsCache = null;
  _fastLaneToolsCache = null;
}

export function getBuiltinAgentChatTools(): ChatCompletionTool[] {
  if (_builtinToolsCache) return _builtinToolsCache;
  const capabilityModuleTools = _capabilityModuleDeps
    ? getCapabilityModuleChatTools(_capabilityModuleDeps)
    : [];
  _builtinToolsCache = [
    ...AGENT_WORLD_CHAT_TOOLS,
    ...AIP_CHAT_TOOLS,
    ...INFO_WEB_CHAT_TOOLS,
    ...LIFE_ASSISTANT_CHAT_TOOLS,
    ...WALLET_CHAT_TOOLS,
    ...AGENT_LINK_CHAT_TOOLS,
    ...AGENT_RELAY_CHAT_TOOLS,
    ...CALENDAR_CHAT_TOOLS,
    ...PHONE_CHAT_TOOLS,
    ...VISION_CHAT_TOOLS,
    ...VOICE_CHAT_TOOLS,
    ...CLOCK_CHAT_TOOLS,
    ...INTERNET_INTELLIGENCE_CHAT_TOOLS,
    ...AGENT_CAPABILITY_QUERY_CHAT_TOOLS,
    ...EMBODIMENT_CHAT_TOOLS,
    ...SMART_HOME_CHAT_TOOLS,
    ...DEVICE_CHAT_TOOLS,
    ...getDesktopVisualChatTools(),
    ...getPhoneBridgeChatTools(),
    BROWSER_SESSION_LIST_CHAT_TOOL,
    ...SELF_PROGRAMMING_CHAT_TOOLS,
    ...capabilityModuleTools,
    ..._brainChatTools,
    ..._bodyChatTools,
    ..._mcpChatTools,
  ];
  return _builtinToolsCache;
}

/**
 * 统一清除 builtin + fastLane 工具缓存。
 *
 * 自我进化装载 / 卸载 Skill 后调用，确保下次 getBuiltinAgentChatTools() /
 * getFastLaneTools() 重新构建，新能力立即可见。
 */
export function invalidateBuiltinToolsCache(): void {
  _builtinToolsCache = null;
  _fastLaneToolsCache = null;
}

/**
 * 智能工具选择系统：基于用户输入上下文动态筛选相关工具，减少 Token 消耗和模型推理时间
 * 预期效果：减少 60-80% 的工具 Token，首字延迟降低 30-50%
 */

type ToolCategory = 'web' | 'calendar' | 'wallet' | 'social' | 'phone' | 'vision' | 'clock' | 'life' | 'capability' | 'desktop' | 'programming' | 'world' | 'aip' | 'embodiment' | 'smart_home' | 'mcp' | 'image' | string;

interface ToolCategoryMapping {
  category: ToolCategory;
  keywords: string[];
  toolNames: string[];
}

const TOOL_CATEGORY_MAPPINGS: ToolCategoryMapping[] = [
  {
    category: 'web',
    keywords: ['搜索', 'search', '网页', 'web', '网址', 'url', '链接', 'link', '查询', 'query', '新闻', 'news', '天气', 'weather', 'fetch', '浏览', 'browse', '导航', 'navigate', '图片', '图像', '照片', 'image', 'photo', '视频', 'video', '对比', '比较', '区别'],
    toolNames: ['internet.research', 'internet.live_check', 'internet.verify', 'search_web', 'search_images', 'search_images_batch', 'search_videos', 'fetch_web', 'info.inspect_webpage', 'info.navigate_site']
  },
  {
    category: 'calendar',
    keywords: ['提醒', 'reminder', '日程', 'schedule', '日历', 'calendar', '任务', 'task', '定时', 'timer', '闹钟', 'alarm', '计划', 'plan', '会议', 'meeting', '预约', 'appointment'],
    toolNames: ['reminder.plan', 'calendar.create_from_text', 'calendar.create_task', 'calendar.list_tasks']
  },
  {
    category: 'wallet',
    keywords: ['钱包', 'wallet', '余额', 'balance', '支付', 'pay', '转账', 'transfer', '充值', 'recharge', '消费', 'purchase', '交易', 'transaction', '账单', 'bill', '钱', 'money', '金额', 'amount'],
    toolNames: [
      'wallet.get_balance',
      'wallet.get_transactions',
      'wallet.transfer',
      'wallet.recharge',
      'wallet.purchase',
      'payment.create_order',
      'payment.query_order',
      'alipay.check-wallet',
      'alipay.apply-wallet',
      'alipay.submit-payment',
      'alipay.query-payment',
      'alipay.pay-402',
      'alipay.proxy-trade',
      'alipay.merchant-list',
      'alipay.merchant-order',
    ]
  },
  {
    category: 'social',
    keywords: ['好友', 'friend', '联系人', 'contact', '消息', 'message', '发送', 'send', '接收', 'receive', '请求', 'request', 'agent', 'peer', '中继', 'relay', '配对', 'pair'],
    toolNames: ['agent.link.list_friends', 'agent.link.list_friend_requests', 'agent.link.send_friend_request', 'agent.link.respond_friend_request', 'agent.send_to_peer']
  },
  {
    category: 'phone',
    keywords: ['电话', 'phone', '拨打', 'call', '虚拟号', 'virtual', '号码', 'number', '通话', 'ring', '来电', 'call'],
    toolNames: ['phone.ensure_my_number', 'phone.virtual_call', 'phone.call_user']
  },
  {
    category: 'vision',
    keywords: ['图像', 'image', '图片', 'picture', '视觉', 'vision', '摄像头', 'camera', '截图', 'screenshot', '画面', 'frame', '拍照', 'photo', '识别', 'recognize', '看', 'see', '观察', 'observe'],
    toolNames: ['vision.http_pull', 'vision.periodic_start', 'vision.periodic_stop', 'vision.periodic_stop_all', 'vision.periodic_list']
  },
  {
    category: 'voice',
    keywords: ['语音', 'voice', '说话', 'speak', '播报', '朗读', '读出来', '说出来', '听', 'listen', '转写', 'transcribe', '识别语音', 'asr', 'tts', '发声', '开口', '说一声', '念', '朗读', '录音', 'audio'],
    toolNames: ['voice.speak', 'voice.send_message', 'voice.transcribe']
  },
  {
    category: 'clock',
    keywords: ['时间', 'time', '日期', 'date', '时钟', 'clock', '现在', 'now', '当前', 'current', '几点', 'what time', '今天', 'today', '星期', 'week', '时区', 'timezone', 'timestamp', '时间戳'],
    toolNames: ['clock.get_current_time', 'clock.get_user_location', 'clock.get_date', 'clock.format_timestamp']
  },
  {
    category: 'life',
    keywords: ['预算', 'budget', '计算', 'calculate', '购物', 'shopping', '建议', 'suggest', '比价', 'compare', '推荐', 'recommend', '生活', 'life', '助手', 'assistant'],
    toolNames: ['budget.calculate', 'shopping.suggest']
  },
  {
    category: 'capability',
    keywords: ['能力', 'capability', '功能', 'function', '能做什么', 'can you do', '帮助', 'help', '技能', 'skill', '工具', 'tool', '介绍', 'introduce', '说明', 'explain'],
    toolNames: ['agent.query_capabilities']
  },
  {
    category: 'embodiment',
    keywords: ['身体', '移动', '动一动', '走动', '逛逛', '漫游', '球形', '机器人', '挪', '飞', '兴奋', '表情', 'roam', 'move', 'body', 'embodiment'],
    toolNames: ['embodiment.observe', 'embodiment.window_place', 'embodiment.roam', 'embodiment.move', 'embodiment.stop', 'embodiment.set_state', 'embodiment.excite', 'embodiment.window_roam']
  },
  {
    // Body Center 器官层：让用户问"身体器官 / 大脑结构 / 我有哪些身体能力"时能命中 body.* 工具
    category: 'body',
    keywords: [
      '身体器官', '器官', '大脑结构', '大脑', 'brain', '身体结构', '身体能力', '身体模块',
      '我有哪些身体', '我有什么身体', '我的身体', '我在哪台设备', '我在哪里渲染',
      '手', '眼', '耳', '嘴', '皮肤', '前庭', '稳态', '反射', 'hand', 'eye', 'ear', 'mouth', 'skin',
      '电量', 'battery', '算力配额', '负载', '疲劳度', 'fatigue',
      'body.list_modules', 'body.where_am_i', 'body.state', 'body.calibrate',
    ],
    toolNames: ['body.list_modules', 'body.where_am_i', 'body.state', 'body.calibrate']
  },
  {
    category: 'desktop',
    keywords: [
      '桌面', 'desktop', '电脑', 'computer', '屏幕', 'screen', '自动化', 'automation', '控制', 'control',
      '操作', 'operate', '点击', 'click', '键盘', 'keyboard', '鼠标', 'mouse', '截屏', '截图', '操控',
      '打开浏览器', '浏览器',
      // 2026-07-13 新增：让 LLM 在「打开微信 / 启动应用 / 发消息 / 跑命令」等场景下能命中 desktop 工具
      '打开', 'open', '启动', 'launch', '运行', 'run', '应用', 'app', '程序', 'program',
      '微信', 'wechat', 'qq', '抖音', 'douyin', '钉钉', 'dingtalk', '飞书', 'feishu', 'lark',
      '窗口', 'window', '按钮', 'button', 'uia', 'uia_query', '控件', 'control_',
      'cmd', 'powershell', 'bash', 'shell', '终端', 'terminal', '命令行',
    ],
    toolNames: [
      'desktop.visual.screenshot',
      'desktop.visual.run_task',
      'desktop.open',
      'desktop.run_preset',
      'desktop.run_shell',
      'desktop.uia_query',
    ],
  },
  {
    category: 'programming',
    keywords: ['编程', 'program', '代码', 'code', '开发', 'develop', '自我', 'self', '优化', 'optimize', '改进', 'improve', '修复', 'fix', 'bug', 'debug'],
    toolNames: [] // self-programming tools are dynamic
  },
  {
    category: 'world',
    keywords: ['世界', 'world', '社交', 'social', '市场', 'market', '点数', 'points', '积分', 'score'],
    toolNames: [] // agent world tools are dynamic
  },
  {
    category: 'aip',
    keywords: ['提案', 'proposal', '联盟', 'alliance', '冲突', 'conflict', '协议', 'protocol', 'aip', '投票', 'vote', '交易', 'trade'],
    toolNames: [] // aip tools are dynamic
  },
  {
    category: 'smart_home',
    keywords: ['灯', '灯光', '开关', '空调', '温度', '窗帘', '传感器', '设备', '家电', '家居', '智能', 'home', 'light', 'climate', 'switch', 'cover', 'sensor', '加热', '取暖', '制冷', 'cool', 'heat', 'fan', '风扇', '湿度', 'humidity', 'brightness', '亮度', '场景', 'scene', '回家', '离家', '晚安'],
    toolNames: ['smart_home.list_devices', 'smart_home.control_device', 'smart_home.scene']
  },
  {
    category: 'mcp',
    keywords: ['微博', 'weibo', '小红书', 'xiaohongshu', 'xhs', '微信', 'wechat', '抖音', 'douyin', 'mcp', '外部工具', 'external tool', '平台', 'platform', '文件', 'file', '读取', 'read', '写入', 'write', '搜索平台', 'platform search'],
    toolNames: [] as string[], // 运行时由 buildToolCategoryMappings() 动态填充
  },
];

/**
 * 构建带动态 MCP 工具名的分类映射。
 * 将已注册的 MCP 工具名注入 mcp 分类的 toolNames，
 * 使关键词筛选阶段能精确命中 MCP 工具（与内置工具行为一致）。
 */
export function buildToolCategoryMappings(
  extraMcpToolNames?: string[],
): typeof TOOL_CATEGORY_MAPPINGS {
  if (!extraMcpToolNames || extraMcpToolNames.length === 0) {
    return TOOL_CATEGORY_MAPPINGS;
  }
  return TOOL_CATEGORY_MAPPINGS.map((mapping) =>
    mapping.category === "mcp"
      ? { ...mapping, toolNames: [...extraMcpToolNames] }
      : mapping,
  );
}

const ALWAYS_INCLUDED_TOOLS = [
  'clock.get_current_time',
  'agent.query_capabilities',
  'brain.list_capabilities',
  'phone.call_user',
  // search_images 不再常驻：
  //   收敛误触发（2026-08-20，宁缺勿滥）——常驻会让模型在"对话前面搜过图、本轮并
  //   未要图"时仍被勾着调用。改为回落到 contextual 筛选：只有当当前轮用户意图命
  //   web/图片类别时才暴露。若模型未搜图但回复里回显了图片链接，服务端
  //   promoteImageUrlsToMedia 会确定性兜底渲染，不会退回"图显示不出来"。
  // embodiment.* 已在 CORE_TOOL_LIBRARY 的 embodiment tier 整族暴露，每轮必带，
  // 不需要再在此重复声明。
];

function extractKeywords(text: string): string[] {
  const cleaned = text.toLowerCase()
    .replace(/[^\u4e00-\u9fa5a-zA-Z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  
  const words = cleaned.split(' ').filter(w => w.length > 0);
  
  const chineseSegments: string[] = [];
  let currentChinese = '';
  
  for (const char of text) {
    if (/[\u4e00-\u9fa5]/.test(char)) {
      currentChinese += char;
      if (currentChinese.length >= 2) {
        chineseSegments.push(currentChinese);
        currentChinese = currentChinese.slice(1);
      }
    } else {
      currentChinese = '';
    }
  }
  
  return [...new Set([...words, ...chineseSegments])];
}

function detectRelevantCategoriesFrom(
  userText: string,
  mappings: typeof TOOL_CATEGORY_MAPPINGS = TOOL_CATEGORY_MAPPINGS,
): Set<ToolCategory> {
  const keywords = extractKeywords(userText);
  const relevantCategories = new Set<ToolCategory>();
  
  for (const mapping of mappings) {
    const matchCount = mapping.keywords.filter(kw => 
      keywords.some(userKw => 
        userKw.includes(kw) || kw.includes(userKw)
      )
    ).length;
    
    if (matchCount > 0) {
      relevantCategories.add(mapping.category);
    }
  }
  
  return relevantCategories;
}

export function selectRelevantTools(
  userText: string,
  allTools: ChatCompletionTool[],
  options?: {
    minTools?: number;
    maxTools?: number;
    includeAlwaysIncluded?: boolean;
    tokenBudget?: number;
  }
): ChatCompletionTool[] {
  const minTools = options?.minTools ?? 5;
  const maxTools = options?.maxTools ?? 20;
  const includeAlwaysIncluded = options?.includeAlwaysIncluded ?? true;

  // 从 allTools 中提取 MCP 工具名，动态注入分类映射
  const mcpToolNames = allTools
    .filter((t) => {
      const fn = (t as { function?: { name?: string } }).function;
      return Boolean(fn?.name?.startsWith("mcp."));
    })
    .map((t) => (t as { function: { name: string } }).function.name);
  const baseCategoryMappings = buildToolCategoryMappings(mcpToolNames);

  // 合并能力模块注入的分类映射（如 image / file_doc / email_sms 等）
  const capabilityModuleMappings: ToolCategoryMapping[] = _capabilityModuleDeps
    ? getCapabilityModuleCategoryMappings(_capabilityModuleDeps).map((m) => ({
        category: m.category as ToolCategory,
        keywords: m.keywords,
        toolNames: m.toolNames,
      }))
    : [];
  const categoryMappings = [...baseCategoryMappings, ...capabilityModuleMappings];

  const relevantCategories = detectRelevantCategoriesFrom(userText, categoryMappings);

  const selectedToolNames = new Set<string>();

  if (includeAlwaysIncluded) {
    ALWAYS_INCLUDED_TOOLS.forEach(name => selectedToolNames.add(name));
  }

  if (isExplicitPhoneCallRequest(userText)) {
    selectedToolNames.add("phone.call_user");
  }

  for (const mapping of categoryMappings) {
    if (relevantCategories.has(mapping.category)) {
      mapping.toolNames.forEach(name => selectedToolNames.add(name));
    }
  }
  
  const filteredTools = allTools.filter((tool) => {
    if (tool.type !== "function" || !("function" in tool) || !tool.function?.name) return false;
    return selectedToolNames.has(tool.function.name);
  });
  
  if (filteredTools.length < minTools) {
    // 兜底补充工具：按"通用工具优先级"排序，而非按 allTools 原始拼接顺序
    // 避免命中很少时（如"在吗"）塞进与意图无关的工具
    const FALLBACK_PRIORITY = [
      "clock.get_current_time",
      "agent.query_capabilities",
      "brain.list_capabilities",
      "search_web",
      "calendar.list_tasks",
      "wallet.get_balance",
      "phone.call_user",
    ];
    const remainingTools = allTools.filter((tool) => {
      if (tool.type !== "function" || !("function" in tool) || !tool.function?.name) return false;
      return !selectedToolNames.has(tool.function.name);
    });
    // 优先级排序：FALLBACK_PRIORITY 中的按顺序排前，其余保持原序
    const priorityRank = new Map(FALLBACK_PRIORITY.map((name, idx) => [name, idx]));
    const sortedRemaining = remainingTools.sort((a, b) => {
      const aName = (a as { function?: { name?: string } }).function?.name ?? "";
      const bName = (b as { function?: { name?: string } }).function?.name ?? "";
      const aRank = priorityRank.has(aName) ? priorityRank.get(aName)! : FALLBACK_PRIORITY.length;
      const bRank = priorityRank.has(bName) ? priorityRank.get(bName)! : FALLBACK_PRIORITY.length;
      return aRank - bRank;
    });
    const needed = minTools - filteredTools.length;
    filteredTools.push(...sortedRemaining.slice(0, needed));
  }
  
  if (filteredTools.length > maxTools) {
    // 超限截断：直接取前 maxTools 个（保持类别相关性排序），不再无条件补回
    // search_images。此前这么做是为了"模型多轮里想看图就能用"，但它绕开了
    // contextual 筛选，是"历史搜图上下文导致后续误触发"的来源之一（宁缺勿滥）。
    return filteredTools.slice(0, maxTools);
  }

  return filteredTools;
}

export function getSmartToolsForContext(userText: string, extraTools?: ChatCompletionTool[]): ChatCompletionTool[] {
  const allBuiltinTools = getBuiltinAgentChatTools();
  const allTools = extraTools ? [...allBuiltinTools, ...extraTools] : allBuiltinTools;
  
  return selectRelevantTools(userText, allTools);
}

function extractUserTextFromMessages(messages: ChatCompletionMessageParam[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'user') {
      if (typeof msg.content === 'string' && msg.content.trim()) {
        return msg.content.trim();
      }
      if (Array.isArray(msg.content)) {
        const textPart = msg.content.find(part => 
          part.type === 'text' && (part as { text?: string })?.text?.trim()
        );
        if (textPart && typeof textPart === 'object' && 'text' in textPart) {
          return (textPart as { text: string }).text.trim();
        }
      }
    }
  }
  return null;
}

/**
 * OpenAI 兼容 Chat Completions：流式输出 + tool_calls 多轮执行（Kimi / OpenAI 共用）。
 */
export async function streamCompletionWithTools(
  client: OpenAI,
  model: string,
  messages: ChatCompletionMessageParam[],
  onDelta: StreamDeltaHandler,
  ctx: ChatToolExecutionContext,
  options?: {
    maxRounds?: number;
    tools?: ChatCompletionTool[];
    toolSearchSourceTools?: ChatCompletionTool[];
    onAfterToolBatch?: (info: ToolLoopAfterBatchInfo) => void;
    /** Moonshot Kimi：如 `{ thinking: { type: "disabled" } }` */
    extraBody?: Record<string, unknown>;
    promptCache?: PrefixCacheRequest;
    requestSystemMessages?: ChatCompletionMessageParam[];
  },
): Promise<string> {
  // 动态调整工具循环轮次（基于任务复杂度）
  let maxRounds = options?.maxRounds;
  const userText = extractUserTextFromMessages(messages) || "";

  if (!maxRounds) {
    maxRounds = getOptimalMaxRounds(userText, messages.length);
  }
  
  const mergedRegistryTools = options?.tools ?? getBuiltinAgentChatTools();
  const toolSearchPrepared = await prepareTools(
    mergedRegistryTools,
    options?.toolSearchSourceTools,
    { userText },
  );
  const registryTools = toolSearchPrepared.visibleTools;
  const deferredToolCatalog = toolSearchPrepared.deferredCatalog;
  const requiresFreshWebLookup = shouldRequireFreshWebLookup(userText, registryTools);

  if (toolSearchPrepared.toolSearchActive) {
    console.info(
      `[tool-search] active: core=${toolSearchPrepared.coreToolCount} ` +
        `deferred=${toolSearchPrepared.deferredToolCount} ` +
        `visible=${registryTools.length} (BM25 index cached per turn)`,
    );
  }

  const { apiTools, resolveRegistryToolName } = prepareToolsForChatApi(registryTools);
  let lastAssistantText = "";
  let lastToolOutputFallback = "";
  const thinkingDisabled = isThinkingDisabled(options?.extraBody);
  let satisfiedFreshWebLookup = false;
  // 2026-08-01 性能优化：从 extraBody 推断 Fast 模式，传递给 resolveForcedToolChoice 跳过强制 tool_choice。
  // Fast 模式 = 对话为主，system prompt 已注入 currentTime / userLocation / scheduleSnapshot，
  // 强制工具调用会多 1 次 round trip，徒增延迟。
  const fastProfile = Boolean(options?.extraBody?.fastProfile === true);
  // 累积所有工具调用结果，供 summary 调用时做数据质量评估 + 策略注入
  const allToolExecResults: Array<{ toolName: string; ok: boolean; result: Record<string, unknown> }> = [];

  // 工具调用克制引导：减少 LLM 对同一工具的冗余重复调用（实测 S3 联网搜索场景
  // LLM 会连续调 3-5 次 search_web，S5 代码沙箱会调 2 次 code.run）。
  // 只在有工具可调时注入，纯对话场景不注入。
  if (apiTools.length > 0) {
    messages.push({
      role: "system",
      content:
        "工具调用原则：\n" +
        "1. 同一工具的结果通常一次就够了。如果 search_web 已返回相关结果，不要用相同或近似 query 再搜一遍——直接基于已有结果回答或 fetch_web 深读。\n" +
        "2. code.run 的 stdout/stderr 如果已包含答案，不要重跑同样代码。输出被截断(truncated=true)时，改用 code.write_file 写产物再 code.read_file 分段读，不要重跑。\n" +
        "3. 能一轮并行解决的不要拆成多轮串行。多个独立 URL 用一轮多个 fetch_web。\n" +
        "4. 拿到工具结果后优先直接回答用户，不要为了「确认」再调一次工具。\n" +
        "5. 图片/照片类需求用 search_images，不要用 search_web 编造图片来源（如 duitang.com 这类假域名）——前端拿不到真实图片。",
    });
  }

  // TEMP DEBUG（重复工具调用诊断：打印每轮的 tool_calls 数量）
  console.log(`[DBG-toolloop] maxRounds=${maxRounds} fastProfile=${fastProfile}`);
  // Fix1(加固 fast 轻工具链路)：recoveryGranted 跨轮持久，保证整个工具循环
  // 最多只授予一次恢复轮，避免失败级联导致无限加轮。
  let recoveryGranted = false;
  for (let round = 0; round < maxRounds; round++) {
    // 记录本轮真实取数工具是否失败（供恢复轮判定）
    let realToolFailedThisRound = false;
    let retriedToolCallIdError = false;
    let stream: Awaited<ReturnType<OpenAI["chat"]["completions"]["create"]>>;

    while (true) {
      // 第 3 轮起压缩早期 tool 结果，减少 token 消耗
      if (round >= 2) compactToolLoopHistory(messages, 2);
      const sanitizedMessages = sanitizeChatMessagesForApi(messages, {
        stripReasoning: thinkingDisabled,
        logPrefix: "[openai-tool-loop]",
      });
      const requestMessages = options?.requestSystemMessages
        ? applyPromptCacheMessages(sanitizedMessages, options.requestSystemMessages)
        : sanitizedMessages;
      // TEMP DEBUG（记忆注入诊断 6：工具分支实际发送的 system 是否含记忆）
      try {
        const sysJoined = requestMessages
          .filter((m) => m.role === "system" && typeof m.content === "string")
          .map((m) => String(m.content))
          .join("\n");
        const { appendFileSync } = await import("node:fs");
        appendFileSync(
          ".memory-inject-debug.log",
          JSON.stringify({
            t: new Date().toISOString(),
            phase: "finalRequestTools",
            round,
            sysMsgCount: requestMessages.filter((m) => m.role === "system").length,
            finalSysHasNarrative: sysJoined.includes("记忆图联想检索"),
            planSysHasNarrative: String(options?.requestSystemMessages?.[0]?.content ?? "").includes("记忆图联想检索"),
            sysHead: sysJoined.slice(0, 100),
          }) + "\n",
        );
      } catch {
        /* ignore */
      }
      try {
        const request = {
          model,
          messages: requestMessages,
          tools: apiTools,
          tool_choice: resolveForcedToolChoice(userText, apiTools, fastProfile),
          // 明确启用并行工具调用，让 LLM 在单轮内返回多个 tool_calls。
          // 配合工具描述里的并行引导，减少串行轮次。
          parallel_tool_calls: true,
          stream: true,
          ...(options?.promptCache ?? {}),
          // ⚠️ OpenAI Node SDK v6 不识别 Python 风格的 `extra_body` 顶层字段——它会
          // 整个 body JSON.stringify 后把 `extra_body` 当作普通 key 发出去，导致
          // `thinking` 被埋到一层下，Moonshot 看不到 → k2.5 默认 thinking 仍开启
          // → 撞上 tool_choice='specified' 直接 400。直接 spread 到顶层。
          ...(options?.extraBody ?? {}),
        };
        stream = await client.chat.completions.create(request as Parameters<typeof client.chat.completions.create>[0]);
        break;
      } catch (e) {
        if (!retriedToolCallIdError && isToolCallIdNotFoundError(e)) {
          retriedToolCallIdError = true;
          repairMessagesAfterToolCallIdError(messages, thinkingDisabled);
          console.warn("[openai-tool-loop] Retrying completion after tool_call_id repair");
          continue;
        }
        throw e;
      }
    }

    let fullText = "";
    let fullReasoning = "";
    let finishReason: string | null = null;
    const normalizedToolCalls: NormalToolCall[] = [];

    try {
      // 流式消费走统一的 provider-agnostic helper：自动累积 content + reasoning_content
      // + tool_calls。任何 provider 的 chunk 只需先经 `adaptOpenAiChatCompletionStream`
      // 适配成 NormalChatChunk 即可。后续若要接入 Anthropic/Google，只换 adapter 即可。
      const result = await consumeNormalizedStream(
        adaptOpenAiChatCompletionStream(
          stream as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>,
        ),
        {
          onContentDelta: (d) => {
            fullText += d;
            // 不在 tool loop 期间推送 delta：避免"思考前导话"流式输出给前端。
            // 最终内容在 round 结束后（finishReason !== "tool_calls"）统一推送到 onDelta。
          },
          onToolCallsComplete: (calls) => {
            for (const c of calls) normalizedToolCalls.push(c);
          },
          providerId: "openai-compatible",
          model,
        },
      );
      fullText = result.content;
      fullReasoning = result.reasoning;
      finishReason = result.finishReason;
    } catch (e) {
      // 流式空闲超时：如果有 partial content 且没有 tool_calls，用 partial content 兜底。
      // tool_calls 不完整时不能兜底（会导致 LLM 收到半截 JSON 参数）。
      if (e instanceof StreamIdleTimeoutError && e.partialContent.trim() && normalizedToolCalls.length === 0) {
        // eslint-disable-next-line no-console
        console.warn(
          `[stream-idle-timeout] tool-loop model=${model} ` +
            `→ 使用 ${e.partialContent.length} 字符的 partial content 兜底`,
        );
        finishReason = "stop"; // 强制标记为正常结束
        // fullText 已通过 onContentDelta 累积，不需要额外处理
      } else {
        throw e;
      }
    }

    // 仅累积正式回复内容；以 tool_calls 结束的轮次中 fullText 仅为思考前导话，
    // 不进入最终回复，也不推送给前端。
    if (finishReason !== "tool_calls" || normalizedToolCalls.length === 0) {
      lastAssistantText = (lastAssistantText ? lastAssistantText + "\n" : "") + fullText;
    }

    if (finishReason !== "tool_calls" || normalizedToolCalls.length === 0) {
      // 对话结束：返回最终回复文本。
      // 剥离 [ts:] 时间戳前缀（仅供 LLM 上下文，不应展示给用户）
      let finalText = lastAssistantText.trim();
      finalText = finalText.replace(/^\[ts:[^\]]*\]\s*/gm, "").trim();

      // （Coze 思路）已移除图片意图"自救"prompt 注入：
      //   - 不靠正则猜意图 / 不注入 prompt 逼模型重调 search_images。
      //   - 媒体是否展示完全由「模型是否真的调用了 search_images」这一服务端事实决定，
      //     search_images 常驻可见，服务端把工具结果确定性渲染成图廊（chat-user-message.ts）。
      //   - 普通问答时模型不该调图片工具就不调，从而彻底避免误返回照片。

      if (requiresFreshWebLookup && !satisfiedFreshWebLookup) {
        messages.push({
          role: "assistant",
          content: finalText || fullText || "(需要调用搜索工具获取最新信息)",
        });
        messages.push({
          role: "system",
          content:
            "This turn requires fresh web evidence. Do not send a final answer yet. Call search_web first, then use fetch_web or info.* if needed, and only answer after you have real search results.",
        });
        continue;
      }
      // 防 LLM "道歉式兜底"：
      //  - 已有成功工具数据但 LLM 输出是 apology/无法整合 → 直接用工具结果拼接，避免扔掉真实数据；
      //  - 无成功工具数据而 LLM 出 apology/空 → Fix3 反道歉重建一次，绝不让"没查到/没找到"直接透出。
      let effectiveFinalText: string;
      if (isApologyStyleFallback(finalText) && lastToolOutputFallback.trim()) {
        effectiveFinalText = lastToolOutputFallback.trim();
      } else if (isApologyStyleFallback(finalText)) {
        effectiveFinalText = await rebuildWithoutFallback(client, model, messages);
        if (!effectiveFinalText || isApologyStyleFallback(effectiveFinalText)) {
          effectiveFinalText = "";
        }
      } else {
        effectiveFinalText = finalText;
      }
      // 流式推送最终内容到 onDelta（→ onAssistantDelta → 前端 chat.assistant_chunk）
      // 根源净化：先把 LLM 混进正文的内部控制标签（[STOP...] / [话题切换...]）剥离，
      // 保证推给前端的气泡不出现这些内部信号（此前在 agent-core finishLlmTurn 后置剥离
      // 太晚——流式早已透出，无法撤回）。
      const sanitizedFinalText = stripInternalControlTags(effectiveFinalText);
      if (sanitizedFinalText) {
        onDelta(sanitizedFinalText);
      }
      messages.push({
        role: "assistant",
        content: sanitizedFinalText || null,
      });
      return sanitizedFinalText;
    }

    // 把 NormalToolCall[] 物化为 OpenAI SDK 形态（保留 id 兜底 + parsedArgs 预解析）
    const toolCalls: ChatCompletionMessageToolCall[] = materializeOpenAiToolCalls(
      normalizedToolCalls,
      model,
    );

    const assistantWithTools: ChatCompletionMessageParam = {
      role: "assistant",
      content: fullText || null,
      tool_calls: toolCalls,
    };
    // Kimi k2.5 开启 thinking 时，带 tool_calls 的 assistant 须含 reasoning_content；关闭 thinking 时不得携带该字段
    if (!thinkingDisabled) {
      (assistantWithTools as { reasoning_content?: string }).reasoning_content =
        fullReasoning.trim() || " ";
    }
    messages.push(assistantWithTools);

    const toolResults: ToolLoopAfterBatchInfo["toolResults"] = [];
    const roundToolOutputs: string[] = [];

    type ToolCallWorkItem = {
      tc: (typeof toolCalls)[number];
      registryToolName: string;
      parsedArgs: Record<string, unknown>;
    };
    const workItems: ToolCallWorkItem[] = [];
    for (const tc of toolCalls) {
      if (tc.type !== "function") continue;
      const fn = tc.function;
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(fn.arguments || "{}") as Record<string, unknown>;
      } catch {
        args = {};
      }
      let registryToolName = resolveRegistryToolName(fn.name);
      let notifyToolName = registryToolName;
      if (isToolSearchBridgeName(registryToolName) && registryToolName === "tool_call") {
        const bridge = await executeBridge(registryToolName, args, deferredToolCatalog);
        if (bridge.kind === "call" && bridge.ok) {
          notifyToolName = bridge.registryToolName;
        }
      }
      ctx.onToolExecuteStart?.({
        toolName: notifyToolName,
        input: args,
        assistantPreamble: fullText.trim() || undefined,
      });
      workItems.push({ tc, registryToolName, parsedArgs: args });
    }
    // TEMP DEBUG（重复工具调用诊断：本轮实际执行的所有工具）
    console.log(
      `[DBG-toolloop] round=${round} toolCalls=${workItems.map((w) => w.registryToolName + ":" + JSON.stringify(w.parsedArgs)).join(" | ")}`,
    );

    const settledResults = await Promise.allSettled(
      workItems.map(async (item) => {
        let targetToolName = item.registryToolName;
        let targetArgs = item.parsedArgs;

        if (isToolSearchBridgeName(item.registryToolName)) {
          const bridge = await executeBridge(
            item.registryToolName,
            item.parsedArgs,
            deferredToolCatalog,
          );
          if (bridge.kind === "search" || bridge.kind === "describe" || bridge.kind === "discover") {
            const compacted = await compactToolOutputForLlm({
              toolName: item.registryToolName,
              ok: bridge.ok,
              result: bridge.result,
              preferredMaxChars: getToolResultBudget(item.registryToolName),
              stripKeys: getToolResultStripKeys(item.registryToolName),
            });
            return {
              exec: { ok: bridge.ok, result: bridge.result },
              compacted,
              injectFrames: undefined,
              resultForWire: bridge.result,
              wireToolName: item.registryToolName,
            } as const;
          }
          if (bridge.kind === "call") {
            if (!bridge.ok) {
              const compacted = await compactToolOutputForLlm({
                toolName: item.registryToolName,
                ok: false,
                result: bridge.result,
                preferredMaxChars: getToolResultBudget(item.registryToolName),
                stripKeys: getToolResultStripKeys(item.registryToolName),
              });
              return {
                exec: { ok: false, result: bridge.result },
                compacted,
                injectFrames: undefined,
                resultForWire: bridge.result,
                wireToolName: item.registryToolName,
              } as const;
            }
            targetToolName = bridge.registryToolName;
            targetArgs = bridge.parsedArgs;
          }
        }

        const TOOL_TIMEOUT_MS = resolveToolExecutionTimeoutMs(targetToolName);

        let exec: Awaited<ReturnType<ChatToolExecutionContext['executeTool']>>;

        // 工具结果缓存：查询类工具在 TTL 内相同参数直接返回缓存，跳过安全检查/BodyGateway 等中间层
        const cachedResult = ctx.getCachedToolResult?.(targetToolName, targetArgs);
        if (cachedResult) {
          exec = cachedResult;
        } else {
          try {
            // 重型工具经并发限制器（code.run / image.generate / voice.* 等），
            // 限流等待不占超时预算：只有 acquire 成功后才开始 Promise.race 计时
            exec = await executeWithToolLimit(targetToolName, () =>
              Promise.race([
                ctx.executeTool(targetToolName, targetArgs),
                new Promise<never>((_, reject) =>
                  setTimeout(() => reject(new Error(`工具 "${targetToolName}" 执行超时 (${TOOL_TIMEOUT_MS}ms)`)), TOOL_TIMEOUT_MS)
                )
              ])
            );
          } catch (timeoutError) {
            console.error(`[工具超时] ${targetToolName}:`, timeoutError instanceof Error ? timeoutError.message : timeoutError);
            exec = {
              ok: false,
              result: {
                error: `工具执行超时，请稍后重试。(${TOOL_TIMEOUT_MS}ms)`,
                timeout: true,
                toolName: targetToolName
              }
            };
          }
        }
        
        let injectFrames: VisionFrame[] | undefined;
        let resultForWire: Record<string, unknown>;
        if (
          exec.ok &&
          exec.result &&
          Array.isArray((exec.result as Record<string, unknown>)[TOOL_RESULT_VISION_INJECT_KEY])
        ) {
          injectFrames = (exec.result as Record<string, unknown>)[TOOL_RESULT_VISION_INJECT_KEY] as VisionFrame[];
          resultForWire = { ...(exec.result as Record<string, unknown>) };
          delete resultForWire[TOOL_RESULT_VISION_INJECT_KEY];
        } else {
          resultForWire = exec.result;
        }
        // 自动检测工具结果中的图片(imageBase64)。
        // 视觉模型 → 转成多模态 image_url 注入;非视觉模型 → 调用 PaddleOCR 识别文本+坐标。
        if (
          exec.ok &&
          resultForWire &&
          typeof (resultForWire as Record<string, unknown>).imageBase64 === "string"
        ) {
          const rw = resultForWire as Record<string, unknown>;
          const b64 = rw.imageBase64 as string;
          const mime = typeof rw.mimeType === "string" ? rw.mimeType : "image/png";
          if (modelSupportsVision(model)) {
            // 视觉模型:注入 image_url 让 LLM 直接看图
            const frame: VisionFrame = {
              sourceKind: "agent_attachment",
              sourceId: targetToolName,
              mimeType: mime,
              dataBase64: b64,
            };
            injectFrames = injectFrames ? [...injectFrames, frame] : [frame];
          } else {
            // 非视觉模型:调用 PaddleOCR 识别文本+坐标,作为视觉替代
            const ocrText = await ocrScreenshot(b64, mime);
            if (ocrText) {
              (rw as Record<string, unknown>).ocrText = ocrText;
            }
          }
          // 移除 base64 数据,避免压缩后以文本形式重复注入
          resultForWire = { ...rw };
          delete resultForWire.imageBase64;
        }
        const compacted = await compactToolOutputForLlm({
          toolName: targetToolName,
          ok: exec.ok,
          result: exec.ok ? resultForWire : { error: exec.result.error ?? exec.result },
          preferredMaxChars: getToolResultBudget(targetToolName),
          stripKeys: getToolResultStripKeys(targetToolName),
        });
        return {
          exec,
          compacted,
          injectFrames,
          resultForWire,
          wireToolName: targetToolName,
        } as const;
      }),
    );

    for (let i = 0; i < workItems.length; i++) {
      const item = workItems[i];
      const settled = settledResults[i];
      const exec = settled.status === "fulfilled" ? settled.value.exec : { ok: false, result: { error: settled.reason instanceof Error ? settled.reason.message : String(settled.reason) } };
      const compacted = settled.status === "fulfilled" ? settled.value.compacted : { content: JSON.stringify(exec.result), rawBytes: 0, compactBytes: 0, compacted: false };
      const injectFrames = settled.status === "fulfilled" ? settled.value.injectFrames : undefined;
      const wireToolName =
        settled.status === "fulfilled" ? settled.value.wireToolName : item.registryToolName;

      toolResults.push({ name: wireToolName, ok: exec.ok });
      if (exec.ok && FRESH_FACT_TOOL_NAMES.has(wireToolName)) {
        satisfiedFreshWebLookup = true;
      }
      // Fix1: 非元工具的真实取数失败 → 标记本轮存在工具失败（供恢复轮判定）
      if (!exec.ok && !META_TOOL_NAMES.has(wireToolName)) {
        realToolFailedThisRound = true;
      }
      ctx.onToolExecuted?.({
        toolName: wireToolName,
        input: item.parsedArgs,
        ok: exec.ok,
        result: settled.status === "fulfilled" ? settled.value.resultForWire : exec.result,
      });
      // 累积工具结果供 summary 调用做策略评估
      allToolExecResults.push({
        toolName: wireToolName,
        ok: exec.ok,
        result: settled.status === "fulfilled" ? settled.value.resultForWire : exec.result,
      });
      const toolContent = compacted.content;
      // 非视觉模型截图后追加 OCR 识别结果(文本+坐标),让 LLM 能"看到"屏幕内容
      const ocrText = settled.status === "fulfilled"
        ? (settled.value.resultForWire as Record<string, unknown>)?.ocrText
        : undefined;
      const fullToolContent = typeof ocrText === "string" && ocrText.trim()
        ? `${toolContent}\n\n${ocrText}`
        : toolContent;
      // 元工具（tool_discover / agent.query_capabilities 等）输出是结构化 JSON，
      // 不进 roundToolOutputs，防止「道歉式兜底」把它们原样拼成回复透出到前端。
      // Fix2(加固 fast 轻工具链路)：失败的工具输出（含"工具执行超时/error"）也不进
      // roundToolOutputs —— 否则它们会被 lastToolOutputFallback/拼接兜底当成答案透出给用户，
      // 表现为 agent 直接回答"工具超时/没查到"。失败信息仍会作为 tool 消息回给 LLM 供其判断。
      if (toolContent?.trim() && exec.ok && !META_TOOL_NAMES.has(wireToolName)) {
        roundToolOutputs.push(toolContent.trim());
      }
      // 对成功的工具结果追加信息充分性提示，减少 LLM 不必要的二次调用。
      // 关键洞察：LLM 重复调用工具的根因是不确定结果是否足够回答。
      // 明确告诉 LLM「结果已完整」，让它直接回答而非重复调用。
      const sufficiencyHint = exec.ok
        ? buildToolSufficiencyHint(wireToolName, fullToolContent)
        : "";
      // 对失败的工具结果追加强约束 reminder，防止 LLM 忽略 error 字段后对用户撒谎。
      // 关键场景：desktop.open 派发进程但窗口未起来 → ok=false → LLM 必须如实承认失败。
      const failureReminder = !exec.ok
        ? buildToolFailureReminder(wireToolName, fullToolContent)
        : "";
      const appendedHints = [sufficiencyHint, failureReminder]
        .filter(Boolean)
        .join("\n");
      messages.push({
        role: "tool",
        tool_call_id: item.tc.id,
        content: appendedHints ? `${fullToolContent}\n${appendedHints}` : fullToolContent,
      });
      if (injectFrames?.length) {
        const frameHint =
          wireToolName === "desktop.visual.screenshot" || wireToolName === "vision.http_pull"
            ? wireToolName === "desktop.visual.screenshot"
              ? "（以下为 desktop.visual.screenshot 截取的当前屏幕画面；请仔细观察画面内容,判断当前屏幕状态和可操作元素,然后决定下一步动作。）"
              : "（以下为 vision.http_pull 抓取的远程图像帧；请客观描述画面并继续完成任务。）"
            : `（以下为 ${wireToolName} 返回的图像；请根据画面内容继续完成任务。）`;
        messages.push({
          role: "user",
          content: openAiUserContentFromTurn({
            text: frameHint,
            visionFrames: injectFrames,
          }),
        });
      }
    }
    // Fix1(加固 fast 轻工具链路)：本轮存在真实工具失败且轮次预算已耗尽 → 授予 1 次恢复轮，
    // 并注入失败提示，让 LLM 换参数/换兜底工具重试或如实说明。
    // 若无此步，fast(maxRounds=1) 下唯一一次工具失败会直接结束循环 → 空回复/"没查到"。
    // 恢复轮只在最后一次时授予、且全程最多一次（recoveryGranted 持久），避免级联加轮。
    if (!recoveryGranted && realToolFailedThisRound && maxRounds <= round + 1) {
      recoveryGranted = true;
      const prevMax = maxRounds;
      maxRounds = round + 2;
      messages.push({
        role: "system",
        content:
          "上一轮调用的工具失败了。请不要向用户道歉，也不要声称「没查到/没找到/做不到/稍后重试」。" +
          "请尝试：①换更稳妥的查询词或参数重试一次；②或基于已有信息/你的知识直接给出你能确定的部分，" +
          "并明确告诉用户还缺哪条线索。绝对不要输出空回复或道歉式兜底。",
      });
      console.warn(
        `[tool-loop] round=${round} 存在真实工具失败，授予 1 次恢复轮 (maxRounds ${prevMax}→${maxRounds})`,
      );
    }
    options?.onAfterToolBatch?.({
      roundIndex: round,
      assistantText: fullText,
      toolResults,
    });
    lastToolOutputFallback = buildFallbackAnswerFromToolOutputs(roundToolOutputs);
  }

  // ⚠️ 工具循环结束兜底：maxRounds 用完或 LLM 一直没出 finalText 时，
  // 如果已有工具结果（lastToolOutputFallback 非空），发一次轻量 LLM 调用让 LLM
  // 用自然语言组织工具结果，避免直接把工具 JSON 摘要 dump 给用户。
  // 同时处理：lastAssistantText 是 apology 风格时，也用 summary 调用重建。
  const needSummaryCall =
    (!lastAssistantText.trim() || isApologyStyleFallback(lastAssistantText)) &&
    lastToolOutputFallback.trim().length > 0;

  if (needSummaryCall) {
    try {
      // 过滤无效 assistant message：OpenAI API 要求 assistant 消息必须有 content 或 tool_calls
      const sanitizedMessages = messages.filter((m) => {
        if (m.role !== "assistant") return true;
        const hasContent = typeof m.content === "string" && m.content.trim().length > 0;
        const hasToolCalls = Array.isArray((m as any).tool_calls) && (m as any).tool_calls.length > 0;
        return hasContent || hasToolCalls;
      });

      // 数据驱动策略评估：根据工具收集到的真实数据质量选择回复策略
      const strategyDirective = evaluateAndSelectStrategy(allToolExecResults, userText);
      const strategyBlock = strategyDirective.instruction
        ? `\n\n【回复策略】${strategyDirective.instruction}`
        : "";
      console.log(
        `[synthesis] 策略=${strategyDirective.strategy} 等级=${strategyDirective.quality.level} ` +
          `来源=${strategyDirective.quality.sourceCount} 成功=${strategyDirective.quality.successCount} ` +
          `内容=${strategyDirective.quality.totalContentLength}字符 理由=${strategyDirective.quality.reason}`,
      );

      const summaryMessages: ChatCompletionMessageParam[] = [
        ...sanitizedMessages,
        {
          role: "user",
          content:
            `刚才调用工具拿到了以下结果，请基于这些结果用自然的口语回答用户的问题。` +
            `不要重复工具调用过程，直接给出结论。如果结果不完整，就给出能确定的部分。` +
            `同一事实不要换个说法再总结第二遍；单一事实查询默认“结论 + 1句依据”，最多保留一个简短追问。` +
            strategyBlock +
            `\n\n工具结果：\n${lastToolOutputFallback.slice(0, 4000)}`,
        },
      ];
      const summaryResp = await client.chat.completions.create({
        model,
        messages: summaryMessages,
        temperature: 0.5,
        max_tokens: 800,
        stream: true,
      });
      // 流式消费 summary 调用：每个 delta 通过 onDelta 实时推送给前端
      let summaryText = "";
      await consumeNormalizedStream(
        adaptOpenAiChatCompletionStream(
          summaryResp as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>,
        ),
        {
          onContentDelta: (d) => {
            summaryText += d;
            onDelta(d);
          },
          providerId: "openai-compatible",
          model,
        },
      );
      summaryText = summaryText.trim();
      if (summaryText && !isApologyStyleFallback(summaryText)) {
        return summaryText;
      }
      // summary 调用也失败了 → 用工具结果拼接兜底（比空串好）
      return lastToolOutputFallback.trim();
    } catch (summaryErr) {
      console.log(
        `[tool-loop] summary 调用失败，回退到工具结果拼接: ${
          summaryErr instanceof Error ? summaryErr.message : String(summaryErr)
        }`,
      );
      return lastToolOutputFallback.trim();
    }
  }

  const raw = isApologyStyleFallback(lastAssistantText) && lastToolOutputFallback.trim()
    ? lastToolOutputFallback.trim()
    : lastAssistantText.trim() || lastToolOutputFallback.trim();
  // Fix3(加固 fast 轻工具链路)：循环耗尽后仍拿到"没查到/道歉式/空"回复 →
  // 反道歉重建一次；重建仍失败落建设性引导，绝不把道歉兜底透出给用户。
  if (!raw.trim() || isApologyStyleFallback(raw)) {
    const rebuilt = await rebuildWithoutFallback(client, model, messages);
    return rebuilt && !isApologyStyleFallback(rebuilt) ? rebuilt : "";
  }
  return raw;
}
