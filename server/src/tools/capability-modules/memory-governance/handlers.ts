import type { ToolHandler, ToolContext, ToolRegistry } from "../../tool-registry.js";
import { resolveActorId } from "../../../agent/actor-id.js";
import type { InterestWatcher } from "../../../proactivity/interest-watcher.js";
import type { AuditTrailService } from "../../../proactivity/audit-timeline.js";
import type { GoalBoard } from "../../../proactivity/goal-board.js";
import type { CommitmentBoard } from "../../../agentic-memory/commitment-board.js";
import type { ShoppingCompareService } from "../../../services/shopping-compare-service.js";
import { getAgenticMemoryRuntime } from "../../../agentic-memory/index.js";

/**
 * memory.forget / activity.timeline handler + 注册入口。
 *
 * forget 是「按关键词的定向遗忘」统一入口：五处可见台账（兴趣/降价监控/承诺/
 * 计划盯梢/长期记忆）逐处尝试、逐处如实报告，清不了的（如未启用 Mem0）如实说明。
 * 语义记忆的溯源级作废（来源/断言级级联）走既有 memory.invalidate，本工具不重复。
 */
export interface MemoryGovernanceModuleDeps {
  interestWatcher?: InterestWatcher | null;
  commitmentBoard?: CommitmentBoard | null;
  shoppingCompareService?: ShoppingCompareService | null;
  goalBoard?: GoalBoard | null;
  auditTrailService?: AuditTrailService | null;
}

export function createForgetHandler(deps: MemoryGovernanceModuleDeps): ToolHandler {
  return async (input: Record<string, unknown>, context: ToolContext) => {
    const actorId = resolveActorId(context);
    const target = typeof input.target === "string" ? input.target.trim() : "";
    if (target.length < 2) return { ok: false, error: "target 至少 2 个字符（要遗忘的对象关键词）" };
    const scope = typeof input.scope === "string" ? input.scope : "auto";
    const kw = target.toLowerCase();
    const cleared: Record<string, number | string[]> = {
      interests: 0,
      watches: 0,
      commitments: 0,
      goals: 0,
      memories: 0,
    };
    const skipped: string[] = [];
    const hitScope = (s: string): boolean => scope === "auto" || scope === s;

    // 1) 兴趣关注
    if (hitScope("interest")) {
      const watcher = deps.interestWatcher;
      if (!watcher) skipped.push("interest(兴趣池未装配)");
      else {
        const before = watcher.listInterests(actorId).length;
        await watcher.removeInterest(actorId, target);
        cleared.interests = Math.max(0, before - watcher.listInterests(actorId).length);
      }
    }

    // 2) 降价监控
    if (hitScope("watch")) {
      const service = deps.shoppingCompareService;
      if (!service) skipped.push("watch(比价服务未装配)");
      else {
        const watches = service.listWatches(actorId);
        const matched = watches.filter(
          (w) => w.query.toLowerCase().includes(kw) || kw.includes(w.query.toLowerCase()),
        );
        for (const w of matched) await service.removeWatch(actorId, w.id);
        cleared.watches = matched.length;
      }
    }

    // 3) 承诺（文本命中的未完结承诺 → superseded；不级联溯源，那归 memory.invalidate）
    if (hitScope("commitment")) {
      const board = deps.commitmentBoard;
      if (!board) skipped.push("commitment(承诺板未装配)");
      else {
        const items = board.list({ actorId });
        let n = 0;
        for (const c of items) {
          if (!c.text.toLowerCase().includes(kw)) continue;
          const r = board.markSuperseded(c.id, "retract", `用户要求遗忘：${target}`);
          if (!("error" in r)) n += 1;
        }
        cleared.commitments = n;
      }
    }

    // 4) 计划/盯梢目标（系统预执行目标 meeting_prep/morning_brief 不在遗忘范围）
    if (hitScope("plan")) {
      const board = deps.goalBoard;
      if (!board) skipped.push("plan(目标板未装配)");
      else {
        let n = 0;
        for (const g of board.list(actorId)) {
          if (g.kind !== "plan" && g.kind !== "track") continue;
          if (!g.title.toLowerCase().includes(kw)) continue;
          if (board.remove(g.goalId, actorId)) n += 1;
        }
        cleared.goals = n;
      }
    }

    // 5) 长期记忆（Mem0：按关键词检索后按 id 删除；未启用时如实说明）
    if (hitScope("memory")) {
      const runtime = getAgenticMemoryRuntime();
      if (!runtime?.memory || !runtime?.lifecycle) {
        skipped.push("memory(长期记忆系统未启用)");
      } else {
        try {
          const all = (await runtime.memory.getAll({ topK: 10000 })) as {
            results?: Array<{ id: string; memory?: string; metadata?: { actorId?: string } }>;
          };
          const ids = (all.results ?? [])
            .filter((m) => (m.metadata?.actorId ?? actorId) === actorId)
            .filter((m) => String(m.memory ?? "").toLowerCase().includes(kw))
            .map((m) => m.id);
          if (ids.length > 0) {
            const deleted = await runtime.lifecycle.deleteByIds(ids);
            cleared.memories = deleted.length;
          }
        } catch (err) {
          skipped.push(`memory(删除失败：${err instanceof Error ? err.message : String(err)})`);
        }
      }
    }

    const total = (cleared.interests as number) + (cleared.watches as number) + (cleared.commitments as number) + (cleared.goals as number) + (cleared.memories as number);
    return {
      ok: true,
      target,
      ...(typeof input.reason === "string" && input.reason.trim() ? { reason: input.reason.trim() } : {}),
      cleared,
      ...(skipped.length > 0 ? { skipped } : {}),
      hint:
        total > 0
          ? "已按上述范围清除，向用户如实报告各项数量；对话历史原文不删，但不会再被主动引用"
          : "没有匹配到任何台账条目，如实告知用户没找到相关记录，并建议换更具体的关键词",
    };
  };
}

export function createTimelineHandler(deps: MemoryGovernanceModuleDeps): ToolHandler {
  return async (input: Record<string, unknown>, context: ToolContext) => {
    const service = deps.auditTrailService;
    if (!service) return { ok: false, error: "审计时间线未装配" };
    const actorId = resolveActorId(context);
    const limitRaw = typeof input.limit === "number" ? Math.floor(input.limit) : 30;
    const limit = Math.min(Math.max(limitRaw, 1), 60);
    const entries = service.timeline(actorId, limit);
    return {
      ok: true,
      count: entries.length,
      entries,
      summary: service.summary(actorId) ?? "",
      hint: "以真实台账回答（办了什么/在忙什么/等确认什么），不要杜撰台账之外的行动",
    };
  };
}

export function registerMemoryGovernanceTools(registry: ToolRegistry, deps: MemoryGovernanceModuleDeps): void {
  registry.register("memory.forget", createForgetHandler(deps));
  registry.register("activity.timeline", createTimelineHandler(deps));
}
