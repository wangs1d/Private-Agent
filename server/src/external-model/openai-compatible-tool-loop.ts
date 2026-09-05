import type OpenAI from "openai";
import { recordLlmUsageByChars } from "../services/llm-token-audit.js";
import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from "openai/resources/chat/completions";

import { AGENT_WORLD_CHAT_TOOLS, filterSocialChatTools } from "@private-ai-agent/agent-world";
import { isAgentWorldSocialEnabled } from "../config/env.js";
import { AIP_CHAT_TOOLS } from "../aip/aip-chat-completion-tools.js";
import { getDesktopVisualChatTools } from "../tools/desktop-visual-chat-tools.js";
import { getPhoneBridgeChatTools } from "../tools/phone-bridge-chat-tools.js";
import { BROWSER_SESSION_LIST_CHAT_TOOL } from "../tools/browser-session-chat-tools.js";
import { INTERNET_INTELLIGENCE_CHAT_TOOLS } from "../tools/internet-intelligence-chat-tools.js";
import { INTEREST_WATCH_CHAT_TOOLS } from "../tools/interest-watch-tools.js";
import { AGENT_TASKS_CHAT_TOOLS } from "../tools/agent-tasks-tools.js";
import { RHYTHM_REMINDER_CHAT_TOOLS } from "../tools/rhythm-reminder-tools.js";
import {
  PROACTIVITY_CONFIRM_CHAT_TOOLS,
  PROACTIVITY_FEEDBACK_CHAT_TOOLS,
} from "../tools/proactivity-feedback-tools.js";
import { CARE_REMINDER_CHAT_TOOLS } from "../tools/care-reminder-tools.js";
import { COMMITMENT_CHAT_TOOLS } from "../tools/commitment-tools.js";
import { GEOFENCE_CHAT_TOOLS } from "../tools/geofence-tools.js";
import { EMBODIMENT_CHAT_TOOLS } from "../tools/embodiment-tools.js";
import { SMART_HOME_CHAT_TOOLS } from "../tools/smart-home-tools.js";
import { DEVICE_CHAT_TOOLS } from "../tools/device-tools.js";
import { SELF_PROGRAMMING_CHAT_TOOLS } from "../tools/self-programming-chat-tools.js";
import { openAiUserContentFromTurn } from "./build-user-message-content.js";
import { stripAllTimestampFrameLines } from "../utils/timestamp-frame.js";
import { modelSupportsVision, ocrScreenshot } from "./vision-support.js";
import { getAgentRuntimeConfig } from "../agent/agent-runtime-config.js";
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
import { resolveForcedToolChoice } from "../gateway/forced-tool.js";
import { buildRecoveryHint } from "../agent/loop/tool-metadata.js";
import {
  isToolCallIdNotFoundError,
  isToolChoiceRejectedError,
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
  createStreamMetaSentenceFilter,
  type NormalChatChunk,
  type NormalToolCall,
  type NormalUsage,
} from "./stream-chat-helpers.js";
import type {
  ChatToolExecutionContext,
  StreamDeltaHandler,
  ToolLoopAfterBatchInfo,
  VisionFrame,
} from "./types.js";
import { executeWithToolLimit } from "../services/concurrency-limiter.js";
import { evaluateAndSelectStrategy } from "../agent/synthesis-strategy.js";
import { isDirectFactQuery } from "../agent/direct-fact-query.js";

const TOOL_RESULT_VISION_INJECT_KEY = "_injectVisionUserMessage";

// 工具结果字符预算：在信息完整性和 token 节省之间取平衡。
// search_web 7000：2026-09-03 需求「检索/任务型回复要信息全面」，snippet 上限同步放宽到
// 400 字符，预算随之上调（原 5000），保证多来源标题+摘要不因截断丢细节。
// fetch_web 4500 / deep_search 6000：深读正文要支撑细节复述，截太狠等于白抓。
const TOOL_RESULT_PRESET_MAX_CHARS: Record<string, number> = {
  "search_web": 7000,
  "search_images": 1200,
  "search_videos": 1200,
  "fetch_web": 4500,
  // deep_search 返回正文，限制注入量避免整页内容灌给 LLM
  "deep_search": 6000,
  // hot_rankings 榜单项字段少，给足即可
  "hot_rankings": 1400,
  "info.search": 5000,
  "info.inspect_webpage": 1000,
  "info.navigate_site": 1200,
  "browser.session.list": 600,
  "browser.fetch_page": 1000,
  "calendar.list_tasks": 800,
  "aip.list_my_state": 800,
  "self.list_custom_skills": 800,
  "agent.query_capabilities": 900,
  "search": 5000,
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

/**
 * 判定工具输出是否是「空洞 JSON」：对象内所有字符串值（含嵌套）均为空。
 * 典型形态 `{"title":"Untitled","content":"","summary":""}`（空页抓取的空壳结果）。
 * 这类输出不携带任何信息，不应作为兜底答案透出给用户。
 */
function isMeaninglessToolOutput(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  try {
    const parsed = JSON.parse(t) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const seen: string[] = [];
    const walk = (v: unknown): void => {
      if (typeof v === "string") seen.push(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    walk(parsed);
    return !seen.some((s) => s.trim().length > 0);
  } catch {
    return false;
  }
}

function buildFallbackAnswerFromToolOutputs(outputs: string[]): string {
  const lines = outputs
    .map((item) => item.replace(/^\[ts:[^\]]*\]\s*/gm, "").trim())
    .filter((item) => item && !isMeaninglessToolOutput(item));
  if (lines.length === 0) return "";
  const unique: string[] = [];
  for (const line of lines) {
    if (!unique.includes(line)) unique.push(line);
  }
  return unique.join("\n\n").trim();
}

/**
 * 检测 LLM 最终回复是否是「道歉式兜底」（无法整合工具结果/道歉重试）。
 * 当工具结果已有真实数据时，这种 apology 不应替代搜索结果 — 应回退到工具结果拼接。
 *
 * 触发条件（任一即视为兜底）：
 *  - 含"抱歉/请稍后重试/无法生成回复/不太清楚/我不太确定"等认错短语
 *  - 长度很短（< 60 字符）且不含任何事实/数字/链接（说明 LLM 没尝试整合）
 */
/**
 * 行动宣告正则：识别「我这就去查…」/「稍后告诉你」/「别急」这类面向未来动作的
 * 承诺性表述（真人感·行动宣告提示词的产物），但此时 LLM 未必真正调用工具。
 *
 * 覆盖模式：
 *  - 主体身份 + 动作动词：我这就去/我来/我去/让我 + 查/看/找/搜/瞅/问/读/取/确认
 *  - 未来承诺收尾：稍后/回头/待会/等一下 + 告诉/发/回/结果
 *  - 安抚等待：别急/别着急/稍等/马上 + 告诉/结果/回复/联系/就去
 *  - 完成通知：查到/找到/弄到/搞定 + 告诉你/发给你/再说
 *  - 假装在办（2026-08-29 补漏，真实案例「规划呢→我在帮你琢磨呢…等我理好了一股脑给你」
 *    从旧正则漏网，垫话被当正式回复放行）：
 *    「我在/正在帮你 + 琢磨/想/研究/盘算/整理/捋/规划/排/弄/办/处理/准备」
 *    「等…理好/想好/弄好/排好/安排好…给你/告诉你」
 */
const ACTION_ANNOUNCE_RE =
  /(?:我这就|我来|我去|让我|我先).{0,14}(?:查|看|找|搜|瞅|问|读|取|打听|确认|翻一下|点点|设个|安排|处理|说一声)|(?:稍后|回头|待会|等一下).{0,8}(?:告诉|发|回|结果|更(?:新|我))|(?:别急|别着急|稍等(?:一下)?).{0,6}(?:告诉|结果|回复|联系|就好|就去)|(?:查到|找到|弄到|搞定|问到|看到)?(?:就|便|再).{0,4}(?:告诉|发你|发给你|再说|通知|更新你)|(?:我在|正在|这就)帮你?(?:琢磨|想|研究|盘算|整理|捋|规划|排|弄|办|处理|准备)|等.{0,8}(?:理好|想好|弄好|搞好|准备好|琢磨好|研究好|排好|整理好|安排好|规划好).{0,10}(?:给你|发你|告诉你|发给你|再说|通知你)|帮你琢磨/i;

/** 是否「只有行动宣告、未兑现任何真实结果」：命中宣告模式 且 不含数据锚点。 */
function isActionAnnouncementOnly(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (!ACTION_ANNOUNCE_RE.test(t)) return false;
  // 含具体结果锚点（数字/链接/引述的具体内容/冒号引导数据）→ 视为已兑现，不拦截。
  // 注意：不把「是/为」等高频口语字当锚点，避免把「其实我这就去…」这类纯宣告漏拦。
  const hasConcrete =
    /\d/.test(t) ||
    /https?:\/\//.test(t) ||
    /[「"“]/.test(t) ||
    /[：:]\s*\S/.test(t);
  return !hasConcrete;
}

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
    // 通用"无能为力"句式（2026-09-05 出口自检话题无关化：只描述"答不了"的
    // 语言形态，不描述任何话题——话题需求由路由层语义分类承担）
    /(?:暂时|目前|现在)(?:没|无法|答不了|查不了|给不了)/,
    /没有现成(?:数据|资料|信息|结果)/,
    /(?:答不了|查不到|拿不到|给不了|掌握不到|无能为力)/,
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

function resolveToolExecutionTimeoutMs(registryToolName: string): number {
  const fallback = Number.parseInt(process.env.TOOL_EXECUTION_TIMEOUT_MS ?? "30000", 10);
  const defaultMs = Number.isFinite(fallback) && fallback > 0 ? fallback : 30_000;
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
    "search_web": Number.parseInt(process.env.TOOL_TIMEOUT_SEARCH_MS ?? "6500", 10),
    "search_images": Number.parseInt(process.env.TOOL_TIMEOUT_SEARCH_MS ?? "6500", 10),
    "search_videos": Number.parseInt(process.env.TOOL_TIMEOUT_SEARCH_MS ?? "6500", 10),
    "video.grab": Number.parseInt(process.env.TOOL_TIMEOUT_VIDEO_GRAB_MS ?? "25000", 10),
    "fetch_web": Number.parseInt(process.env.TOOL_TIMEOUT_FETCH_MS ?? "15000", 10),
    "info.inspect_webpage": Number.parseInt(process.env.TOOL_TIMEOUT_FETCH_MS ?? "15000", 10),
    "info.navigate_site": Number.parseInt(process.env.TOOL_TIMEOUT_NAVIGATE_MS ?? "20000", 10),
    "info.search": Number.parseInt(process.env.TOOL_TIMEOUT_SEARCH_MS ?? "6500", 10),
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
 * 桥接调用（tool_discover / tool_search / tool_describe / tool_call 解析）超时上限。
 * 桥接只做检索与参数解析（真实工具执行另有 TOOL_TIMEOUT 竞速），但底层走
 * tool-router（HTTP 30s / stdio worker 60s 命令超时）+ 冷备 TS 检索，历史上
 * 无任何超时包装——worker 假死时整个工具循环永不返回，会话队列锁死。
 * 默认 70s = worker 命令超时 60s + 余量，env TOOL_BRIDGE_TIMEOUT_MS 可调。
 */
function resolveToolBridgeTimeoutMs(): number {
  const n = Number.parseInt(process.env.TOOL_BRIDGE_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 70_000;
}

function executeBridgeWithTimeout(
  bridgeName: string,
  args: Record<string, unknown>,
  catalog: Parameters<typeof executeBridge>[2],
): Promise<Awaited<ReturnType<typeof executeBridge>>> {
  const timeoutMs = resolveToolBridgeTimeoutMs();
  return new Promise<Awaited<ReturnType<typeof executeBridge>>>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`tool bridge timeout: ${bridgeName} exceeded ${timeoutMs}ms`));
    }, timeoutMs);
    executeBridge(bridgeName, args, catalog).then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
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

/**
 * 压缩 schema 文本中的冗余空白（换行/缩进→单空格）。无损：description 是给 LLM 看的
 * 自然语言，压缩空白不改变语义，但 JSON 序列化后每轮重复发送的字符数显著下降。
 */
function compactSchemaText(text: string | undefined): string | undefined {
  if (!text) return text;
  return text.replace(/\s+/g, " ").trim();
}

/**
 * 递归压缩 JSON Schema 中所有层级的 description 字符串（只动 description 键，
 * 绝不触碰 name/type/enum/const 等语义值），用于工具 schema 发送前的无损瘦身。
 */
function compactSchemaDescriptions(node: unknown): unknown {
  if (Array.isArray(node)) return node.map((v) => compactSchemaDescriptions(v));
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      out[k] =
        k === "description" && typeof v === "string"
          ? compactSchemaText(v)
          : compactSchemaDescriptions(v);
    }
    return out;
  }
  return node;
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
        description: compactSchemaText(tool.function.description),
        parameters: tool.function.parameters
          ? (compactSchemaDescriptions(tool.function.parameters) as typeof tool.function.parameters)
          : tool.function.parameters,
      },
    };
  });
  return {
    apiTools,
    resolveRegistryToolName: (apiName) => apiToRegistry.get(apiName) ?? apiName,
  };
}

