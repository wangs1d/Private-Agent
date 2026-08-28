import { createHash } from "node:crypto";

import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";

import { finalizeChatSystemPrompt, type FinalizeChatSystemPromptOpts } from "../agent/prompt-builder.js";
import { assembleSystemPrompt } from "../agent/prompt-assembler.js";
import type { AgentPromptMemoryContext } from "./types.js";

export type PrefixCacheRequest = {
  prompt_cache_key: string;
  prompt_cache_retention?: "24h";
};

export type PromptCacheMode = "none" | "explicit-key" | "implicit-prefix";

export type PromptCacheProfile = {
  mode: PromptCacheMode;
  namespace: string;
  supportsRetention24h?: boolean;
};

export type PreparePromptCachePlanArgs = {
  providerId: string;
  model: string;
  baseSystemPrompt: string;
  memory?: AgentPromptMemoryContext;
  finalizeOptions?: FinalizeChatSystemPromptOpts;
  tools?: ChatCompletionTool[];
  variant?: string;
};

export type PreparedPromptCachePlan = {
  profile: PromptCacheProfile;
  fullSystemPrompt: string;
  requestSystemMessages: ChatCompletionMessageParam[];
  /** 需要沉底注入到「最新 user 消息尾部」的 volatile 动态上下文（记忆/时间/意图等）。 */
  tailDynamicContext?: string;
  promptCache?: PrefixCacheRequest;
};

const DEFAULT_NAMESPACE = "private-ai-agent-system-prompt-v1";

function envEnabled(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name]?.trim();
  if (!raw) return defaultValue;
  return !["0", "false", "off", "no"].includes(raw.toLowerCase());
}

function includeToolsInPromptCacheKey(): boolean {
  return envEnabled("OPENAI_PROMPT_CACHE_KEY_INCLUDE_TOOLS", false);
}

function stableToolSignature(tools?: ChatCompletionTool[]): string {
  if (!tools?.length || !includeToolsInPromptCacheKey()) return "";
  return JSON.stringify(
    tools.map((tool) => {
      if (tool.type !== "function") return tool;
      return {
        type: tool.type,
        function: {
          name: tool.function?.name ?? "",
          description: tool.function?.description ?? "",
          parameters: tool.function?.parameters ?? null,
        },
      };
    }),
  );
}

function supportsOpenAiPromptCacheRetention(model: string): boolean {
  return (
    model.startsWith("gpt-5") ||
    model.startsWith("gpt-4.1") ||
    model === "gpt-5.1-chat-latest"
  );
}

function resolvePromptCacheProfile(providerId: string, model: string): PromptCacheProfile {
  const normalized = providerId.trim().toLowerCase();

  if (normalized === "openai") {
    return {
      mode: envEnabled("OPENAI_PREFIX_CACHE_ENABLED", true) ? "explicit-key" : "none",
      namespace: process.env.OPENAI_PROMPT_CACHE_NAMESPACE?.trim() || DEFAULT_NAMESPACE,
      supportsRetention24h: supportsOpenAiPromptCacheRetention(model),
    };
  }

  if (normalized === "moonshot-kimi" || normalized === "moonshot" || normalized === "kimi") {
    return {
      mode: envEnabled("MOONSHOT_PREFIX_CACHE_ENABLED", true) ? "implicit-prefix" : "none",
      namespace: process.env.MOONSHOT_PROMPT_CACHE_NAMESPACE?.trim() || DEFAULT_NAMESPACE,
    };
  }

  return {
    mode: envEnabled("EXTERNAL_MODEL_PREFIX_CACHE_ENABLED", true) ? "implicit-prefix" : "none",
    namespace: process.env.EXTERNAL_MODEL_PROMPT_CACHE_NAMESPACE?.trim() || DEFAULT_NAMESPACE,
  };
}

function resolvePromptCacheRetention(profile: PromptCacheProfile): "24h" | undefined {
  const raw = process.env.OPENAI_PROMPT_CACHE_RETENTION?.trim();
  if (!raw) return undefined;
  if (raw !== "24h") {
    console.warn(
      `[prefix-cache] Ignoring unsupported OPENAI_PROMPT_CACHE_RETENTION=${raw}. Expected "24h".`,
    );
    return undefined;
  }
  return profile.supportsRetention24h ? "24h" : undefined;
}

function buildStableSystemPrompt(
  baseSystemPrompt: string,
  memory: AgentPromptMemoryContext | undefined,
  finalizeOptions: FinalizeChatSystemPromptOpts | undefined,
): { fullSystemPrompt: string; stableSystemPrompt: string; dynamicSystemPrompt?: string } {
  // 单一出口：finalize（规则后缀）→ assemble（全局规则 + stable/dynamic 分层）一次完成。
  // 旧版在此处连调 finalize + Sections + buildLayeredSystemPrompt 三次重复渲染。
  const finalizedBaseSystem = finalizeChatSystemPrompt(baseSystemPrompt, finalizeOptions);
  return assembleSystemPrompt(finalizedBaseSystem, memory);
}

function buildPromptCacheKey(args: {
  profile: PromptCacheProfile;
  model: string;
  stableSystemPrompt: string;
  tools?: ChatCompletionTool[];
  variant?: string;
}): string {
  const hash = createHash("sha256");
  hash.update(args.profile.namespace);
  hash.update("\nprovider-mode:");
  hash.update(args.profile.mode);
  hash.update("\nmodel:");
  hash.update(args.model);
  hash.update("\nvariant:");
  hash.update(args.variant ?? "chat");
  hash.update("\nstable-system:");
  hash.update(args.stableSystemPrompt);
  hash.update("\ntools:");
  hash.update(stableToolSignature(args.tools));
  return `${args.profile.namespace}:${hash.digest("hex").slice(0, 32)}`;
}

