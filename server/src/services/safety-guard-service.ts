import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { decryptWellnessJson, encryptWellnessJson } from "./wellness-crypto.js";
import type { ProactiveProposal } from "../proactivity/pipeline-types.js";

/**
 * 安全守护 service（方案见 docs/women-care-proposal.md §A）。
 *
 * M1 三条链路（全部用户主动触发，无自动监听——声学/视觉主动检测属 M2+，见方案 §6.1）：
 *   - 紧急联系人管理（加密存储，上限 5 位）
 *   - 一键 SOS：按需取一次定位（LocationCoordinator ondemand，不做持续上传）
 *     → 向紧急联系人发求助短信 → 经 proactivity 管道 critical 通知用户全部设备
 *   - 借口来电：经 PhoneCallCoordinator 真实外呼用户本人手机（复用确认门/频控，
 *     用户在聊天确认 + 手机全屏二次确认后才拨出）
 *
 * 定位隐私：SOS 触发时请求一次实时定位，失败回退 60s 内缓存；不落库、
 * 不进位置历史，短信发出即弃（方案 §D.2）。
 */

/** 紧急联系人。 */
export interface EmergencyContact {
  id: string;
  name: string;
  /** 手机号，原样保存（对外展示一律走 maskPhone） */
  phone: string;
  /** 关系（如 家人 / 闺蜜 / 室友），原样保存 */
  relationship?: string;
  isPrimary?: boolean;
  createdAt: string;
}

/** 安全偏好设置。 */
export interface SafetySettings {
  /** 用户本人手机号（借口来电的被叫号码） */
  myMobileNumber?: string;
  /** SOS 短信附加信息（如过敏史/血型，供联系人转告急救） */
  sosNote?: string;
  /** 借口来电默认话术要点 */
  fakeCallScript?: string;
}

/** 单个 actor 的存储结构（加密落盘）。 */
interface SafetyStore {
  version: 1;
  contacts: EmergencyContact[];
  settings: SafetySettings;
  /** SOS 触发历史（最近 20 条） */
  sosHistory: Array<{ at: string; reason?: string; okCount: number; total: number }>;
}

/** SOS 单个联系人的投递结果。 */
export interface SosDispatchResult {
  contactId: string;
  name: string;
  phoneMasked: string;
  ok: boolean;
  error?: string;
}

export interface SosResult {
  ok: boolean;
  /** SOS 已受理（至少流程完整走完）；联系人全部失败时 ok 仍为 true 但 dispatched=false */
  dispatched: boolean;
  needsSetup?: boolean;
  notified: SosDispatchResult[];
  location: { latitude: number; longitude: number; city?: string; district?: string } | null;
  emergencyHint: string[];
  summary: string;
  error?: string;
}

/** 按需定位端口（wiring 注入 LocationCoordinator，测试注入 stub）。 */
export type SafetyLocationPort = (
  actorId: string,
  reason: string,
) => Promise<{
  latitude: number;
  longitude: number;
  city?: string;
  district?: string;
} | null>;

/** 主动通知端口（同 period-care，经 proactivity 管道直投）。 */
export interface SafetyNotifyPort {
  submitProposal(p: ProactiveProposal): unknown;
}

export interface SafetyGuardDeps {
  dataDir: string;
  /** 发短信（EmailSmsService.sendSms 的窄化端口） */
  sendSms: (params: { to: string; text: string }) => Promise<{ ok: boolean; error?: string }>;
  /** 借口来电：PhoneCallCoordinator.prepare 的窄化端口（复用确认门/频控） */
  prepareCall: (
    actorId: string,
    input: {
      number: string;
      contactName?: string;
      goal: string;
      script?: string;
      facts?: Record<string, unknown>;
    },
  ) => Promise<Record<string, unknown>>;
  /** 电话代办能力是否启用（PHONE_CALL_ENABLED） */
  isCallEnabled: () => boolean;
  /** 按需定位（含 60s 缓存兜底） */
  requestLocation: SafetyLocationPort;
  getPipeline: () => SafetyNotifyPort | null;
  now?: () => Date;
}

const MAX_CONTACTS = 5;

export function maskPhone(phone: string): string {
  const p = phone.trim();
  if (p.length < 7) return "***";
  return `${p.slice(0, 3)}****${p.slice(-4)}`;
}

export class SafetyGuardService {
  private readonly stores = new Map<string, SafetyStore>();
  private readonly dirty = new Set<string>();
  private persistTimer: NodeJS.Timeout | null = null;
  private readonly now: () => Date;

