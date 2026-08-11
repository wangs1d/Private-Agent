import type { AgentStreamOptions, ToolLoopAfterBatchInfo } from "../../external-model/types.js";
import { getFastLaneTools } from "../../external-model/openai-compatible-tool-loop.js";
import type { PromptContextBuilder } from "../prompt-context-builder.js";
import type { PersonalizationPromptSlice } from "../../services/user-personalization/user-personalization-service.js";
import type { LlmExecutionMode } from "../task-router.js";
import { getRuntimeKernel } from "../runtime-kernel.js";
import { TaskTier, buildModelOverrideOpts } from "../../config/model-routing.js";
import type { MetacogAssessment } from "../../brain/meta-cognition-cortex.js";
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
  cognitiveMetacog?: MetacogAssessment;
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
            userLocation: undefined,
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

    this.applyCognitiveHints(baseStreamOpts, input.cognitiveMetacog, input.cognitiveEmotion);

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
    metacog: MetacogAssessment | undefined,
    emotion: EmotionVector | null | undefined,
  ): void {
    const memory = streamOpts.promptContext?.memory;
    if (!memory || (!metacog && !emotion)) return;

    if (metacog && (metacog.shouldReflect || metacog.confidence < 0.7)) {
      const markers = metacog.uncertaintyMarkers.slice(0, 2).join("; ");
      const direction = metacog.shouldReflect ? "reflect briefly before answering" : "state uncertain points clearly";
      memory.metaCognition = `confidence=${metacog.confidence.toFixed(2)}; ${direction}${markers ? `; ${markers}` : ""}`;
    }

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
