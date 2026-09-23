/**
 * 自主性设置存储（AutonomySettingsStore）—— 每用户的"管家自主程度"配置。
 *
 * 等级语义（缺省 1）：
 *   0 = 只建议：主动性只说话不执行（act 意图一律降级为 speak）
 *   1 = 标准：常规事务可自动执行，金额/不可逆/第三方影响先问（既有三分支语义）
 *   2 = 高效：可逆且不涉钱、不影响第三方的动作即使净效用未过阈也直接执行，
 *       仅金额/不可逆仍先问
 *
 * 附带勿扰（DND）：dndUntil 时间戳内非 critical 的主动性一律沉默
 * （经 FrequencyGovernor.canTrigger 生效，hub 与管道两条入口全覆盖）。
 *
 * 落盘 data/autonomy-settings.json（actorId → 设置）；HTTP GET/PUT /api/autonomy 读写。
 */
import { readJson, writeJson } from "../proactivity/persist-file.js";

export type AutonomyLevel = 0 | 1 | 2;

export type AutonomySettings = {
  level: AutonomyLevel;
  /** 勿扰截止（epoch ms）；0/缺省 = 未开启 */
  dndUntil: number;
};

type PersistedShape = Record<string, Partial<AutonomySettings>>;

const DEFAULTS: AutonomySettings = { level: 1, dndUntil: 0 };

export class AutonomySettingsStore {
  private readonly byActor = new Map<string, AutonomySettings>();
  private dirty = false;

  constructor(private readonly path?: string) {
    if (path) {
      const raw = readJson<PersistedShape>(path, {});
      for (const [actorId, s] of Object.entries(raw)) {
        if (!s || typeof s !== "object") continue;
        this.byActor.set(actorId, {
          level: (s.level === 0 || s.level === 1 || s.level === 2 ? s.level : 1) as AutonomyLevel,
          dndUntil: typeof s.dndUntil === "number" && Number.isFinite(s.dndUntil) ? s.dndUntil : 0,
        });
      }
    }
  }

  get(actorId: string): AutonomySettings {
    return this.byActor.get(actorId) ?? { ...DEFAULTS };
  }

  getLevel(actorId: string): AutonomyLevel {
    return this.get(actorId).level;
  }

  setLevel(actorId: string, level: AutonomyLevel): AutonomySettings {
    const current = this.get(actorId);
    const next: AutonomySettings = { ...current, level };
    this.byActor.set(actorId, next);
    this.dirty = true;
    this.flush();
    return next;
  }

  /** 勿扰开关：untilMs ≤ now 视为关闭；返回设置后的完整状态 */
  setDnd(actorId: string, untilMs: number): AutonomySettings {
    const current = this.get(actorId);
    const next: AutonomySettings = { ...current, dndUntil: Math.max(0, untilMs) };
    this.byActor.set(actorId, next);
    this.dirty = true;
    this.flush();
    return next;
  }

  /** 是否勿扰中（governor.canTrigger 前置闸；critical 不受勿扰限制由调用方判定） */
  isDnd(actorId: string, now = Date.now()): boolean {
    const { dndUntil } = this.get(actorId);
    return dndUntil > now;
  }

  /** 诊断/设置页回显 */
  listAll(): Array<{ actorId: string } & AutonomySettings> {
    return [...this.byActor.entries()].map(([actorId, s]) => ({ actorId, ...s }));
  }

  flush(): void {
    if (!this.dirty || !this.path) return;
    const out: PersistedShape = {};
    for (const [actorId, s] of this.byActor) out[actorId] = s;
    writeJson(this.path, out);
    this.dirty = false;
  }
}