  constructor(private readonly deps: SafetyGuardDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** 启动加载（加密文件；解密失败跳过并告警，不做静默覆盖）。 */
  async load(): Promise<void> {
    let files: string[];
    try {
      files = await readdir(this.deps.dataDir);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("ENOENT")) {
        console.error("[SafetyGuard] load readdir failed:", error);
      }
      return;
    }
    for (const f of files.filter((f) => f.endsWith(".json"))) {
      const actorId = f.slice(0, -5);
      try {
        const raw = await readFile(join(this.deps.dataDir, f), "utf8");
        this.stores.set(actorId, this.normalizeStore(decryptWellnessJson<SafetyStore>(raw)));
      } catch (error) {
        console.error(`[SafetyGuard] load file ${f} failed（密钥不匹配或数据损坏?）:`, error);
      }
    }
  }

  async flush(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    const ids = Array.from(this.dirty);
    this.dirty.clear();
    for (const actorId of ids) {
      const store = this.stores.get(actorId);
      if (!store) continue;
      try {
        await mkdir(this.deps.dataDir, { recursive: true });
        await writeFile(
          join(this.deps.dataDir, `${actorId}.json`),
          encryptWellnessJson(store),
          "utf8",
        );
      } catch (error) {
        console.error(`[SafetyGuard] flush ${actorId} failed:`, error);
      }
    }
  }

  /** 清除某 actor 的全部安全档案（一键清除隐私承诺）。 */
  async purge(actorId: string): Promise<void> {
    this.stores.delete(actorId);
    this.dirty.delete(actorId);
    try {
      await rm(join(this.deps.dataDir, `${actorId}.json`), { force: true });
    } catch (error) {
      console.error(`[SafetyGuard] purge ${actorId} failed:`, error);
    }
  }

  // ─── 紧急联系人 ─────────────────────────────────────────────────────

  /** 新增或更新紧急联系人（按 id 更新；同号自动合并；上限 5 位）。 */
  async setContact(
    actorId: string,
    input: { id?: string; name: string; phone: string; relationship?: string; isPrimary?: boolean },
  ): Promise<{ contact: EmergencyContact; merged: boolean }> {
    const store = this.getStore(actorId);
    const name = input.name.trim();
    const phone = input.phone.trim();
    if (!name || !phone) {
      throw new Error("姓名与手机号均为必填");
    }
    let merged = false;
    let contact = input.id
      ? store.contacts.find((c) => c.id === input.id)
      : store.contacts.find((c) => c.phone === phone);
    if (contact) {
      merged = true;
      contact.name = name;
      contact.phone = phone;
      if (input.relationship != null) contact.relationship = input.relationship.trim() || undefined;
    } else {
      if (store.contacts.length >= MAX_CONTACTS) {
        throw new Error(`紧急联系人最多 ${MAX_CONTACTS} 位，请先移除一位再加`);
      }
      contact = {
        id: randomUUID(),
        name,
        phone,
        ...(input.relationship?.trim() ? { relationship: input.relationship.trim() } : {}),
        createdAt: this.now().toISOString(),
      };
      store.contacts.push(contact);
    }
    if (input.isPrimary) {
      for (const c of store.contacts) c.isPrimary = c.id === contact.id;
    } else if (!store.contacts.some((c) => c.isPrimary)) {
      contact.isPrimary = true; // 首位联系人自动设为主联系人
    }
    this.schedulePersist(actorId);
    return { contact, merged };
  }

  async removeContact(actorId: string, contactId: string): Promise<boolean> {
    const store = this.getStore(actorId);
    const idx = store.contacts.findIndex((c) => c.id === contactId);
    if (idx < 0) return false;
    const [removed] = store.contacts.splice(idx, 1);
    if (removed.isPrimary && store.contacts.length > 0) {
      store.contacts[0].isPrimary = true;
    }
    this.schedulePersist(actorId);
    return true;
  }

  /** 联系人列表（手机号脱敏，真实号码只在 SOS 发送时内部使用）。 */
  listContacts(actorId: string): Array<
    EmergencyContact & { phone: string }
  > {
    const store = this.getStore(actorId);
    return [...store.contacts]
      .sort((a, b) => Number(b.isPrimary ?? false) - Number(a.isPrimary ?? false))
      .map((c) => ({ ...c, phone: maskPhone(c.phone) }));
  }

  // ─── 设置 ───────────────────────────────────────────────────────────

