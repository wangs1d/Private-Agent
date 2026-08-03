import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { encodingForModel } from "js-tiktoken";

import { BrainCenter } from "../src/brain/brain-center.js";
import { PromptContextBuilder } from "../src/agent/prompt-context-builder.js";
import {
  buildLayeredSystemPrompt,
  finalizeChatSystemPrompt,
} from "../src/agent/prompt-builder.js";
import { RuntimeKernel, type RuntimeKernelPromptMode } from "../src/agent/runtime-kernel.js";
import { resolveChatToolPlanForStream } from "../src/external-model/resolve-chat-tools.js";
import type { AgentPromptMemoryContext, AgentStreamOptions } from "../src/external-model/types.js";

const MODEL = "gpt-4o";
const ACTOR_ID = "session-mvp-001";
const BASE_SYSTEM_PROMPT =
  "You are a helpful, safe assistant. Respond in the same language the user uses when appropriate (Chinese or English). Refuse requests involving illegal or harmful content.";

type AgentMemoryEntries = Record<string, unknown>;
type PromptSlice = {
  name: string;
  text: string;
};

class FakeMemorySyncService {
  constructor(private readonly entriesByActor: Record<string, AgentMemoryEntries>) {}

  getSnapshot(actorId: string, _keys: string[]): { revision: number; entries: AgentMemoryEntries } {
    return { revision: 0, entries: this.entriesByActor[actorId] ?? {} };
  }
}

function tokenCount(text: string): number {
  const enc = encodingForModel(MODEL);
  try {
    return enc.encode(text).length;
  } finally {
    enc.free?.();
  }
}

async function readJson<T>(path: string): Promise<T> {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as T;
}

