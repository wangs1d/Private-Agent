import type { WorldService } from "@private-ai-agent/agent-world";
import type { ChatCompletionTool } from "openai/resources/chat/completions";

import {
  buildAgentCoreCapabilityPromptSection,
  buildAgentWorldPromptSection,
} from "./agent-capabilities.js";
import { getAgentRuntimeConfig } from "./agent-runtime-config.js";
import {
  sliceMemoryEntriesToPromptContext,
} from "./prompt-builder.js";
import { buildTaskContextPrompt } from "./task-context.js";
import { buildMasterAgentChatTools, buildSubAgentChatTools } from "../services/master-agent-tool-filter.js";
import { buildSessionSkillChatTools } from "../skills/skill-openai-bridge.js";
import type { SkillManager } from "../skills/index.js";
import type { SubAgentCapability } from "../services/master-agent-types.js";
import type { AgentMemorySyncService } from "../services/agent-memory-sync-service.js";
import type { VirtualPhoneService } from "../services/virtual-phone-service.js";
import type {
  AgentPromptMemoryContext,
  AgentStreamOptions,
  ToolLoopAfterBatchInfo,
} from "../external-model/types.js";

export type BuildPromptContextInput = {
  actorId: string;
  userText?: string;
  narrativeRecall?: string;
  interruptedContext?: string;
  /** 基于 IP 解析的用户位置说明（注入 system prompt） */
  userLocation?: string;
  onToolLoopAfterBatch?: (info: ToolLoopAfterBatchInfo) => void;
};

export type BuildMasterDelegateInput = BuildPromptContextInput & {
  subAgentCapabilities: Iterable<SubAgentCapability>;
};

export type BuildSubAgentInput = BuildPromptContextInput & {
  capability: SubAgentCapability;
};

/**
 * 统一的 system prompt / stream 选项组装，供标准路径与主 Agent 路径复用。
 */
export class PromptContextBuilder {
  constructor(
    private readonly deps: {
      agentMemorySyncService: AgentMemorySyncService | null;
      worldService: WorldService | null;
      skillManager: SkillManager | null;
      virtualPhoneService: VirtualPhoneService | null;
    },
  ) {}

  build(input: BuildPromptContextInput): AgentStreamOptions | undefined {
    const memory = this.assembleMemory(input);
    const hasMemory = this.hasMemoryContent(memory);
    const chatToolsExtra = this.sessionSkillTools(input.actorId);
    const toolLoop =
      input.onToolLoopAfterBatch != null
        ? { onAfterToolBatch: input.onToolLoopAfterBatch }
        : undefined;

    if (!hasMemory && !toolLoop && (!chatToolsExtra || chatToolsExtra.length === 0)) {
      return undefined;
    }

    return {
      ...(hasMemory ? { promptContext: { memory } } : {}),
      ...(toolLoop ? { toolLoop } : {}),
      ...(chatToolsExtra?.length ? { chatToolsExtra } : {}),
    };
  }

  buildForMasterDelegate(input: BuildMasterDelegateInput): AgentStreamOptions {
    const base = this.build(input) ?? {};
    const chatToolsExtra = base.chatToolsExtra ?? [];
    return {
      ...base,
      masterSubAgentDelegate: true,
      chatToolsBuiltin: buildMasterAgentChatTools(input.subAgentCapabilities, chatToolsExtra),
      chatToolsExtra: [],
    };
  }

  buildForSubAgent(input: BuildSubAgentInput): AgentStreamOptions {
    const base = this.build(input) ?? {};
    const scopedBuiltin = buildSubAgentChatTools(input.capability.tools, base.chatToolsExtra);
    return {
      ...base,
      chatToolsBuiltin: scopedBuiltin,
      chatToolsExtra: [],
    };
  }

  private assembleMemory(input: BuildPromptContextInput): AgentPromptMemoryContext {
    const config = getAgentRuntimeConfig();
    let fromKv: AgentPromptMemoryContext = {};
    const memoryKeys = config.memoryPrompt.promptMemoryKeys;
    if (this.deps.agentMemorySyncService && memoryKeys && memoryKeys.length > 0) {
      const { entries } = this.deps.agentMemorySyncService.getSnapshot(input.actorId, memoryKeys);
      fromKv = sliceMemoryEntriesToPromptContext(entries);
    }

    let agentCaps: string | undefined;
    let worldCaps: string | undefined;
    if (this.deps.skillManager && config.memoryPrompt.worldCapsInPrompt) {
      agentCaps = buildAgentCoreCapabilityPromptSection(
        this.deps.skillManager,
        this.deps.virtualPhoneService ?? undefined,
        input.actorId,
      );
      if (this.deps.worldService) {
        worldCaps = buildAgentWorldPromptSection(
          input.actorId,
          this.deps.worldService,
          this.deps.skillManager,
        );
      }
    }

    let interruptedCtx: string | undefined;
    if (input.interruptedContext?.trim()) {
      interruptedCtx = `【用户打断了之前的回复，以下是被打断的内容，请在回答时考虑这些上下文】\n${input.interruptedContext.trim()}`;
    }

    return {
      ...fromKv,
      ...(config.memoryPrompt.taskContextInPrompt && input.userText?.trim()
        ? { taskContext: buildTaskContextPrompt(input.userText) }
        : {}),
      ...(agentCaps ? { agentCaps } : {}),
      ...(worldCaps ? { worldCaps } : {}),
      ...(input.narrativeRecall ? { narrativeRecall: input.narrativeRecall } : {}),
      ...(input.userLocation ? { userLocation: input.userLocation } : {}),
      ...(interruptedCtx ? { interruptedContext: interruptedCtx } : {}),
    };
  }

  private hasMemoryContent(memory: AgentPromptMemoryContext): boolean {
    return (
      Boolean(memory.persona) ||
      Boolean(memory.values) ||
      Boolean(memory.abilities) ||
      Boolean(memory.memorySummary) ||
      Boolean(memory.agentCaps) ||
      Boolean(memory.worldCaps) ||
      Boolean(memory.narrativeRecall) ||
      Boolean(memory.interruptedContext) ||
      Boolean(memory.userLocation) ||
      Boolean(memory.taskContext)
    );
  }

  private sessionSkillTools(actorId: string): ChatCompletionTool[] | undefined {
    if (!this.deps.worldService || !this.deps.skillManager) return undefined;
    const tools = buildSessionSkillChatTools(actorId, this.deps.worldService, this.deps.skillManager);
    return tools.length ? tools : undefined;
  }
}
