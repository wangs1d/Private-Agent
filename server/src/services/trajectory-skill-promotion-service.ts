import { createHash } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { TaskExecutionPlan } from "../agent/plan-execute-loop.js";
import type { TrajectoryPromotionPipeline } from "./skill-promotion-pipeline.js";

export type TrajectoryToolRecord = { name: string; ok: boolean; snippet?: string };

export type HermesObservePhase = {
  ts: string;
  kind: "user_turn" | "tool_batch" | "plan_executed" | "self_check" | "hermes_reflect";
  detail?: Record<string, unknown>;
};

/**
 * Hermes 风格：observe（轨迹写入）→ reflect（启发式）→ consolidate（升格 Skill 草稿，需人工审核上架）。
 *
 * ENV:
 * - `AGENT_TRAJECTORY_JSONL`: 轨迹文件（默认 data/hermes-trajectories.jsonl）
 * - `AGENT_SKILL_PROMOTION_DRAFTS_DIR`: 草稿目录（默认 data/skill-promotion-drafts）
 * - `AGENT_SKILL_PROMOTION_MIN_TOOLS` / `MIN_UNIQUE_TOOLS`（默认 2）
 * - `AGENT_SKILL_PROMOTION_REQUIRE_PE_PASS=1`: 若在 PE 环下则要求未 exhaustedRetries 才升格
 * - `AGENT_SKILL_PROMOTION_PIPELINE=validate_sync|queue|off|draft_only`: 草稿后 **同步校验** 或 **入队异步校验**（与 POST `/world/market/skills/validate` 同源）
 * - `AGENT_SKILL_PROMOTION_QUEUE_INTERVAL_MS` / `AGENT_SKILL_PROMOTION_QUEUE_FILE`
 */

function envInt(name: string, def: number): number {
  const v = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(v) ? v : def;
}

