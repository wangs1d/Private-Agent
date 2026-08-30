import type { FastifyInstance } from "fastify";
import { z } from "zod";
import fs from "fs";
import { travelMediaStore } from "../../skills/travel-planning/travel-media-store.js";
import type { PlanningService } from "../../skills/travel-planning/travel-planning-service.js";

const poiBodySchema = z.object({
  name: z.string().min(1).max(120),
  type: z.enum(["attraction", "hotel", "restaurant"]),
  latitude: z.coerce.number().finite().optional(),
  longitude: z.coerce.number().finite().optional(),
});

const addImageSchema = poiBodySchema.extend({
  url: z.string().url().optional(),
  dataUrl: z.string().max(15 * 1024 * 1024).optional(),
  source: z.enum(["user", "curated", "wikimedia"]).optional(),
  uploader: z.string().max(60).optional(),
  takenAt: z.string().max(40).optional(),
});

const addReviewSchema = poiBodySchema.extend({
  author: z.string().max(60).optional(),
  rating: z.coerce.number().min(1).max(5),
  text: z.string().min(1).max(2000),
  images: z.array(z.string().max(500)).max(9).optional(),
  visitedDate: z.string().max(20).optional(),
  source: z.enum(["user", "imported"]).optional(),
});

const addVideoSchema = poiBodySchema.extend({
  platform: z.string().max(30),
  title: z.string().max(200),
  author: z.string().max(80),
  durationSeconds: z.coerce.number().int().min(0).optional(),
  thumbnailUrl: z.string().max(1000).optional(),
  playPageUrl: z.string().url().max(1000),
});

const updateImageSchema = poiBodySchema.extend({
  url: z.string().min(1).max(1000),
  source: z.enum(["user", "curated", "wikimedia"]).optional(),
  takenAt: z.string().max(40).optional(),
  uploader: z.string().max(60).optional(),
});

const deleteByUrlSchema = poiBodySchema.extend({
  url: z.string().min(1).max(1000),
});

const updateReviewSchema = poiBodySchema.extend({
  reviewId: z.string().min(1).max(80),
  rating: z.coerce.number().min(1).max(5).optional(),
  text: z.string().min(1).max(2000).optional(),
  author: z.string().max(60).optional(),
});

const deleteReviewSchema = poiBodySchema.extend({
  reviewId: z.string().min(1).max(80),
});

const deleteVideoSchema = poiBodySchema.extend({
  playPageUrl: z.string().min(1).max(1000),
});

const backfillSchema = poiBodySchema;

/**
 * POI 媒体库路由：本地上传实拍图、评论、视频（元数据+播放页），
 * 供行程面板展示与排序聚合分使用。视频不自托管，只存元数据 + 播放页跳转。
 *
 * 管理端：图片/评论/视频的更新与删除（PUT/DELETE），以及单 POI 手动回填
 * （自动回填被 TRAVEL_MEDIA_BACKFILL=off 关闭时的替代写入路径）。
 */