export function preparePromptCachePlan(
  args: PreparePromptCachePlanArgs,
): PreparedPromptCachePlan {
  const profile = resolvePromptCacheProfile(args.providerId, args.model);
  const { fullSystemPrompt, stableSystemPrompt, dynamicSystemPrompt } = buildStableSystemPrompt(
    args.baseSystemPrompt,
    args.memory,
    args.finalizeOptions,
  );

  // P0-2 前缀稳定化：requestSystemMessages 只保留静态 system（stable）——
  // volatile 动态上下文（记忆图联想检索/当前时间/意图理解等）不再作为独立 system
  // 放在请求头部（任何记忆变化都会使整段前缀缓存失效），改经 tailDynamicContext
  // 沉底注入到「最新 user 消息尾部」。DeepSeek 等 provider 的自动 prefix cache
  // 因此能命中稳定的 system+历史对话前缀，只有尾部动态增量产生新的缓存放量。
  const requestSystemMessages: ChatCompletionMessageParam[] = [
    { role: "system", content: stableSystemPrompt },
  ];

  const promptCache =
    profile.mode === "explicit-key"
      ? {
          prompt_cache_key: buildPromptCacheKey({
            profile,
            model: args.model,
            stableSystemPrompt,
            tools: args.tools,
            variant: args.variant,
          }),
          ...(resolvePromptCacheRetention(profile)
            ? { prompt_cache_retention: resolvePromptCacheRetention(profile) }
            : {}),
        }
      : undefined;

  return {
    profile,
    fullSystemPrompt,
    requestSystemMessages,
    tailDynamicContext: dynamicSystemPrompt,
    promptCache,
  };
}

/** 沉底块的包裹标签：让 LLM 明确这是本轮系统注入的上下文，而非用户消息正文。 */
const DYNAMIC_CONTEXT_WRAP_BEGIN = "[system-context]";
const DYNAMIC_CONTEXT_WRAP_END = "[/system-context]";

function wrapTailDynamicContext(tail: string): string {
  return (
    `\n\n${DYNAMIC_CONTEXT_WRAP_BEGIN}\n` +
    `（本轮系统注入的上下文：记忆/时间/任务等，非用户消息正文，按 system 指令同等遵循）\n` +
    `${tail}\n${DYNAMIC_CONTEXT_WRAP_END}`
  );
}

/** 找到最新一条 user 消息（从尾部向前扫）；无 user 消息返回 null。 */
function findLastUserMessage(
  messages: ChatCompletionMessageParam[],
): ChatCompletionMessageParam | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg && msg.role === "user") return msg;
  }
  return null;
}

/**
 * 把 volatile 动态上下文沉底注入到「最新 user 消息尾部」，返回克隆后的消息数组。
 * - string content：追加一行包裹标签文本
 * - content parts 数组：追加一个 text part（保留 image_url 等既有 part）
 * - 找不到 user 消息（极罕见）：回退为附加到 system 之后，兼容旧行为，不丢语义
 *
 * 只克隆被修改的 user 消息，绝不改写调用方持有的 thread 消息对象（防污染会话历史）。
 */
export function applyTailDynamicContext(
  messages: ChatCompletionMessageParam[],
  tailDynamicContext: string,
): ChatCompletionMessageParam[] {
  if (!tailDynamicContext) return messages;
  const lastUser = findLastUserMessage(messages);
  if (!lastUser) {
    return [...messages, { role: "system", content: tailDynamicContext }];
  }
  // 只克隆被修改的 user 消息，绝不改写调用方持有的 thread 消息对象（防污染会话历史）。
  return messages.map(
    // TS 断言返回值：openai v6 的 content part 类型组合在 spread 后会被 TS 展成
    // 带 refusal/developer 的过宽并集，运行时内容本身仍是合法 text part。
    (msg): ChatCompletionMessageParam => {
      if (msg !== lastUser) return msg;
      const wrapped = wrapTailDynamicContext(tailDynamicContext);
      if (typeof msg.content === "string") {
        return { ...msg, content: `${msg.content}${wrapped}` };
      }
      if (Array.isArray(msg.content)) {
        const parts = msg.content as Array<
          Record<string, unknown> & { type?: string; text?: string; refusal?: string }
        >;
        return {
          ...msg,
          content: [...parts, { type: "text", text: wrapped }],
        } as ChatCompletionMessageParam;
      }
      return msg;
    },
  ) as ChatCompletionMessageParam[];
}

export function applyPromptCacheMessages(
  messages: ChatCompletionMessageParam[],
  requestSystemMessages: ChatCompletionMessageParam[],
  tailDynamicContext?: string,
): ChatCompletionMessageParam[] {
  if (messages.length === 0) return [...requestSystemMessages];
  if (messages[0]?.role !== "system") {
    const base = [...requestSystemMessages, ...messages];
    return tailDynamicContext ? applyTailDynamicContext(base, tailDynamicContext) : base;
  }
  const base = [...requestSystemMessages, ...messages.slice(1)];
  return tailDynamicContext ? applyTailDynamicContext(base, tailDynamicContext) : base;
}
