/**
 * 方案 C 修正通道：commitment.* 显式工具（Agent 调用）。
 *
 * 用途：用户主动登记承诺、纠正自动提取的错误、补充遗漏、Agent 执行过程中
 * 产生的新承诺。与自动提取通道共用 CommitmentBoard 的存储/状态机/扫描循环；
 * 本通道创建的承诺 source=manual（不要求账本证据）。
 *
 * 工具集（并入 getBuiltinAgentChatTools + ToolRegistry）：
 *   commitment.create / update / cancel / confirm / fulfill / list
 */

import type { ChatCompletionTool } from "openai/resources/chat/completions";

import type { ToolRegistry } from "./tool-registry.js";
import type {
  CommitmentBoard,
  CommitmentContact,
  CommitmentRecord,
  CommitmentStatus,
  CommittedBy,
  EscalationPolicy,
} from "../agentic-memory/commitment-board.js";
import type { ProvenanceService } from "../agentic-memory/provenance.js";
import { resolveActorId } from "../agent/actor-id.js";

const STATUS_VALUES: CommitmentStatus[] = [
  "candidate",
  "pending_confirmation",
  "active",
  "fulfilled",
  "cancelled",
  "broken",
  "superseded",
];

export const COMMITMENT_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "commitment.create",
      description: [
        "登记一条承诺（承诺草稿板）。当用户明确说「记住我答应过…」「我承诺周五前…」，",
        "或你在对话/执行中做出可兑现的承诺（「我明天把整理好的资料发你」）时调用。",
        "会按截止时间自动提醒与超时升级。",
      ].join(" "),
      parameters: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description: "承诺内容（第三人称陈述），如「用户承诺周五前把合同发给张总」",
          },
          committedBy: {
            type: "string",
            enum: ["user", "agent", "third_party"],
            description: "承诺方：user 用户 / agent 你自己 / third_party 第三方",
          },
          deadline: {
            type: "string",
            description: "截止时间，ISO 8601 格式（如 2026-09-10T18:00:00+08:00）；无明确期限则省略",
          },
          dependencies: {
            type: "array",
            items: { type: "string" },
            description: "（可选）依赖的其他承诺 id 列表；依赖未兑现前会冻结提醒",
          },
          remindBeforeMin: {
            type: "number",
            description: "（可选）临近提醒提前量（分钟），默认 30",
          },
          escalateAfterMin: {
            type: "number",
            description: "（可选）超时后升级间隔（分钟），默认 60",
          },
          notes: { type: "string", description: "（可选）备注" },
          category: {
            type: "string",
            description: "（可选）承诺类别，如 报价/交付/会面/转账/其他；用于同类承诺的模式学习",
          },
          contact: {
            type: "object",
            description:
              "（可选，third_party 承诺建议提供）对方联系渠道：超时未履约时你批准后可代发催促消息。" +
              "platform 取 wechat/qq/feishu/generic；channelId 填对方会话 id（messages.list_conversations 可查）；participantName 填对方称呼",
            properties: {
              platform: { type: "string", enum: ["wechat", "qq", "feishu", "generic"] },
              channelId: { type: "string", description: "对方会话 id（conversationId）" },
              participantId: { type: "string", description: "（可选）对方 id" },
              participantName: { type: "string", description: "（可选）对方称呼" },
            },
            required: ["platform", "channelId"],
            additionalProperties: false,
          },
        },
        required: ["text", "committedBy"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "commitment.update",
      description: [
        "修改未完结承诺的内容/截止时间/依赖/提醒策略。",
        "用户说「那个承诺改到下周三」「再加一条依赖」时调用。",
      ].join(" "),
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "承诺 id（从 commitment.list 获取）" },
          text: { type: "string", description: "（可选）新的承诺内容" },
          deadline: {
            type: "string",
            description: "（可选）新的截止时间（ISO 8601）；传空字符串表示清除期限",
          },
          dependencies: {
            type: "array",
            items: { type: "string" },
            description: "（可选）新的依赖 id 列表（整体替换）",
          },
          remindBeforeMin: { type: "number", description: "（可选）临近提醒提前量（分钟）" },
          escalateAfterMin: { type: "number", description: "（可选）超时升级间隔（分钟）" },
          maxEscalations: { type: "number", description: "（可选）最大升级次数" },
          notes: { type: "string", description: "（可选）备注" },
        },
        required: ["id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "commitment.cancel",
      description: "取消一条承诺（对方撤回/双方同意取消时调用），需给出原因。",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "承诺 id" },
          reason: { type: "string", description: "取消原因" },
        },
        required: ["id", "reason"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "commitment.confirm",
      description: [
        "确认一条待确认（pending_confirmation）的承诺——自动提取置信度不足时",
        "会以待确认状态落板，用户在后续对话中确认后调用本工具转为正式承诺。",
      ].join(" "),
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "承诺 id" } },
        required: ["id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "commitment.fulfill",
      description: "标记承诺已兑现（承诺完成后调用，同时解除下游依赖的阻塞）。",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "承诺 id" } },
        required: ["id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "commitment.retract",
      description: [
        "撤回/作废一条承诺及其证据。当用户说「这事不算了」「我改主意了，不报价了」",
        "或否认说过某承诺时调用：承诺标记 superseded，其关联的账本证据同步作废，",
        "派生的记忆（Mem0/认知图）一并级联清理——避免 agent 拿着已推翻的记忆继续行事（幽灵幻觉治理）。",
      ].join(" "),
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "承诺 id（从 commitment.list 获取）" },
          reason: { type: "string", description: "作废原因，如「用户改主意」「用户否认说过」" },
        },
        required: ["id", "reason"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "commitment.list",
      description: [
        "查询承诺列表。用户问「我答应过你什么」「还有什么没兑现的承诺」时调用。",
        "默认只列未完结（active/pending_confirmation/candidate）的。",
      ].join(" "),
      parameters: {
        type: "object",
        properties: {
          status: {
            type: "array",
            items: { type: "string", enum: STATUS_VALUES },
            description: "（可选）按状态过滤，缺省为 active+pending_confirmation+candidate",
          },
          committedBy: {
            type: "string",
            enum: ["user", "agent", "third_party"],
            description: "（可选）按承诺方过滤",
          },
          includeDone: { type: "boolean", description: "（可选）是否包含已完结（fulfilled/cancelled/broken）" },
        },
        additionalProperties: false,
      },
    },
  },
];

