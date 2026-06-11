import { randomUUID } from "node:crypto";

import type { AgentCore } from "../services/agent-core.js";
import { getToolResultProcessor } from "../services/tool-result-processor.js";
import type { WsConnectionRegistry } from "../services/ws-connection-registry.js";
import { ServerEventType } from "../protocol.js";
import { chunkText, dedupeAdjacentLines } from "../utils/text.js";
import { fetchHttpVisionFrame } from "./fetch-http-vision-frame.js";

export type VisionPeriodicSchedulerDeps = {
  agentCore: AgentCore;
  wsRegistry: WsConnectionRegistry;
};

type InternalJob = {
  jobId: string;
  actorId: string;
  url: string;
  intervalMs: number;
  prompt: string;
  timer: NodeJS.Timeout;
};

function envInt(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * 服务端定时从 HTTP(S) 快照 URL 拉帧并触发一轮带视觉的 Agent 推理（需客户端 WebSocket 在线以接收流式回复）。
 */
export class VisionPeriodicScheduler {
  private readonly jobs = new Map<string, InternalJob>();
  private readonly runningFire = new Set<string>();

  constructor(private readonly deps: VisionPeriodicSchedulerDeps) {}

  startJob(
    actorId: string,
    params: { url: string; intervalSeconds: number; prompt?: string },
  ): { ok: true; jobId: string } | { ok: false; error: string } {
    const url = params.url.trim();
    if (!url) {
      return { ok: false, error: "需要 url" };
    }
    const minSec = Math.min(3600, envInt("AGENT_VISION_PERIODIC_MIN_INTERVAL_SEC", 30));
    const maxSec = Math.min(86400, envInt("AGENT_VISION_PERIODIC_MAX_INTERVAL_SEC", 3600));
    let sec = Number(params.intervalSeconds);
    if (!Number.isFinite(sec)) {
      sec = minSec;
    }
    sec = Math.round(sec);
    if (sec < minSec) {
      return { ok: false, error: `intervalSeconds 过小，最小 ${minSec}s` };
    }
    if (sec > maxSec) {
      return { ok: false, error: `intervalSeconds 过大，最大 ${maxSec}s` };
    }
    const maxJobs = Math.min(32, envInt("AGENT_VISION_PERIODIC_MAX_JOBS_PER_ACTOR", 4));
    const actorJobCount = [...this.jobs.values()].filter((j) => j.actorId === actorId).length;
    if (actorJobCount >= maxJobs) {
      return { ok: false, error: `每位用户最多 ${maxJobs} 个定时视觉任务` };
    }

    const jobId = randomUUID();
    const intervalMs = sec * 1000;
    const prompt =
      params.prompt?.trim() ||
      "（定时视觉巡检）请根据图像简述可见内容与异常点；若无异常则说明「无明显变化」。";

    const job: InternalJob = {
      jobId,
      actorId,
      url,
      intervalMs,
      prompt,
      timer: setInterval(() => {
        void this.fire(job);
      }, intervalMs),
    };
    this.jobs.set(jobId, job);
    void this.fire(job);
    return { ok: true, jobId };
  }

  stopJob(actorId: string, jobId: string): { ok: boolean; reason?: string } {
    const j = this.jobs.get(jobId);
    if (!j) {
      return { ok: false, reason: "任务不存在" };
    }
    if (j.actorId !== actorId) {
      return { ok: false, reason: "无权停止该任务" };
    }
    clearInterval(j.timer);
    this.jobs.delete(jobId);
    return { ok: true };
  }

  stopAllForActor(actorId: string): number {
    let n = 0;
    for (const [id, j] of [...this.jobs.entries()]) {
      if (j.actorId === actorId) {
        clearInterval(j.timer);
        this.jobs.delete(id);
        n += 1;
      }
    }
    return n;
  }

  listForActor(actorId: string): Array<{ jobId: string; url: string; intervalSeconds: number; prompt: string }> {
    return [...this.jobs.values()]
      .filter((j) => j.actorId === actorId)
      .map((j) => ({
        jobId: j.jobId,
        url: j.url,
        intervalSeconds: Math.round(j.intervalMs / 1000),
        prompt: j.prompt,
      }));
  }

  /** @internal 测试：清理全部定时器 */
  disposeAll(): void {
    for (const j of this.jobs.values()) {
      clearInterval(j.timer);
    }
    this.jobs.clear();
  }

  private async fire(job: InternalJob): Promise<void> {
    if (this.runningFire.has(job.jobId)) {
      return;
    }
    this.runningFire.add(job.jobId);
    const messageId = `vision-periodic-${job.jobId}-${Date.now()}`;
    const assistantMsgId = `assistant-${messageId}`;

    try {
      let frame;
      try {
        frame = await fetchHttpVisionFrame(job.url, "external_stream", `periodic:${job.jobId}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.deps.wsRegistry.trySend(
          job.actorId,
          JSON.stringify({
            type: ServerEventType.ErrorEvent,
            payload: {
              code: "VISION_PERIODIC_FETCH_FAILED",
              message: msg,
              jobId: job.jobId,
            },
          }),
        );
        return;
      }

      let chunkSeq = 0;
      const reply = await this.deps.agentCore.handleUserMessage(job.actorId, job.prompt, {
        chatUserMessageId: messageId,
        visionFrames: [frame],
        onAssistantDelta: (delta) => {
          this.deps.wsRegistry.trySend(
            job.actorId,
            JSON.stringify({
              type: ServerEventType.ChatAssistantChunk,
              payload: {
                sessionId: job.actorId,
                messageId: assistantMsgId,
                chunk: delta,
                sequence: chunkSeq++,
              },
            }),
          );
        },
        onExternalToolExecuted: (info) => {
          this.deps.wsRegistry.trySend(
            job.actorId,
            JSON.stringify({
              type: ServerEventType.ToolCall,
              payload: {
                toolName: info.toolName,
                input: info.input,
                traceId: messageId,
              },
            }),
          );
          const res = { ...info.result };
          delete res._injectVisionUserMessage;
          this.deps.wsRegistry.trySend(
            job.actorId,
            JSON.stringify({
              type: ServerEventType.ToolResult,
              payload: {
                toolName: info.toolName,
                ok: info.ok,
                result: res,
                traceId: messageId,
              },
            }),
          );
        },
      });

      if (!reply.streamedChunks) {
        const chunks = chunkText(reply.text, 12);
        chunks.forEach((chunk, index) => {
          this.deps.wsRegistry.trySend(
            job.actorId,
            JSON.stringify({
              type: ServerEventType.ChatAssistantChunk,
              payload: {
                sessionId: job.actorId,
                messageId: assistantMsgId,
                chunk,
                sequence: index,
              },
            }),
          );
        });
      }

      this.deps.wsRegistry.trySend(
        job.actorId,
        JSON.stringify({
          type: ServerEventType.ChatAssistantDone,
          payload: {
            sessionId: job.actorId,
            messageId: assistantMsgId,
            finalText: getToolResultProcessor().processAssistantText(
              dedupeAdjacentLines((reply.text ?? "").trim()),
              { userText: job.prompt },
            ),
            toolCalls: reply.toolName ? [reply.toolName] : [],
            visionPeriodicJobId: job.jobId,
          },
        }),
      );
    } finally {
      this.runningFire.delete(job.jobId);
    }
  }
}
