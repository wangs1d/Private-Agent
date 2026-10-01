import { randomInt } from "crypto";

/**
 * 邮箱所有权验证码（OTP）：注册/登录前向用户自报的邮箱发验证码，
 * 证明「这个邮箱真的属于你」——堵住「随便编一个邮箱字符串即可注册登录」的洞。
 *
 * 与 {@link EmailRegistrationService}（系统分配占位邮箱的注册流）不同：
 * 这里的邮箱是用户自己填的外部真实邮箱，验证码通过 {@link EmailSmsService}
 * 的 SMTP 通道发出（OUTBOUND_SMTP_* 凭据齐备才启用）。
 *
 * 存储为进程内存（验证码 TTL 10 分钟，重启清空 = 重新走一次发码即可，
 * 不值得为瞬时状态落盘）；限频防两种滥用：
 * - 拿我们的 SMTP 通道当垃圾邮件跳板（对任意邮箱狂发）；
 * - 对同一邮箱验证码爆破（尝试次数封顶）。
 */

export type EmailOtpRecord = {
  code: string;
  /** 过期时间（epoch ms） */
  expiresAt: number;
  /** 已尝试验证次数（含失败；封顶后作废） */
  attempts: number;
  /** 本记录内的发码时间戳（滚动 1 小时限频用） */
  sentAt: number[];
};

/** 重发冷却：同一邮箱两次发码最小间隔 */
const RESEND_COOLDOWN_MS = 60_000;
/** 同一邮箱滚动 1 小时最多发码次数 */
const MAX_SENDS_PER_EMAIL_PER_HOUR = 5;
/** 同一 IP 滚动 1 小时最多触发发码次数（防扫任意邮箱轰炸） */
const MAX_SENDS_PER_IP_PER_HOUR = 20;
/** 验证码有效期 */
const CODE_TTL_MS = 10 * 60_000;
/** 单个验证码最多尝试次数（超过作废，须重新发码） */
const MAX_VERIFY_ATTEMPTS = 5;

export type OtpIssueResult =
  | { ok: true; /** 重发冷却秒数（前端倒计时用） */ resendAfterSeconds: number; ttlMinutes: number }
  | { ok: false; error: string; retryAfterSeconds?: number };

export class EmailOtpService {
  private readonly byEmail = new Map<string, EmailOtpRecord>();
  private readonly ipSends = new Map<string, number[]>();

  /** 邮箱归一：与账号主键同一套小写规则。 */
  static normalize(email: string): string {
    return email.trim().toLowerCase();
  }

  private prune(): void {
    const now = Date.now();
    for (const [k, rec] of this.byEmail) {
      if (now > rec.expiresAt) this.byEmail.delete(k);
    }
    for (const [k, stamps] of this.ipSends) {
      const alive = stamps.filter((t) => now - t < 3_600_000);
      if (alive.length === 0) this.ipSends.delete(k);
      else this.ipSends.set(k, alive);
    }
  }

  /**
   * 签发验证码并交付（deliver 由调用方注入：路由层负责真正发邮件，
   * 便于测试注入假通道）。限频不通过时返回 ok:false。
   */
  async issue(
    rawEmail: string,
    opts: { ip?: string; deliver: (email: string, code: string) => Promise<void> },
  ): Promise<OtpIssueResult> {
    this.prune();
    const email = EmailOtpService.normalize(rawEmail);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return { ok: false, error: "请输入有效的邮箱地址" };
    }
    const now = Date.now();

    const rec = this.byEmail.get(email);
    if (rec && rec.sentAt.length > 0) {
      const sinceLast = now - rec.sentAt[rec.sentAt.length - 1];
      if (sinceLast < RESEND_COOLDOWN_MS) {
        return {
          ok: false,
          error: "验证码发送过于频繁，请稍后再试",
          retryAfterSeconds: Math.ceil((RESEND_COOLDOWN_MS - sinceLast) / 1000),
        };
      }
      const hourAgo = now - 3_600_000;
      if (rec.sentAt.filter((t) => t >= hourAgo).length >= MAX_SENDS_PER_EMAIL_PER_HOUR) {
        return { ok: false, error: "该邮箱发码次数已达上限，请 1 小时后再试" };
      }
    }

    if (opts.ip) {
      const stamps = this.ipSends.get(opts.ip) ?? [];
      const hourAgo = now - 3_600_000;
      if (stamps.filter((t) => t >= hourAgo).length >= MAX_SENDS_PER_IP_PER_HOUR) {
        return { ok: false, error: "操作过于频繁，请 1 小时后再试" };
      }
    }

    const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
    // 重新发码沿用记录累加 sentAt（滚动限频），过期记录已被 prune 重建
    const next: EmailOtpRecord = rec ?? { code: "", expiresAt: 0, attempts: 0, sentAt: [] };
    next.code = code;
    next.expiresAt = now + CODE_TTL_MS;
    next.attempts = 0;
    next.sentAt = [...next.sentAt.filter((t) => t >= now - 3_600_000), now];
    this.byEmail.set(email, next);

    if (opts.ip) {
      this.ipSends.set(opts.ip, [...(this.ipSends.get(opts.ip) ?? []), now]);
    }

    try {
      await opts.deliver(email, code);
    } catch (e) {
      // 发送失败：保留记录但立刻可重试（不锁冷却），避免凭据故障把用户锁死
      next.sentAt = next.sentAt.slice(0, -1);
      throw e;
    }

    return {
      ok: true,
      resendAfterSeconds: Math.ceil(RESEND_COOLDOWN_MS / 1000),
      ttlMinutes: Math.ceil(CODE_TTL_MS / 60_000),
    };
  }

  /**
   * 校验验证码。`consume` 为 true 时验证通过即作废（一次性）；
   * 为 false 用于「先探后用」——通过后由调用方在闸门全过时再 consume。
   * 尝试次数封顶：连错 5 次作废该码，须重新发码。
   */
  verify(rawEmail: string, code: string, opts: { consume?: boolean } = {}): boolean {
    this.prune();
    const email = EmailOtpService.normalize(rawEmail);
    const rec = this.byEmail.get(email);
    if (!rec) return false;
    if (Date.now() > rec.expiresAt) {
      this.byEmail.delete(email);
      return false;
    }
    if (rec.attempts >= MAX_VERIFY_ATTEMPTS) {
      this.byEmail.delete(email);
      return false;
    }
    rec.attempts += 1;
    if (rec.code !== code.trim()) {
      if (rec.attempts >= MAX_VERIFY_ATTEMPTS) this.byEmail.delete(email);
      return false;
    }
    if (opts.consume) this.byEmail.delete(email);
    return true;
  }

  /** 验证通过后作废（一次性语义；配合 verify({consume:false}) 使用）。 */
  consume(rawEmail: string): void {
    this.byEmail.delete(EmailOtpService.normalize(rawEmail));
  }

  /** 测试钩子：直读当前码（仅供单测/探针，生产路由不暴露）。 */
  peekCodeForTest(rawEmail: string): string | undefined {
    return this.byEmail.get(EmailOtpService.normalize(rawEmail))?.code;
  }
}