/** memory.invalidate 工具声明：来源/断言级溯源作废（方案 D 的 agent 入口） */
export const MEMORY_INVALIDATION_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "memory.invalidate",
      description: [
        "作废一条记忆的来源（用户撤回消息/否认说过）或单条断言（被证伪）。",
        "级联清理：语义账本标记 void、Mem0 记忆删除、认知图节点标记 overridden、",
        "关联承诺标记 superseded。用户说「我从来没说过这话」「那条信息是错的，删掉」时调用。",
      ].join(" "),
      parameters: {
        type: "object",
        properties: {
          sourceRef: {
            type: "string",
            description: "来源引用（如 chat:turn-123）；与 claimId 二选一，来源级作废优先",
          },
          claimId: { type: "string", description: "账本断言 id（断言级作废）" },
          reason: { type: "string", description: "作废原因" },
        },
        required: ["reason"],
        additionalProperties: false,
      },
    },
  },
];

function isErr(v: CommitmentRecord | { error: string }): v is { error: string } {
  return typeof (v as { error?: string }).error === "string";
}

function summarize(c: CommitmentRecord): Record<string, unknown> {
  return {
    id: c.id,
    text: c.text,
    committedBy: c.committedBy,
    status: c.status,
    deadline: c.deadline,
    dependencies: c.dependencies.length > 0 ? c.dependencies : undefined,
    dependencyBlocked: c.dependencyBlocked || undefined,
    escalationCount: c.escalationCount || undefined,
    source: c.source,
    confidence: c.confidence,
    category: c.category || undefined,
    evidenceLedgerIds: c.evidenceLedgerIds.length > 0 ? c.evidenceLedgerIds : undefined,
    notes: c.notes,
  };
}

