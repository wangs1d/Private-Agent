/**
 * 闹钟持久化存储 —— 小规模场景用 JSON 落盘（单文件全量，tmp 原子替换），
 * 目录 data/alarm-clock/alarms.json。闹钟量级（人均几十条）远低于换 SQLite 的必要。
 */
import { join } from "node:path";
import { readJson, writeJson } from "../../proactivity/persist-file.js";
import { advanceAlarmNextFireMs } from "./alarm-rrule.js";
import type { Alarm, AlarmTriggerRecord, AlarmWakeMode } from "./alarm-types.js";

type PersistedShape = {
  alarms: Alarm[];
  triggers: AlarmTriggerRecord[]; // 只留最近 N 条，防膨胀
};

const MAX_TRIGGER_RECORDS = 2000;

function defaultSnooze() {
  return { enabled: true, presetsMinutes: [5, 10, 15], maxCount: 3 };
}

export type AlarmCreateInput = {
  actorId: string;
  label: string;
  kind?: "alarm" | "reminder";
  fireAt: string; // ISO8601
  repeatRule?: string | null;
  snooze?: Partial<{ enabled: boolean; presetsMinutes: number[]; maxCount: number }>;
  wakeMode?: AlarmWakeMode;
  dndBypass?: boolean;
  deviceId?: string | null;
  idempotencyKey?: string | null;
  source?: "agent" | "user" | "sync";
  // reminder 专属（kind=reminder 时生效）
  channelPlan?: Array<"voice_call" | "tts_broadcast" | "popup" | "notification" | "in_app_banner">;
  escalateAfterSec?: number;
  requireAck?: boolean;
  remindText?: string;
  /** 状态修改（取消/暂停/恢复）；创建时固定 active */
  status?: import("./alarm-types.js").AlarmStatus;
};

export class AlarmStore {
  private data: PersistedShape = { alarms: [], triggers: [] };
  private readonly path: string;

  constructor(dataDir: string) {
    this.path = join(dataDir, "alarms.json");
    const raw = readJson<PersistedShape>(this.path, { alarms: [], triggers: [] });
    this.data = {
      alarms: Array.isArray(raw.alarms) ? raw.alarms : [],
      triggers: Array.isArray(raw.triggers) ? raw.triggers : [],
    };
  }

  flush(): void {
    writeJson(this.path, this.data);
  }

  listByActor(actorId: string, status?: string): Alarm[] {
    const now = Date.now();
    return this.data.alarms.filter(
      (a) =>
        a.actorId === actorId &&
        (status ? a.status === status : true) &&
        // 读取时惰性收尾：单次闹钟错过超过 24h 且未响（脏数据）→ 标记 done，不再出现在 active 列表
        !(a.status === "active" && !a.repeat.rule && a.nextFireAt && new Date(a.nextFireAt).getTime() < now - 24 * 3600 * 1000),
    );
  }

  get(id: string): Alarm | undefined {
    return this.data.alarms.find((a) => a.id === id);
  }

  /** 幂等创建：同 actor 同 idempotencyKey，或同 label 且 fireAt 相差 <60s → 返回既有条目 */
  findDuplicate(actorId: string, input: AlarmCreateInput): Alarm | undefined {
    if (input.idempotencyKey) {
      const hit = this.data.alarms.find(
        (a) => a.actorId === actorId && a.idempotencyKey === input.idempotencyKey && a.status !== "canceled",
      );
      if (hit) return hit;
    }
    const fireMs = new Date(input.fireAt).getTime();
    if (!Number.isFinite(fireMs)) return undefined;
    return this.data.alarms.find((a) => {
      if (a.actorId !== actorId || a.status === "canceled") return false;
      if (a.label !== input.label) return false;
      const delta = Math.abs(new Date(a.fireAt).getTime() - fireMs);
      return delta < 60_000;
    });
  }

