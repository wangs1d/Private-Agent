/**
 * 可热替换的外部对话模型代理。
 *
 * 服务端 externalChat 在 bootstrap 创建一次后即被 agent-core / 旁路服务 / 计划
 * 执行等十几处闭包捕获，用户在「服务接入」页保存密钥后无法逐处重建——本代理
 * 以稳定实例 + 内部 current 槽位的方式把热替换收敛到一处：PUT /api/service-config
 * 应用 env 后调用 {@link swap} 装入新 provider，所有消费者下一次调用即走新绑定。
 *
 * 未配置（current 为空）时 isEnabled()=false，与 createExternalChatProviderFromEnv
 * 返回 null 的语义对齐；isEnabled=false 时仍被直调 streamCompletion 的话抛出带
 * 配置指引的错误（聊天主链路会先看 isEnabled 走未配置分支，不会到这里）。
 */

import type {
  AgentStreamOptions,
  ChatToolExecutionContext,
  ChatUserTurn,
  ExternalChatProvider,
  StreamDeltaHandler,
} from "./types.js";

export class MutableExternalChatProvider implements ExternalChatProvider {
  private current: ExternalChatProvider | null;

  constructor(initial: ExternalChatProvider | null = null) {
    this.current = initial;
  }

  /** 热替换当前 provider（传 null = 撤下，回到未配置态）。 */
  swap(next: ExternalChatProvider | null): void {
    this.current = next;
  }

  get inner(): ExternalChatProvider | null {
    return this.current;
  }

  get id(): string {
    return this.current?.id ?? "unconfigured";
  }

  get displayLabel(): string {
    return this.current?.displayLabel ?? "未配置";
  }

  get capabilities() {
    return this.current?.capabilities;
  }

  isEnabled(): boolean {
    return this.current?.isEnabled() ?? false;
  }

  async streamCompletion(
    sessionId: string,
    userTurn: ChatUserTurn,
    onDelta: StreamDeltaHandler,
    tools?: ChatToolExecutionContext,
    streamOpts?: AgentStreamOptions,
  ): Promise<string> {
    const provider = this.current;
    if (!provider || !provider.isEnabled()) {
      throw new Error("模型服务未配置：请在「服务接入」填写 API Key（或由部署方配置服务端密钥）");
    }
    return provider.streamCompletion(sessionId, userTurn, onDelta, tools, streamOpts);
  }

  clearSession(sessionId: string): void {
    this.current?.clearSession?.(sessionId);
  }

  appendThreadTurn(
    sessionId: string,
    userTurn: ChatUserTurn,
    assistantText: string,
    maxThreadMessages?: number,
    model?: string,
  ): void {
    this.current?.appendThreadTurn?.(sessionId, userTurn, assistantText, maxThreadMessages, model);
  }

  removeUserTurnAndAfter?(sessionId: string, clientMessageId?: string): void {
    this.current?.removeUserTurnAndAfter?.(sessionId, clientMessageId);
  }

  appendTaskRecord(sessionId: string, goal: string, resultText: string): void {
    this.current?.appendTaskRecord?.(sessionId, goal, resultText);
  }
}
