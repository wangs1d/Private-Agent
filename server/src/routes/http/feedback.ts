import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { resolveActorId } from "../../agent/actor-id.js";
import { writeJsonAtomic } from "../../storage/atomic-json.js";

/**
 * 帮助与反馈：客户端反馈的唯一落点。
 *
 * 私有化部署下没有第三方云服务，反馈直接落到服务端 data/feedback.json，
 * 管理员（部署者本人）通过 GET /api/feedback 查看全部反馈并流转状态；
 * 客户端只查自己提交的记录（scope=actorId 过滤），形成提交→处理→回复的闭环。
 */

const FEEDBACK_TYPES = new Set(["bug", "suggestion", "other"]);
const FEEDBACK_STATUSES = new Set(["open", "processing", "resolved"]);
const MAX_RECORDS = 500;
const MAX_DIAGNOSTIC_ENTRIES = 30;

type FeedbackType = "bug" | "suggestion" | "other";
type FeedbackStatus = "open" | "processing" | "resolved";

type FeedbackRecord = {
  id: string;
  type: FeedbackType;
  title: string;
  description: string;
  contact: string | null;
  status: FeedbackStatus;
  replyNote: string | null;
  actorId: string;
  clientVersion: string | null;
  platform: string | null;
  diagnostics: Record<string, string | number | boolean>;
  createdAt: string;
  updatedAt: string;
};

type FeedbackStore = {
  items: FeedbackRecord[];
};

const submitBodySchema = z.object({
  userId: z.string().optional(),
  sessionId: z.string().optional(),
  type: z.enum(["bug", "suggestion", "other"]),
  title: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(4000),
  contact: z.string().trim().max(120).optional(),
  clientVersion: z.string().trim().max(32).optional(),
  platform: z.string().trim().max(120).optional(),
  diagnostics: z.record(z.string(), z.unknown()).optional(),
});

const statusBodySchema = z.object({
  status: z.enum(["open", "processing", "resolved"]),
  replyNote: z.string().trim().max(500).optional(),
});

const listQuerySchema = z.object({
  userId: z.string().optional(),
  sessionId: z.string().optional(),
  /** 传入时只返回该身份的反馈（客户端「我的反馈」）；缺省返回全部（管理端）。 */
  actorId: z.string().optional(),
  status: z.string().optional(),
  type: z.string().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
});

/** 诊断信息只收标量、限量限长：反馈通道不该成为任意数据的倾倒口。 */
function sanitizeDiagnostics(
  raw: Record<string, unknown> | undefined,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!raw) return out;
  for (const [key, value] of Object.entries(raw)) {
    if (Object.keys(out).length >= MAX_DIAGNOSTIC_ENTRIES) break;
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) out[key.slice(0, 64)] = trimmed.slice(0, 500);
    } else if (typeof value === "number" && Number.isFinite(value)) {
      out[key.slice(0, 64)] = value;
    } else if (typeof value === "boolean") {
      out[key.slice(0, 64)] = value;
    }
  }
  return out;
}

class FeedbackStoreManager {
  private store: FeedbackStore | null = null;
  private readonly filePath = join(process.cwd(), "data", "feedback.json");

  async load(): Promise<FeedbackStore> {
    if (this.store) return this.store;
    let raw: string | undefined;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch {
      // 首次启动没有数据文件
    }
    let items: FeedbackRecord[] = [];
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Partial<FeedbackStore>;
        items = Array.isArray(parsed.items) ? parsed.items : [];
      } catch (error) {
        console.error("[feedback] load failed:", error);
      }
    }
    this.store = { items };
    return this.store;
  }

  async persist(): Promise<void> {
    if (!this.store) return;
    await writeJsonAtomic(this.filePath, this.store);
  }

  /** 按创建时间倒序插入，超量丢最旧的已闭环记录，不够再丢最旧的。 */
  add(record: FeedbackRecord): void {
    const items = this.store?.items;
    if (!items) return;
    items.unshift(record);
    if (items.length > MAX_RECORDS) {
      const closedIdx = items.findIndex(
        (item, i) => i >= MAX_RECORDS / 2 && item.status === "resolved",
      );
      if (closedIdx >= 0) items.splice(closedIdx, 1);
      else items.pop();
    }
  }
}

const storeManager = new FeedbackStoreManager();

export function registerFeedbackRoutes(app: FastifyInstance): void {
  app.post("/api/feedback", async (request, reply) => {
    const parsed = submitBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const body = parsed.data;
    const actorId = resolveActorId({
      userId: body.userId,
      sessionId: body.sessionId ?? "",
    });
    const now = new Date().toISOString();
    const record: FeedbackRecord = {
      id: `fb_${randomUUID().slice(0, 8)}`,
      type: body.type,
      title: body.title,
      description: body.description,
      contact: body.contact || null,
      status: "open",
      replyNote: null,
      actorId,
      clientVersion: body.clientVersion || null,
      platform: body.platform || null,
      diagnostics: sanitizeDiagnostics(body.diagnostics),
      createdAt: now,
      updatedAt: now,
    };
    const store = await storeManager.load();
    storeManager.add(record);
    await storeManager.persist();
    return { ok: true, feedback: record };
  });

  app.get("/api/feedback", async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const q = parsed.data;
    const store = await storeManager.load();
    let items = store.items;
    if (q.actorId) {
      const actorId = resolveActorId({
        userId: q.userId,
        sessionId: q.sessionId ?? "",
      });
      items = items.filter((item) => item.actorId === actorId);
    }
    if (q.status && FEEDBACK_STATUSES.has(q.status)) {
      items = items.filter((item) => item.status === q.status);
    }
    if (q.type && FEEDBACK_TYPES.has(q.type)) {
      items = items.filter((item) => item.type === q.type);
    }
    return { ok: true, total: items.length, items: items.slice(0, q.limit ?? 50) };
  });

  app.post<{ Params: { id: string } }>("/api/feedback/:id/status", async (request, reply) => {
    const parsed = statusBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const id = String(request.params.id ?? "").trim();
    const store = await storeManager.load();
    const record = store.items.find((item) => item.id === id);
    if (!record) return reply.code(404).send({ ok: false, message: "feedback not found" });
    record.status = parsed.data.status;
    if (parsed.data.replyNote !== undefined) {
      record.replyNote = parsed.data.replyNote || null;
    }
    record.updatedAt = new Date().toISOString();
    await storeManager.persist();
    return { ok: true, feedback: record };
  });
}

/** 各状态反馈计数（管理控制台概览用）。 */
export async function feedbackStatusCounts(): Promise<{
  total: number;
  open: number;
  processing: number;
  resolved: number;
}> {
  const store = await storeManager.load();
  const counts = { total: store.items.length, open: 0, processing: 0, resolved: 0 };
  for (const item of store.items) {
    if (counts[item.status as FeedbackStatus] !== undefined) {
      counts[item.status as FeedbackStatus]++;
    }
  }
  return counts;
}

