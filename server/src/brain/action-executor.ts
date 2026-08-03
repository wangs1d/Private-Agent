// Agent Brain Center — ActionExecutor（统一动作执行层）
//
// 职责：合并三处动作执行（ProactionCortex.executeActions / executeProactiveDecision
// 的 LLM function calling / PlannerCortex.executeWithToolExecutor），统一调度/日志/安全检查。
//
// 设计原则：
//  1. 单一入口：execute(name, args, opts) 同时满足 ActionExecutorLike 和 ToolExecutorLike
//  2. 统一安全检查：所有动作执行前过 LimbicCortex.checkSafety
//  3. 统一日志：记录动作来源/执行结果/耗时，便于调试和审计
//  4. 失败不阻塞：单个动作失败不影响其他动作，仅记日志
//
// 接入点：
//  - ProactionCortex.registerActionExecutor(actionExecutor) — 替代原 executeActions 内部直接执行
//  - PlannerCortex.registerToolExecutor(actionExecutor) — 替代原 executeWithToolExecutor
//  - executeProactiveDecision 的 LLM function calling 通过 actionExecutor 调度

import type {
  BrainDecisionAction,
  SafetyCheckResult,
} from "./types.js";
import type {
  BodyActionResult,
  BodyGatewayLike,
  BodySignal,
} from "../body/types.js";
import { BODY_SIGNAL_KIND } from "../body/types.js";

// ---- 外观接口 ------------------------------------------------------------

/**
 * ToolRegistry 外观接口。
 * 让 ActionExecutor 委托实际工具执行到 ToolRegistry，不直接依赖 ToolRegistry 实现。
 */
export interface ToolRegistryLike {
  execute(
    name: string,
    args: Record<string, unknown>,
    opts?: { actorId?: string },
  ): Promise<{ ok: boolean; result: Record<string, unknown> }>;
}

/**
 * LimbicCortex 外观接口。
 * 用于统一安全检查。
 */
export interface LimbicCortexLike {
  checkSafety(
    action: { tool: string; args: Record<string, unknown> },
    ctx?: Record<string, unknown>,
  ): SafetyCheckResult;
}

/**
 * BodyBus 外观接口（P0-2 工具执行反馈闭环）。
 *
 * ActionExecutor 通过此接口把工具执行结果回流到 BodyBus 作为感官信号，
 * 让下一轮 cognize 能感知上一轮 hand 做了什么。
 * 仅需 publish 方法；未注入时 ActionExecutor 静默跳过信号发布（降级安全）。
 */
export interface BodyBusLike {
  publish(signal: BodySignal): void;
}

// ---- 日志类型 ------------------------------------------------------------

export interface ActionLogEntry {
  actorId: string;
  tool: string;
  args: Record<string, unknown>;
  source: "proaction" | "cognize" | "planner" | "unknown";
  signalKind?: string;
  success: boolean;
  severity: SafetyCheckResult["severity"];
  reason?: string;
  errorMessage?: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

export interface ActionResult {
  action: BrainDecisionAction;
  ok: boolean;
  result: Record<string, unknown>;
  safety: SafetyCheckResult;
  errorMessage?: string;
}

// ---- ActionExecutor 主类 ------------------------------------------------

/**
 * 统一动作执行层。
 *
 * 合并 ProactionCortex.executeActions / PlannerCortex.executeWithToolExecutor
 * 两处工具执行，统一安全检查和日志。executeProactiveDecision 的 LLM function
 * calling 通过 ChatToolExecutionContext 间接调用 ToolRegistry，不直接走 ActionExecutor，
 * 但其内部 executeTool 可包装为调用 actionExecutor.execute。
 *
 * 单个动作失败不阻塞其他动作，仅记日志。
 */
export class ActionExecutor {
  private toolRegistry: ToolRegistryLike;
  private limbic: LimbicCortexLike | null = null;
  /** BodyGateway 引用（大脑→身体下行网关，可选；注入后 execute 优先委托 BodyGateway） */
  private bodyGateway: BodyGatewayLike | null = null;
  /** BodyBus 引用（P0-2 反馈闭环，可选；注入后 execute 成功/失败均回流信号到 BodyBus） */
  private bodyBus: BodyBusLike | null = null;
  private logs: ActionLogEntry[] = [];
  private readonly maxLogs = 200;

  constructor(toolRegistry: ToolRegistryLike) {
    this.toolRegistry = toolRegistry;
  }

  /** 注入 LimbicCortex 用于安全检查 */
  registerLimbic(limbic: LimbicCortexLike): void {
    this.limbic = limbic;
  }

