import test from "node:test";
import assert from "node:assert/strict";

import { AgentCore } from "../src/services/agent-core.js";
import { resetAgentRuntimeConfigForTests } from "../src/agent/agent-runtime-config.js";
import { masterChatSessionId } from "../src/agent/master-chat-session.js";
import { resetChatThreadStoreForTests, getChatThreadStore } from "../src/external-model/chat-thread-store.js";
import type {
  AgentStreamOptions,
  ChatToolExecutionContext,
  ChatUserTurn,
  ExternalChatProvider,
  StreamDeltaHandler,
} from "../src/external-model/types.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";

class Deferred<T> {
  promise: Promise<T>;
  resolve!: (value: T) => void;

  constructor() {
    this.promise = new Promise<T>((resolve) => {
      this.resolve = resolve;
    });
  }
}

class FakeLiveProvider implements ExternalChatProvider {
  readonly id = "fake-live";
  readonly displayLabel = "Fake Live";
  readonly calls: string[] = [];
  readonly complexGate = new Deferred<string>();

  isEnabled(): boolean {
    return true;
  }

  async streamCompletion(
    sessionId: string,
    userTurn: ChatUserTurn,
    onDelta: StreamDeltaHandler,
    _tools?: ChatToolExecutionContext,
    _streamOpts?: AgentStreamOptions,
  ): Promise<string> {
    this.calls.push(sessionId);
    if (sessionId.startsWith("llm-route::")) {
      // LLM 语义路由调用（2026-08-29 起为路由唯一权威）：本测试需要走
      // complex + parallel-live 路径，路由判定固定返回 complex。
      return "complex";
    }
    if (sessionId.startsWith("parallel-live-")) {
      return this.complexGate.promise;
    }
    if (sessionId.startsWith("fast-continuation-")) {
      const text = "补充：刚刚查到还有一个新细节。";
      onDelta(text);
      return text;
    }
    const text = `fast:${userTurn.text}`;
    onDelta(text);
    this.appendThreadTurn(sessionId, userTurn, text);
    return text;
  }

  appendThreadTurn(
    sessionId: string,
    userTurn: ChatUserTurn,
    assistantText: string,
    maxThreadMessages?: number,
  ): void {
    getChatThreadStore().appendTurn(sessionId, "system", userTurn, assistantText, maxThreadMessages);
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("handleUserMessage returns fast reply before parallel complex continuation", async () => {
  const oldEnableMaster = process.env.ENABLE_MASTER_AGENT_DELEGATION;
  const oldParallel = process.env.AGENT_PARALLEL_LIVE_COMPLEX;
  const oldMin = process.env.AGENT_PARALLEL_LIVE_MIN_CHARS;
  process.env.ENABLE_MASTER_AGENT_DELEGATION = "1";
  process.env.AGENT_PARALLEL_LIVE_COMPLEX = "1";
  process.env.AGENT_PARALLEL_LIVE_MIN_CHARS = "1";
  resetAgentRuntimeConfigForTests();
  resetChatThreadStoreForTests();

  try {
    const provider = new FakeLiveProvider();
    const core = new AgentCore(new ToolRegistry(), provider);
    const deltas: string[] = [];
    const backgroundDeltas: Array<{ messageId: string; delta: string }> = [];
    const backgroundDone: Array<{ messageId: string; finalText: string }> = [];

    const reply = await core.handleUserMessage("actor-live", "今天 AI 新闻有什么重点", {
      chatUserMessageId: "msg-live-1",
      onAssistantDelta: (delta) => deltas.push(delta),
      onBackgroundAssistantDelta: ({ messageId, delta }) => {
        backgroundDeltas.push({ messageId, delta });
      },
      onBackgroundAssistantDone: ({ messageId, finalText }) => {
        backgroundDone.push({ messageId, finalText });
      },
    });

    assert.equal(reply.text, "fast:今天 AI 新闻有什么重点");
    assert.deepEqual(deltas, ["fast:今天 AI 新闻有什么重点"]);
    assert.equal(provider.calls.some((id) => id.startsWith("parallel-live-")), true);

    provider.complexGate.resolve("complex:还有一个新细节。");
    await waitFor(() => backgroundDone.length === 1);

    assert.deepEqual(deltas, ["fast:今天 AI 新闻有什么重点"]);
    assert.equal(backgroundDeltas[0]?.messageId, "parallel-live:msg-live-1");
    assert.deepEqual(backgroundDeltas.map((item) => item.delta), ["补充：刚刚查到还有一个新细节。"]);
    assert.deepEqual(backgroundDone, [
      {
        messageId: "parallel-live:msg-live-1",
        finalText: "补充：刚刚查到还有一个新细节。",
      },
    ]);

    const thread = getChatThreadStore().thread(masterChatSessionId("actor-live"), "system");
    const assistantMessages = thread.filter((m) => m.role === "assistant");
    assert.equal(assistantMessages.length, 2);
    assert.equal(typeof assistantMessages[0]?.content === "string" && assistantMessages[0].content.includes("fast:"), true);
    assert.equal(
      typeof assistantMessages[1]?.content === "string" &&
        assistantMessages[1].content.includes("补充：刚刚查到还有一个新细节。"),
      true,
    );
  } finally {
    if (oldEnableMaster === undefined) delete process.env.ENABLE_MASTER_AGENT_DELEGATION;
    else process.env.ENABLE_MASTER_AGENT_DELEGATION = oldEnableMaster;
    if (oldParallel === undefined) delete process.env.AGENT_PARALLEL_LIVE_COMPLEX;
    else process.env.AGENT_PARALLEL_LIVE_COMPLEX = oldParallel;
    if (oldMin === undefined) delete process.env.AGENT_PARALLEL_LIVE_MIN_CHARS;
    else process.env.AGENT_PARALLEL_LIVE_MIN_CHARS = oldMin;
    resetAgentRuntimeConfigForTests();
    resetChatThreadStoreForTests();
  }
});
