/**
 * 挂起行动确认存储（PendingConfirmationStore）—— ask_first 分支的统一确认登记处。
 *
 * hub（行动级：工具步骤计划）与管道（提案级：带 confirmAction 的提案，如承诺代催）
 * 共用同一实例，`proactivity.confirmAction` 工具经 hub 统一解析：
 *   - origin=hub      → 确认后执行 steps（黑名单安全门仍兜底）
 *   - origin=pipeline → 确认后经 hub 注入的 resolver 回调管道
 *     （onProposalApproved → 装配层定义的批准动作 + speak 回执）
 *
 * 落盘 data/proactivity/confirmations.json（可选）：hub 步骤计划是纯数据，
 * 重启恢复后仍可执行；未注入路径时内存态（测试/降级）。过期未回复静默作废。
 */
import { readJson, writeJson } from "./persist-file.js";
import type { ProactiveProposal } from "./pipeline-types.js";

/** ask_first 确认的默认有效期：10 分钟未回复自动作废（不执行） */
export const CONFIRMATION_TTL_MS = 10 * 60_000;

export type PendingConfirmation = {
  confirmId: string;
  actorId: string;
  kind: string;
  /** hub 行动级的执行步骤；pipeline 提案级为空数组（动作由 onProposalApproved 定义） */
  steps: Array<{ tool: string; args: Record<string, unknown> }>;
  /** 要做的事（确认请求文案与执行审计展示） */
  rationale: string;
  createdAt: number;
  expiresAt: number;
  /** hub=行动计划确认；pipeline=提案级确认（批准后走 onProposalApproved） */
  origin: "hub" | "pipeline";
  /** pipeline 级：确认请求对应的原始提案（批准回调的入参） */
  proposal?: ProactiveProposal;
};

interface ConfirmationFileShape {
  version: 1;
  entries: PendingConfirmation[];
}

let idSeq = 0;

export function nextConfirmationId(): string {
  idSeq = (idSeq + 1) % 100000;
  return `pc_${Date.now().toString(36)}_${idSeq.toString(36)}`;
}

export class PendingConfirmationStore {
  private readonly entries = new Map<string, PendingConfirmation>();
  private dirty = false;

  constructor(private readonly path?: string) {
    if (path) {
      const raw = readJson<ConfirmationFileShape>(path, { version: 1, entries: [] });
      for (const e of raw.entries ?? []) {
        if (e.expiresAt > Date.now()) this.entries.set(e.confirmId, e); // 过期的恢复即弃
      }
    }
  }

  /** 登记一条待确认（自动剔除过期并落盘） */
  register(
    entry: Omit<PendingConfirmation, "confirmId"> & { confirmId?: string },
  ): PendingConfirmation {
    this.pruneExpired();
    const confirmed: PendingConfirmation = {
      ...entry,
      confirmId: entry.confirmId ?? nextConfirmationId(),
    };
    this.entries.set(confirmed.confirmId, confirmed);
    this.dirty = true;
    this.flush();
    return confirmed;
  }

  get(confirmId: string): PendingConfirmation | undefined {
    return this.entries.get(confirmId);
  }

  /** 取出并移除（确认推进/作废） */
  take(confirmId: string): PendingConfirmation | undefined {
    const e = this.entries.get(confirmId);
    if (e) {
      this.entries.delete(confirmId);
      this.dirty = true;
      this.flush();
    }
    return e;
  }

  list(actorId: string): PendingConfirmation[] {
    this.pruneExpired();
    return [...this.entries.values()].filter((e) => e.actorId === actorId);
  }

  size(): number {
    this.pruneExpired();
    return this.entries.size;
  }

  /** 剔除过期未回复的确认（静默作废，不执行） */
  pruneExpired(now = Date.now()): void {
    for (const [id, e] of this.entries) {
      if (e.expiresAt <= now) {
        this.entries.delete(id);
        this.dirty = true;
      }
    }
  }

  flush(): void {
    if (!this.dirty || !this.path) return;
    writeJson(this.path, { version: 1, entries: [...this.entries.values()] } satisfies ConfirmationFileShape);
    this.dirty = false;
  }
}