/** 注册 commitment.* / memory.invalidate 工具执行器（create-app-services 装配时调用） */
export function registerCommitmentTools(
  registry: ToolRegistry,
  deps: { board: CommitmentBoard; provenance?: ProvenanceService | null },
): void {
  const { board, provenance } = deps;

  /** 解析第三方联系渠道入参（缺字段/非法 platform 返回 undefined = 不代发） */
  function parseContactInput(raw: unknown): CommitmentContact | undefined {
    if (!raw || typeof raw !== "object") return undefined;
    const o = raw as Record<string, unknown>;
    const platform = String(o.platform ?? "").trim();
    const channelId = String(o.channelId ?? "").trim();
    if (!channelId) return undefined;
    if (!["wechat", "qq", "feishu", "generic"].includes(platform)) return undefined;
    return {
      platform: platform as CommitmentContact["platform"],
      channelId,
      ...(o.participantId ? { participantId: String(o.participantId) } : {}),
      ...(o.participantName ? { participantName: String(o.participantName) } : {}),
    };
  }

  registry.register("commitment.create", async (input, context) => {
    const actorId = resolveActorId(context);
    const text = String(input.text ?? "").trim();
    const committedBy = String(input.committedBy ?? "").trim() as CommittedBy;

    const policy: Partial<EscalationPolicy> = {};
    if (input.remindBeforeMin !== undefined) policy.remindBeforeMin = Number(input.remindBeforeMin);
    if (input.escalateAfterMin !== undefined) policy.escalateAfterMin = Number(input.escalateAfterMin);

    const deps2 = Array.isArray(input.dependencies)
      ? input.dependencies.map((d: unknown) => String(d))
      : undefined;

    const result = board.create({
      actorId,
      text,
      committedBy,
      deadline: input.deadline !== undefined ? String(input.deadline) : null,
      dependencies: deps2,
      escalationPolicy: policy,
      source: "manual",
      notes: input.notes ? String(input.notes) : null,
      category: input.category ? String(input.category) : null,
      contact: parseContactInput(input.contact),
    });
    if (isErr(result)) return { ok: false, error: result.error };
    return { ok: true, commitment: summarize(result) };
  });

  registry.register("commitment.update", async (input, context) => {
    void context;
    const policy: Partial<EscalationPolicy> = {};
    if (input.remindBeforeMin !== undefined) policy.remindBeforeMin = Number(input.remindBeforeMin);
    if (input.escalateAfterMin !== undefined) policy.escalateAfterMin = Number(input.escalateAfterMin);
    if (input.maxEscalations !== undefined) policy.maxEscalations = Number(input.maxEscalations);

    const result = board.update(String(input.id ?? ""), {
      text: input.text !== undefined ? String(input.text) : undefined,
      deadline:
        input.deadline !== undefined
          ? String(input.deadline) === ""
            ? null
            : String(input.deadline)
          : undefined,
      dependencies: Array.isArray(input.dependencies)
        ? input.dependencies.map((d: unknown) => String(d))
        : undefined,
      escalationPolicy: Object.keys(policy).length > 0 ? policy : undefined,
      notes: input.notes !== undefined ? String(input.notes) : undefined,
      contact: input.contact !== undefined ? parseContactInput(input.contact) : undefined,
    });
    if (isErr(result)) return { ok: false, error: result.error };
    return { ok: true, commitment: summarize(result) };
  });

  registry.register("commitment.cancel", async (input, context) => {
    void context;
    const result = board.cancel(String(input.id ?? ""), String(input.reason ?? ""));
    if (isErr(result)) return { ok: false, error: result.error };
    return { ok: true, commitment: summarize(result) };
  });

  // 撤回 = 承诺作废 + 证据级联作废（账本 void → Mem0 删除 → 认知图 overridden）
  registry.register("commitment.retract", async (input, context) => {
    void context;
    const id = String(input.id ?? "");
    const reason = String(input.reason ?? "");
    const target = board.get(id);
    if (!target) return { ok: false, error: `承诺不存在：${id}` };

    const result = board.markSuperseded(id, "retract", reason);
    if (isErr(result)) return { ok: false, error: result.error };

    const cascaded: Array<{ claimId: string; ok: boolean }> = [];
    if (provenance) {
      for (const evidenceId of target.evidenceLedgerIds) {
        try {
          const report = await provenance.invalidateClaim(evidenceId, `承诺撤回：${reason}`);
          cascaded.push({ claimId: evidenceId, ok: report.ledgerSuperseded > 0 });
        } catch (err) {
          cascaded.push({ claimId: evidenceId, ok: false });
          void err;
        }
      }
    }
    return { ok: true, commitment: summarize(result), evidenceCascaded: cascaded };
  });

  registry.register("commitment.confirm", async (input, context) => {
    void context;
    const result = board.confirm(String(input.id ?? ""));
    if (isErr(result)) return { ok: false, error: result.error };
    return { ok: true, commitment: summarize(result) };
  });

  registry.register("commitment.fulfill", async (input, context) => {
    void context;
    const result = board.fulfill(String(input.id ?? ""));
    if (isErr(result)) return { ok: false, error: result.error };
    return { ok: true, commitment: summarize(result) };
  });

  registry.register("commitment.list", async (input, context) => {
    const actorId = resolveActorId(context);
    const includeDone = input.includeDone === true;
    const statusFilter: CommitmentStatus[] | undefined = Array.isArray(input.status)
      ? (input.status.map((s: unknown) => String(s)) as CommitmentStatus[])
      : includeDone
        ? undefined
        : ["active", "pending_confirmation", "candidate"];

    const items = board.list({
      actorId,
      status: statusFilter,
      committedBy: input.committedBy ? (String(input.committedBy) as CommittedBy) : undefined,
    });
    return {
      ok: true,
      count: items.length,
      commitments: items.map(summarize),
    };
  });

  // memory.invalidate：来源级 / 断言级作废（方案 D 的 agent 可调入口）
  registry.register("memory.invalidate", async (input, context) => {
    void context;
    if (!provenance) return { ok: false, error: "溯源服务未启用（AGENT_MEMORY_PROVENANCE_ENABLED）" };
    const reason = String(input.reason ?? "");
    const sourceRef = input.sourceRef ? String(input.sourceRef) : "";
    const claimId = input.claimId ? String(input.claimId) : "";
    if (!sourceRef && !claimId) {
      return { ok: false, error: "请提供 sourceRef（来源级作废）或 claimId（断言级作废）" };
    }
    const report = sourceRef
      ? await provenance.invalidateSource(sourceRef, reason)
      : await provenance.invalidateClaim(claimId, reason);
    return {
      ok: true,
      invalidated: {
        scope: sourceRef ? `source:${sourceRef}` : `claim:${claimId}`,
        ledgerSuperseded: report.ledgerSuperseded,
        mem0Deleted: report.mem0Deleted,
        graphOverridden: report.graphOverridden,
        errors: report.mem0DeleteErrors,
      },
    };
  });
}
