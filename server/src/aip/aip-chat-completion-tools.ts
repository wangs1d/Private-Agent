import type { ChatCompletionTool } from "openai/resources/chat/completions";

/**
 * 供 Chat Completions 使用的 AIP 工具定义（与 ToolRegistry 名称一致）。
 */
export const AIP_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "aip.dispatch",
      description:
        "投递 AI 原生交互协议（AIP v0.1）结构化消息到另一 Agent 的 session：对话意图、交易意向、结盟、冲突宣告与回应等。需与对方配对（若启用 AGENT_RELAY_REQUIRE_PAIR）。成功时对方收到 agent.peer_message，payload 含 aip 字段。kind 取值：utterance | trade_proposal | trade_response | alliance_invite | alliance_response | conflict_declare | conflict_response。",
      parameters: {
        type: "object",
        properties: {
          toSessionId: { type: "string", description: "接收方 sessionId" },
          kind: {
            type: "string",
            enum: [
              "utterance",
              "trade_proposal",
              "trade_response",
              "alliance_invite",
              "alliance_response",
              "conflict_declare",
              "conflict_response",
            ],
          },
          payload: {
            type: "object",
            description:
              "各 kind 的载荷：utterance{text,intentTag?}；trade_proposal{summary,offer?,ask?,...}；trade_response{proposalId,decision,note?}；alliance_invite{terms?,inviteeSessionId?}；alliance_response{proposalId,decision,note?}；conflict_declare{targetSessionId,reason,...}；conflict_response{conflictId,action,note?}",
          },
          correlationId: { type: "string" },
          proposalId: { type: "string" },
          traceId: { type: "string" },
        },
        required: ["toSessionId", "kind", "payload"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "aip.list_my_state",
      description: "查询当前 session 在 AIP 下的结盟成员关系与进行中的开放冲突（内存态）。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "aip.get_proposal",
      description: "按 proposalId 查询交易/结盟提议状态（须为提议相关方）。",
      parameters: {
        type: "object",
        properties: { proposalId: { type: "string" } },
        required: ["proposalId"],
        additionalProperties: false,
      },
    },
  },
];
