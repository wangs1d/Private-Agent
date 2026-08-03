import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";

import { validateCommunitySkillCandidate, type HttpRouteDepsLike } from "@private-ai-agent/agent-world";

import { skillMetadataFromTrajectoryDraft } from "./skill-promotion-metadata.js";
import type { SkillPromotionQueueService } from "./skill-promotion-queue-service.js";
import type { SkillMetadata } from "../skills/types.js";

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
 * Skill 装载成功后的通知回调。
 *
 * 由 bootstrap 阶段注入实现，负责把自我进化生成的新能力同步到：
 *  - CapabilityCortex（让 agent.query_capabilities 可见）
 *  - 动态 fastLane 名单（若 Skill 标记为 fast_lane，让 Fast 模式可收编）
 *  - builtin / fastLane 工具缓存清除（确保下次请求看到新能力）
 */
export type OnSkillPromotedCallback = (params: {
  metadata: SkillMetadata;
  skillName: string;
}) => void;

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
    /**
     * Skill 装载成功后的通知回调（自我进化能力与工具收编结合的关键钩子）。
     * 装载成功后触发，把新 Skill 的 metadata + skillName 传给调用方，
     * 由调用方决定如何同步到 CapabilityCortex / 动态 fastLane / 缓存。
     */
    private readonly onSkillPromoted?: OnSkillPromotedCallback,
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

  /**
   * 把 SkillGenerator 生成的代码编译并装载到 SkillManager（自我进化用）。
   *
   * 调用 SkillManager.registerFromCode：
   * 1. 安全扫描 handlerCode（拒绝 process./require/eval/Function/__dirname 等危险模式）
   * 2. 用 new Function 编译 handlerCode 为 SkillHandler 函数
   * 3. 注册到 SkillManager，立即可被 ToolRegistry.execute 调用
   *
   * @returns ok=true 表示装载成功，Skill 已可用
   */
  async promote(skill: {
    metadata: SkillMetadata;
    handlerCode: string;
  }): Promise<{ ok: boolean; error?: string }> {
    const skillManager = this.validateDeps.skillManager;
    if (!skillManager) {
      return { ok: false, error: "SkillManager 未注入" };
    }

    if (typeof skillManager.registerFromCode !== "function") {
      return { ok: false, error: "SkillManager 未实现 registerFromCode 方法" };
    }

    const result = skillManager.registerFromCode(skill.metadata, skill.handlerCode, {
      autoEnable: true,
    });

    if (!result.ok) {
      return { ok: false, error: result.error ?? "未知错误" };
    }

    // 装载成功后触发通知回调：同步 CapabilityCortex + 动态 fastLane + 缓存清除
    // 回调失败不影响装载结果（fire-and-forget，错误静默吞掉）
    if (this.onSkillPromoted) {
      try {
        this.onSkillPromoted({
          metadata: skill.metadata,
          skillName: result.skillName!,
        });
      } catch (e) {
        console.warn(
          `[TrajectoryPromotionPipeline] onSkillPromoted 回调失败（不影响装载）:`,
          e instanceof Error ? e.message : e,
        );
      }
    }

    console.log(
      `✅ [TrajectoryPromotionPipeline] Skill '${result.skillName}' 已通过自我进化路径装载`,
    );
    return { ok: true };
  }
}
