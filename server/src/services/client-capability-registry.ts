/**
 * 客户端能力声明注册表（进程内，按 actorId）。
 *
 * 背景（2026-09-12）：media.play 等媒体控制工具向客户端推 `agent.media.*` WS 事件，
 * 服务端无法知道客户端是否真的实现了播放——历史事故：客户端从未实现 agent.media.play
 * 处理，push 成功后模型基于「客户端会自动播放」的工具摘要向用户宣称「歌已经放上了」，
 * 实际什么都没响（假成功）。
 *
 * 契约：客户端在 session.init 里带 `capabilities: { mediaPlayback: true }` 声明能力；
 * 未声明（默认）= 不支持，媒体推送类工具如实返回失败，让模型改走 desktop.open 等
 * 真实可达路径，而不是空口宣称成功。
 */

const TTL_MS = 12 * 60 * 60_000;

interface StoredCapabilities {
  mediaPlayback: boolean;
  declaredAt: number;
}

const byActor = new Map<string, StoredCapabilities>();

export function declareClientCapabilities(
  actorId: string,
  caps: { mediaPlayback?: boolean } | undefined,
): void {
  const id = actorId?.trim();
  if (!id) return;
  byActor.set(id, {
    mediaPlayback: caps?.mediaPlayback === true,
    declaredAt: Date.now(),
  });
}

export function clearClientCapabilities(actorId: string): void {
  byActor.delete(actorId);
}

/** 客户端是否声明了媒体播放能力。未声明/已过期一律 false（fail-closed = 诚实失败）。 */
export function clientSupportsMediaPlayback(actorId: string): boolean {
  const stored = byActor.get(actorId?.trim() ?? "");
  if (!stored) return false;
  if (Date.now() - stored.declaredAt > TTL_MS) {
    byActor.delete(actorId);
    return false;
  }
  return stored.mediaPlayback;
}
