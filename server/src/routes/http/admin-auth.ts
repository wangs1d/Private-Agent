import { createHash, timingSafeEqual } from "node:crypto";
import { appendFile, readFile, rename, stat } from "node:fs/promises";
import { join } from "node:path";

import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * 管理后台共享鉴权与操作审计。
 *
 * 管理令牌只来自环境变量 ADMIN_UPLOAD_TOKEN，不再提供任何默认值：
 * 未配置时管理接口一律 503（宁可拒绝服务也不留默认口令）。
 * 之前 4 个路由文件各自实现了同一份 checkAdmin（默认 token "admin-upload-secret"
 * 兜底），统一收敛到这里；比较用 sha256 + timingSafeEqual 防时序侧信道。
 *
 * 审计日志追加写 data/admin-audit.jsonl（每行一个 JSON 事件），超过 5MB
 * 轮转为 .1 只保留一代 —— 管理操作量级不需要更多。
 */

const AUDIT_MAX_BYTES = 5 * 1024 * 1024;

export function adminTokenConfigured(): boolean {
  return Boolean(process.env.ADMIN_UPLOAD_TOKEN?.trim());
}

function adminToken(): string {
  return process.env.ADMIN_UPLOAD_TOKEN?.trim() ?? "";
}

function tokenMatches(presented: string): boolean {
  const expected = adminToken();
  if (!expected || !presented) return false;
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** 请求是否携带有效管理令牌（无 preHandler 场景的条件分支用）。 */
export function isAdminRequest(req: FastifyRequest): boolean {
  if (!adminTokenConfigured()) return false;
  return tokenMatches(String(req.headers["x-admin-token"] ?? ""));
}

/**
 * Fastify 共享 preHandler：统一管理接口鉴权。
 * 用法：app.get("/api/admin/x", { preHandler: requireAdmin }, handler)
 */
export async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!adminTokenConfigured()) {
    await reply.code(503).send({ ok: false, message: "ADMIN_UPLOAD_TOKEN 未配置，管理接口已锁定" });
    return;
  }
  if (!tokenMatches(String(req.headers["x-admin-token"] ?? ""))) {
    await reply.code(401).send({ ok: false, message: "Unauthorized: invalid admin token" });
  }
}

export type AdminAuditEntry = {
  time: string;
  action: string;
  detail: Record<string, unknown>;
  ip: string | null;
};

function auditFilePath(): string {
  return join(process.cwd(), "data", "admin-audit.jsonl");
}

/** 追加一条管理操作审计（写失败只记错误日志，不影响主流程）。 */
export async function adminAudit(
  action: string,
  detail: Record<string, unknown> = {},
  req?: FastifyRequest,
): Promise<void> {
  const entry: AdminAuditEntry = {
    time: new Date().toISOString(),
    action,
    detail,
    ip: req?.ip ?? null,
  };
  const path = auditFilePath();
  try {
    try {
      const s = await stat(path);
      if (s.size > AUDIT_MAX_BYTES) {
        await rename(path, `${path}.1`).catch(() => {});
      }
    } catch {
      // 文件尚不存在
    }
    await appendFile(path, `${JSON.stringify(entry)}\n`, "utf8");
  } catch (err) {
    console.error("[admin-audit] write failed:", err);
  }
}

/** 读取最近 N 条审计（时间倒序），供管理页展示。 */
export async function readAdminAudit(limit = 50): Promise<AdminAuditEntry[]> {
  let raw: string;
  try {
    raw = await readFile(auditFilePath(), "utf8");
  } catch {
    return [];
  }
  const entries: AdminAuditEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as AdminAuditEntry;
      if (parsed?.time && parsed?.action) entries.push(parsed);
    } catch {
      // 跳过损坏行
    }
  }
  return entries.slice(-limit).reverse();
}