  create(input: AlarmCreateInput): Alarm {
    const nowIso = new Date().toISOString();
    const fireMs = new Date(input.fireAt).getTime();
    const alarm: Alarm = {
      id: `alarm_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      actorId: input.actorId,
      deviceId: input.deviceId ?? null,
      label: input.label,
      kind: input.kind ?? "alarm",
      fireAt: input.fireAt,
      repeat: { rule: input.repeatRule ?? null, until: null, count: null },
      snooze: { ...defaultSnooze(), ...(input.snooze ?? {}) },
      wakeMode: input.wakeMode,
      dnd: { bypass: input.dndBypass ?? (input.kind ?? "alarm") === "alarm" },
      status: "active",
      createdAt: nowIso,
      updatedAt: nowIso,
      lastFiredAt: null,
      nextFireAt: new Date(fireMs).toISOString(),
      idempotencyKey: input.idempotencyKey ?? null,
      snoozeCount: 0,
      source: input.source ?? "agent",
      ...(input.kind === "reminder"
        ? {
            channelPlan: input.channelPlan ?? ["notification", "popup"],
            escalateAfterSec: input.escalateAfterSec ?? 120,
            requireAck: input.requireAck ?? true,
            remindText: input.remindText ?? input.label,
          }
        : {}),
    } as Alarm;
    this.data.alarms.push(alarm);
    this.flush();
    return alarm;
  }

  update(id: string, patch: Partial<AlarmCreateInput>): Alarm | undefined {
    const alarm = this.get(id);
    if (!alarm) return undefined;
    if (patch.label !== undefined) alarm.label = patch.label;
    if (patch.fireAt !== undefined) {
      alarm.fireAt = patch.fireAt;
      alarm.nextFireAt = new Date(new Date(patch.fireAt).getTime()).toISOString();
      alarm.snoozeCount = 0;
    }
    if (patch.repeatRule !== undefined) {
      alarm.repeat = { ...alarm.repeat, rule: patch.repeatRule };
      this.recomputeNextFire(alarm);
    }
    if (patch.snooze !== undefined) alarm.snooze = { ...alarm.snooze, ...patch.snooze };
    if (patch.wakeMode !== undefined) alarm.wakeMode = patch.wakeMode;
    if (patch.dndBypass !== undefined) alarm.dnd = { bypass: patch.dndBypass };
    if (patch.status !== undefined) alarm.status = patch.status;
    alarm.updatedAt = new Date().toISOString();
    this.flush();
    return alarm;
  }

  /** 触发后推进下一跳：重复 → 单跳重算；单次 → done */
  advanceAfterFire(alarm: Alarm, nowMs: number): void {
    alarm.lastFiredAt = new Date(nowMs).toISOString();
    const next = advanceAlarmNextFireMs(alarm.repeat, new Date(alarm.fireAt).getTime(), nowMs);
    if (next !== null) {
      alarm.nextFireAt = new Date(next).toISOString();
      alarm.snoozeCount = 0;
      alarm.status = "active";
    } else {
      alarm.nextFireAt = null;
      alarm.status = "done";
    }
    alarm.updatedAt = new Date().toISOString();
    this.flush();
  }

  /** 贪睡：把 nextFireAt 顺延 minutes 分钟（不动 repeat 语义），累计次数 */
  snooze(alarm: Alarm, minutes: number, nowMs: number): Alarm {
    const base = Math.max(nowMs, new Date(alarm.nextFireAt ?? alarm.fireAt).getTime());
    alarm.nextFireAt = new Date(base + minutes * 60_000).toISOString();
    alarm.snoozeCount = (alarm.snoozeCount ?? 0) + 1;
    alarm.updatedAt = new Date().toISOString();
    this.flush();
    return alarm;
  }

  recomputeNextFire(alarm: Alarm): void {
    const anchor = new Date(alarm.fireAt).getTime();
    const nowMs = Date.now();
    if (!alarm.repeat.rule) {
      alarm.nextFireAt = anchor > nowMs ? new Date(anchor).toISOString() : null;
      return;
    }
    alarm.nextFireAt = new Date(advanceAlarmNextFireMs(alarm.repeat, anchor, nowMs) ?? 0).toISOString() || null;
    if (!alarm.nextFireAt || new Date(alarm.nextFireAt).getTime() <= 0) alarm.nextFireAt = null;
  }

  recordTrigger(rec: AlarmTriggerRecord): { accepted: boolean; duplicate: boolean } {
    // 幂等：同一 alarmId 同一跳（±90s 窗口）只记一次
    const dup = this.data.triggers.find(
      (t) => t.alarmId === rec.alarmId && Math.abs(t.firedAtMs - rec.firedAtMs) < 90_000 && t.outcome !== "ringing",
    );
    if (dup) return { accepted: false, duplicate: true };
    this.data.triggers.push(rec);
    if (this.data.triggers.length > MAX_TRIGGER_RECORDS) {
      this.data.triggers = this.data.triggers.slice(-MAX_TRIGGER_RECORDS);
    }
    this.flush();
    return { accepted: true, duplicate: false };
  }

  listTriggers(alarmId: string): AlarmTriggerRecord[] {
    return this.data.triggers.filter((t) => t.alarmId === alarmId);
  }
}
