import type { FastifyInstance } from "fastify";
import { LIFE_DOMAINS } from "../../catalog/index.js";
import type { HttpRouteDeps } from "./types.js";

/**
 * Feature Catalog HTTP 路由（能力分类统一层的对外视图）。
 *
 *   GET /api/catalog/domains            12 生活域统计（客户端能力面板数据源）
 *   GET /api/catalog/features?domain=   按域列能力（不传 domain 返回全部）
 *   GET /api/catalog/classify?name=     单个能力的分类（调试/联动用）
 *
 * catalog 未装配时统一返回 503（与 travelPlanningService 未装配时的约定一致）。
 */
export function registerCatalogRoutes(app: FastifyInstance, deps: HttpRouteDeps): void {
  const requireCatalog = (): NonNullable<HttpRouteDeps["featureCatalog"]> | null => {
    return deps.featureCatalog ?? null;
  };

  app.get("/api/catalog/domains", async (_request, reply) => {
    const catalog = requireCatalog();
    if (!catalog) return reply.code(503).send({ ok: false, error: "Feature Catalog 未装配" });
    return {
      ok: true,
      builtAt: catalog.getBuiltAt(),
      total: catalog.all().length,
      domains: catalog.domainStats(),
    };
  });

  app.get("/api/catalog/features", async (request, reply) => {
    const catalog = requireCatalog();
    if (!catalog) return reply.code(503).send({ ok: false, error: "Feature Catalog 未装配" });
    const query = (request.query as { domain?: string }).domain?.toLowerCase().trim();
    if (query && !(LIFE_DOMAINS as readonly string[]).includes(query)) {
      return reply.code(400).send({ ok: false, error: `domain 必须是：${LIFE_DOMAINS.join("/")}` });
    }
    const features = query ? catalog.byDomain(query as never) : catalog.all();
    return {
      ok: true,
      domain: query ?? "all",
      count: features.length,
      unclassified: catalog.getUnclassified(),
      features: features.map((f) => ({
        name: f.name,
        surface: f.surface,
        domain: f.cls.domain,
        action: f.cls.action,
        trigger: f.cls.trigger,
        risk: f.cls.risk,
        description: f.description,
        classifiedBy: f.classifiedBy,
      })),
    };
  });

  app.get("/api/catalog/classify", async (request, reply) => {
    const catalog = requireCatalog();
    if (!catalog) return reply.code(503).send({ ok: false, error: "Feature Catalog 未装配" });
    const name = (request.query as { name?: string }).name?.trim() ?? "";
    if (!name) return reply.code(400).send({ ok: false, error: "缺少 name 参数" });
    const feature = catalog.classify(name);
    if (!feature) return reply.code(404).send({ ok: false, error: `能力 ${name} 不在目录中` });
    return { ok: true, feature };
  });
}
