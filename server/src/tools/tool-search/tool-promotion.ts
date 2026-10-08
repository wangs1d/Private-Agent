/**
 * 高频工具晋升（2026-10-09 五层根修 L4，chat / task 车道共用）。
 *
 * 机理：模型真实成功调用过 N 次（默认 3）的延迟工具，说明该 actor 的工作流
 * 真用得上它——晋升为该 actor 的常驻可见工具，不再依赖每轮的域预载/top-K
 * 兜底/两波 discover 召回。这是「调用即发现」（L3 转正）的下游闭环：转正
 * 执行成功 → 记晋升计数 → 凑满阈值常驻。
 *
 * 为什么不用 sharedHistoryStore：那是检索排序的反馈信号（RRS 加权/衰减），
 * 语义是「分数」；晋升需要的是「近窗真实成功次数 ≥ 阈值」的确定性计数，
 * 两者混用会让晋升被检索调参牵连。本模块独立进程内计数（重启即清零，无妨——
 * 高频工具很快重新凑满），按 actor 隔离。
 *
 * 观测对齐：入口在 ToolContextFactory.execute（全车道工具执行唯一咽喉），
 * 写操作与失败调用不计数；桥工具/元工具/obs_recall 永不晋升。
 */

/** 晋升阈值：近窗成功调用次数（lane-tool-sets 注释里的 PROMOTE_THRESHOLD=3 落地） */
export const TOOL_PROMOTE_THRESHOLD = 3;
/** 滑动窗口：近 48h 的成功调用才计数 */
const TOOL_PROMOTE_WINDOW_MS = 48 * 60 * 60 * 1000;
/** 每 actor 晋升上限（防常驻集膨胀；超过后按最近使用时间 LRU 淘汰） */
const TOOL_PROMOTE_CAP = 6;
/** 记录桶内最大保留条目（防无限增长） */
const PER_ACTOR_MAX_TOOLS = 64;

/** 元工具/桥/上下文管线支撑工具：永不晋升（它们本身是召回通道，不是业务能力） */
const NON_PROMOTABLE_NAMES: ReadonlySet<string> = new Set([
  "tool_search",
  "tool_discover",
  "tool_describe",
  "tool_call",
  "obs_recall",
  "agent.query_capabilities",
  "task.dispatch",
  "task.status",
  "task.cancel",
]);

type ActorPromotionState = Map<string, number[]>; // toolName → 成功调用时间戳数组

const promotionState = new Map<string, ActorPromotionState>();
const ACTOR_STATE_MAX = 512;

function pruneTimestamps(timestamps: number[], now: number): number[] {
  const minTs = now - TOOL_PROMOTE_WINDOW_MS;
  return timestamps.filter((ts) => ts >= minTs);
}

/** 记一次真实工具执行（仅成功调用计数；失败不计）。 */
export function recordToolUsageForPromotion(actorId: string, toolName: string, ok: boolean): void {
  if (!ok || !actorId || !toolName || NON_PROMOTABLE_NAMES.has(toolName)) return;
  const now = Date.now();
  let state = promotionState.get(actorId);
  if (!state) {
    if (promotionState.size >= ACTOR_STATE_MAX) {
      // LRU 近似：清最旧一半（进程内观测数据，不值得精确 LRU 的复杂度）
      const keys = [...promotionState.keys()].slice(0, Math.floor(ACTOR_STATE_MAX / 2));
      for (const k of keys) promotionState.delete(k);
    }
    state = new Map();
    promotionState.set(actorId, state);
  }
  const timestamps = pruneTimestamps(state.get(toolName) ?? [], now);
  timestamps.push(now);
  if (state.size > PER_ACTOR_MAX_TOOLS) {
    // 按最近使用时间淘汰最旧的 1/4
    const entries = [...state.entries()].sort((a, b) => Math.max(...b[1]) - Math.max(...a[1]));
    for (const [name] of entries.slice(PER_ACTOR_MAX_TOOLS)) state.delete(name);
  }
  state.set(toolName, timestamps);
}

/** 该 actor 的晋升工具名（近窗成功 ≥ 阈值；超过 cap 按最近使用取前 cap）。确定性输出。 */
export function getPromotedToolNames(actorId: string): string[] {
  const state = promotionState.get(actorId);
  if (!state || state.size === 0) return [];
  const now = Date.now();
  const qualified: Array<{ name: string; count: number; latest: number }> = [];
  for (const [name, timestamps] of state) {
    const recent = pruneTimestamps(timestamps, now);
    if (recent.length >= TOOL_PROMOTE_THRESHOLD) {
      qualified.push({ name, count: recent.length, latest: Math.max(...recent) });
    }
  }
  qualified.sort((a, b) => b.count - a.count || b.latest - a.latest || a.name.localeCompare(b.name));
  return qualified.slice(0, TOOL_PROMOTE_CAP).map((q) => q.name);
}

/** 测试用：清空全部晋升状态。 */
export function resetToolPromotionState(): void {
  promotionState.clear();
}
