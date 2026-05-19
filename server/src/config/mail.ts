/**
 * Agent 专用邮箱默认域名（替换为真实域名前请勿用于对外投递）。
 * 可通过环境变量 AGENT_MAIL_DOMAIN 覆盖。
 */
export function getAgentMailDomain(): string {
  return process.env.AGENT_MAIL_DOMAIN?.trim() || "agents.privateai.local";
}

/**
 * Inbound Webhook 共享密钥；若设置则请求须带 `X-Agent-Mail-Secret` 头与之相同。
 * 未设置时不校验（仅适合本机/内网调试）。
 */
export function getAgentMailInboundSecret(): string | undefined {
  const s = process.env.AGENT_MAIL_INBOUND_SECRET?.trim();
  return s || undefined;
}
