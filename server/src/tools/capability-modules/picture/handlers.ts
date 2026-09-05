import type { ToolHandler } from "../../tool-registry.js";
import type { PictureKit, ImageAsset } from "@private-ai-agent/picture";
import { listBeautyStyles } from "@private-ai-agent/picture";

/**
 * picture.gallery / picture.beautify 工具 handler。
 *
 * 图库数据源是 `@private-ai-agent/picture` 的 PictureKit(存储根 data/pictures);
 * 返回给 LLM 的条目附带缩略图/原图 URL(由 routes/http/picture.ts 提供静态服务),
 * 客户端可直接展示。
 */

function assetUrls(asset: ImageAsset): { thumbnailUrl: string; imageUrl: string } {
  return {
    thumbnailUrl: `/picture/assets/${asset.id}/thumbnail/small`,
    imageUrl: `/picture/assets/${asset.id}/file`,
  };
}

function assetSummary(asset: ImageAsset): Record<string, unknown> {
  return {
    id: asset.id,
    fileName: asset.fileName,
    width: asset.width,
    height: asset.height,
    tags: asset.tags,
    rating: asset.rating,
    sceneType: asset.sceneType,
    takenAt: asset.takenAt,
    createdAt: asset.createdAt,
    ...assetUrls(asset),
  };
}

export function createPictureGalleryHandler(pictureKit: PictureKit): ToolHandler {
  return async (input) => {
    const action = String(input.action ?? "query");
    try {
      switch (action) {
        case "query": {
          const page = Math.max(1, Number(input.page ?? 1) || 1);
          const pageSize = Math.min(50, Math.max(1, Number(input.pageSize ?? 20) || 20));
          const result = await pictureKit.store.query({
            filters: typeof input.tagFilter === "string" && input.tagFilter ? { tags: [input.tagFilter] } : undefined,
            page,
            pageSize,
          });
          return {
            ok: true,
            total: result.total,
            page: result.page,
            pageSize: result.pageSize,
            photos: result.items.map(assetSummary),
          };
        }
        case "get": {
          const asset = pictureKit.store.get(String(input.photoId ?? ""));
          if (!asset) {
            return { ok: false, error: `照片不存在: ${String(input.photoId ?? "")}` };
          }
          return { ok: true, photo: assetSummary(asset) };
        }
        case "add_tag":
          return { ok: true, photo: assetSummary(await pictureKit.store.addTag(String(input.photoId), String(input.tag ?? "收藏"))) };
        case "remove_tag":
          return { ok: true, photo: assetSummary(await pictureKit.store.removeTag(String(input.photoId), String(input.tag ?? ""))) };
        case "set_rating":
          return { ok: true, photo: assetSummary(await pictureKit.store.setRating(String(input.photoId), Number(input.rating ?? 0))) };
        case "set_scene":
          return { ok: true, photo: assetSummary(await pictureKit.store.setSceneType(String(input.photoId), String(input.sceneType ?? ""))) };
        case "stats":
          return { ok: true, stats: pictureKit.store.stats() };
        default:
          return { ok: false, error: `未知的 picture.gallery action: ${action}` };
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };
}

export function createPictureBeautifyHandler(pictureKit: PictureKit): ToolHandler {
  return async (input) => {
    try {
      const style = typeof input.style === "string" && input.style ? input.style : undefined;
      const sceneType = typeof input.sceneType === "string" && input.sceneType ? input.sceneType : undefined;
      const adjustments =
        input.adjustments && typeof input.adjustments === "object"
          ? (input.adjustments as Record<string, number>)
          : undefined;
      if (!style && !sceneType && !adjustments) {
        return { ok: false, error: "请至少指定 style / sceneType / adjustments 之一" };
      }

      // 目标照片:显式 ids,或图库最新一张
      let photoIds = Array.isArray(input.photoIds) ? input.photoIds.map(String) : [];
      if (photoIds.length === 0) {
        const latest = await pictureKit.store.query({ pageSize: 1 });
        if (latest.items.length === 0) {
          return { ok: false, error: "图库为空,请先上传照片" };
        }
        photoIds = [latest.items[0]!.id];
      }

      const sources = photoIds
        .map((id) => pictureKit.store.get(id))
        .filter((asset): asset is ImageAsset => asset !== null);
      if (sources.length === 0) {
        return { ok: false, error: `照片不存在: ${photoIds.join(", ")}` };
      }

      const result = await pictureKit.batch.processPhotos({
        photoPaths: sources.map((asset) => asset.filePath),
        style,
        sceneType,
        adjustments,
      });

      // 产物自动存回图库(带 beautified 标签与风格标记)
      const beautified: Array<Record<string, unknown>> = [];
      for (const [index, outputPath] of result.outputPaths.entries()) {
        const source = sources[index]!;
        const { asset } = await pictureKit.store.ingest(outputPath, {
          fileName: `beautified_${source.fileName.replace(/\.[^.]+$/, "")}.webp`,
          tags: ["beautified", ...(style ? [style] : [])],
          sceneType: source.sceneType ?? undefined,
        });
        beautified.push({ sourceId: source.id, ...assetSummary(asset) });
      }

      const styleLabel = style ? listBeautyStyles().find((option) => option.id === style)?.label : undefined;
      return {
        ok: true,
        count: beautified.length,
        style: style ?? sceneType ?? "custom",
        styleLabel: styleLabel ?? null,
        appliedAdjustments: result.appliedAdjustments,
        photos: beautified,
        summary: `已完成美颜批图(${styleLabel ?? style ?? sceneType ?? "自定义参数"}),共 ${beautified.length} 张,已存回图库。`,
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };
}