/**
 * P2：会话级工具 schema 稳定（排序 + 快照）。
 *
 * 背景：多分类工具检索每轮召回顺序可能不同，同一会话内请求体 `tools` 数组顺序
 * 一抖动，DeepSeek / Kimi 等基于「请求前缀」的上下文缓存命中率就下降（tools 参与
 * 服务端请求哈希/前缀比对）。
 *
 * 方案：
 * - 首轮按工具名确定性排序（字母序）建立会话基准快照；
 * - 后续轮已知工具严格按基准序重排，仅本轮动态新召回的匹配工具追加到末尾，
 *   同时吸收进基准（保留多分类检索的动态召回能力，不让快照变成死工具集）。
 *
 * 模块级 LRU 防膨胀：只保留最近 128 个会话的顺序基准。
 */
const SESSION_TOOL_ORDER = new Map<string, Map<string, number>>();
const SESSION_TOOL_ORDER_MAX = 128;

function apiToolNameOf(tool: ChatCompletionTool): string {
  return tool.type === "function" ? (tool.function?.name ?? "") : "";
}

function stabilizeToolOrderForSession(
  apiTools: ChatCompletionTool[],
  sessionId: string | undefined,
): ChatCompletionTool[] {
  const sorted = [...apiTools].sort((a, b) =>
    apiToolNameOf(a).localeCompare(apiToolNameOf(b)),
  );
  if (!sessionId) return sorted;

  if (SESSION_TOOL_ORDER.size >= SESSION_TOOL_ORDER_MAX) {
    const oldest = SESSION_TOOL_ORDER.keys().next().value as string | undefined;
    if (oldest !== undefined) SESSION_TOOL_ORDER.delete(oldest);
  }

  let order = SESSION_TOOL_ORDER.get(sessionId);
  if (!order) {
    order = new Map(sorted.map((t, i) => [apiToolNameOf(t), i]));
    SESSION_TOOL_ORDER.set(sessionId, order);
    return sorted;
  }
  const known: ChatCompletionTool[] = [];
  const fresh: ChatCompletionTool[] = [];
  for (const t of sorted) {
    const n = apiToolNameOf(t);
    (order.has(n) ? known : fresh).push(t);
  }
  known.sort(
    (a, b) => (order!.get(apiToolNameOf(a)) ?? 0) - (order!.get(apiToolNameOf(b)) ?? 0),
  );
  const stabilized = [...known, ...fresh];
  if (fresh.length > 0) {
    const next = new Map(order);
    let idx = next.size;
    for (const t of fresh) next.set(apiToolNameOf(t), idx++);
    SESSION_TOOL_ORDER.set(sessionId, next);
  }
  return stabilized;
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
        "联网搜索公开网页信息（按发布时间从新到旧）。query 由你按用户意图组织成完整、具体、语义清晰的搜索词（可含主体+特征+限定词），不要机械截成 2-6 字短词；时效话题请加当前年月或「最新」。\n如果有多个独立的查询维度（例如对比多个商品 / 多个主题），请在同一轮内并行发起多个 search_web 调用，每个 tool_call 用不同的 query，避免串行等待。\n【强制调用规则】涉及时事、新闻、股价、排片、票价、天气、价格、公告等时效信息时必须先调用本工具，禁止仅凭训练数据作答；本地消费（电影票、外卖等）同样须先搜索再试。整合结果时优先引用发布时间最新的条目并注明日期。动态/新闻/盘点/对比类问题要把多来源信息按主题整理充分（保留日期、数字、人名、作品名等细节），用 Markdown 小标题/加粗/表格组织成结构清晰的充分回答；只有真正的单一事实判断（是/否、单个数据点）才用「结论 + 1句依据」收尾。若摘要不足以覆盖用户要的细节（事件经过、正文内容），继续用 fetch_web / deep_search 深读相关链接后再回答。",
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
          query: { type: "string", description: "图片搜索词，按要找的图片内容具体描述（主体+外观特征+场景），完整具体，不要过度截短" },
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
          query: { type: "string", description: "视频搜索词，完整具体，按要找的视频内容描述" },
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
          query: { type: "string", description: "搜索词，完整具体，按要查的主题语义组织" },
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
      // 2026-09-05 与 calendar.create_from_text/create_task 的重复行为规则互相去重：
      // 每个 tool 只保留自身必需的最小说明（delegate 全量注入时 schema 按轮计费）。
      description:
        "【生活助手】按用户原句创建定时提醒并写入服务端日程。带明确时间点的单次提醒（「明天 9:00 提醒我开会」「晚上10点叫我吃药」）必须直接调用本工具，不要追问、不要只口头答应。仅当返回 needsRecurrenceConfirm=true 时，按 suggestedQuestion 向用户追问一次后再次调用。成功返回 taskId、nextRunAt（UTC）、nextRunAtLocal（展示给用户必须用此字段）、recurrence。\n提醒方式默认弹窗（popup）；仅用户明确要求（「打电话提醒我」「语音喊我」）才用 TTS/电话，不要主动升级。",
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
          shortTitle: { type: "string", description: "简洁展示标题（「今日安排」紧凑列表用）：去掉指令词与时间词只留核心事项，如「明天9点提醒我吃药」→\"吃药\"。缺省时服务端自动生成。" },
          category: { type: "string", enum: ["itinerary", "trivia"], description: "trivia=喝水/睡觉/锻炼等生活琐事(照常提醒,不进「今日安排」)；行程正事填 itinerary；缺省 itinerary。" },
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
        "【内置 Calendar】按用户原句一句话创建日程/提醒。带明确时间点的单次日程/提醒必须直接调用，不要追问；仅当返回 needsRecurrenceConfirm=true 才按 suggestedQuestion 追问一次后重调。解析失败返回 matched=false；展示时间用返回的 nextRunAtLocal。",
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
        "【内置 Calendar】按结构化字段创建定时任务：reminder（提醒）/action（HTTP 动作）/weather_brief（天气简报，需用户已在天气页保存定位）/agent_task（到点让 Agent 执行 prompt）。runAt 须为 ISO-8601 未来时间；时间/类型已明确时优先用本工具，含糊时用 calendar.create_from_text。返回 taskId、nextRunAt（UTC）、nextRunAtLocal（展示用）。",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "完整任务标题（用于日程页完整列表；reminder 类型可选，由 reminderMessage 兜底）" },
          shortTitle: { type: "string", description: "简洁展示标题（「今日安排」紧凑列表用）：去掉指令词与时间词只留核心事项，如「明天9点提醒我吃药」→\"吃药\"。reminder 类型必填；其他类型缺省用 title 兜底。" },
          description: { type: "string" },
          kind: {
            type: "string",
            enum: ["reminder", "action", "weather_brief", "agent_task"],
            description: "weather_brief 需用户已在天气页保存定位；agent_task 会在到点后让 Agent 执行 prompt",
          },
          category: {
            type: "string",
            enum: ["itinerary", "trivia"],
            description: "trivia=喝水/睡觉/锻炼等生活琐事(照常提醒,不进「今日安排」)；行程正事填 itinerary；缺省 itinerary。",
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

/**
 * Surface-on-Demand：召唤客户端信息面板（语音模式"念+显"双通道的"显"）。
 * handler 在 ToolRegistry（surface-tools.ts）；核心库 dialogue 分组收录，
 * 每轮注入。典型场景：语音模式下用户问"今天有什么安排"→ 调用本工具把
 * 「今日安排」悬浮窗召唤到桌面，同时文本给出简短口头摘要（会被 TTS 朗读）。
 */
const SURFACE_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "surface.show",
      description:
        "【召唤桌面悬浮卡】要求客户端在桌面上展示一个信息面板（悬浮卡），配合文本回答形成" +
        "\"念+显\"双通道：文本回答给口头摘要（语音模式下会被朗读），悬浮卡给可视化细节。" +
        "典型场景：用户问「今天有什么安排」「看看日程」「今天要做什么」→ 调用本工具展示" +
        "today_schedule，同时用一两句话口头概括今日要点。不要为纯闲聊调用本工具。",
      parameters: {
        type: "object",
        properties: {
          surface: {
            type: "string",
            enum: ["today_schedule"],
            description: "要召唤的面板：today_schedule=今日安排悬浮卡",
          },
          ttlSeconds: {
            type: "number",
            description: "可选：悬浮卡展示时长（秒，5~300，默认 30，到期自动淡出）",
          },
        },
        required: ["surface"],
        additionalProperties: false,
      },
    },
  },
];

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
  // 2026-09-05 双面架构：escalate 逃生舱已删除（对话面零工具、任务面全量工具，
  // 轨道内出口自检承担纠错，不再需要模型侧升级哨兵）。
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