  async updateSettings(actorId: string, patch: Partial<SafetySettings>): Promise<SafetySettings> {
    const store = this.getStore(actorId);
    if (patch.myMobileNumber != null) {
      const v = patch.myMobileNumber.trim();
      store.settings.myMobileNumber = v || undefined;
    }
    if (patch.sosNote != null) {
      const v = patch.sosNote.trim();
      store.settings.sosNote = v || undefined;
    }
    if (patch.fakeCallScript != null) {
      const v = patch.fakeCallScript.trim();
      store.settings.fakeCallScript = v || undefined;
    }
    this.schedulePersist(actorId);
    return this.getSettings(actorId);
  }

  getSettings(actorId: string): SafetySettings {
    const s = this.getStore(actorId).settings;
    return {
      ...s,
      myMobileNumber: s.myMobileNumber ? maskPhone(s.myMobileNumber) : undefined,
    };
  }

  // ─── SOS ────────────────────────────────────────────────────────────

  /**
   * 触发紧急求助：按需定位（一次）→ 联系人短信 → 用户全设备 critical 通知。
   * 不做任何确认门（用户说「救命」时每一步延迟都是代价），误触由客户端
   * 触发层的倒计时撤销负责。
   */
  async triggerSos(actorId: string, input: { reason?: string } = {}): Promise<SosResult> {
    const store = this.getStore(actorId);
    const hint = ["110", "120", "119"];
    if (store.contacts.length === 0) {
      this.notifyUser(actorId, {
        title: "收到紧急求助信号",
        text: "还没有配置紧急联系人，短信无法代发。请现在直接拨打 110 / 120。空下来后跟我说「设置紧急联系人」，下次我可以帮你自动通知。",
      });
      return {
        ok: false,
        dispatched: false,
        needsSetup: true,
        notified: [],
        location: null,
        emergencyHint: hint,
        error: "尚未配置紧急联系人，无法代发求助短信",
        summary: "未配置紧急联系人；已提醒用户直接拨打 110/120",
      };
    }

    const location = await this.deps.requestLocation(actorId, "safety:sos").catch(() => null);
    const contacts = [...store.contacts].sort(
      (a, b) => Number(b.isPrimary ?? false) - Number(a.isPrimary ?? false),
    );
    const smsText = this.buildSmsText(input.reason, location, store.settings.sosNote);

    const settled = await Promise.allSettled(
      contacts.map((c) => this.deps.sendSms({ to: c.phone, text: smsText })),
    );
    const notified: SosDispatchResult[] = contacts.map((c, i) => {
      const r = settled[i];
      const ok = r.status === "fulfilled" && r.value.ok === true;
      return {
        contactId: c.id,
        name: c.name,
        phoneMasked: maskPhone(c.phone),
        ok,
        ...(ok ? {} : { error: r.status === "rejected" ? String(r.reason) : r.value.error }),
      };
    });
    const okCount = notified.filter((n) => n.ok).length;

    const locText = location
      ? "已附实时位置。"
      : "暂时拿不到定位，短信里没有位置信息。";
    this.notifyUser(actorId, {
      title: okCount > 0 ? "紧急求助短信已发出" : "紧急求助短信未能发出",
      text:
        okCount > 0
          ? `已向 ${okCount}/${contacts.length} 位紧急联系人（${notified
              .filter((n) => n.ok)
              .map((n) => n.name)
              .join("、")}）发出求助短信，${locText}如果情况紧急，请直接拨打 110 / 120。`
          : "求助短信全部发送失败（短信服务可能未配置）。请立即直接拨打 110 / 120，不要等待。",
    });

    store.sosHistory.push({
      at: this.now().toISOString(),
      ...(input.reason ? { reason: input.reason } : {}),
      okCount,
      total: contacts.length,
    });
    if (store.sosHistory.length > 20) store.sosHistory.shift();
    this.schedulePersist(actorId);

    const names = notified.map((n) => `${n.name}${n.ok ? "✓" : "✗"}`).join("、");
    return {
      ok: true,
      dispatched: okCount > 0,
      notified,
      location: location
        ? {
            latitude: location.latitude,
            longitude: location.longitude,
            ...(location.city ? { city: location.city } : {}),
            ...(location.district ? { district: location.district } : {}),
          }
        : null,
      emergencyHint: hint,
      summary:
        okCount > 0
          ? `求助短信已发给 ${okCount}/${contacts.length} 位联系人（${names}），${locText}请提醒用户：110/120 永远优先。`
          : `短信全部发送失败（${names}）。请立即告诉用户直接拨打 110/120。`,
    };
  }

