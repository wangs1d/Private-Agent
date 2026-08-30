import type { AgentStreamOptions, ToolLoopAfterBatchInfo } from "../../external-model/types.js";
import { getFastLaneTools } from "../../external-model/openai-compatible-tool-loop.js";
import type { PromptContextBuilder } from "../prompt-context-builder.js";
import type { PersonalizationPromptSlice } from "../../services/user-personalization/user-personalization-service.js";
import type { LlmExecutionMode } from "../task-router.js";
import { getRuntimeKernel } from "../runtime-kernel.js";
import { TaskTier, buildModelOverrideOpts } from "../../config/model-routing.js";
import type { EmotionVector } from "../../brain/types.js";
import type { ToolPlan } from "../../brain/tool-planning-cortex.js";

export type BuildStreamOptionsInput = {
  actorId: string;
  sessionId: string;
  text: string;
  mode: LlmExecutionMode;
  promptContextBuilder: PromptContextBuilder;
  narrativeRecall?: string;
  interruptedContext?: string;
  userLocation?: string;
  personalization: PersonalizationPromptSlice;
  onToolLoopAfterBatch?: (info: ToolLoopAfterBatchInfo) => void;
  userPattern?: {
    topics: string[];
    preferredToolDomain?: string;
    negativeFeedbackCount: number;
    learningActive?: boolean;
  };
  toolPlan?: ToolPlan;
  toolExposureProfile: AgentStreamOptions["toolExposureProfile"];
  toolRankingHint: AgentStreamOptions["toolRankingHint"];
  cognitiveEmotion?: EmotionVector | null;
  signal?: AbortSignal;
};

export class StreamOptionsBuilder {
  build(input: BuildStreamOptionsInput): AgentStreamOptions {
    const isFast = input.mode === "fast";
    const baseStreamOpts: AgentStreamOptions = isFast
      ? ({
          ...(input.promptContextBuilder.build({
            actorId: input.actorId,
            sessionId: input.sessionId,
            userText: input.text,
            narrativeRecall: input.narrativeRecall,
            interruptedContext: input.interruptedContext,
            // 2026-08-20 修复：fast 分支此前强制 userLocation=undefined,导致 LLM 看不到
            // 用户位置,天气类问题在第二句(正文)返回「没拿到定位」。改为复用
            // input.userLocation(对齐 agent-core.ts:2078 runStandardLlmPath fast 分支)。
            // 没有位置时值仍为 undefined,promptContextBuilder 内部已做空值过滤。
            userLocation: input.userLocation,
            personalization: input.personalization,
            onToolLoopAfterBatch: undefined,
            userPattern: input.userPattern,
            toolPlan: input.toolPlan,
          }) ?? {}),
          chatToolsBuiltin: getFastLaneTools(),
          chatToolsExtra: [],
          toolExposureProfile: input.toolExposureProfile,
          toolRankingHint: input.toolRankingHint,
        } satisfies AgentStreamOptions)
      : {
          ...(input.promptContextBuilder.build({
            actorId: input.actorId,
            sessionId: input.sessionId,
            userText: input.text,
            narrativeRecall: input.narrativeRecall,
            interruptedContext: input.interruptedContext,
            userLocation: input.userLocation,
            personalization: input.personalization,
            onToolLoopAfterBatch: input.onToolLoopAfterBatch,
            userPattern: input.userPattern,
            toolPlan: input.toolPlan,
          }) ?? {}),
          toolExposureProfile: input.toolExposureProfile,
          toolRankingHint: input.toolRankingHint,
        };

    this.applyCognitiveHints(baseStreamOpts, input.cognitiveEmotion);

    const runtimeKernel = getRuntimeKernel(input.actorId);
    const runtimePlan = runtimeKernel.planTurn(input.text, baseStreamOpts.promptContext?.memory);
    const sanitizedMemory = runtimeKernel.sanitizePromptMemory(
      baseStreamOpts.promptContext?.memory,
      runtimePlan,
    );
    const isMinimalMode = runtimeKernel.isMinimalMode();
    const tierForMode: Record<LlmExecutionMode, TaskTier> = {
      fast: TaskTier.FAST,
      complex: TaskTier.COMPLEX,
    };

    return {
      ...baseStreamOpts,
      ...(sanitizedMemory ? { promptContext: { memory: sanitizedMemory } } : { promptContext: undefined }),
      ...(runtimePlan.promptMode === "conversation_only"
        ? {
            systemPromptOverride:
              "You are a helpful, safe assistant. Reply in the user's language. Follow the current user request and conversation context.",
          }
        : {}),
      ...(isMinimalMode
        ? {
            systemPromptOverride: runtimeKernel.buildSessionSystem() ?? undefined,
            suppressRuntimeSuffixes: true,
            functionalSuffixes: runtimePlan.functionalSuffixes !== false,
          }
        : {}),
      toolExposureProfile: runtimePlan.toolExposureProfile ?? baseStreamOpts.toolExposureProfile,
      pinnedToolNames: runtimePlan.enabled
        ? [...(baseStreamOpts.pinnedToolNames ?? []), ...runtimePlan.pinnedToolNames]
        : baseStreamOpts.pinnedToolNames,
      ...(isFast
        ? {
            toolLoop: {
              ...(baseStreamOpts.toolLoop ?? {}),
              maxRounds: 1,
            },
          }
        : baseStreamOpts.toolLoop
          ? { toolLoop: baseStreamOpts.toolLoop }
          : {}),
      maxThreadMessages: runtimePlan.promptMode === "conversation_only"
        ? Number.parseInt(process.env.AGENT_RUNTIME_KERNEL_MAX_THREAD_MESSAGES ?? "12", 10)
        : baseStreamOpts.maxThreadMessages,
      ...(input.signal ? { signal: input.signal } : {}),
      ...buildModelOverrideOpts(tierForMode[input.mode]),
    };
  }

  private applyCognitiveHints(
    streamOpts: AgentStreamOptions,
    emotion: EmotionVector | null | undefined,
  ): void {
    const memory = streamOpts.promptContext?.memory;
    if (!memory || !emotion) return;

    if (emotion) {
      const { valence, arousal } = emotion;
      if (valence < -0.3 || valence > 0.5 || arousal > 0.7) {
        const tone =
          valence < -0.5
            ? "keep the reply short and gentle"
            : valence < -0.3
              ? "use a warmer tone"
              : valence > 0.5
                ? "allow a more lively tone"
                : arousal > 0.7
                  ? "avoid sounding rushed"
                  : "";
        memory.emotionState = `emotion=${emotion.label}${tone ? `; ${tone}` : ""}`;
      }
    }
  }
}
