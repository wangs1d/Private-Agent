import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { validateCommunitySkillCandidate, type HttpRouteDepsLike } from "@private-ai-agent/agent-world";

import { skillMetadataFromTrajectoryDraft } from "./skill-promotion-metadata.js";

export type SkillPromotionQueueJob = {
  id: string;
  draftPath: string;
  traceId: string;
  enqueuedAt: string;
};

type QueueEnvelope = {
  jobs: SkillPromotionQueueJob[];
};

function parsePromotionPipelineJobsPath(): string {
  return (
    process.env.AGENT_SKILL_PROMOTION_QUEUE_FILE?.trim() ||
    join(process.cwd(), "data", "skill-promotion-queue", "jobs.json")
  );
}

/**
 * Skill 升格 **异步校验**队列：`enqueue` → 周期性 `processOne`。
 * Body 仍为「轨迹草稿」，处理时生成占位 `SkillMetadata` 调用 `validateCommunitySkillCandidate`，
 * 将结果写入 `*.skill-draft.validation.json`，**不触发实际上架**。
 */
export class SkillPromotionQueueService {
  private readonly queuePath: string;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | undefined;
  private processing = false;

  constructor(
    private readonly deps: Pick<HttpRouteDepsLike, "skillManager" | "skillMetadataValidator">,
    opts?: { queuePath?: string; intervalMs?: number },
  ) {
    this.queuePath = opts?.queuePath ?? parsePromotionPipelineJobsPath();
    const raw = Number.parseInt(process.env.AGENT_SKILL_PROMOTION_QUEUE_INTERVAL_MS ?? "", 10);
    this.intervalMs =
      opts?.intervalMs ?? (Number.isFinite(raw) && raw >= 250 ? raw : 4000);
  }

  /** 需在进程启动后显式调用 */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.processOneSafely();
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async enqueue(job: Omit<SkillPromotionQueueJob, "enqueuedAt">): Promise<void> {
    const full: SkillPromotionQueueJob = {
      ...job,
      enqueuedAt: new Date().toISOString(),
    };
    const envelope = await this.load();
    envelope.jobs.push(full);
    await this.save(envelope);
  }

  private async processOneSafely(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      await this.processOne();
    } catch (e) {
      console.warn(
        "[skill-promotion-queue] process error:",
        e instanceof Error ? e.message : e,
      );
    } finally {
      this.processing = false;
    }
  }

  /** 可被测试或运维手动触发 drain */
  async processOne(): Promise<void> {
    const envelope = await this.load();
    const job = envelope.jobs.shift();
    await this.save(envelope);
    if (!job) return;

    try {
      const raw = JSON.parse(await readFile(job.draftPath, "utf8")) as Record<string, unknown>;
      const metadata = skillMetadataFromTrajectoryDraft(raw, job.traceId);
      const res = await validateCommunitySkillCandidate(this.deps, { metadata });

      const outPath = `${job.draftPath}.validation.json`;
      await writeFile(
        outPath,
        `${JSON.stringify({ traceId: job.traceId, jobId: job.id, validatedAt: new Date().toISOString(), validation: res }, null, 2)}\n`,
        "utf8",
      ).catch(async () => {
        await writeFile(
          `${job.draftPath}.validation-failed-write.txt`,
          "failed validation json write\n",
          "utf8",
        );
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await writeFile(
        `${job.draftPath}.queue-error.json`,
        `${JSON.stringify({ ok: false, traceId: job.traceId, jobId: job.id, message: msg }, null, 2)}\n`,
        "utf8",
      ).catch(() => {});
    }
  }

  private async load(): Promise<QueueEnvelope> {
    try {
      const buf = await readFile(this.queuePath, "utf8");
      const p = JSON.parse(buf) as QueueEnvelope;
      if (Array.isArray(p?.jobs)) return { jobs: p.jobs };
    } catch {
      /* empty */
    }
    return { jobs: [] };
  }

  /** 近似原子写：rename */
  private async save(env: QueueEnvelope): Promise<void> {
    await mkdir(dirname(this.queuePath), { recursive: true });
    const tmp = `${this.queuePath}.${Date.now().toString(36)}.tmp`;
    await writeFile(tmp, `${JSON.stringify(env, null, 2)}\n`, "utf8");
    await rename(tmp, this.queuePath).catch(async () => {
      await writeFile(this.queuePath, `${JSON.stringify(env, null, 2)}\n`, "utf8");
      await unlink(tmp).catch(() => {});
    });
  }
}
