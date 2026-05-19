import { resolveActorId } from "../agent/actor-id.js";
import type { ToolRegistry } from "./tool-registry.js";
import type { VisionPeriodicScheduler } from "../vision/vision-periodic-scheduler.js";
import { fetchHttpVisionFrame } from "../vision/fetch-http-vision-frame.js";

const INJECT_KEY = "_injectVisionUserMessage";

export function registerVisionTools(registry: ToolRegistry, periodic: VisionPeriodicScheduler): void {
  registry.register("vision.http_pull", async (input, ctx) => {
    const url = String(input.url ?? "").trim();
    if (!url) {
      return { ok: false, error: "需要 url" };
    }
    const sourceId = input.sourceId != null ? String(input.sourceId).trim().slice(0, 160) : undefined;
    try {
      const frame = await fetchHttpVisionFrame(url, "external_stream", sourceId);
      return {
        ok: true,
        mimeType: frame.mimeType,
        byteLength: Buffer.byteLength(frame.dataBase64, "base64"),
        sourceKind: frame.sourceKind,
        sourceId: frame.sourceId,
        hint: "图像已注入紧随其后的模型上下文（用于视觉描述），请勿重复下载同一 URL 除非场景变化。",
        [INJECT_KEY]: [frame],
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: msg };
    }
  });

  registry.register("vision.periodic_start", async (input, ctx) => {
    const actorId = resolveActorId(ctx);
    const url = String(input.url ?? "").trim();
    const intervalSeconds = Number(input.intervalSeconds);
    const prompt = input.prompt != null ? String(input.prompt) : undefined;
    const r = periodic.startJob(actorId, { url, intervalSeconds, prompt });
    if (!r.ok) {
      return { ok: false, error: r.error };
    }
    return {
      ok: true,
      jobId: r.jobId,
      message: "已启动服务端定时拉流抓帧；每个周期会向模型发送带图消息（需 WebSocket 在线接收回复）。",
    };
  });

  registry.register("vision.periodic_stop", async (input, ctx) => {
    const actorId = resolveActorId(ctx);
    const jobId = String(input.jobId ?? "").trim();
    if (!jobId) {
      return { ok: false, error: "需要 jobId" };
    }
    const r = periodic.stopJob(actorId, jobId);
    if (!r.ok) {
      return { ok: false, error: r.reason ?? "停止失败" };
    }
    return { ok: true, message: "已停止该定时视觉任务" };
  });

  registry.register("vision.periodic_stop_all", async (_input, ctx) => {
    const actorId = resolveActorId(ctx);
    const n = periodic.stopAllForActor(actorId);
    return { ok: true, stoppedCount: n };
  });

  registry.register("vision.periodic_list", async (_input, ctx) => {
    const actorId = resolveActorId(ctx);
    const jobs = periodic.listForActor(actorId);
    return { ok: true, jobs };
  });
}
