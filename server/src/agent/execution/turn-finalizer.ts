import type { BrainCenter } from "../../brain/index.js";
import type { AgentReply } from "../types.js";
import { getRuntimeKernel } from "../runtime-kernel.js";
import { TurnLifecycle } from "../turn-lifecycle.js";
import type { TaskExecutionPlan } from "../plan-execute-loop.js";
import type { ExternalChatProvider } from "../../external-model/types.js";
import type { ShortTermMemoryGatewayService } from "../../services/short-term-memory-gateway.js";
import type { TrajectorySkillPromotionService } from "../../services/trajectory-skill-promotion-service.js";

export type FinishTurnMeta = {
  streamedChunks: boolean;
  modelCallsConsumed: number;
  planExecuteUsed: boolean;
  pePlan: TaskExecutionPlan | null;
  peExhausted: boolean;
  trajCap: ReturnType<TrajectorySkillPromotionService["beginCapture"]> | undefined;
  messageId?: string;
  sessionId?: string;
};

export type TurnFinalizerDeps = {
  provider: ExternalChatProvider | null;
  turnLifecycle: TurnLifecycle;
  shortTermMemoryGateway: ShortTermMemoryGatewayService | null;
  getBrainCenter: () => BrainCenter | null;
};

export class TurnFinalizer {
  constructor(private readonly deps: TurnFinalizerDeps) {}

  async finish(
    actorId: string,
    userText: string,
    assistantText: string,
    meta: FinishTurnMeta,
    onAssistantDelta?: (delta: string) => void,
  ): Promise<AgentReply> {
    const outputSafety = this.deps.getBrainCenter()?.checkOutputSafety(assistantText, {
      actorId,
      sessionId: meta.sessionId,
      userText,
    });
    let sanitizedOutput = outputSafety?.sanitized ?? assistantText;

    const runtimeKernel = getRuntimeKernel(actorId);
    if (runtimeKernel.isMinimalMode()) {
      const postResult = runtimeKernel.postValidate(sanitizedOutput);
      if (!postResult.ok) {
        console.warn(
          `[RuntimeKernel.postValidate] output matched ${postResult.hitPatterns.length} rule(s):`,
          postResult.violations,
        );
      }
    }

    const trimmed = sanitizedOutput.trim();
    if (!trimmed) {
      const regenerated = await this.regenerateEmptyReply(actorId, userText, onAssistantDelta);
      return {
        text: regenerated,
        streamedChunks: regenerated ? meta.streamedChunks : false,
      };
    }

    TurnLifecycle.finalizeTrajectory(meta.trajCap, trimmed, {
      planExecuteUsed: meta.planExecuteUsed,
      modelCallsApprox: meta.modelCallsConsumed,
      pePlan: meta.pePlan,
      peExhausted: meta.peExhausted,
    });

    const { quotaSuffix } = this.deps.turnLifecycle.finalizeTurn({
      actorId,
      userText,
      assistantText: trimmed,
      sessionId: meta.sessionId,
      modelCallsConsumed: meta.modelCallsConsumed,
      planExecuteUsed: meta.planExecuteUsed,
      pePlan: meta.pePlan,
      peExhausted: meta.peExhausted,
      messageId: meta.messageId,
    });

    if (this.deps.shortTermMemoryGateway && meta.sessionId) {
      this.deps.shortTermMemoryGateway.reconcileTaskAfterTurn(meta.sessionId, userText, trimmed);
    }

    return {
      text: quotaSuffix ? `${trimmed}\n\n${quotaSuffix}` : trimmed,
      streamedChunks: meta.streamedChunks,
    };
  }

  private async regenerateEmptyReply(
    actorId: string,
    userText: string,
    onAssistantDelta?: (delta: string) => void,
  ): Promise<string> {
    try {
      const provider = this.deps.provider;
      if (!provider?.isEnabled()) return "";
      console.warn("[TurnFinalizer] received empty output, regenerating once");
      const regenerateText = await provider.streamCompletion(
        `regen-${actorId}-${Date.now()}`,
        {
          text:
            `${userText}\n\n` +
            "[system hint: the previous turn produced no response text; answer the user directly in natural language]",
        },
        (delta) => onAssistantDelta?.(delta),
        undefined,
        {
          ephemeralTurn: true,
          disableThinking: true,
          maxThreadMessages: 4,
        },
      );
      return regenerateText.trim();
    } catch (err) {
      console.error("[TurnFinalizer] regeneration failed", err);
      return "";
    }
  }
}
