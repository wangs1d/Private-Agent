import type {
  AgentStreamOptions,
  ChatToolExecutionContext,
  ChatUserTurn,
  ExternalChatProvider,
  StreamDeltaHandler,
} from "./types.js";
import { CircuitBreaker } from "./circuit-breaker.js";

/**
 * 按顺序尝试多个 {@link ExternalChatProvider}，仅调用 `isEnabled()` 为 true 的成员；
 * 某次 `streamCompletion` 抛错时尝试下一个（适用于建连失败、4xx/5xx 等）。
 *
 * 注意：若首个提供方已开始流式输出并调用了 `onDelta`，再失败时切换到下一个可能造成客户端重复片段；
 * 适合「请求未成功建立流」类故障；生产级可改为仅缓冲首个 chunk 前失败才切换。
 */
export class FailoverChatProvider implements ExternalChatProvider {
  readonly id = "failover";
  readonly displayLabel: string;

  /** 每个 provider 对应一个熔断器，按 provider 引用索引。 */
  private readonly breakers: Map<ExternalChatProvider, CircuitBreaker>;

  constructor(
    private readonly chain: ExternalChatProvider[],
    displayLabel?: string,
  ) {
    const ids = chain.map((p) => p.id).join("→");
    this.displayLabel = displayLabel ?? `Failover(${ids})`;
    this.breakers = new Map();
    for (const p of chain) {
      this.breakers.set(p, new CircuitBreaker());
    }
  }

  isEnabled(): boolean {
    return this.chain.some((p) => p.isEnabled());
  }

  clearSession(sessionId: string): void {
    for (const p of this.chain) p.clearSession?.(sessionId);
  }

  appendThreadTurn(
    sessionId: string,
    userTurn: ChatUserTurn,
    assistantText: string,
    maxThreadMessages?: number,
    model?: string,
  ): void {
    const enabled = this.chain.filter((p) => p.isEnabled());
    const p = enabled[0];
    p?.appendThreadTurn?.(sessionId, userTurn, assistantText, maxThreadMessages, model);
  }

  async streamCompletion(
    sessionId: string,
    userTurn: ChatUserTurn,
    onDelta: StreamDeltaHandler,
    tools?: ChatToolExecutionContext,
    streamOpts?: AgentStreamOptions,
  ): Promise<string> {
    const enabled = this.chain.filter((p) => p.isEnabled());
    if (enabled.length === 0) {
      throw new Error("failover chain has no enabled provider");
    }
    let lastErr: unknown;
    let attemptedAny = false;
    for (const p of enabled) {
      const breaker = this.breakers.get(p)!;
      // 熔断中（open）跳过该 provider，直接尝试下一个
      if (!breaker.canExecute()) {
        console.warn(
          `[external-model] Provider "${p.id}" circuit ${breaker.getState()}, skipping`,
        );
        continue;
      }
      try {
        const result = await p.streamCompletion(
          sessionId,
          userTurn,
          onDelta,
          tools,
          streamOpts,
        );
        breaker.recordSuccess();
        return result;
      } catch (e) {
        breaker.recordFailure();
        lastErr = e;
        attemptedAny = true;
        console.warn(
          `[external-model] Provider "${p.id}" failed, trying next:`,
          e instanceof Error ? e.message : e,
        );
      }
    }
    // 所有 provider 均被熔断跳过
    if (!attemptedAny) {
      throw new Error("failover chain exhausted: all providers circuit-open");
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
}
