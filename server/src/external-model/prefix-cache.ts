import { createHash } from "node:crypto";

import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";

import {
  buildLayeredSystemPrompt,
  buildLayeredSystemPromptSections,
  finalizeChatSystemPrompt,
  type FinalizeChatSystemPromptOpts,
} from "../agent/prompt-builder.js";
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
  const finalizedBaseSystem = finalizeChatSystemPrompt(baseSystemPrompt, finalizeOptions);
  const { stablePrefix, dynamicContext } = buildLayeredSystemPromptSections(memory);
  const fullSystemPrompt = buildLayeredSystemPrompt(finalizedBaseSystem, memory);

  if (stablePrefix.length === 0 && dynamicContext.length === 0) {
    return {
      fullSystemPrompt,
      stableSystemPrompt: finalizedBaseSystem,
    };
  }

  const stableSystemPrompt = [finalizedBaseSystem, ...stablePrefix].join("\n\n").trim();
  const dynamicSystemPrompt = dynamicContext.join("\n\n").trim() || undefined;

  return {
    fullSystemPrompt,
    stableSystemPrompt,
    dynamicSystemPrompt,
  };
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

  const requestSystemMessages: ChatCompletionMessageParam[] = [
    { role: "system", content: stableSystemPrompt },
    ...(profile.mode !== "none" && dynamicSystemPrompt
      ? [{ role: "system", content: dynamicSystemPrompt } satisfies ChatCompletionMessageParam]
      : []),
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
    promptCache,
  };
}

export function applyPromptCacheMessages(
  messages: ChatCompletionMessageParam[],
  requestSystemMessages: ChatCompletionMessageParam[],
): ChatCompletionMessageParam[] {
  if (messages.length === 0) return [...requestSystemMessages];
  if (messages[0]?.role !== "system") return [...requestSystemMessages, ...messages];
  return [...requestSystemMessages, ...messages.slice(1)];
}
