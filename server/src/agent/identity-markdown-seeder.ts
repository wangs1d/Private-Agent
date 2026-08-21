import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentMemorySyncService } from "../services/agent-memory-sync-service.js";

/**
 * 身份 / 记忆 Markdown 文档 → agent-memory-sync KV 的幂等种子。
 *
 * 把仓库根的三个约定文档在启动时（或每个 actor 首次对话时）种进记忆 KV：
 *   - agent/SOUL.md    → `soul`           ：persona 后备人格源
 *   - agent/USER.md    → `user_profile`   ：userProfile 后备用户画像
 *   - agent/MEMORY.md  → `memory_document`：长期记忆文档（非保留键，自动进 memorySummary）
 *
 * 这样 SOUL / USER / MEMORY 就不再是"无人消费的装饰文件"，而是真正写入
 * agent-memory-sync-service 的 KV 并被 prompt 各字段消费、实际影响回复。
 *
 * 幂等性：
 *   - 进程内：seededInProcess 集合保证每个 actor 每进程只读一次 md。
 *   - KV 层：seedIfAbsent 仅当目标键不存在才写入，跨重启不会覆盖运行时学习到的
 *     人格内核 / 用户画像 / 长期事实。
 *
 * 路径可用环境变量覆盖：
 *   AGENT_SOUL_PATH / AGENT_USER_MD_PATH / AGENT_MEMORY_MD_PATH
 */

const seededInProcess = new Set<string>();

export interface IdentityMarkdownPaths {
  soul?: string;
  user?: string;
  memory?: string;
}

export function resolveIdentityMarkdownPaths(): IdentityMarkdownPaths {
  const base = process.cwd();
  return {
    soul: process.env.AGENT_SOUL_PATH?.trim() || join(base, "agent", "SOUL.md"),
    user: process.env.AGENT_USER_MD_PATH?.trim() || join(base, "agent", "USER.md"),
    memory: process.env.AGENT_MEMORY_MD_PATH?.trim() || join(base, "agent", "MEMORY.md"),
  };
}

async function readOptional(path?: string): Promise<string | null> {
  if (!path) return null;
  try {
    const raw = await readFile(path, "utf8");
    return raw.trim() || null;
  } catch {
    return null;
  }
}

export async function seedIdentityMarkdown(
  sync: AgentMemorySyncService | null,
  actorId: string,
): Promise<void> {
  if (!sync || seededInProcess.has(actorId)) return;
  seededInProcess.add(actorId);

  const { soul, user, memory } = resolveIdentityMarkdownPaths();
  const [soulText, userText, memoryText] = await Promise.all([
    readOptional(soul),
    readOptional(user),
    readOptional(memory),
  ]);

  await Promise.all([
    soulText ? sync.seedIfAbsent(actorId, "soul", soulText) : Promise.resolve(false),
    userText ? sync.seedIfAbsent(actorId, "user_profile", userText) : Promise.resolve(false),
    memoryText ? sync.seedIfAbsent(actorId, "memory_document", memoryText) : Promise.resolve(false),
  ]);
}