export function registerTravelMediaRoutes(
  app: FastifyInstance,
  deps: { travelPlanningService?: PlanningService } = {},
): void {
  /** 查询单个 POI 的媒体（含聚合统计） */
  app.get("/travel/media", async (request, reply) => {
    const parsed = poiBodySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const { name, type, latitude, longitude } = parsed.data;
    const entry = travelMediaStore.get(type, name);
    if (!entry) return { ok: true, exists: false, aggregate: null };
    return {
      ok: true,
      exists: true,
      poiKey: entry.poiKey,
      name: entry.name,
      type: entry.type,
      latitude: entry.latitude ?? latitude,
      longitude: entry.longitude ?? longitude,
      images: entry.images,
      reviews: entry.reviews,
      videos: entry.videos,
      aggregate: travelMediaStore.aggregate(type, name),
    };
  });

  /** 上传实拍图：body 传 dataUrl（自动落盘）或外链 url */
  app.post("/travel/media/images", async (request, reply) => {
    const parsed = addImageSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const { name, type, latitude, longitude, ...img } = parsed.data;
    const result = travelMediaStore.addImage(
      type,
      name,
      img,
      latitude !== undefined && longitude !== undefined ? { latitude, longitude } : undefined,
    );
    if (!result.ok) return reply.code(400).send(result);
    return { ok: true, image: result.image, aggregate: travelMediaStore.aggregate(type, name) };
  });

  /** 写入评论（1-5 分 + 文本，可附图） */
  app.post("/travel/media/reviews", async (request, reply) => {
    const parsed = addReviewSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const { name, type, latitude, longitude, ...review } = parsed.data;
    const result = travelMediaStore.addReview(
      type,
      name,
      review,
      latitude !== undefined && longitude !== undefined ? { latitude, longitude } : undefined,
    );
    if (!result.ok) return reply.code(400).send(result);
    return { ok: true, review: result.review, aggregate: travelMediaStore.aggregate(type, name) };
  });

  /** 登记视频：只存元数据 + 封面 + 播放页链接（抖音/小红书/B站等，不自托管文件） */
  app.post("/travel/media/videos", async (request, reply) => {
    const parsed = addVideoSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const { name, type, latitude, longitude, ...video } = parsed.data;
    const result = travelMediaStore.addVideo(
      type,
      name,
      video,
      latitude !== undefined && longitude !== undefined ? { latitude, longitude } : undefined,
    );
    if (!result.ok) return reply.code(400).send(result);
    return { ok: true, aggregate: travelMediaStore.aggregate(type, name) };
  });

  // ======================== 管理端：更新 / 删除 / 回填 ========================

  /** 更新图片元数据（来源/拍摄时间/上传者；改 source 会影响展示优先级） */
  app.put("/travel/media/images", async (request, reply) => {
    const parsed = updateImageSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const { name, type, url, ...patch } = parsed.data;
    const updated = travelMediaStore.updateImage(type, name, url, patch);
    if (!updated) return reply.code(404).send({ ok: false, error: "图片不存在" });
    return { ok: true, aggregate: travelMediaStore.aggregate(type, name) };
  });

  /** 删除图片（本地 assets 文件一并清理） */
  app.delete("/travel/media/images", async (request, reply) => {
    const parsed = deleteByUrlSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const { name, type, url } = parsed.data;
    const removed = travelMediaStore.removeImage(type, name, url);
    if (!removed) return reply.code(404).send({ ok: false, error: "图片不存在" });
    return { ok: true, aggregate: travelMediaStore.aggregate(type, name) };
  });

  /** 更新评论（评分/文本/作者） */
  app.put("/travel/media/reviews", async (request, reply) => {
    const parsed = updateReviewSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const { name, type, ...patch } = parsed.data;
    const updated = travelMediaStore.updateReview(type, name, patch.reviewId, patch);
    if (!updated) return reply.code(404).send({ ok: false, error: "评论不存在或参数非法" });
    return { ok: true, review: updated, aggregate: travelMediaStore.aggregate(type, name) };
  });

  /** 删除评论 */
  app.delete("/travel/media/reviews", async (request, reply) => {
    const parsed = deleteReviewSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const { name, type, reviewId } = parsed.data;
    const removed = travelMediaStore.removeReview(type, name, reviewId);
    if (!removed) return reply.code(404).send({ ok: false, error: "评论不存在" });
    return { ok: true, aggregate: travelMediaStore.aggregate(type, name) };
  });

  /** 删除视频登记 */
  app.delete("/travel/media/videos", async (request, reply) => {
    const parsed = deleteVideoSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const { name, type, playPageUrl } = parsed.data;
    const removed = travelMediaStore.removeVideo(type, name, playPageUrl);
    if (!removed) return reply.code(404).send({ ok: false, error: "视频不存在" });
    return { ok: true, aggregate: travelMediaStore.aggregate(type, name) };
  });

  /** 手动回填单个 POI 的 Wikimedia 图片（自动回填关闭时的替代路径） */
  app.post("/travel/media/backfill", async (request, reply) => {
    if (!deps.travelPlanningService) {
      return reply.code(503).send({ ok: false, error: "规划服务未装配，无法回填" });
    }
    const parsed = backfillSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const { name, type, latitude, longitude } = parsed.data;
    try {
      const images = await deps.travelPlanningService.backfillMediaForPoi(
        name,
        type,
        latitude,
        longitude,
      );
      return {
        ok: true,
        filled: images.length,
        images,
        aggregate: travelMediaStore.aggregate(type, name),
      };
    } catch (err) {
      return reply.code(502).send({
        ok: false,
        error: `回填失败：${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });

  /** 媒体库静态资源（上传实拍图）。文件名严格校验防穿越，长缓存（内容不可变）。 */
  app.get<{ Params: { dir: string; fileName: string } }>(
    "/travel/media/assets/:dir/:fileName",
    async (request, reply) => {
      const { dir, fileName } = request.params;
      const full = travelMediaStore.resolveAssetPath(dir, fileName);
      if (!full) return reply.code(404).send({ ok: false, reason: "NOT_FOUND" });
      const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
      const mime =
        ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : ext === "gif" ? "image/gif" : "image/jpeg";
      void reply.header("Content-Type", mime);
      void reply.header("Cache-Control", "public, max-age=2592000, immutable");
      return reply.send(fs.createReadStream(full));
    },
  );

  /** 域索引（与其他路由域一致的自我描述） */
  app.get("/travel/media/_meta", async () => ({
    domain: "travel-media",
    endpoints: [
      "GET  /travel/media?name=&type=&latitude=&longitude=",
      "POST /travel/media/images   {name,type,dataUrl|url,source?,uploader?}",
      "POST /travel/media/reviews  {name,type,rating,text,author?}",
      "POST /travel/media/videos   {name,type,platform,title,author,playPageUrl}",
      "GET  /travel/media/assets/:dir/:fileName",
      "PUT    /travel/media/images   {name,type,url,source?,takenAt?,uploader?}",
      "DELETE /travel/media/images   {name,type,url}",
      "PUT    /travel/media/reviews  {name,type,reviewId,rating?,text?,author?}",
      "DELETE /travel/media/reviews  {name,type,reviewId}",
      "DELETE /travel/media/videos   {name,type,playPageUrl}",
      "POST   /travel/media/backfill {name,type,latitude?,longitude?}",
    ],
    note: "poiKey 归一化规则见 travel-media-store.ts poiKeyOf()，上传与查询需使用同一 name/type",
  }));
}
