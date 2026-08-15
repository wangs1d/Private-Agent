import type {
  ChatToolExecutionContext,
  ToolExecutedInfo,
  ToolExecuteStartInfo,
} from "../../external-model/types.js";
import type { AgentAccessMode } from "../agent-access-mode.js";
import type { BrainCenter } from "../../brain/index.js";
import type { ClientLocationWire } from "../../types/client-location.js";
import type { ToolContext, ToolRegistry } from "../../tools/tool-registry.js";

export type ToolExecutionAccess = {
  agentAccessMode?: AgentAccessMode;
  desktopBridgeOnline?: boolean;
  phoneBridgeOnline?: boolean;
  /** 按需位置：位置类工具（weather.get_local 等）在缺少经纬度时可向客户端请求实时 GPS */
  requestLocation?: () => Promise<ClientLocationWire | null>;
};

export type ToolExecutionBase = {
  actorId: string;
  sessionId: string;
  userId?: string;
  chatUserMessageId?: string;
  clientIp?: string;
  clientLocation?: ClientLocationWire;
  userText?: string;
  source: string;
  access?: ToolExecutionAccess;
};

export type ToolContextFactoryDeps = {
  toolRegistry: ToolRegistry;
  getBrainCenter: () => BrainCenter | null;
};

export type ToolContextCallbacks = {
  onToolExecuteStart?: (info: ToolExecuteStartInfo) => void;
  onToolExecuted?: (info: ToolExecutedInfo) => void;
  onAgentStatusLine?: (line: string) => void;
};

export class ToolContextFactory {
  constructor(private readonly deps: ToolContextFactoryDeps) {}

  create(base: ToolExecutionBase, callbacks: ToolContextCallbacks = {}): ChatToolExecutionContext {
    return {
      getCachedToolResult: (name, args) => this.deps.toolRegistry.getCachedResult(name, args),
      executeTool: (name, args) => this.execute(name, args, base),
      onToolExecuteStart: callbacks.onToolExecuteStart,
      onAgentStatusLine: callbacks.onAgentStatusLine,
      onToolExecuted: callbacks.onToolExecuted,
    };
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    base: ToolExecutionBase,
  ): Promise<{ ok: boolean; result: Record<string, unknown> }> {
    const brainCenter = this.deps.getBrainCenter();
    const brainSafety = brainCenter?.checkSafety(
      { tool: name, args },
      {
        actorId: base.actorId,
        sessionId: base.sessionId,
        ...(base.userText ? { userText: base.userText } : {}),
      },
    );
    if (brainSafety && !brainSafety.allowed) {
      return {
        ok: false,
        result: {
          error: brainSafety.reason,
          severity: brainSafety.severity,
          blockedBy: "brain_center",
        },
      };
    }

    const bodyGateway = brainCenter?.getBodyGateway();
    if (bodyGateway?.hasRoute(name)) {
      return bodyGateway.execute({
        tool: name,
        args,
        actorId: base.actorId,
        source: base.source,
      });
    }

    return this.deps.toolRegistry.execute(name, args, this.toToolContext(base));
  }

  private toToolContext(base: ToolExecutionBase): ToolContext {
    return {
      sessionId: base.sessionId,
      userId: base.userId,
      chatUserMessageId: base.chatUserMessageId,
      clientIp: base.clientIp,
      clientLocation: base.clientLocation,
      agentAccessMode: base.access?.agentAccessMode,
      desktopBridgeOnline: base.access?.desktopBridgeOnline,
      phoneBridgeOnline: base.access?.phoneBridgeOnline,
    };
  }
}