  /**
   * 注入 BodyGateway（大脑→身体下行网关）。
   *
   * 注入后 execute(name, args, opts) 会优先委托 bodyGateway.execute，
   * 工具未被任何 BodyModule 匹配时（errorMessage 含 "tool_not_found"）才 fallback 到 ToolRegistry。
   * 不修改构造函数签名，避免破坏现有调用方。
   */
  registerBodyGateway(gw: BodyGatewayLike): void {
    this.bodyGateway = gw;
    console.log("[ActionExecutor] 已注册 BodyGateway");
  }

  /**
   * 注入 BodyBus（P0-2 工具执行反馈闭环）。
   *
   * 注入后 execute 成功时发布 `body.action.executed`、失败时发布 `body.action.failed`，
   * 让下一轮 cognize 能感知上一轮 hand 做了什么。
   * 信号发布 fire-and-forget，不阻塞执行，异常静默吞掉并记日志。
   * 未注入时静默跳过（降级安全）。
   */
  registerBodyBus(bus: BodyBusLike): void {
    this.bodyBus = bus;
    console.log("[ActionExecutor] 已注册 BodyBus（反馈闭环）");
  }

  /**
   * 统一执行入口（同时满足 ActionExecutorLike 和 ToolExecutorLike）。
   *
   * @param name 工具名
   * @param args 工具参数
   * @param opts 执行选项（actorId/source/signalKind）
   */
  async execute(
    name: string,
    args: Record<string, unknown>,
    opts?: {
      actorId?: string;
      source?: "proaction" | "cognize" | "planner" | "unknown";
      signalKind?: string;
    },
  ): Promise<{ ok: boolean; result: Record<string, unknown> }> {
    const actorId = opts?.actorId ?? "unknown";
    const source = opts?.source ?? "unknown";
    const signalKind = opts?.signalKind;
    const startedAt = new Date().toISOString();
    const startTime = Date.now();

    // 1. 统一安全检查（执行前）
    const safety = this.checkSafety({ tool: name, args });
    if (!safety.allowed) {
      const errorMsg = `safety_blocked:${safety.reason}`;
      console.log(
        `[ActionExecutor] 安全检查拒绝 actorId=${actorId} tool=${name} ` +
          `severity=${safety.severity} reason=${safety.reason}`,
      );
      this.appendLog({
        actorId,
        tool: name,
        args,
        source,
        signalKind,
        success: false,
        severity: safety.severity,
        reason: safety.reason,
        errorMessage: errorMsg,
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startTime,
      });
      this.publishActionSignal({
        ok: false,
        actorId,
        tool: name,
        source,
        durationMs: Date.now() - startTime,
        error: errorMsg,
      });
      return { ok: false, result: { error: errorMsg, safety } };
    }

    // 1.5. 优先委托 BodyGateway（若已注入）
    // BodyGateway 会先过反射弧（身体侧硬安全门），再路由到对应 BodyModule.act。
    // 工具未被任何 BodyModule 匹配时（errorMessage 含 "tool_not_found"）fallback 到 ToolRegistry。
    if (this.bodyGateway) {
      try {
        const bodyResult = await this.bodyGateway.execute({
          tool: name,
          args,
          actorId,
          source,
        });
        // 检查是否为"工具未找到"情况 → fallback 到 ToolRegistry
        const isNotFound = !bodyResult.ok && this.isToolNotFoundError(bodyResult);
        if (!isNotFound) {
          // 成功 或 非工具未找到的错误（如反射弧拒绝）→ 直接返回，不走 ToolRegistry
          const finishedAt = new Date().toISOString();
          const durationMs = Date.now() - startTime;
          this.appendLog({
            actorId,
            tool: name,
            args,
            source,
            signalKind,
            success: bodyResult.ok,
            severity: bodyResult.refused ? "denied" : "allowed",
            reason: bodyResult.reason,
            errorMessage: bodyResult.ok
              ? undefined
              : (bodyResult.errorMessage ?? "").slice(0, 100),
            startedAt,
            finishedAt,
            durationMs,
          });
          if (!bodyResult.ok) {
            console.log(
              `[ActionExecutor] BodyGateway 执行失败 actorId=${actorId} tool=${name} ` +
                `result=${JSON.stringify(bodyResult.result).slice(0, 100)}`,
            );
          }
          this.publishActionSignal({
            ok: bodyResult.ok,
            actorId,
            tool: name,
            source,
            durationMs,
            result: bodyResult.result,
            error: bodyResult.ok
              ? undefined
              : (bodyResult.errorMessage ?? bodyResult.reason ?? "body_gateway_failed"),
          });
          return { ok: bodyResult.ok, result: bodyResult.result };
        }
        // ok=false 且 errorMessage 含 "tool_not_found" → fallback 到 ToolRegistry
      } catch (e) {
        // BodyGateway 异常 → fallback 到 ToolRegistry，不阻塞主流程
        console.log(
          `[ActionExecutor] BodyGateway 异常, fallback 到 ToolRegistry: ${e}`,
        );
      }
    }

    // 2. fallback：委托 ToolRegistry 执行
    try {
      const result = await this.toolRegistry.execute(name, args, { actorId });
      const finishedAt = new Date().toISOString();
      const durationMs = Date.now() - startTime;
      this.appendLog({
        actorId,
        tool: name,
        args,
        source,
        signalKind,
        success: result.ok,
        severity: "allowed",
        errorMessage: result.ok ? undefined : JSON.stringify(result.result).slice(0, 100),
        startedAt,
        finishedAt,
        durationMs,
      });
      if (!result.ok) {
        console.log(
          `[ActionExecutor] 工具执行失败 actorId=${actorId} tool=${name} ` +
            `result=${JSON.stringify(result.result).slice(0, 100)}`,
        );
      }
      this.publishActionSignal({
        ok: result.ok,
        actorId,
        tool: name,
        source,
        durationMs,
        result: result.result,
        error: result.ok ? undefined : JSON.stringify(result.result).slice(0, 120),
      });
      return result;
    } catch (err) {
      const errorMsg = String(err).slice(0, 120);
      console.log(
        `[ActionExecutor] 工具执行异常 actorId=${actorId} tool=${name} err=${errorMsg}`,
      );
      this.appendLog({
        actorId,
        tool: name,
        args,
        source,
        signalKind,
        success: false,
        severity: "allowed",
        errorMessage: errorMsg,
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startTime,
      });
      this.publishActionSignal({
        ok: false,
        actorId,
        tool: name,
        source,
        durationMs: Date.now() - startTime,
        error: errorMsg,
      });
      return { ok: false, result: { error: errorMsg } };
    }
  }