  // ─── 借口来电 ───────────────────────────────────────────────────────

  /**
   * 借口来电：经 PhoneCallCoordinator.prepare 走确认门（聊天卡片确认 +
   * 手机全屏二次确认后由手机桥拨出真实电话）。
   */
  async requestFakeCall(
    actorId: string,
    input: { script?: string; goal?: string } = {},
  ): Promise<Record<string, unknown>> {
    const store = this.getStore(actorId);
    if (!this.deps.isCallEnabled()) {
      return {
        ok: false,
        error: "电话能力未启用（服务端 PHONE_CALL_ENABLED=false），无法拨出来电",
        setupHint: "在服务端 .env 设置 PHONE_CALL_ENABLED=1 并配置手机桥后重试",
      };
    }
    const number = store.settings.myMobileNumber;
    if (!number) {
      return {
        ok: false,
        error: "尚未配置你的手机号，不知道该往哪里打",
        needsSetup: true,
        summary: "请用户先说「设置我的手机号为 1xx…」，再重新请求借口来电",
      };
    }
    const result = await this.deps.prepareCall(actorId, {
      number,
      contactName: "小助手",
      goal: input.goal?.trim() || "借口来电：制造一个自然离开的理由",
      script: input.script?.trim() || store.settings.fakeCallScript,
      facts: { purpose: "fake_call" },
    });
    const ok = (result as { ok?: boolean }).ok !== false;
    return {
      ...result,
      ok,
      summary: ok
        ? "已发起借口来电请求，用户在聊天里确认、并在手机上二次确认后，小助手会真实拨到 TA 的手机上（接通后无自动话术，用户自行发挥）。"
        : undefined,
    };
  }

  // ─── 内部 ───────────────────────────────────────────────────────────

  /** 求助短信文案（联系人视角；无位置时明确说明，避免虚假安心）。 */
  private buildSmsText(
    reason: string | undefined,
    location: Awaited<ReturnType<SafetyLocationPort>>,
    sosNote: string | undefined,
  ): string {
    const now = this.now();
    const timeText = `${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const locText = location
      ? `我的位置：https://uri.amap.com/marker?position=${location.longitude},${location.latitude}（${location.latitude.toFixed(5)}, ${location.longitude.toFixed(5)}${location.city ? `，${location.city}${location.district ?? ""}` : ""}）`
      : "暂时无法获取我的定位，请立刻打电话给我。";
    return [
      "【紧急求助】我可能遇到了需要帮助的情况，收到请立刻联系我。",
      reason ? `情况：${reason}。` : "",
      locText,
      `时间：${timeText}。`,
      sosNote ? `健康信息：${sosNote}。` : "",
      "（本条消息由我的私人助理自动发出）",
    ]
      .filter(Boolean)
      .join("\n");
  }

  /** 经 proactivity 管道 critical 直投用户全部设备（桌面弹窗 + 离线手机推送）。 */
  private notifyUser(actorId: string, msg: { title: string; text: string }): void {
    const pipeline = this.deps.getPipeline();
    if (!pipeline) return;
    const proposal: ProactiveProposal = {
      proposalId: `p_${Date.now().toString(36)}_sos`,
      actorId,
      kind: "safety_sos",
      tier: "must",
      importance: "critical",
      dedupKey: `safety_sos:${actorId}:${Date.now()}`,
      title: msg.title,
      summary: msg.text,
      evidence: ["safety-guard:sos"],
      directText: msg.text,
      createdAt: Date.now(),
      source: "tool",
    };
    try {
      pipeline.submitProposal(proposal);
    } catch (error) {
      console.error("[SafetyGuard] notifyUser failed:", error);
    }
  }

  private getStore(actorId: string): SafetyStore {
    let store = this.stores.get(actorId);
    if (!store) {
      store = { version: 1, contacts: [], settings: {}, sosHistory: [] };
      this.stores.set(actorId, store);
      this.schedulePersist(actorId);
    }
    return store;
  }

  private normalizeStore(raw: Partial<SafetyStore>): SafetyStore {
    return {
      version: 1,
      contacts: Array.isArray(raw.contacts) ? raw.contacts : [],
      settings: raw.settings ?? {},
      sosHistory: Array.isArray(raw.sosHistory) ? raw.sosHistory : [],
    };
  }

  private schedulePersist(actorId: string): void {
    this.dirty.add(actorId);
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.flush();
    }, 1_000);
    this.persistTimer.unref?.();
  }
}