export function isSkillPromotionFromTrajectoryEnabled(): boolean {
  const raw = process.env.AGENT_SKILL_PROMOTION_FROM_TRAJECTORY?.trim().toLowerCase();
  if (!raw || raw === "0" || raw === "false" || raw === "no" || raw === "off") {
    return false;
  }
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

export class TrajectorySkillPromotionService {
  private readonly trajectoryPath: string;
  private readonly draftsDir: string;
  private readonly minToolsOk: number;
  private readonly minUniqueTools: number;

  constructor(private readonly promotionPipeline?: TrajectoryPromotionPipeline | null) {
    this.trajectoryPath =
      process.env.AGENT_TRAJECTORY_JSONL?.trim() ||
      join(process.cwd(), "data", "hermes-trajectories.jsonl");
    this.draftsDir =
      process.env.AGENT_SKILL_PROMOTION_DRAFTS_DIR?.trim() ||
      join(process.cwd(), "data", "skill-promotion-drafts");
    this.minToolsOk = Math.max(1, envInt("AGENT_SKILL_PROMOTION_MIN_TOOLS", 2));
    this.minUniqueTools = Math.max(1, envInt("AGENT_SKILL_PROMOTION_MIN_UNIQUE_TOOLS", 2));
  }

  beginCapture(actorId: string, chatUserMessageId: string | undefined, userText: string): TrajectoryCapture {
    return new TrajectoryCapture({
      trajectoryPath: this.trajectoryPath,
      draftsDir: this.draftsDir,
      minToolsOk: this.minToolsOk,
      minUniqueTools: this.minUniqueTools,
      actorId,
      chatUserMessageId: chatUserMessageId ?? "",
      userText,
      promotionPipeline: this.promotionPipeline ?? null,
    });
  }
}

export type TrajectoryCaptureMeta = {
  planExecuteEnabled: boolean;
  modelCallsApprox: number;
  pePlan: TaskExecutionPlan | null;
  peExhaustedRetries: boolean;
};

export class TrajectoryCapture {
  private readonly tools: TrajectoryToolRecord[] = [];
  private readonly phases: HermesObservePhase[] = [];

  constructor(
    private readonly ctx: {
      trajectoryPath: string;
      draftsDir: string;
      minToolsOk: number;
      minUniqueTools: number;
      actorId: string;
      chatUserMessageId: string;
      userText: string;
      promotionPipeline: TrajectoryPromotionPipeline | null;
    },
  ) {
    this.phases.push({
      ts: new Date().toISOString(),
      kind: "user_turn",
      detail: { len: ctx.userText.length },
    });
  }

  observeToolExecuted(info: { toolName: string; ok: boolean; result?: Record<string, unknown> }): void {
    const snippet = info.result ?
      JSON.stringify(info.result).replace(/\s+/g, " ").slice(0, 400)
    : "";
    this.tools.push({ name: info.toolName, ok: info.ok, snippet });
  }

  observePePlan(plan: TaskExecutionPlan | null): void {
    this.phases.push({
      ts: new Date().toISOString(),
      kind: "plan_executed",
      detail: { hasPlan: !!plan, goalLen: plan?.goal?.length ?? 0 },
    });
  }

  observeSelfCheck(summary: string, pass?: boolean): void {
    this.phases.push({
      ts: new Date().toISOString(),
      kind: "self_check",
      detail: { pass, summary: summary.slice(0, 480) },
    });
  }

  /** Hermes consolidate：在满足闸门时写入 Skill 草稿 JSON（非自动上架）。 */
  async finalizeHermes(
    assistantFinal: string,
    meta: TrajectoryCaptureMeta,
  ): Promise<{ trajectoryLine: boolean; draftPath?: string }> {
    await mkdir(dirname(this.ctx.trajectoryPath), { recursive: true });
    const traceDigest = createHash("sha256")
      .update(`${this.ctx.actorId}|${this.ctx.chatUserMessageId}|${Date.now()}|${Math.random()}`)
      .digest("hex")
      .slice(0, 16);
    const line = {
      type: "trajectory_finalize",
      traceId: traceDigest,
      ts: new Date().toISOString(),
      actorId: this.ctx.actorId,
      chatUserMessageId: this.ctx.chatUserMessageId,
      userSnippet: this.ctx.userText.replace(/\s+/g, " ").slice(0, 400),
      assistantSnippet: assistantFinal.replace(/\s+/g, " ").slice(0, 600),
      tools: this.tools,
      phases: this.phases,
      meta,
    };
    await appendFile(this.ctx.trajectoryPath, `${JSON.stringify(line)}\n`, "utf8").catch(() => {});

    if (!isSkillPromotionFromTrajectoryEnabled()) {
      return { trajectoryLine: true };
    }

    const reqPe =
      process.env.AGENT_SKILL_PROMOTION_REQUIRE_PE_PASS?.trim() === "1" ||
      process.env.AGENT_SKILL_PROMOTION_REQUIRE_PE_PASS?.toLowerCase() === "true";
    if (reqPe && meta.planExecuteEnabled && meta.peExhaustedRetries) {
      return { trajectoryLine: true };
    }

    const okTools = this.tools.filter((t) => t.ok);
    if (okTools.length < this.ctx.minToolsOk) {
      return { trajectoryLine: true };
    }
    const uniq = new Set(okTools.map((t) => t.name));
    if (uniq.size < this.ctx.minUniqueTools) {
      return { trajectoryLine: true };
    }

    const reflectSummary = Array.from(uniq.values()).slice(0, 24).join(" → ");
    const draft = {
      $schema_hint: "Community skill promotion draft — requires human validation before upload",
      title: `[draft] trajectory ${traceDigest}`,
      description: `由轨迹自动提炼：${reflectSummary}. 用户任务摘要：${this.ctx.userText.slice(0, 140)}`,
      derivedFromTrajectory: traceDigest,
      toolSequenceHint: Array.from(uniq.values()),
      hermes_reflect: `成功工具计数=${okTools.length}；distinct=${uniq.size}`,
      proceduralHint:
        meta.pePlan ?
          `按计划 goal:「${meta.pePlan.goal}」，关键步骤：` +
          meta.pePlan.steps.map((s) => s.intent).join(" ; ")
        : "无结构化计划片段；请参照 toolSequenceHint",
    };

    await mkdir(this.ctx.draftsDir, { recursive: true }).catch(() => {});
    const path = join(this.ctx.draftsDir, `${traceDigest}.skill-draft.json`);
    await writeFile(path, `${JSON.stringify(draft, null, 2)}\n`, "utf8");
    await appendFile(
      this.ctx.trajectoryPath,
      `${JSON.stringify({ type: "skill_draft_promoted", traceId: traceDigest, path, ts: new Date().toISOString() })}\n`,
      "utf8",
    ).catch(() => {});

    void this.ctx.promotionPipeline
      ?.onDraftPersisted({
        draftPath: path,
        draft: draft as Record<string, unknown>,
        traceId: traceDigest,
      })
      .catch(() => {});

    return { trajectoryLine: true, draftPath: path };
  }
}