  /**
   * 批量执行动作列表（用于 ProactionCortex.decide 阶段 3）。
   *
   * @param actions 动作列表
   * @param opts 执行选项
   * @returns 每个动作的执行结果
   */
  async executeBatch(
    actions: BrainDecisionAction[],
    opts: {
      actorId: string;
      source: "proaction" | "cognize" | "planner";
      signalKind?: string;
    },
  ): Promise<ActionResult[]> {
    const results: ActionResult[] = [];
    for (const action of actions) {
      const safety = this.checkSafety({ tool: action.tool, args: action.args });
      if (!safety.allowed) {
        console.log(
          `[ActionExecutor] 批量执行安全拒绝 tool=${action.tool} reason=${safety.reason}`,
        );
        results.push({
          action,
          ok: false,
          result: { error: `safety_blocked:${safety.reason}` },
          safety,
          errorMessage: `safety_blocked:${safety.reason}`,
        });
        continue;
      }

      try {
        const result = await this.execute(action.tool, action.args, {
          actorId: opts.actorId,
          source: opts.source,
          signalKind: opts.signalKind,
        });
        results.push({
          action,
          ok: result.ok,
          result: result.result,
          safety,
          errorMessage: result.ok ? undefined : String(result.result?.error ?? "").slice(0, 100),
        });
        if (result.ok) {
          console.log(
            `[ActionExecutor] 动作执行成功 tool=${action.tool} reason=${action.reason}`,
          );
        }
      } catch (err) {
        results.push({
          action,
          ok: false,
          result: { error: String(err).slice(0, 120) },
          safety,
          errorMessage: String(err).slice(0, 120),
        });
      }
    }
    return results;
  }

  /**
   * 统一安全检查。
   * 委托 LimbicCortex.checkSafety（含黑名单/高风险/SSRF 检查）；
   * 未注册 LimbicCortex 时默认 allowed（向后兼容）。
   */
  private checkSafety(action: {
    tool: string;
    args: Record<string, unknown>;
  }): SafetyCheckResult {
    if (!this.limbic) {
      return {
        allowed: true,
        severity: "allowed",
        reason: "no_limbic_registered",
        tool: action.tool,
        args: action.args,
        checkedAt: new Date().toISOString(),
      };
    }
    try {
      return this.limbic.checkSafety(action, { tool: action.tool });
    } catch (err) {
      // 安全检查本身异常 → fail-closed（拒绝执行）
      console.log(`[ActionExecutor] 安全检查异常，fail-closed 拒绝: ${err}`);
      return {
        allowed: false,
        severity: "denied",
        reason: `safety_check_error:${String(err).slice(0, 80)}`,
        tool: action.tool,
        args: action.args,
        checkedAt: new Date().toISOString(),
      };
    }
  }

