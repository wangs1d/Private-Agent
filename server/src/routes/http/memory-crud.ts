// HTTP 路由：记忆管理（记忆可见、可改、可纠错）
//
//   GET  /api/memory/items?actorId=&q=&limit=   列出某 actor 的长期记忆（可选关键词过滤）
//   POST /api/memory/update      {actorId,id,content}   编辑一条记忆（mem0 原生 update，向量同步重建）
//   POST /api/memory/delete      {actorId,id}           删除一条记忆（bridge 调和 + 强化侧表级联回收）
//   GET  /api/memory/profile?actorId=            读取"我对用户的理解"（USER_PROFILE.md）
//
// 编辑/删除后会失效记忆目录缓存（memory-inventory），保证下一轮召回即见最新。
// 画像文件由 UserProfileAggregator 按轮次增量维护，这里仅提供只读视图。
import type { FastifyInstance } from "fastify";

import { getAgenticMemoryRuntime } from "../../agentic-memory/index.js";
import { getGlobalMemoryInventory } from "../../brain/memory-inventory.js";
import { UserProfileStore } from "../../services/user-personalization/user-profile-store.js";

type Mem0Record = {
  id: string;
  memory?: string;
  metadata?: { actorId?: string; source?: string; importance?: number; highSignal?: boolean };
  createdAt?: string;
  updatedAt?: string;
};

export function registerMemoryCrudRoutes(app: FastifyInstance): void {
  app.get("/api/memory/items", async (request, reply) => {
    const query = request.query as { actorId?: string; q?: string; limit?: string };
    const actorId = String(query.actorId ?? "").trim();
    if (!actorId) return reply.code(400).send({ ok: false, error: "actorId required" });
    const runtime = getAgenticMemoryRuntime();
    if (!runtime?.memory) {
      return reply.code(503).send({ ok: false, error: "记忆系统未启用（检查 OPENAI_API_KEY / AGENT_AGENTIC_MEMORY_ENABLED）" });
    }
    const keyword = String(query.q ?? "").trim().toLowerCase();
    const limit = Math.min(Math.max(Number(query.limit) > 0 ? Number(query.limit) : 200, 1), 1000);
    try {
      const allResult = (await runtime.memory.getAll({ topK: 10000 })) as { results?: Mem0Record[] };
      const items = (allResult.results ?? [])
        .filter((m) => (m.metadata?.actorId ?? actorId) === actorId)
        .filter((m) => !keyword || String(m.memory ?? "").toLowerCase().includes(keyword))
        .sort((a, b) => String(b.updatedAt ?? b.createdAt ?? "").localeCompare(String(a.updatedAt ?? a.createdAt ?? "")))
        .slice(0, limit)
        .map((m) => ({
          id: m.id,
          content: String(m.memory ?? ""),
          createdAt: m.createdAt,
          updatedAt: m.updatedAt,
          source: m.metadata?.source,
          importance: m.metadata?.importance,
          highSignal: m.metadata?.highSignal === true,
        }));
      return { ok: true, actorId, count: items.length, items };
    } catch (err) {
      return reply.code(500).send({
        ok: false,
        error: `读取记忆失败: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });

  app.post("/api/memory/update", async (request, reply) => {
    const body = (request.body ?? {}) as { actorId?: string; id?: string; content?: string };
    const actorId = String(body.actorId ?? "").trim();
    const id = String(body.id ?? "").trim();
    const content = String(body.content ?? "").trim();
    if (!actorId || !id) return reply.code(400).send({ ok: false, error: "actorId and id required" });
    if (!content) return reply.code(400).send({ ok: false, error: "content required（清空请直接删除）" });
    const runtime = getAgenticMemoryRuntime();
    if (!runtime?.memory) {
      return reply.code(503).send({ ok: false, error: "记忆系统未启用" });
    }
    try {
      await runtime.memory.update(id, content);
      getGlobalMemoryInventory()?.invalidate(actorId);
      return { ok: true, id };
    } catch (err) {
      return reply.code(500).send({
        ok: false,
        error: `更新记忆失败: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });

  app.post("/api/memory/delete", async (request, reply) => {
    const body = (request.body ?? {}) as { actorId?: string; id?: string };
    const actorId = String(body.actorId ?? "").trim();
    const id = String(body.id ?? "").trim();
    if (!actorId || !id) return reply.code(400).send({ ok: false, error: "actorId and id required" });
    const runtime = getAgenticMemoryRuntime();
    if (!runtime?.lifecycle) {
      return reply.code(503).send({ ok: false, error: "记忆系统未启用" });
    }
    try {
      const deleted = await runtime.lifecycle.deleteByIds([id]);
      if (deleted.length === 0) {
        return reply.code(404).send({ ok: false, error: "记忆不存在或删除失败" });
      }
      getGlobalMemoryInventory()?.invalidate(actorId);
      return { ok: true, id };
    } catch (err) {
      return reply.code(500).send({
        ok: false,
        error: `删除记忆失败: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });

  app.get("/api/memory/profile", async (request, reply) => {
    const query = request.query as { actorId?: string };
    const actorId = String(query.actorId ?? "").trim();
    if (!actorId) return reply.code(400).send({ ok: false, error: "actorId required" });
    try {
      const markdown = await new UserProfileStore().read(actorId);
      return { ok: true, actorId, markdown };
    } catch (err) {
      return reply.code(500).send({
        ok: false,
        error: `读取用户画像失败: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });
}