/** 动态注入的记忆工具 schema（由 bootstrap 阶段设置；记忆网关未启用时为空数组） */
let _memoryChatTools: ChatCompletionTool[] = [];

/** 注入记忆工具 schema 列表（启动时调用一次；与 setBrainChatTools 对称） */
export function setMemoryChatTools(tools: ChatCompletionTool[]): void {
  _memoryChatTools = tools;
  _builtinToolsCache = null;
  _fastLaneToolsCache = null;
}

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

/**
 * Agent World 对话工具注入：AGENT_WORLD_SOCIAL_ENABLED（默认关闭）时仅注入
 * identity/注册/房间最小集（filterSocialChatTools 过滤 free_market/social/music
 * 社交经济域工具），开启时注入全量 AGENT_WORLD_CHAT_TOOLS，行为与现状一致。
 * 延迟求值：首次构建 builtin 工具集时读取 env（确保 .env 已加载完成）。
 */
function getAgentWorldChatToolsForLlm(): ChatCompletionTool[] {
  return isAgentWorldSocialEnabled()
    ? AGENT_WORLD_CHAT_TOOLS
    : filterSocialChatTools(AGENT_WORLD_CHAT_TOOLS);
}

export function getBuiltinAgentChatTools(): ChatCompletionTool[] {
  if (_builtinToolsCache) return _builtinToolsCache;
  const capabilityModuleTools = _capabilityModuleDeps
    ? getCapabilityModuleChatTools(_capabilityModuleDeps)
    : [];
  _builtinToolsCache = [
    ...getAgentWorldChatToolsForLlm(),
    ...AIP_CHAT_TOOLS,
    ...INFO_WEB_CHAT_TOOLS,
    ...LIFE_ASSISTANT_CHAT_TOOLS,
    ...WALLET_CHAT_TOOLS,
    ...AGENT_LINK_CHAT_TOOLS,
    ...AGENT_RELAY_CHAT_TOOLS,
    ...CALENDAR_CHAT_TOOLS,
    ...PHONE_CHAT_TOOLS,
    ...VISION_CHAT_TOOLS,
    ...SURFACE_CHAT_TOOLS,
    ...VOICE_CHAT_TOOLS,
    ...CLOCK_CHAT_TOOLS,
    ...INTERNET_INTELLIGENCE_CHAT_TOOLS,
    ...INTEREST_WATCH_CHAT_TOOLS,
    ...AGENT_TASKS_CHAT_TOOLS,
    ...RHYTHM_REMINDER_CHAT_TOOLS,
    ...PROACTIVITY_FEEDBACK_CHAT_TOOLS,
    ...PROACTIVITY_CONFIRM_CHAT_TOOLS,
    ...CARE_REMINDER_CHAT_TOOLS,
    ...COMMITMENT_CHAT_TOOLS,
    ...GEOFENCE_CHAT_TOOLS,
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
    ..._memoryChatTools,
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
    // 2026-08-29 C 端生活管家强化：补齐热搜/晨报口语关键词，并把 hot_rankings
    // （实时热点榜单工具，注册于 web-tools.ts）纳入本分类工具清单——此前它不在
    // 任何分类映射里，"热搜/吃瓜"命中 web 分类后 hot_rankings 也不会被召回。
    category: 'web',
    keywords: ['搜索', 'search', '网页', 'web', '网址', 'url', '链接', 'link', '查询', 'query', '新闻', 'news', '天气', 'weather', 'fetch', '浏览', 'browse', '导航', 'navigate', '图片', '图像', '照片', 'image', 'photo', '视频', 'video', '对比', '比较', '区别', '查查', '查一查', '搜一下', '八卦', '吃瓜', '爆料', '热搜', '热点', '热榜', '上热搜', '简报', '早报', '晨报', '早安', '今日要点', '近况', '怎么样了', '什么情况'],
    toolNames: ['internet.research', 'internet.live_check', 'internet.verify', 'search_web', 'search_images', 'search_images_batch', 'search_videos', 'fetch_web', 'info.inspect_webpage', 'info.navigate_site', 'hot_rankings']
  },
  {
    // 记忆检索工具化（Letta/MemGPT agentic retrieval 模式）：
    // 长期记忆召回不再只靠系统层注入，LLM 可在 PLAN 阶段自主决定调 brain.recall
    // 按需检索（结果以 tool 消息进上下文，身份隔离天然防串台）。
    // 用户提到记忆类措辞时命中，让 brain.recall / brain.remember 进入可见工具集。
    category: 'memory',
    keywords: ['记得', '回忆', '记忆', '忘了', '忘记', '上次聊', '上回聊', '之前说过', '之前提到', '提过', '聊过', 'remember', 'recall', 'memory'],
    toolNames: ['brain.recall', 'brain.remember']
  },
  {
    // 2026-08-29 C 端生活管家强化：补齐提醒类口语关键词（提醒我/别忘了/到点叫我/
    // 定个闹钟），让 fast 模式下 reminder.plan / calendar.* 能被可靠召回。
    category: 'calendar',
    keywords: ['提醒', '提醒我', '别忘了', '到点叫我', '定个闹钟', 'reminder', '日程', 'schedule', '日历', 'calendar', '任务', 'task', '定时', 'timer', '闹钟', 'alarm', '计划', 'plan', '会议', 'meeting', '预约', 'appointment'],
    toolNames: ['reminder.plan', 'calendar.create_from_text', 'calendar.create_task', 'calendar.list_tasks']
  },
  {
    // 2026-08-29 C 端生活管家强化：补齐支付/记账口语关键词（付钱/买单/代付/缴费/
    // 记账/花了）。注意：钱包域工具有真实资金副作用，只做关键词映射召回，
    // 不做强推（forced tool choice），最终是否调用仍由 LLM 在用户授权语境下决定。
    category: 'wallet',
    keywords: ['钱包', 'wallet', '余额', 'balance', '支付', 'pay', '转账', 'transfer', '充值', 'recharge', '付钱', '买单', '代付', '缴费', '记账', '花了', '消费', 'purchase', '交易', 'transaction', '账单', 'bill', '钱', 'money', '金额', 'amount'],
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
    // 兴趣话题追踪：用户表达长期关注（喜欢/粉丝/常看/关注）时命中 interest.manage
    category: 'life',
    keywords: ['喜欢', 'like', '粉丝', 'fan', '关注', 'follow', '常看', '常聊', '感兴趣', 'interest', '追', '热榜', '热搜', '热点', '动态', 'updates'],
    toolNames: ['interest.manage']
  },
  {
    // Task 20 统一频控框架：用户对主动提醒/推送表达负反馈（别再提醒/别推了/
    // 太烦了）时命中 proactivity.feedback，LLM 调它写入持久抑制表。
    category: 'life',
    keywords: ['别再提醒', '别提醒', '不要提醒', '别再推', '别推', '别发了', '别再发', '别打扰', '不打扰', '太烦了', '烦死了', '安静点', '别唠叨', '别再给我', '退订', 'unsubscribe', 'suppress'],
    toolNames: ['proactivity.feedback']
  },
  {
    // Task 17 人情关系管家：提到生日/纪念日/重要日子时召回录入与查询工具
    category: 'life',
    keywords: ['生日', 'birthday', '纪念日', '周年', '重要日子', '重要日期', '谁要过生日', '记住这个日子'],
    toolNames: ['care.set_important_date', 'care.get_important_dates', 'care.delete_important_date']
  },
  {
    // 方案 C 承诺草稿板：用户提到承诺/答应/兑现/欠的事时召回 commitment.* 工具
    category: 'life',
    keywords: ['承诺', '答应', '保证', '说好', '约好', '兑现', '爽约', '答应过', '答应我', '我保证', '欠着', '还没给', '说过要', '改主意了', '不算了', 'commitment', 'promise'],
    toolNames: ['commitment.create', 'commitment.list', 'commitment.confirm', 'commitment.cancel', 'commitment.retract', 'commitment.update', 'commitment.fulfill']
  },
  {
    // 方案 D 溯源作废：用户否认说过/要求删除记忆时召回 memory.invalidate
    category: 'life',
    keywords: ['我没说过', '我没有说过', '当我没说', '记错了', '那条记忆', '删掉记忆', '作废', '那条信息是错的', '我不是那个意思', 'invalidate'],
    toolNames: ['memory.invalidate']
  },
  {
    // Task 19 健康关怀：健康数据确定性统计问答（这周跑了几次步/步数/睡眠）
    category: 'life',
    keywords: ['跑步', '跑了几次', '跑了多少', '步数', '步行', '锻炼', '健身', '运动量', '运动了几天', '睡眠时长', '体重', '健康数据', 'health'],
    toolNames: ['health.query']
  },
  {
    // Task 19 节律提醒：喝水/睡觉/运动预设模板开关（默认不创建，用户明说才开）
    category: 'life',
    keywords: ['喝水', '饮水', '睡觉提醒', '早睡提醒', '运动提醒', '节律', '久坐', '起来活动'],
    toolNames: ['care.rhythm_reminder']
  },
  {
    // Task 18 管家任务闭环：任务状态查询（我还有什么待办/之前的任务跑完了吗）
    category: 'life',
    keywords: ['待办', '还有什么任务', '任务列表', '任务进度', '跑完了吗', '进行到哪', '任务状态'],
    toolNames: ['agent.tasks.list']
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
      '眼', '耳', '皮肤', '前庭', '稳态', '反射', 'eye', 'ear', 'skin',
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
  // 2026-09-05：escalate 哨兵工具已随车道内升级机制一起删除。
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
    // 兜底填充黑名单：记忆工具（brain.recall/brain.remember）只能由 memory 分类
    // 关键词召回（用户显式提及记忆时）。若经兜底混进低意图轮次（如"你确定？"），
    // LLM 可能自发调用 brain.recall → 跨会话记忆灌回任务轮（串台回归向量）。
    const PADDING_EXCLUDED_TOOLS = new Set(["brain.recall", "brain.remember"]);
    const remainingTools = allTools.filter((tool) => {
      if (tool.type !== "function" || !("function" in tool) || !tool.function?.name) return false;
      if (PADDING_EXCLUDED_TOOLS.has(tool.function.name)) return false;
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
// ═══════════════════════════════════════════════════════════════════
// Plan-and-Execute 工具编排（2026-08-26 起替代已删除的 ReAct 多轮循环）
//
// 架构（每轮对话最多 3 类 LLM 调用，消除"每轮重发历史 + 全量 schema"的循环开销）：
//   ① PLAN      —— 单次带 schema 的规划调用：LLM 一次性列出本轮需要的全部工具
//                  调用（parallel_tool_calls），不再逐轮"想一步调一步"。
//   ② EXECUTE   —— 系统层并行执行全部 tool_calls，LLM 不参与调度。执行器内置
//                  轮内去重缓存（同工具+同参数只真实执行一次，用完即丢）与
//                  失败确定性重试（非超时失败自动重试 1 次）。
//   ③ SUMMARIZE —— 单次不带 schema 的汇总调用（流式）：工具结果已作为 tool
//                  消息在上下文里，不再重发工具 schema。
//
// 波次（wave）与 replan：
//   - 首个 PLAN 波次执行完毕后，若"全部成功 + 无元工具 + 强制联网已满足 +
//     未用交互式工具"，先做一次「充分性探测」（不带 schema，首行输出
//     NEED_MORE_TOOLS 可升级）；探测通过 → 直接 SUMMARIZE 收尾（2 次调用，
//     token 最省路径）。
//   - 存在失败 / 元工具（tool_search 桥接）/ 交互式工具（浏览器/桌面/代码链路）
//     时，进入带 schema 的 replan 波次（上限 maxRounds，默认
//     PLAN_EXECUTE_MAX_WAVES=4，fast 模式 1）：模型基于已有结果继续规划或
//     直接给出最终回答（文本回复即流式返回）。
//   - 波次耗尽仍有未收尾的工具链 → 兜底 SUMMARIZE（失败信息已在 tool 消息中）。
// ═══════════════════════════════════════════════════════════════════

/** 规划波次（plan + replan）默认上限；可用环境变量 PLAN_EXECUTE_MAX_WAVES 调整。 */
const PLAN_EXECUTE_MAX_WAVES_DEFAULT = (() => {
  const raw = Number.parseInt(process.env.PLAN_EXECUTE_MAX_WAVES ?? "", 10);
  return Number.isFinite(raw) && raw >= 1 ? raw : 4;
})();

/** 充分性探测的升级标记：汇总调用首行输出该标记表示"结果不足，需要 replan"。 */
const NEED_MORE_TOOLS_MARKER = "NEED_MORE_TOOLS";

/**
 * 规划调用输出 token 上限（仅「非思考」模型生效，思考模型的 reasoning 空间不被压缩）。
 * 防止规划轮模型输出冗长正文（非 tool_calls）时烧 token；正常回答长度远低于该值。
 * 可用环境变量 `PLAN_CALL_MAX_OUTPUT_TOKENS` 调整，设 0 关闭。
 */
const PLAN_CALL_MAX_OUTPUT_TOKENS = (() => {
  const raw = Number.parseInt(process.env.PLAN_CALL_MAX_OUTPUT_TOKENS ?? "", 10);
  return Number.isFinite(raw) && raw >= 256 ? raw : 3000;
})();

/**
 * 规划轮是否走非流式请求（内容与流式完全一致，协议更省、usage 更确定——含 prefix
 * cache token）。仅对「非思考」模型生效。可用 `PLAN_NON_STREAMING=0` 关闭。
 */
const PLAN_NON_STREAMING = process.env.PLAN_NON_STREAMING !== "0";


/** replan 历史瘦身：折叠旧波次工具结果时保留的结果要点长度（确定性截断，不经 LLM）。 */
const REPLAN_FOLD_DIGEST_CHARS = 160;

/**
 * 确定性安全截断：普通超长文本按 maxChars 截断；若截断点恰好落在 URL 中间
 * （http(s):// 已开始但未收尾），向后延伸到 URL 结束，避免 replan 规划拿到半截
 * URL 后自行脑补补齐（幻觉来源）。纯字符串操作，不经 LLM。
 */
export function safeTruncateDigest(raw: string, maxChars: number): string {
  if (raw.length <= maxChars) return raw;
  const cut = raw.slice(0, maxChars);
  const urlMatch = cut.match(/https?:\/\/\S*$/);
  if (urlMatch && urlMatch[0].length >= 10) {
    const rest = raw.slice(maxChars);
    const tail = rest.match(/^[^\s"',)}\]]*/);
    if (tail && tail[0].length > 0) {
      return cut + tail[0] + "…";
    }
  }
  return cut + "…";
}

/** summary 历史裁剪：保留最近 N 个用户回合（含其后的全部工具链），丢弃更早纯对话。 */
const SUMMARY_KEEP_USER_TURNS = 4;
/** summary 旧波折叠摘要长度：比 replan 折叠（160）更长，保住跨波对比的关键数据。 */
const SUMMARY_FOLD_DIGEST_CHARS = 400;
/** summary 历史裁剪生效的消息数阈值：短对话不裁剪（避免丢失引用上下文）。 */
const SUMMARY_TRIM_MIN_MESSAGES = 14;
/**
 * 质量保护闸：当前用户消息命中「指代早期对话」的措辞（刚才/上面/之前/继续/深入等）时，
 * 禁止 summary 历史裁剪——模型需要完整历史来消解引用，裁剪会让它失去所指对象、
 * 基于猜测作答（幻觉）。命中的概率不高，命中一次省不了多少 token，宁可保留。
 */
const SUMMARY_TRIM_REFERENCE_CUES =
  /刚才|刚刚|刚说|刚聊|前面|上面|上一条|之前|上次|上一|刚才说|上面说|前面说|继续说|接着|继续|展开|深入|再看|回顾|再说一遍/i;

/**
 * 交互式/自动化工具：结果几乎总是需要模型继续决策下一步（浏览器/桌面/代码/
 * 手机/具身链路）。这类波次不做「充分性探测」——探测大概率升级 replan，
 * 徒增一次无 schema 调用的延迟——直接进入下一轮带 schema 的 replan。
 */
const INTERACTIVE_TOOL_PREFIXES = [
  "agent_browser.",
  "desktop.",
  "code.",
  "phone.",
  "embodiment.",
  "browser.",
];

function isInteractiveToolName(name: string): boolean {
  return INTERACTIVE_TOOL_PREFIXES.some((p) => name.startsWith(p));
}

/** 工具执行结果（executeTool 的返回形状）。 */
type ToolExecOutcome = { ok: boolean; result: Record<string, unknown> };

/** 轮内去重缓存的参数键：对参数做稳定序列化（键排序），语义相同的参数命中同一键。 */
function stableArgsKey(args: Record<string, unknown>): string {
  const keys = Object.keys(args).sort();
  return keys.map((k) => `${k}=${JSON.stringify(args[k] ?? null)}`).join("&");
}

/** 判断一条 assistant 消息是否携带 tool_calls。 */
function isAssistantWithToolCalls(m: ChatCompletionMessageParam): boolean {
  if (m.role !== "assistant") return false;
  const calls = (m as { tool_calls?: unknown[] }).tool_calls;
  return Array.isArray(calls) && calls.length > 0;
}

/** 取 assistant tool_calls 的函数名列表（用于折叠摘要的标注）。 */
function assistantToolCallNames(m: ChatCompletionMessageParam): string {
  const calls = ((m as { tool_calls?: Array<{ function?: { name?: string } }> }).tool_calls ?? []).map(
    (c) => c.function?.name ?? "?",
  );
  return calls.length > 0 ? calls.join("/") : "工具";
}

/**
 * replan 历史瘦身：把「早于当前波次」的已完成工具链（assistant tool_calls + 其 tool
 * 回复）折叠为一条确定性摘要 user 消息，仅保留最近一个波次的完整链。replan 规划只需
 * 「上一步拿到了什么」，不必重发全部细节。折叠是确定性截断（保留工具名 + 结果要点），
 * 不经过 LLM，杜绝幻觉；最终汇总（runSchemaLessSummary）对旧波用更长的摘要预算
 * （SUMMARY_FOLD_DIGEST_CHARS）作答，尽量保住跨波取数需要的关键数据。
 */
function foldOldWaveToolChains(
  msgs: ChatCompletionMessageParam[],
  digestChars: number = REPLAN_FOLD_DIGEST_CHARS,
): ChatCompletionMessageParam[] {
  // 定位所有工具链起点；最后一个链 = 当前波次（必须原样保留）
  const chainStarts: number[] = [];
  for (let i = 0; i < msgs.length; i++) {
    if (isAssistantWithToolCalls(msgs[i])) chainStarts.push(i);
  }
  if (chainStarts.length <= 1) return msgs;
  const keepFrom = chainStarts[chainStarts.length - 1];

  const out: ChatCompletionMessageParam[] = [];
  let foldedLines: string[] = [];
  const flushFolded = () => {
    if (foldedLines.length === 0) return;
    out.push({
      role: "user",
      content: "【历史工具结果摘要（早于当前规划轮，供参考）】\n" + foldedLines.join(""),
    });
    foldedLines = [];
  };

  let i = 0;
  while (i < msgs.length) {
    const m = msgs[i];
    if (!isAssistantWithToolCalls(m)) {
      out.push(m);
      i += 1;
      continue;
    }
    // 收集完整链：assistant + 紧随其后的全部 tool 消息
    const chain: ChatCompletionMessageParam[] = [m];
    let j = i + 1;
    while (j < msgs.length && msgs[j].role === "tool") {
      chain.push(msgs[j]);
      j += 1;
    }
    if (i >= keepFrom) {
      // 当前波次链：先把已折叠的旧块落盘，再原样保留本链
      flushFolded();
      out.push(...chain);
    } else {
      // 旧波次链：折叠为确定性摘要（URL 安全截断，防止规划拿半截 URL 脑补）
      const names = assistantToolCallNames(m);
      for (const tm of chain.slice(1)) {
        const raw = typeof tm.content === "string" ? tm.content : JSON.stringify(tm.content ?? "");
        const digest = safeTruncateDigest(raw, REPLAN_FOLD_DIGEST_CHARS);
        foldedLines.push(`- ${names}[结果]: ${digest}`);
      }
    }
    i = j;
  }
  flushFolded();
  return out;
}

/**
 * summary 历史裁剪：仅保留全部 system 消息 + 最近 N 个用户回合及其后的所有内容
 * （含全部工具链），丢弃更早的纯对话。工具结果永远完整保留，最终回答依赖的真实数据
 * 不丢；短对话（低于阈值）为无操作。若传入的当前用户文本命中「指代早期对话」的措辞，
 * 直接返回原历史（保护引用消解，防止上下文丢失导致的幻觉）。
 */
export function trimHistoryForSummary(
  msgs: ChatCompletionMessageParam[],
  keepUserTurns = SUMMARY_KEEP_USER_TURNS,
  protectUserText?: string,
): ChatCompletionMessageParam[] {
  if (protectUserText && SUMMARY_TRIM_REFERENCE_CUES.test(protectUserText)) {
    return msgs;
  }
  const userIdx: number[] = [];
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].role === "user") userIdx.push(i);
  }
  if (msgs.length < SUMMARY_TRIM_MIN_MESSAGES || userIdx.length <= keepUserTurns) {
    return msgs;
  }
  const startIdx = userIdx[userIdx.length - keepUserTurns];
  const head = msgs.slice(0, startIdx).filter((m) => m.role === "system");
  return [...head, ...msgs.slice(startIdx)];
}

/** 单元素 async iterable：把非流式完整响应归一化为一个 chunk 喂给统一 consumer。 */
async function* singleChunkSource(chunk: NormalChatChunk): AsyncGenerator<NormalChatChunk> {
  yield chunk;
}

/**
 * 工具结果充分性提示：明确告诉 LLM「结果已完整」，减少不确定驱动的重复调用。
 */
function buildToolSufficiencyHint(toolName: string, content: string | undefined): string {
  if (!content || content.length < 8) return "";
  return (
    `[系统提示] ${toolName} 的结果已完整返回，不要重复同一查询。` +
    `但若这些摘要/片段不足以覆盖用户要的细节（如具体事件经过、正文内容、多主题盘点），` +
    `应继续用 fetch_web / deep_search 深读相关链接，而不是仅凭摘要直接收尾。`
  );
}

export async function streamCompletionWithTools(
  client: OpenAI,
  model: string,
  messages: ChatCompletionMessageParam[],
  onDelta: StreamDeltaHandler,
  ctx: ChatToolExecutionContext,
  options?: {
    /** 规划波次上限（plan + replan 总次数）；fast 场景传 1 */
    maxRounds?: number;
    tools?: ChatCompletionTool[];
    toolSearchSourceTools?: ChatCompletionTool[];
    onAfterToolBatch?: (info: ToolLoopAfterBatchInfo) => void;
    /** Moonshot Kimi：如 `{ thinking: { type: "disabled" } }` */
    extraBody?: Record<string, unknown>;
    promptCache?: PrefixCacheRequest;
    requestSystemMessages?: ChatCompletionMessageParam[];
    /** volatile 动态上下文（记忆/时间等），沉底注入到最新 user 消息尾部，保护前缀缓存 */
    tailDynamicContext?: string;
    /** 输出 token 上限（对应 OpenAI 的 max_tokens）；不传则不限制 */
    maxOutputTokens?: number;
    /**
     * 中断信号：透传到循环内每次 LLM 请求（规划轮 + 总结轮）。
     * 用户发新消息 abort 旧轮时，工具分支的流式请求同样会被中断——
     * 此前只有非工具分支传了 signal，工具分支挂死时只能吃满 SDK 默认超时。
     */
    signal?: AbortSignal;
    /** Token 用量审计打点信息（可选，内部自动记录每轮输入/输出） */
    audit?: { sessionId?: string; stage?: "main_chat" };
  },
): Promise<string> {
  const userText = extractUserTextFromMessages(messages) || "";
  // 2026-08-01 性能优化：从 extraBody 推断 Fast 模式，传递给 resolveForcedToolChoice 跳过强制 tool_choice。
  // Fast 模式 = 对话为主，system prompt 已注入 currentTime / userLocation / scheduleSnapshot，
  // 强制工具调用会多 1 次 round trip，徒增延迟。
  const fastProfile = Boolean(options?.extraBody?.fastProfile === true);
  const maxWaves = Math.max(
    1,
    options?.maxRounds ?? (fastProfile ? 1 : PLAN_EXECUTE_MAX_WAVES_DEFAULT),
  );
  
  const mergedRegistryTools = options?.tools ?? getBuiltinAgentChatTools();
  const toolSearchPrepared = await prepareTools(
    mergedRegistryTools,
    options?.toolSearchSourceTools,
    { userText },
  );
  const registryTools = toolSearchPrepared.visibleTools;
  const deferredToolCatalog = toolSearchPrepared.deferredCatalog;

  if (toolSearchPrepared.toolSearchActive) {
    console.info(
      `[tool-search] active: core=${toolSearchPrepared.coreToolCount} ` +
        `deferred=${toolSearchPrepared.deferredToolCount} ` +
        `visible=${registryTools.length} (BM25 index cached per turn)`,
    );
  }

  const { apiTools, resolveRegistryToolName } = prepareToolsForChatApi(registryTools);
  // P2：会话级工具 schema 稳定——首轮确定性排序 + 会话基准快照，后续轮保持顺序，
  // 避免多分类检索的顺序抖动破坏 DeepSeek/Kimi 等 provider 的前缀上下文缓存。
  const stableApiTools = stabilizeToolOrderForSession(apiTools, options?.audit?.sessionId);
  let lastAssistantText = "";
  let lastToolOutputFallback = "";
  const thinkingDisabled = isThinkingDisabled(options?.extraBody);
  // 累积所有工具调用结果，供 summary 调用时做数据质量评估 + 策略注入
  const allToolExecResults: Array<{
    toolName: string;
    ok: boolean;
    input?: Record<string, unknown>;
    result: Record<string, unknown>;
  }> = [];

  // ── 统一出口自检 TurnOutcomeGate（2026-09-05，话题无关）──
  // 判定不使用任何话题关键词（价格/新闻/媒体词表已随话题路由一起删除）：
  // "这轮是否需要工具"由路由层的语义分类决定，本门只负责事实核查——
  // 任务面轮次结束时有「实质成功的工具结果」才算诉求被满足；
  // 没有成功结果且收尾是道歉式/机制话（风格判定，话题无关）→ 换路续波一次。
  // 置信而答的直答（含模型凭既有知识回答）不拦截，避免空转烧 token。
  /** 有实质产出的成功工具数：元工具（能力查询/目录检索）与失败执行不计入。 */
  const countSubstantiveOkResults = (): number =>
    allToolExecResults.filter((r) => r.ok && !META_TOOL_NAMES.has(r.toolName)).length;
  /** 出口自检：本轮收尾是否「用户诉求未满足」。null = 满足，可正常收尾。 */
  const assessTurnUnsatisfied = (finalText: string): string | null => {
    if (countSubstantiveOkResults() > 0) return null;
    // 事实判定（话题无关）：任务面轮次尝试过实质工具但零成功 → 诉求未满足。
    // 任务面本身由路由层语义分类选定（声明了能力需求），"有没有真的办成"
    // 只看服务端工具执行结果，不猜话题、不看措辞。
    if (allToolExecResults.length > 0) {
      return "substantive_tools_attempted_but_none_succeeded";
    }
    // 零尝试：仅当收尾是道歉式/机制话（风格判定，天然话题无关）才续波——
    // 置信的知识直答与向用户追问澄清的轮次不拦截，避免空转烧 token。
    if (isApologyStyleFallback(finalText.trim())) {
      return "no_attempt_and_hedged";
    }
    return null;
  };
  // 轮内去重缓存：同一工具 + 同一参数在本轮对话内只真实执行一次（用完即丢，
  // 不跨轮持久——跨轮缓存由 ctx.getCachedToolResult 的 TTL 缓存负责）。
  // 值为共享 Promise：同一波内并发出现的相同调用 await 同一个执行（含确定性重试），
  // 消除并行重复执行；失败结果落定后立即摘除，后续 replan 波次仍可重新执行。
  const turnDedupeCache = new Map<string, Promise<ToolExecOutcome>>();
  // 强制联网兜底（模型未调搜索工具就收尾时注入提示重规划）只授予一次
  // 行动宣告未兑现兜底（模型只承诺要查/去办、却一个工具都没调就收尾）只授予一次。
  let announcementEnforced = false;
  // 空正文整合兜底（2026-08-29）：模型调完工具只发 tool_calls 就收尾、零正文时，
  // 强制它基于工具结果说人话（而非把工具 JSON 原文糊给用户），只授予一次。
  let narrationEnforced = false;
  // 统一出口自检（2026-09-05 TurnOutcomeGate）：轨迹内「换路续波」只授予一次，
  // 不再区分 fast/complex 车道（2026-09-05 双面架构后只有任务面进工具循环）。
  let outcomeGateEnforced = false;
  // 档3 委派引导状态：汇总探测报不足且命中探索型信号 → 向下一次 replan 波次
  // 前缀缓存命中统计（本调用内聚合，结束时打印一行，验证优化前后命中率变化）
  const prefixCacheStats = { hit: 0, miss: 0 };
  const accumulatePrefixCacheUsage = (usage?: NormalUsage) => {
    if (!usage) return;
    if (typeof usage.promptCacheHitTokens === "number") prefixCacheStats.hit += usage.promptCacheHitTokens;
    if (typeof usage.promptCacheMissTokens === "number") prefixCacheStats.miss += usage.promptCacheMissTokens;
  };
  const logPrefixCacheStats = () => {
    const total = prefixCacheStats.hit + prefixCacheStats.miss;
    if (total <= 0) return;
    console.info(
      `[prefix-cache] 本调用聚合: hit=${prefixCacheStats.hit} miss=${prefixCacheStats.miss} ` +
        `hitRate=${((prefixCacheStats.hit / total) * 100).toFixed(1)}%`,
    );
  };

  // 规划引导：Plan-and-Execute 要求模型在单次回复里一次性规划全部工具调用，
  // 减少串行波次（每多一波 = 多一次带 schema 的全量历史重发）。
  // 只在有工具可调时注入，纯对话场景不注入。
  if (stableApiTools.length > 0) {
    messages.push({
      role: "system",
      content:
        "工具调用原则（Plan-and-Execute）：\n" +
        "1. 一次性规划：把本轮需要的所有工具调用放在同一次回复里并行发出（独立的信息需求拆成多个并行调用），不要拆成多轮串行。\n" +
        "2. 不要用完全相同的 query 重复搜索；但对比/多主题/盘点类需求，或首轮结果覆盖不全时，应换角度拆多个 query 补搜，或用 fetch_web / deep_search 深读，把信息收齐再回答，不要急着收尾。\n" +
        "3. code.run 的 stdout/stderr 如果已包含答案，不要重跑同样代码。输出被截断(truncated=true)时，改用 code.write_file 写产物再 code.read_file 分段读，不要重跑。\n" +
        "4. 拿到工具结果后优先直接回答用户，不要为了「确认」再调一次工具。\n" +
        "5. 图片/照片类需求用 search_images，不要用 search_web 编造图片来源（如 duitang.com 这类假域名）——前端拿不到真实图片。搜到的每张照片会由视觉模型自动生成真实画面描述并展示在照片下方，正文**不要**逐张介绍照片、不要用「第一张图/第二张图」这类指代（你看不见图片内容，写了必然对不上），也不要把图片链接复述进正文；正文只写整体性的结论、建议或补充信息。\n" +
        "6. 如果此前（含更早轮次）就任务细节向用户追问过（目的地/时间/选项/偏好等），而用户本轮给出了答案、确认或补充（哪怕只有几个字如「先去A吧」「就这个」）：不要只回一句「好的/收到/不错」——立即调用对应工具把任务真正完成，拿到结果后再回复用户。只确认不兑现 = 任务失败。",
    });
  }

  // 失败换路预算（2026-09-02）：存在失败的工具执行时，fast 追加 1 波
  // 「换工具重试」预算（如 search_images 失败 → 改 search_web/fetch_web），
  // 不挤占正常收尾预算；complex 波次充裕不追加。总上限 4，防失败循环膨胀。
  // 用闭包函数而非常量：for 条件与波次终止决策读取同一份动态预算（失败发生后生效）。
  const effectiveMaxWaves = (): number =>
    fastProfile ? Math.min(maxWaves + (allToolExecResults.some((r) => !r.ok) ? 1 : 0), 4) : maxWaves;

  for (let wave = 0; wave < effectiveMaxWaves(); wave++) {
    let retriedToolCallIdError = false;
    let retriedToolChoice = false;
    let stream: Awaited<ReturnType<OpenAI["chat"]["completions"]["create"]>>;
    // ③/④ 规划轮：非思考模型走非流式 + 输出上限（协议更省、usage 确定、防正文烧 token）；
    // 思考模型（deepseek-reasoner 等）保持流式 + 不限 max_tokens，避免压缩 reasoning 空间。
    const planNonStreaming = PLAN_NON_STREAMING && thinkingDisabled;
    const planMaxTokens = options?.maxOutputTokens
      ? options.maxOutputTokens
      : thinkingDisabled
        ? PLAN_CALL_MAX_OUTPUT_TOKENS
        : undefined;
    // Token 用量审计：本轮发往 LLM 的输入规模（估算）
    let auditInputChars = 0;

    while (true) {
      // ① replan 历史瘦身：wave>0 时把早于当前波次的旧工具链折叠为确定性摘要
      //（仅保留最近波次完整链），replan 规划不必重发旧波次全部细节。
      const sanitizedMessages = sanitizeChatMessagesForApi(
        wave > 0 ? foldOldWaveToolChains(messages) : messages,
        {
          stripReasoning: thinkingDisabled,
          logPrefix: "[openai-tool-loop]",
        },
      );
      const requestMessages = options?.requestSystemMessages
        ? applyPromptCacheMessages(
            sanitizedMessages,
            options.requestSystemMessages,
            options.tailDynamicContext,
          )
        : sanitizedMessages;
      try {
        const request = {
          model,
          messages: requestMessages,
          tools: stableApiTools,
          tool_choice: retriedToolChoice ? "auto" : resolveForcedToolChoice(userText, stableApiTools, fastProfile),
          // 明确启用并行工具调用，让 LLM 在单轮内返回多个 tool_calls。
          // 配合工具描述里的并行引导，减少串行轮次。
          parallel_tool_calls: true,
          stream: planNonStreaming ? false : true,
          ...(planMaxTokens ? { max_tokens: planMaxTokens } : {}),
          ...(options?.promptCache ?? {}),
          // ⚠️ OpenAI Node SDK v6 不识别 Python 风格的 `extra_body` 顶层字段——它会
          // 整个 body JSON.stringify 后把 `extra_body` 当作普通 key 发出去，导致
          // `thinking` 被埋到一层下，Moonshot 看不到 → k2.5 默认 thinking 仍开启
          // → 撞上 tool_choice='specified' 直接 400。直接 spread 到顶层。
          ...(options?.extraBody ?? {}),
        };
        stream = await client.chat.completions.create(
          request as Parameters<typeof client.chat.completions.create>[0],
          options?.signal ? { signal: options.signal } : undefined,
        );
        auditInputChars = JSON.stringify(requestMessages).length + JSON.stringify(stableApiTools ?? []).length;
        break;
      } catch (e) {
        if (!retriedToolCallIdError && isToolCallIdNotFoundError(e)) {
          retriedToolCallIdError = true;
          repairMessagesAfterToolCallIdError(messages, thinkingDisabled);
          console.warn("[openai-tool-loop] Retrying completion after tool_call_id repair");
          continue;
        }
        // tool_choice 兼容性保护：部分端点（DeepSeek、thinking 模式 Moonshot 等）
        // 拒绝非 auto 的 tool_choice（"Thinking mode does not support this tool_choice"→400）。
        // 首次带强制 tool_choice 失败后，降级为 auto 重试一次，不丢强制工具的优化收益。
        if (!retriedToolChoice && isToolChoiceRejectedError(e)) {
          retriedToolChoice = true;
          console.warn(
            `[openai-tool-loop] tool_choice 被端点拒绝（${(e as { status?: number }).status}），降级 auto 重试`,
          );
          continue;
        }
        throw e;
      }
    }

    let fullText = "";
    let fullReasoning = "";
    let finishReason: string | null = null;
    const normalizedToolCalls: NormalToolCall[] = [];
    // 流末尾 chunk 的 usage（可能缺失）；声明在 try 外，供块外审计使用
    let streamUsage: NormalUsage | undefined;

    try {
      if (planNonStreaming) {
        // ④ 非流式规划响应：把完整 message 归一化为单个 NormalChatChunk 走同一 consumer。
        // 内容与流式完全一致（DSML 工具调用提取、reasoning 累积都在 consumer 内完成），
        // 但协议更省、usage 更确定（含 prefix cache token）。
        const resp = stream as OpenAI.Chat.Completions.ChatCompletion;
        const choice = resp.choices?.[0];
        const msg = choice?.message;
        const usageRaw = resp.usage as OpenAI.CompletionUsage | undefined;
        const usageExtras = usageRaw as unknown as Record<string, unknown> | undefined;
        const toolCalls: NormalToolCall[] = (
          (msg?.tool_calls ?? []) as Array<{
            id?: string;
            function?: { name?: string; arguments?: string };
          }>
        ).map((tc, i) => ({
          index: i,
          id: tc.id ?? null,
          name: tc.function?.name,
          argumentsChunk: tc.function?.arguments,
        }));
        const chunk: NormalChatChunk = {
          content: typeof msg?.content === "string" && msg.content.length > 0 ? msg.content : undefined,
          reasoning: (msg as { reasoning_content?: string }).reasoning_content,
          finishReason: choice?.finish_reason ?? null,
          ...(toolCalls.length > 0 ? { toolCalls } : {}),
          ...(usageRaw
            ? {
                usage: {
                  inputTokens: usageRaw.prompt_tokens,
                  outputTokens: usageRaw.completion_tokens,
                  promptCacheHitTokens:
                    (usageExtras?.prompt_cache_hit_tokens as number | undefined) ??
                    ((usageExtras?.prompt_tokens_details as { cached_tokens?: number } | undefined)
                      ?.cached_tokens),
                  promptCacheMissTokens: usageExtras?.prompt_cache_miss_tokens as number | undefined,
                },
              }
            : {}),
        };
        const result = await consumeNormalizedStream(singleChunkSource(chunk), {
          onToolCallsComplete: (calls) => {
            for (const c of calls) normalizedToolCalls.push(c);
          },
          providerId: "openai-compatible",
          model,
        });
        fullText = result.content;
        fullReasoning = result.reasoning;
        finishReason = result.finishReason;
        streamUsage = result.usage;
      } else {
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
        streamUsage = result.usage;
      }
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

    // 前缀缓存统计聚合（本调用内）
    accumulatePrefixCacheUsage(streamUsage);

    // Token 用量审计：记录本轮实际 LLM 调用（工具循环内每次 round 一条），
    // 附带 API 真实返回的 prefix cache 命中/未命中 token（若流末尾带 usage）
    try {
      if (options?.audit && auditInputChars > 0) {
        recordLlmUsageByChars({
          stage: options.audit.stage ?? "main_chat",
          sessionId: options.audit.sessionId,
          inputChars: auditInputChars,
          outputChars: (fullText?.length ?? 0) + (fullReasoning?.length ?? 0),
          model,
          promptCacheHitTokens: streamUsage?.promptCacheHitTokens,
          promptCacheMissTokens: streamUsage?.promptCacheMissTokens,
        });
      }
    } catch {
      /* 审计失败静默 */
    }

    // 仅累积正式回复内容；以 tool_calls 结束的轮次中 fullText 仅为思考前导话，
    // 不进入最终回复，也不推送给前端。
    if (finishReason !== "tool_calls" || normalizedToolCalls.length === 0) {
      lastAssistantText = (lastAssistantText ? lastAssistantText + "\n" : "") + fullText;
    }

    if (finishReason !== "tool_calls" || normalizedToolCalls.length === 0) {
      // 对话结束：返回最终回复文本。
      // 剥离 [ts:] 时间戳帧（仅供 LLM 上下文，不应展示给用户）；
      // 用容错版本，连模型复述出的残缺帧（[ts 后断行/丢冒号）一并清掉。
      let finalText = stripAllTimestampFrameLines(lastAssistantText.trim()).trim();

      // （Coze 思路）已移除图片意图"自救"prompt 注入：
      //   - 不靠正则猜意图 / 不注入 prompt 逼模型重调 search_images。
      //   - 媒体是否展示完全由「模型是否真的调用了 search_images」这一服务端事实决定，
      //     search_images 常驻可见，服务端把工具结果确定性渲染成图廊（chat-user-message.ts）。
      //   - 普通问答时模型不该调图片工具就不调，从而彻底避免误返回照片。

      // ── 收尾兜底链（2026-09-05 根源化：全部话题无关）──
      // 旧链中的「强制联网重试」依赖 FRESH_WEB_LOOKUP_RE 等话题词表判定"需要联网"，
      // 属于关键词打地鼠，已删除——"需不需要外部信息"由路由层语义分类承担，
      // "有没有真的查"由下方出口自检（风格判定）承担，不再需要话题词预判。
      // 现顺序：
      //   1) 行动宣告未兑现补打（零工具 + 纯宣告，风格判定，一次）；
      //   2) 统一出口自检 TurnOutcomeGate（无实质成功结果 + 道歉式收场，一次）。
      // 行动宣告未兑现兜底（根治「回复了却没结果」）：文本命中行动宣告模式 且
      // 本轮从未执行过任何工具 且 未强制过 → 注入指令强制补打一波真实工具调用。
      // 全程最多授予一次。
      if (
        isActionAnnouncementOnly(finalText) &&
        allToolExecResults.length === 0 &&
        !announcementEnforced
      ) {
        announcementEnforced = true;
        messages.push({
          role: "assistant",
          content: finalText || fullText || "",
        });
        messages.push({
          role: "system",
          content:
            "你刚才只向用户宣告了要做某件事（查/搜/看/办…）但还没有真正调用任何工具、也没有给出任何结果。" +
            "请立即调用相应工具真正完成这件事并基于真实结果回答用户；若工具不可用或确实办不到，请如实向用户说明。" +
            "严禁只重复「我去查/稍后告诉你」这类承诺而不兑现。",
        });
        continue;
      }
      // 统一出口自检（2026-09-05 TurnOutcomeGate，不分车道）：「诉求未满足」且预算
      // 还有余量 → 注入一次换路续波指令（换关键词/换工具/换数据源），在原轨迹内纠错。
      // 预算耗尽 → 如实收尾（honest 策略），不再有升级哨兵/整轮重放。
      // 仅当本轮有工具可调时生效——零工具轮（对话面）不在这里空转。
      if (stableApiTools.length > 0) {
        const unsatisfiedReason = assessTurnUnsatisfied(finalText);
        if (
          unsatisfiedReason &&
          !outcomeGateEnforced &&
          wave + 1 < effectiveMaxWaves()
        ) {
          outcomeGateEnforced = true;
          console.info(
            `[openai-tool-loop] 出口自检：${unsatisfiedReason}` +
              `（工具尝试 ${allToolExecResults.length} 次，成功实质 ${countSubstantiveOkResults()} 次）→ 换路续波`,
          );
          messages.push({
            role: "assistant",
            content: finalText || fullText || "",
          });
          messages.push({
            role: "system",
            content:
              "出口自检：到目前为止还没有任何一次成功的工具结果能回答用户的问题。" +
              "请换一个关键词重搜、换一个工具（如 search_web / fetch_web / internet.*）或换数据源再试一次，" +
              "拿到真实结果后再回答。若所有途径确实都不可用，请如实向用户说明卡点，不要编造结果。",
          });
          continue;
        }
        if (unsatisfiedReason) {
          console.info(
            `[openai-tool-loop] 出口自检：${unsatisfiedReason}（预算耗尽）→ 如实收尾`,
          );
        }
      }
      // 空正文整合兜底（2026-08-29）：isApologyStyleFallback("")=true，旧行为会
      // 把 lastToolOutputFallback（工具输出原文，如 travel.plan-itinerary 的
      // summarizeItinerary JSON）整段糊给用户。这里先注入一次指令强制模型基于
      // 工具结果用自然口语回复；仍失败才落到下方工具原文拼接。
      // wave 预算守卫：fast（maxWaves=1）与最后一波不授予，避免 continue 越过预算。
      if (
        !finalText.trim() &&
        allToolExecResults.length > 0 &&
        !narrationEnforced &&
        wave + 1 < maxWaves
      ) {
        narrationEnforced = true;
        messages.push({
          role: "assistant",
          content: fullText || "",
        });
        messages.push({
          role: "system",
          content:
            "你刚才调用了工具但还没有向用户输出任何正文。请立即基于以上工具结果用自然口语回复用户，把关键信息讲清楚；" +
            "不要输出 JSON 或原始数据结构（那由前端结构化渲染负责）。若结果为空或失败，请如实向用户说明。",
        });
        continue;
      }
      // 防 LLM "道歉式兜底"（不做额外 LLM1 重建，减少 LLM 调用）：
      //  - 已有成功工具数据但 LLM 输出是 apology/无法整合 → 直接用工具结果拼接，不额外调 LLM1；
      //  - 无成功工具数据而 LLM 出 apology/空 → 返回空串，由上层自然处理，不额外调 LLM1。
      let effectiveFinalText: string;
      if (isApologyStyleFallback(finalText) && lastToolOutputFallback.trim()) {
        effectiveFinalText = lastToolOutputFallback.trim();
      } else if (isApologyStyleFallback(finalText)) {
        effectiveFinalText = "";
      } else {
        effectiveFinalText = finalText;
      }
      // 流式推送最终内容到 onDelta（→ onAssistantDelta → 前端 chat.assistant_chunk）
      // 根源净化：先把 LLM 混进正文的内部控制标签（[STOP...] / [话题切换...]）剥离，
      // 保证推给前端的气泡不出现这些内部信号（此前在 agent-core finishLlmTurn 后置剥离
      // 太晚——流式早已透出，无法撤回）。
      //
      // 2026-08-29 扩展：再走一次元术语整句过滤，兜底 LLM 把系统元描述（"上一轮转入
      // 规划任务，执行脑已接手处理中"）写成完整句子的场景——这类整句与正常内容混编
      // 时整段丢弃，避免污染前端气泡。
      const metaFilter = createStreamMetaSentenceFilter();
      const sanitizedFinalText = stripInternalControlTags(
        metaFilter(effectiveFinalText),
      );
      if (sanitizedFinalText) {
        onDelta(sanitizedFinalText);
      }
      messages.push({
        role: "assistant",
        content: sanitizedFinalText || null,
      });
      logPrefixCacheStats();
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
    // 本波次是否使用了交互式工具（浏览器/桌面/代码链路）：影响波次终止决策
    let waveUsedInteractiveTool = false;

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
        const bridge = await executeBridgeWithTimeout(registryToolName, args, deferredToolCatalog);
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

    const settledResults = await Promise.allSettled(
      workItems.map(async (item) => {
        let targetToolName = item.registryToolName;
        let targetArgs = item.parsedArgs;

        if (isToolSearchBridgeName(item.registryToolName)) {
          const bridge = await executeBridgeWithTimeout(
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

        let exec: ToolExecOutcome;

        // 单次执行尝试：重型工具经并发限制器（code.run / image.generate / voice.* 等），
        // 限流等待不占超时预算：只有 acquire 成功后才开始 Promise.race 计时
        const attemptExec = () =>
          executeWithToolLimit(targetToolName, () =>
            Promise.race([
              ctx.executeTool(targetToolName, targetArgs),
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error(`工具 "${targetToolName}" 执行超时 (${TOOL_TIMEOUT_MS}ms)`)), TOOL_TIMEOUT_MS)
              )
            ])
          );

        // 完整执行流程（超时兜底 + 非超时失败确定性重试 1 次），作为共享 Promise 的载荷：
        // 同一波内并发的相同工具调用复用同一次执行，不再各自真实执行。
        const runExecWithRetry = async (): Promise<ToolExecOutcome> => {
          let exec: ToolExecOutcome;
          try {
            exec = await attemptExec();
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
          // 失败确定性重试：非超时失败（瞬时故障/网络抖动）自动重试 1 次；
          // 超时已烧完整个时间预算，重试只会让前端再等一倍时间，不再重试。
          const isTimeoutFailure =
            (exec.result as Record<string, unknown> | undefined)?.timeout === true;
          if (!exec.ok && !isTimeoutFailure) {
            console.warn(
              `[plan-execute] ${targetToolName} 首次执行失败，确定性重试 1 次: ` +
                JSON.stringify(exec.result).slice(0, 200),
            );
            try {
              const retried = await attemptExec();
              if (retried.ok) exec = retried;
            } catch {
              /* 保留首次失败结果 */
            }
          }
          return exec;
        };

        // 轮内去重缓存：同工具+同参数 → 共享同一次执行（含确定性重试）。
        // 替代旧 ReAct 循环的"重复搜索制动"——波次有界 + 去重，从源头消除重复执行。
        const dedupeKey = `${targetToolName}::${stableArgsKey(targetArgs)}`;
        // 跨轮 TTL 缓存：查询类工具在 TTL 内相同参数直接返回缓存，跳过安全检查/BodyGateway 等中间层
        const cachedResult = ctx.getCachedToolResult?.(targetToolName, targetArgs);

        const inflight = turnDedupeCache.get(dedupeKey);
        if (inflight) {
          // 命中（进行中或已成功落定）：直接复用同一次执行的结果
          exec = await inflight;
        } else if (cachedResult) {
          exec = cachedResult;
        } else {
          const shared = runExecWithRetry().then((settled) => {
            // 失败结果不驻留缓存：本轮后续 replan 波次仍可重新执行；
            // 同波内已在等待的并发调用持有同一 Promise 引用，不受删除影响。
            if (!settled.ok) turnDedupeCache.delete(dedupeKey);
            return settled;
          });
          turnDedupeCache.set(dedupeKey, shared);
          exec = await shared;
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

    // 2026-09-05：escalate 哨兵短路已删除——升级/重放机制退役，
    // 出口自检在 final-text 分支统一处理（见上方 outcomeGateEnforced）。

    // 本波最后一条成功工具消息的下标：充分性提示只追加一次。
    // 此前每条成功消息都重复追加同一段提示（5 个并行工具 = 5 份相同文本）。
    let lastOkToolIndex = -1;
    for (let i = 0; i < settledResults.length; i++) {
      const s = settledResults[i];
      if (s.status === "fulfilled" && s.value.exec.ok) lastOkToolIndex = i;
    }

    for (let i = 0; i < workItems.length; i++) {
      const item = workItems[i];
      const settled = settledResults[i];
      const exec = settled.status === "fulfilled" ? settled.value.exec : { ok: false, result: { error: settled.reason instanceof Error ? settled.reason.message : String(settled.reason) } };
      const compacted = settled.status === "fulfilled" ? settled.value.compacted : { content: JSON.stringify(exec.result), rawBytes: 0, compactBytes: 0, compacted: false };
      const injectFrames = settled.status === "fulfilled" ? settled.value.injectFrames : undefined;
      const wireToolName =
        settled.status === "fulfilled" ? settled.value.wireToolName : item.registryToolName;

      toolResults.push({ name: wireToolName, ok: exec.ok });
      if (isInteractiveToolName(wireToolName)) {
        waveUsedInteractiveTool = true;
      }
      ctx.onToolExecuted?.({
        toolName: wireToolName,
        input: item.parsedArgs,
        ok: exec.ok,
        result: settled.status === "fulfilled" ? settled.value.resultForWire : exec.result,
      });
      // 累积工具结果供 summary 调用做策略评估（input 供升级继承记录关键入参）
      allToolExecResults.push({
        toolName: wireToolName,
        ok: exec.ok,
        input: item.parsedArgs,
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
      // 只追加在本波最后一条成功消息上（内容与具体工具无关，逐条重复纯烧 token）。
      // 关键洞察：LLM 重复调用工具的根因是不确定结果是否足够回答。
      // 明确告诉 LLM「结果已完整」，让它直接回答而非重复调用。
      const sufficiencyHint =
        exec.ok && i === lastOkToolIndex
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

    options?.onAfterToolBatch?.({
      roundIndex: wave,
      assistantText: fullText,
      toolResults,
    });
    lastToolOutputFallback = buildFallbackAnswerFromToolOutputs(roundToolOutputs);

    // ── 波次终止决策 ──（与 for 条件共用 effectiveMaxWaves：失败发生后预算 +1）
    const wavesRemaining = wave + 1 < effectiveMaxWaves();
    if (!wavesRemaining) {
      // 预算耗尽仍有未收尾的工具链 → 兜底 SUMMARIZE（失败信息已在 tool 消息中）
      break;
    }

    const allSucceeded = toolResults.length > 0 && toolResults.every((r) => r.ok);
    const hasMetaTool = toolResults.some((r) => META_TOOL_NAMES.has(r.name));

    if (allSucceeded && !hasMetaTool && !waveUsedInteractiveTool) {
      // 充分性探测（token 最省路径）：不带 schema 的轻量汇总调用。工具结果已完整
      // 存在于上方 tool 消息里（无压缩/折叠），汇总指令不再重复 dump。
      // 首行输出 NEED_MORE_TOOLS → 结果不足，升级一次 replan（带 schema）。
      const probe = await runSchemaLessSummary(true);
      if (!probe.needMore) {
        console.info(
          `[plan-execute] wave=${wave} ${toolResults.length} 个工具全部成功，探测通过 → 无 schema 汇总收尾（工具 schema 不再重发）`,
        );
        logPrefixCacheStats();
        return probe.text;
      }
      console.info(`[plan-execute] wave=${wave} 汇总探测报告结果不足，进入 replan 波次`);
      continue;
    }
    // 存在失败 / 元工具（tool_search 桥接）/ 交互式工具 → replan（带 schema，
    // 模型基于已有结果继续规划或直接给出最终回答）
  }

  // ── 兜底 SUMMARIZE：波次耗尽仍未收尾的工具链（无逃生门的最终汇总，流式输出）──
  const finalSummary = await runSchemaLessSummary(false);
  logPrefixCacheStats();
  // 出口自检（summary 路径，2026-09-05 统一）：波次已耗尽、且最终汇总仍未满足诉求
  // → 无预算续波，如实收尾（记录日志供观测；不再返回升级哨兵/整轮重放）。
  {
    const summaryUnsatisfiedReason = assessTurnUnsatisfied(finalSummary.text);
    if (summaryUnsatisfiedReason) {
      console.info(
        `[openai-tool-loop] summary 出口自检：${summaryUnsatisfiedReason}` +
          `（工具尝试 ${allToolExecResults.length} 次，成功实质 ${countSubstantiveOkResults()} 次）→ 预算耗尽，如实收尾`,
      );
    }
  }
  return finalSummary.text;

  /**
   * SUMMARIZE 阶段：单次不带工具 schema 的汇总调用（流式）。
   *
   * - 工具结果存在于 messages 的 tool 消息里；旧波工具链折叠为确定性摘要
   *   （SUMMARY_FOLD_DIGEST_CHARS），最近一波完整保留。汇总指令不再重复
   *   dump 工具结果，省一份 token。
   * - escapeAllowed=true 时为「充分性探测」：首行输出 NEED_MORE_TOOLS 表示
   *   结果不足以回答，调用方据此升级一次 replan。为避免标记透出到前端，
   *   首行（或前 48 字符）先缓冲，判定不是标记后才 flush 给 onDelta。
   * - 产出为空/道歉式 → 确定性回退到工具结果拼接（不额外调 LLM 重建）。
   * - 调用异常 → 同样回退到工具结果拼接，保证真实数据不丢。
   */
  async function runSchemaLessSummary(
    escapeAllowed: boolean,
  ): Promise<{ text: string; needMore: boolean }> {
    // summary 输出预算：跟随调用方的 maxOutputTokens（fast 主链路默认不设限），
    // 未配置时给 2000 兜底，保证多来源汇总有展开空间
    const summaryMaxTokens =
      options?.maxOutputTokens && options.maxOutputTokens > 0 ? options.maxOutputTokens : 2000;
    try {
      // 过滤无效 assistant message：OpenAI API 要求 assistant 消息必须有 content 或 tool_calls
      const sanitizedMessages = messages.filter((m) => {
        if (m.role !== "assistant") return true;
        const hasContent = typeof m.content === "string" && m.content.trim().length > 0;
        const hasToolCalls =
          Array.isArray((m as { tool_calls?: unknown }).tool_calls) &&
          ((m as { tool_calls?: unknown[] }).tool_calls?.length ?? 0) > 0;
        return hasContent || hasToolCalls;
      });

      // ① 旧波工具链折叠（2026-09-05）：多波任务此前把全部波次的工具结果原文
      // 完整重发给汇总调用（replan 后甚至重发两次）。现仅保留最近一波完整链，
      // 旧波折叠为 400 字符确定性摘要（工具名+结果要点，URL 安全截断）——
      // 比 replan 折叠（160）更长，保住跨波对比需要的关键数据。
      // 用户文本命中「指代早期对话」措辞时跳过折叠（与条数裁剪同一保护闸）。
      const foldAllowed = !(userText && SUMMARY_TRIM_REFERENCE_CUES.test(userText));
      const summaryBaseMessages = foldAllowed
        ? foldOldWaveToolChains(sanitizedMessages, SUMMARY_FOLD_DIGEST_CHARS)
        : sanitizedMessages;

      // ② summary 历史裁剪：只保留全部 system + 最近 N 个用户回合（含其后的全部工具链），
      // 丢弃更早纯对话。工具结果完整保留，最终回答的真实数据不丢；短对话为无操作。
      // 质量保护：当前用户文本命中指代早期对话的措辞（刚才/上面/继续等）时跳过裁剪。
      const trimmedMessages = trimHistoryForSummary(summaryBaseMessages, SUMMARY_KEEP_USER_TURNS, userText);

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

      // 零工具结果守卫（2026-08-28）：本轮没有任何工具执行（含搜索）时，
      // 明确告知 LLM 禁止虚构"已查询/已翻阅/公开渠道没查到"——假搜索回复的
      // 最后防线。正则门控（forced-tool）+ 强制联网兜底已在前置层拦住绝大多数，
      // 这里兜住漏网：模型在无任何证据下编造"查过了"的叙述。
      // 元工具兜底守卫（2026-08-29）：本轮只执行了 tool_discover / agent.query_capabilities
      // 这类"查工具目录"的元工具（或全部失败）时，LLM 手里的"工具结果"只有能力描述文本。
      // 若仍按"基于这些结果回答"引导，会产出"工具没返回内容，都是些功能说明"这种
      // 把机制话透给用户的回复（fast maxRounds=1 下是高发路径：发现→执行需两轮，单波必断头）。
      const substantiveToolResults = allToolExecResults.filter(
        (r) => !META_TOOL_NAMES.has(r.toolName) && r.ok,
      );
      const metaOnlyGuard =
        allToolExecResults.length > 0 && substantiveToolResults.length === 0
          ? `\n\n【重要】本轮只查询了工具目录/能力清单（或工具全部执行失败），没有拿到任何真实的外部内容。` +
            `严禁把工具说明、能力描述、参数列表当作查询结果复述给用户；` +
            `严禁说"工具没返回""都是些功能说明"这类暴露机制的话；也不要声称已经查到资料。` +
            `请基于对话上下文自然回应；若用户要的是需要真正查询才能拿到的信息，就照实说你得现查。`
          : "";
      const zeroToolGuard =
        allToolExecResults.length === 0
          ? `\n\n【重要】本轮没有执行任何工具或检索。严禁声称已经查询、搜索、翻阅过任何资料` +
            `（包括"翻了一圈""公开渠道没查到""据我了解最新消息"等说法）；` +
            `也不要编造任何具体信息来源。请直接说明本轮未获取到外部信息。`
          : "";
      // 求简指令只对真正的单一事实求证生效；其余一律要求把信息组织充分（2026-09-03：
      // 检索/任务型回复不再受「口语求简」约束，需按主题分节、可用 Markdown 排版）
      const singleFactClause = isDirectFactQuery(userText)
        ? `这是单一事实求证（是/否、一个数据点）：给「结论 + 1 句依据」即可，最多保留一个简短追问。`
        : `把检索到的信息组织充分：按主题分节，用 Markdown 小标题/加粗/表格排版，保留日期、数字、来源等细节，不要为了简短丢掉用户想看的内容。`;
      const baseDirective =
        (substantiveToolResults.length > 0
          ? `刚才调用工具拿到了以下结果，请基于这些结果回答用户的问题：语气自然像朋友，但内容要充分、结构清晰。` +
            `不要重复工具调用过程，直接给出结论。如果结果不完整，就给出能确定的部分。` +
            `同一事实不要换个说法再总结第二遍；${singleFactClause}`
          : `请基于本轮对话上下文，用自然、像朋友一样的语气回答用户的问题。`) +
        strategyBlock +
        zeroToolGuard +
        metaOnlyGuard;
      const escapeDirective = escapeAllowed
        ? `\n\n【重要】如果你认为现有工具结果不足以回答用户的问题（例如还需要抓取某个具体网页、` +
          `还需要换关键词再查一次），第一行只输出 ${NEED_MORE_TOOLS_MARKER}，不要输出任何其他内容。` +
          `能回答时直接回答，禁止输出该标记。`
        : "";
      const summaryMessages: ChatCompletionMessageParam[] = [
        ...trimmedMessages,
        { role: "user", content: baseDirective + escapeDirective },
      ];
      const summaryResp = await client.chat.completions.create({
        model,
        messages: summaryMessages,
        temperature: 0.5,
        // 输出上限跟随调用方配置；默认 2000 保证盘点/汇总类回答有充分展开空间。
        // 之前硬编码 800，把多来源汇总硬截成一小段，是「回复潦草」的直接原因之一
        // （主链路设计是默认不限 max_tokens，见 agent-core fastMaxOutputTokens 注释）。
        ...(summaryMaxTokens ? { max_tokens: summaryMaxTokens } : {}),
        stream: true,
      }, options?.signal ? { signal: options.signal } : undefined);

      let summaryText = "";
      let needMore = false;
      // 逃生模式下先缓冲首行（或前 48 字符）再决定是否推送给前端，防止标记透出
      let headDecided = !escapeAllowed;
      let pendingHead = "";
      const summaryConsumeResult = await consumeNormalizedStream(
        adaptOpenAiChatCompletionStream(
          summaryResp as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>,
        ),
        {
          onContentDelta: (d) => {
            summaryText += d;
            if (headDecided) {
              if (!needMore) onDelta(d);
              return;
            }
            pendingHead += d;
            const nl = pendingHead.indexOf("\n");
            if (nl >= 0 || pendingHead.trim().length >= 48) {
              headDecided = true;
              const firstLine = (nl >= 0 ? pendingHead.slice(0, nl) : pendingHead).trim();
              if (firstLine.startsWith(NEED_MORE_TOOLS_MARKER)) {
                needMore = true;
              } else {
                onDelta(pendingHead);
              }
              pendingHead = "";
            }
          },
          providerId: "openai-compatible",
          model,
        },
      );
      // 汇总调用同样计入前缀缓存统计（该调用无 schema，命中率反映「system+历史前缀」的缓存质量）
      accumulatePrefixCacheUsage(summaryConsumeResult.usage);
      // 流结束仍未触发首行判定（回答极短且无换行）
      if (!headDecided) {
        headDecided = true;
        if (pendingHead.trim().startsWith(NEED_MORE_TOOLS_MARKER)) {
          needMore = true;
        } else if (pendingHead) {
          onDelta(pendingHead);
        }
        pendingHead = "";
      }
      summaryText = summaryText.trim();
      // Token 用量审计：summary/探测调用统一并入 main_chat 环节，与规划轮次同一把尺子。
      // needMore 的探测也是一次真实 LLM 调用，必须计入（否则低估 token 消耗）。
      try {
        recordLlmUsageByChars({
          stage: "main_chat",
          sessionId: options?.audit?.sessionId,
          inputChars: JSON.stringify(summaryMessages).length,
          outputChars: summaryText.length,
          model,
        });
      } catch {
        /* 审计失败静默 */
      }
      if (needMore) {
        return { text: "", needMore: true };
      }
      if (summaryText && !isApologyStyleFallback(summaryText)) {
        return { text: summaryText, needMore: false };
      }
      // summary 调用成功但产出为空/道歉式 → 直接回退到工具结果拼接（保留真实数据，不额外调 LLM）。
      return { text: lastToolOutputFallback.trim(), needMore: false };
    } catch (summaryErr) {
      console.log(
        `[plan-execute] summary 调用失败，回退到工具结果拼接: ${
          summaryErr instanceof Error ? summaryErr.message : String(summaryErr)
        }`,
      );
      return { text: lastToolOutputFallback.trim(), needMore: false };
    }
  }
}