  /**
   * 判断 BodyActionResult 是否为"工具未找到"错误。
   *
   * BodyGateway 在工具未匹配任何 BodyModule 且无 fallbackToolRegistry 时
   * 返回 errorMessage 含 "tool_not_found"。
   * 此类错误应 fallback 到 ToolRegistry（脑侧工具注册表），而非直接返回失败。
   *
   * 反射弧拒绝（refused=true）不算 not_found，应直接返回。
   */
  private isToolNotFoundError(result: BodyActionResult): boolean {
    if (result.ok) return false;
    if (result.refused) return false; // 反射弧拒绝不是 not_found
    if (!result.errorMessage) return false;
    return result.errorMessage.includes("tool_not_found");
  }

  /** 追加日志（环形缓冲，最多 maxLogs 条） */
  private appendLog(entry: ActionLogEntry): void {
    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }
  }

  /**
   * 发布工具执行反馈信号到 BodyBus（P0-2 反馈闭环）。
   *
   * - 成功 → `body.action.executed`（含 tool/actorId/result摘要/success:true）
   * - 失败 → `body.action.failed`（含 tool/actorId/error/success:false）
   *
   * fire-and-forget：异常静默吞掉并记日志，不阻塞主流程。
   * BodyBus 未注入时静默跳过（降级安全）。
   */
  private publishActionSignal(info: {
    ok: boolean;
    actorId: string;
    tool: string;
    source: string;
    durationMs: number;
    result?: Record<string, unknown>;
    error?: string;
  }): void {
    if (!this.bodyBus) return;
    try {
      const kind = info.ok
        ? BODY_SIGNAL_KIND.ACTION_EXECUTED
        : BODY_SIGNAL_KIND.ACTION_FAILED;
      const payload: Record<string, unknown> = {
        tool: info.tool,
        actorId: info.actorId,
        source: info.source,
        success: info.ok,
        durationMs: info.durationMs,
      };
      if (info.ok && info.result) {
        // result 摘要（截断防止信号 payload 过大）
        payload.resultSummary = summarizeResult(info.result);
      }
      if (!info.ok && info.error) {
        payload.error = info.error;
      }
      this.bodyBus.publish({
        kind,
        payload,
        module: "action",
        actorId: info.actorId,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      // fire-and-forget：异常不阻塞主流程
      console.log(
        `[ActionExecutor] publishActionSignal 异常（已吞掉） tool=${info.tool} err=${err}`,
      );
    }
  }

  /** 获取最近日志（用于审计/调试） */
  getRecentLogs(limit = 50): ActionLogEntry[] {
    return this.logs.slice(-limit);
  }

  /** 获取统计（用于 snapshot） */
  getStats(): {
    totalActions: number;
    successCount: number;
    failureCount: number;
    safetyBlockedCount: number;
    avgDurationMs: number;
  } {
    const total = this.logs.length;
    let success = 0;
    let failure = 0;
    let blocked = 0;
    let totalDuration = 0;
    for (const log of this.logs) {
      if (log.success) {
        success++;
      } else {
        failure++;
        if (log.severity === "denied" || log.severity === "high_risk") {
          blocked++;
        }
      }
      totalDuration += log.durationMs;
    }
    return {
      totalActions: total,
      successCount: success,
      failureCount: failure,
      safetyBlockedCount: blocked,
      avgDurationMs: total > 0 ? Math.round(totalDuration / total) : 0,
    };
  }
}

// ---- 工具函数 ------------------------------------------------------------

/** result 摘要最大长度（防止信号 payload 过大）。 */
const RESULT_SUMMARY_MAX_LEN = 200;

/**
 * 把工具执行 result 安全序列化为简短摘要（截断到 RESULT_SUMMARY_MAX_LEN）。
 * 用于 body.action.executed 信号的 resultSummary 字段。
 */
function summarizeResult(result: Record<string, unknown>): string {
  let s: string;
  try {
    s = JSON.stringify(result);
  } catch {
    s = String(result);
  }
  if (s.length > RESULT_SUMMARY_MAX_LEN) {
    return s.slice(0, RESULT_SUMMARY_MAX_LEN) + "...[truncated]";
  }
  return s;
}
