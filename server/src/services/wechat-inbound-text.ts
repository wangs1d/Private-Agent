/**
 * OpenClaw 微信入站（before_dispatch）常带「Conversation info」信封，需剥离后再送入 AgentCore。
 */
export function sanitizeWechatInboundText(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";

  const withoutEnvelope = trimmed.replace(
    /Conversation info\s*\(untrusted metadata\):\s*```[\s\S]*?```\s*/i,
    "",
  ).trim();
  if (withoutEnvelope && withoutEnvelope !== trimmed) {
    return withoutEnvelope;
  }

  const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1] ?? "";
  if (last && !last.startsWith("{") && !last.includes("chat_id")) {
    return last;
  }

  return trimmed;
}
