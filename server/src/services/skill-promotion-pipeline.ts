import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";

import { validateCommunitySkillCandidate, type HttpRouteDepsLike } from "@private-ai-agent/agent-world";

import { skillMetadataFromTrajectoryDraft } from "./skill-promotion-metadata.js";
import type { SkillPromotionQueueService } from "./skill-promotion-queue-service.js";

export type SkillPromotionPipelineMode = "off" | "validate_sync" | "queue";

/** 解析升格后处理模式：默认仅写草稿 JSON；`validate_sync`=立即跑校验 API 同款门禁；`queue`=入队异步校验。 */
export function parseSkillPromotionPipelineMode(): SkillPromotionPipelineMode {
  const raw = process.env.AGENT_SKILL_PROMOTION_PIPELINE?.trim().toLowerCase();
  if (!raw || raw === "draft_only" || raw === "off" || raw === "0") return "off";
  if (raw === "validate_sync" || raw === "immediate" || raw === "validate") return "validate_sync";
  if (raw === "queue" || raw === "async") return "queue";
  return "off";
}

/**
 * `TrajectorySkillPromotionService` 在写出 `*.skill-draft.json` 后调用本类：
 * — `validate_sync`：同步写 `*.skill-draft.validation.json`；
 * — `queue`：投递 `SkillPromotionQueueService`。
 */
export class TrajectoryPromotionPipeline {
  constructor(
    private readonly mode: SkillPromotionPipelineMode,
    private readonly validateDeps: Pick<HttpRouteDepsLike, "skillManager" | "skillMetadataValidator">,
    private readonly queue: SkillPromotionQueueService | null,
  ) {}

  getMode(): SkillPromotionPipelineMode {
    return this.mode;
  }

  async onDraftPersisted(params: {
    draftPath: string;
    draft: Record<string, unknown>;
    traceId: string;
  }): Promise<void> {
    if (this.mode === "off") return;

    if (this.mode === "validate_sync") {
      try {
        const metadata = skillMetadataFromTrajectoryDraft(params.draft, params.traceId);
        const res = await validateCommunitySkillCandidate(this.validateDeps, { metadata });
        const outPath = `${params.draftPath}.validation.json`;
        await writeFile(
          outPath,
          `${JSON.stringify({ traceId: params.traceId, validatedAt: new Date().toISOString(), validation: res }, null, 2)}\n`,
          "utf8",
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await writeFile(
          `${params.draftPath}.validation-sync-error.json`,
          `${JSON.stringify({ traceId: params.traceId, message: msg }, null, 2)}\n`,
          "utf8",
        ).catch(() => {});
      }
      return;
    }

    if (this.mode === "queue" && this.queue) {
      await this.queue.enqueue({
        id: randomUUID(),
        draftPath: params.draftPath,
        traceId: params.traceId,
      });
    }
  }
}
