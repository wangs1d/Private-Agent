/**
 * actor 形式归一（2026-10-04 事故根修）。
 *
 * 权威形式 = 原始 actorId（如邮箱带 @：2378709729@qq.com）。历史上一条夜间
 * 固化链把 journal 目录名（旧净化规则下 2378709729_qq.com）当 actorId 写进了
 * ledger/provenance/bridge/mem0/HumanLikeMemory 等几乎所有记忆库，导致同一
 * 用户两种形式并存：按单形式 purge 会漏（清空记忆清不掉日志固化）、按单形式
 * 召回查不到（固化内容不可见）。目录净化已改为保留 @（daily-journal-service
 * 落盘边界，sanitizeActorKey），新数据单形式；凡按 actor 删/扫的路径一律用
 * actorIdVariants 同时覆盖两种形式，兼容存量。
 */

/** 存储键净化（现行规则）：只替换文件系统不友好的字符；@ 必须保留（邮箱 actor 原样往返） */
export function sanitizeActorKey(actorId: string): string {
  return String(actorId ?? "").replace(/[^\w.@-]/g, "_");
}

/** 旧净化规则（2026-10-04 前）：@ 不在保留集，被替换成 _ —— 存量第二种形式的来源 */
function legacySanitizeActorKey(actorId: string): string {
  return String(actorId ?? "").replace(/[^\w.-]/g, "_");
}

/**
 * 历史/存量数据可能以任一形式落库：返回 [原始 id, 旧规则净化 id]（去重、保序）。
 * 用于 purge / 全量扫描等按 actor 删查的边界，保证两种形式都命中。
 */
export function actorIdVariants(actorId: string): string[] {
  const raw = String(actorId ?? "").trim();
  if (!raw) return [];
  const legacy = legacySanitizeActorKey(raw);
  return legacy === raw ? [raw] : [raw, legacy];
}
