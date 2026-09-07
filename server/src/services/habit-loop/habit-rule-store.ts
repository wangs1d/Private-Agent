import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

import type { HabitRule } from "./habit-types.js";

/**
 * 习惯规则本地存储（JSON 文件，风格对齐 booking-order-store）。
 *
 * - data/habit-loop/rules.json；file 为 null 时纯内存（测试用）
 * - 写入原子化（tmp + rename），并发写串行化
 */
export class HabitRuleStore {
  private rules = new Map<string, HabitRule>();
  private writeChain: Promise<void> = Promise.resolve();
  private loaded = false;

  constructor(private readonly file: string | null = null) {}

  private async ensureLoaded(): Promise<void> {
    if (this.loaded || !this.file) return;
    this.loaded = true;
    try {
      if (existsSync(this.file)) {
        const raw = await readFile(this.file, "utf8");
        const parsed = JSON.parse(raw) as { rules?: HabitRule[] };
        for (const rule of parsed.rules ?? []) {
          if (rule?.id) this.rules.set(rule.id, rule);
        }
      }
    } catch {
      // 损坏文件：从空开始（与 booking-order-store 容错策略一致）
    }
  }

  private persist(): void {
    if (!this.file) return;
    const file = this.file;
    const payload = JSON.stringify({ rules: [...this.rules.values()] }, null, 2);
    this.writeChain = this.writeChain
      .then(async () => {
        await mkdir(dirname(file), { recursive: true });
        const tmp = join(dirname(file), `.${basename(file)}.${randomBytes(4).toString("hex")}.tmp`);
        await writeFile(tmp, payload, "utf8");
        await rename(tmp, file);
      })
      .catch((err) => {
        console.warn("[HabitRuleStore] 规则写盘失败", err);
      });
  }

  async upsert(rule: HabitRule): Promise<HabitRule> {
    await this.ensureLoaded();
    this.rules.set(rule.id, rule);
    this.persist();
    return rule;
  }

  async get(ruleId: string): Promise<HabitRule | null> {
    await this.ensureLoaded();
    return this.rules.get(ruleId) ?? null;
  }

  async listByActor(actorId: string): Promise<HabitRule[]> {
    await this.ensureLoaded();
    return [...this.rules.values()]
      .filter((r) => r.actorId === actorId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  /** 全量规则（tick 扫描用，新→旧）。 */
  async listAll(): Promise<HabitRule[]> {
    await this.ensureLoaded();
    return [...this.rules.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  async delete(ruleId: string, actorId: string): Promise<boolean> {
    await this.ensureLoaded();
    const rule = this.rules.get(ruleId);
    if (!rule || rule.actorId !== actorId) return false;
    this.rules.delete(ruleId);
    this.persist();
    return true;
  }

  async flush(): Promise<void> {
    await this.writeChain;
  }
}

export function newHabitRuleId(now = new Date()): string {
  return `hl_${now.getTime().toString(36)}_${randomBytes(3).toString("hex")}`;
}
