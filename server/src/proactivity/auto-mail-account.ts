// 邮箱自动接入（P2，2026-10-01）：注册登录时留下的邮箱自动接入邮件盯梢。
//
// 链路：AgentAccountService（注册表，邮箱在注册/OTP 流程已验证落库）→
// 本模块按邮箱域推断 IMAP host → 注入 MailWatchService（actorId=该邮箱账号）。
//
// 诚实边界：IMAP 密码是邮箱服务商的「授权码」，不是邮箱登录密码——服务端
// 无从得知，必须用户在设置里填一次（MAIL_WATCH_PASS 或设置页）。本模块只
// 负责「邮箱地址自动接线 + host 自动推断 + actorId 自动归属」这三件，
// 授权码未配置时 status() 如实报 needs_pass，绝不假装在盯。
//
// host 映射表覆盖国内主流邮箱；未收录的域（企业邮箱/小众邮箱）不猜——
// 返回 unknown_domain，等显式 MAIL_WATCH_HOST 配置。
import type { AgentAccountService, AgentAccountRecord } from "../services/agent-account-service.js";

/** 常见邮箱域 → IMAP host（端口统一 993 IMAPS）。新增域加一行。 */
const DOMAIN_IMAP_HOST: Record<string, string> = {
  "qq.com": "imap.qq.com",
  "foxmail.com": "imap.qq.com",
  "163.com": "imap.163.com",
  "126.com": "imap.126.com",
  "yeah.net": "imap.yeah.net",
  "gmail.com": "imap.gmail.com",
  "outlook.com": "outlook.office365.com",
  "hotmail.com": "outlook.office365.com",
  "icloud.com": "imap.mail.me.com",
  "aliyun.com": "imap.aliyun.com",
  "sina.com": "imap.sina.com",
  "sohu.com": "imap.sohu.com",
  "139.com": "imap.139.com",
  "189.cn": "imap.189.cn",
};

export type ResolvedMailAccount = {
  actorId: string;
  email: string;
  imapHost: string;
  imapPort: number;
};

/**
 * 从注册表解析「最近活跃、邮箱可映射 IMAP host」的账号（单用户机即真实用户）。
 * 无匹配（未注册邮箱/未收录域/账号表未加载）返回 null——调用方保持 env 配置路径。
 */
export function resolveAutoMailAccount(
  accounts: AgentAccountService,
): ResolvedMailAccount | null {
  let best: { rec: AgentAccountRecord; host: string } | null = null;
  for (const rec of accounts.listAll()) {
    if (!rec.email || !rec.setupComplete) continue;
    const domain = rec.email.split("@")[1]?.toLowerCase() ?? "";
    const host = DOMAIN_IMAP_HOST[domain];
    if (!host) continue;
    const at = Date.parse(rec.lastActiveAt ?? rec.createdAt ?? "");
    const bestAt = best ? Date.parse(best.rec.lastActiveAt ?? best.rec.createdAt ?? "") : -1;
    if (!best || at > bestAt) best = { rec, host };
  }
  if (!best) return null;
  return {
    actorId: best.rec.userId,
    email: best.rec.email!,
    imapHost: best.host,
    imapPort: 993,
  };
}
