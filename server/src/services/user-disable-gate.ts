import { readFile, stat } from "node:fs/promises";

/**
 * 用户禁用门（跨进程）。
 *
 * 管理员在 HTTP 进程经 AgentAccountService.disable 写 data/agent-accounts.json；
 * 对话轮发生在 runtime 进程，拿不到那边的服务实例，这里直接读账号文件并按
 * mtime + size 做失效判断 —— 每轮对话一次 stat，文件一变立即重新解析，
 * 禁用/恢复在下一轮对话即生效。
 */

type AccountsCache = { accounts: Map<string, boolean>; mtimeMs: number; size: number };

let cache: AccountsCache | null = null;

function accountsFilePath(): string {
  return process.env.AGENT_ACCOUNTS_FILE?.trim() || "data/agent-accounts.json";
}

/** 主体（userId/actorId）是否被管理员禁用；读不到账号文件时一律视为未禁用。 */
export async function isActorDisabled(actorId: string): Promise<boolean> {
  const id = actorId.trim();
  if (!id) return false;
  try {
    const path = accountsFilePath();
    const s = await stat(path);
    if (!cache || cache.mtimeMs !== s.mtimeMs || cache.size !== s.size) {
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw) as {
        accounts?: Array<{ userId?: string; sessionId?: string; disabled?: boolean }>;
      };
      const map = new Map<string, boolean>();
      for (const a of parsed.accounts ?? []) {
        const key = String(a.userId ?? a.sessionId ?? "").trim();
        if (key) map.set(key, Boolean(a.disabled));
      }
      cache = { accounts: map, mtimeMs: s.mtimeMs, size: s.size };
    }
    return cache.accounts.get(id) ?? false;
  } catch {
    return false;
  }
}
