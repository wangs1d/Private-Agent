/**
 * 购物建议模块的 HTTP 端点（runtime 内置能力的配套只读端点）。
 *
 *   GET  /api/recommendation/products        商品库清单（摘要，含图片路径）
 *   GET  /api/recommendation/media/:file     商品图/试色图（文件名白名单）
 *
 * 推荐对话本身不走独立通道：主聊天中由 shopping.suggest 工具触发，
 * 卡片经 tool-card-registry 内联渲染。
 */

import { readFile } from "node:fs/promises";
import type { FastifyInstance } from "fastify";

import type { ProductCatalog } from "./product-catalog.js";

const MEDIA_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export type RecommendationRouteDeps = {
  catalog: ProductCatalog | null;
  /** 媒体目录（商品图/试色图落盘处） */
  mediaDir: string | null;
};

export function registerRecommendationRoutes(
  app: FastifyInstance,
  deps: RecommendationRouteDeps,
): void {
  const catalog = deps.catalog;

  app.get("/api/recommendation/products", async () => {
    if (!catalog) {
      return { ok: false, error: "recommendation 模块未装配" };
    }
    return {
      ok: true,
      products: catalog.list().map((p) => ({
        id: p.id,
        brand: p.brand,
        name: p.name,
        category: p.category,
        tags: p.tags,
        desc: p.desc,
        image: p.image,
        minPriceCny: Math.min(...p.channels.map((c) => c.priceCny)),
        maxPriceCny: Math.max(...p.channels.map((c) => c.priceCny)),
      })),
    };
  });

  // 商品图等静态媒体：文件名白名单（防路径穿越）
  app.get("/api/recommendation/media/:file", async (req, reply) => {
    const { file } = req.params as { file: string };
    if (!deps.mediaDir) {
      return reply.code(503).send({ ok: false, error: "媒体目录未装配" });
    }
    if (!/^[a-zA-Z0-9._-]+$/.test(file) || file.startsWith(".")) {
      return reply.code(400).send({ ok: false, error: "非法文件名" });
    }
    const ext = file.slice(file.lastIndexOf(".")).toLowerCase();
    const contentType = MEDIA_TYPES[ext];
    if (!contentType) {
      return reply.code(415).send({ ok: false, error: "不支持的媒体类型" });
    }
    try {
      const bytes = await readFile(`${deps.mediaDir}/${file}`);
      return reply
        .header("content-type", contentType)
        .header("cache-control", "public, max-age=86400")
        .send(bytes);
    } catch {
      return reply.code(404).send({ ok: false, error: `媒体不存在：${file}` });
    }
  });
}