async function readJsonFromKnownDataPaths<T>(filename: string): Promise<T> {
  const candidates = [
    join(process.cwd(), "server", "data", filename),
    join(process.cwd(), "data", filename),
  ];
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return await readJson<T>(candidate);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function collectMemorySlices(memory?: AgentPromptMemoryContext): PromptSlice[] {
  if (!memory) return [];
  return Object.entries(memory)
    .filter(([, value]) => typeof value === "string" && value.trim().length > 0)
    .map(([name, text]) => ({ name, text: String(text) }));
}

function createRuntimeKernel(mode: RuntimeKernelPromptMode): RuntimeKernel {
  const kernel = new RuntimeKernel();
  kernel.update({
    enabled: true,
    promptMode: mode,
  });
  return kernel;
}

async function main(): Promise<void> {
  const memoryData = await readJsonFromKnownDataPaths<{
    sessions: Record<string, { entries: AgentMemoryEntries }>;
  }>("agent-memory-sync.json");
  const entries = memoryData.sessions[ACTOR_ID]?.entries;
  if (!entries) {
    throw new Error(`No memory entries found for ${ACTOR_ID}`);
  }

  const builder = new PromptContextBuilder({
    agentMemorySyncService: new FakeMemorySyncService({ [ACTOR_ID]: entries }) as never,
    worldService: null,
    skillManager: null,
    virtualPhoneService: null,
    scheduleTaskService: null,
    shortTermMemoryGateway: null,
  });

  const userText = "帮我搜索一下今天的 AI 新闻，然后看看我今天的日程安排";
  const built = builder.build({
    actorId: ACTOR_ID,
    sessionId: ACTOR_ID,
    userText,
    narrativeRecall: "用户最近在追踪 AI 行业新闻，并且今天有多个会议安排。",
    personalization: {
      toneGuidance: "简洁、自然、像熟人聊天。",
      userProfile: "用户偏好先给结论，再补必要细节。",
      relationshipGuidance: "保持贴近、不过度客套。",
    },
  });

  const baseMemory = built?.promptContext?.memory;
  if (!baseMemory) {
    throw new Error("PromptContextBuilder returned no prompt memory; test cannot continue.");
  }

  const baselinePrompt = finalizeChatSystemPrompt(
    buildLayeredSystemPrompt(BASE_SYSTEM_PROMPT, baseMemory),
    {
      tools: true,
      agentAccessMode: "full",
      desktopBridgeOnline: true,
      phoneBridgeOnline: true,
    },
  );
  const baselineTools = resolveChatToolPlanForStream(userText, {
    ...(built ?? {}),
    toolExposureProfile: "contextual",
    agentAccessMode: "full",
    desktopBridgeOnline: true,
    phoneBridgeOnline: true,
  }).visibleTools;
  const baselineToolsNoDesktopPins = resolveChatToolPlanForStream(userText, {
    ...(built ?? {}),
    toolExposureProfile: "contextual",
    agentAccessMode: "sandbox",
    desktopBridgeOnline: false,
    phoneBridgeOnline: false,
  }).visibleTools;

  const brainCenter = new BrainCenter();

  console.log("=".repeat(80));
  console.log("RuntimeKernel effectiveness check");
  console.log("=".repeat(80));
  console.log(`User text: ${userText}`);
  console.log(`Legacy prompt tokens: ${tokenCount(baselinePrompt)}`);
  console.log(`Legacy visible tools: ${baselineTools.length}`);
  console.log(`Legacy visible tools (without desktop auto-pins): ${baselineToolsNoDesktopPins.length}`);
  console.log("");

  for (const mode of ["dynamic", "conversation_only"] as const) {
    const kernel = createRuntimeKernel(mode);
    brainCenter.registerRuntimeKernel(kernel);
    const turnPlan = kernel.planTurn(userText, baseMemory);
    const sanitizedMemory = kernel.sanitizePromptMemory(baseMemory, turnPlan);
    const streamOpts: AgentStreamOptions = {
      ...(built ?? {}),
      promptContext: sanitizedMemory ? { memory: sanitizedMemory } : undefined,
      toolExposureProfile: turnPlan.toolExposureProfile ?? "contextual",
      pinnedToolNames: turnPlan.pinnedToolNames,
      agentAccessMode: "full",
      desktopBridgeOnline: true,
      phoneBridgeOnline: true,
    };
    const finalPrompt = finalizeChatSystemPrompt(
      buildLayeredSystemPrompt(BASE_SYSTEM_PROMPT, sanitizedMemory),
      {
        tools: true,
        agentAccessMode: "full",
        desktopBridgeOnline: true,
        phoneBridgeOnline: true,
      },
    );
    const toolPlan = resolveChatToolPlanForStream(userText, streamOpts);
    const toolPlanNoDesktopPins = resolveChatToolPlanForStream(userText, {
      ...streamOpts,
      agentAccessMode: "sandbox",
      desktopBridgeOnline: false,
      phoneBridgeOnline: false,
    });
    const slices = collectMemorySlices(sanitizedMemory);
    const snapshot = brainCenter.snapshot(ACTOR_ID);

    console.log(`[mode=${mode}]`);
    console.log(`  prompt tokens: ${tokenCount(finalPrompt)} (delta ${tokenCount(finalPrompt) - tokenCount(baselinePrompt)})`);
    console.log(`  visible tools: ${toolPlan.visibleTools.length} (legacy ${baselineTools.length})`);
    console.log(
      `  visible tools without desktop auto-pins: ${toolPlanNoDesktopPins.visibleTools.length} ` +
        `(legacy ${baselineToolsNoDesktopPins.length})`,
    );
    console.log(`  kept fields: ${turnPlan.audit.kept.join(", ") || "(none)"}`);
    console.log(`  stripped fields: ${turnPlan.audit.stripped.join(", ") || "(none)"}`);
    console.log(`  pinned tools: ${turnPlan.pinnedToolNames.join(", ") || "(none)"}`);
    console.log(`  sanitized memory fields: ${slices.map((slice) => slice.name).join(", ") || "(none)"}`);
    console.log(`  brain snapshot linked: ${snapshot.runtimeKernel?.promptMode ?? "missing"}`);
    console.log("");
  }

  console.log("Result guide:");
  console.log("- If prompt tokens drop and kept/stripped fields change, RuntimeKernel is affecting prompt injection.");
  console.log("- If visible tool count changes and pinned tools are present, the intent hook is affecting tool exposure.");
  console.log("- If brain snapshot linked shows the active mode, RuntimeKernel is attached to BrainCenter rather than hanging off to the side.");
}

void main();
