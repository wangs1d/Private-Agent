import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { randomUUID } from "crypto";

export type AgentAccountRecord = {
  accountId: string;
  /** 登录主体，与 `boundActorId` / `resolveActorId` 一致 */
  userId: string;
  displayName: string;
  /** 经邮箱验证流程绑定的地址；旧数据或工具直开账号可能为空 */
  email?: string;
  createdAt: string;
  /** 自导初始化流程是否已标记完成 */
  setupComplete: boolean;
};

type PersistedAccountRow = AgentAccountRecord & { sessionId?: string };

/**
 * 每个登录主体（userId / 旧版 sessionId）至多一个 Agent 账号；持久化 JSON（默认 `data/agent-accounts.json`）。
 */
export class AgentAccountService {
  private readonly byActorId = new Map<string, AgentAccountRecord>();

  private get persistPath(): string {
    return process.env.AGENT_ACCOUNTS_FILE ?? join(process.cwd(), "data", "agent-accounts.json");
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.persistPath, "utf8");
      const data = JSON.parse(raw) as { accounts?: PersistedAccountRow[] };
      const list = data.accounts ?? [];
      this.byActorId.clear();
      for (const a of list) {
        if (!a?.accountId) continue;
        const actorId = String(a.userId ?? a.sessionId ?? "").trim();
        if (!actorId) continue;
        this.byActorId.set(actorId, {
          accountId: a.accountId,
          userId: actorId,
          displayName: String(a.displayName ?? "").trim() || "Agent",
          ...(a.email ? { email: a.email } : {}),
          createdAt: a.createdAt ?? new Date().toISOString(),
          setupComplete: Boolean(a.setupComplete),
        });
      }
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") return;
      throw e;
    }
  }

  async persist(): Promise<void> {
    const dir = dirname(this.persistPath);
    await mkdir(dir, { recursive: true });
    const accounts = Array.from(this.byActorId.values()).map((a) => ({
      ...a,
      sessionId: a.userId,
    }));
    await writeFile(this.persistPath, JSON.stringify({ accounts }, null, 2), "utf8");
  }

  getByActorId(actorId: string): AgentAccountRecord | undefined {
    return this.byActorId.get(actorId.trim());
  }

  /** @deprecated 使用 {@link getByActorId}（参数为登录主体 id） */
  getBySession(sessionId: string): AgentAccountRecord | undefined {
    return this.getByActorId(sessionId);
  }

  /**
   * 新建账号；若该主体已有账号则抛错。
   * @param email 可选；邮箱流程传入已验证地址，将写入账号。
   */
  async register(actorId: string, displayName: string, email?: string): Promise<AgentAccountRecord> {
    const id = actorId.trim();
    if (!id) throw new Error("登录主体 id 不能为空");
    const name = displayName.trim();
    if (!name) throw new Error("显示名称不能为空");
    if (name.length > 120) throw new Error("显示名称过长");
    if (email !== undefined) {
      const e = email.trim();
      if (!e) throw new Error("邮箱不能为空");
      if (e.length > 254) throw new Error("邮箱过长");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
        throw new Error("邮箱格式无效");
      }
    }
    if (this.byActorId.has(id)) {
      throw new Error("该用户已存在 Agent 账号，无需重复注册");
    }
    const record: AgentAccountRecord = {
      accountId: randomUUID(),
      userId: id,
      displayName: name,
      ...(email !== undefined ? { email: email.trim() } : {}),
      createdAt: new Date().toISOString(),
      setupComplete: false,
    };
    this.byActorId.set(id, record);
    await this.persist();
    return record;
  }

  async markSetupComplete(actorId: string): Promise<AgentAccountRecord | undefined> {
    const id = actorId.trim();
    const r = this.byActorId.get(id);
    if (!r) return undefined;
    r.setupComplete = true;
    this.byActorId.set(id, r);
    await this.persist();
    return r;
  }

  /**
   * 更新展示名（已存在账号时）。
   */
  async updateDisplayName(actorId: string, displayName: string): Promise<AgentAccountRecord> {
    const id = actorId.trim();
    const name = displayName.trim();
    if (!id) throw new Error("登录主体 id 不能为空");
    if (!name) throw new Error("显示名称不能为空");
    if (name.length > 120) throw new Error("显示名称过长");
    const r = this.byActorId.get(id);
    if (!r) throw new Error("尚未创建 Agent 账号，请先注册");
    r.displayName = name;
    this.byActorId.set(id, r);
    await this.persist();
    return r;
  }
}
