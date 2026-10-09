/**
 * 预载负反馈（2026-10-10 L5 数据回流）：「预载了但没被调」的工具自动退出预载。
 *
 * 数据源（同进程闭环，不解析日志）：注入侧在 buildDomainPreloadTools 出口记录
 * 本轮实际预载名；执行侧在 ToolContextFactory.execute（全车道工具执行唯一咽喉）
 * 记录真实成功调用。两侧都是确定性锚点，无采样误差。
 *
 * 机理：某工具累计预载 ≥ DEWEIGHT_INJECTION_THRESHOLD 次且期间零真实成功执行
 * → 判定为「占着 cap 的噪声槽」（实证：shopping 族靠描述长词撞进域预载，模型
 * 拿到也不调），冷却期内不再进预载候选——cap 12 留给真有转化率的工具。冷却
 * 期满自动恢复观察；期间出现一次真实成功执行立即恢复并清零计数（正反馈通道：
 * 模型经 discover/桥调通了，说明值得继续给）。
 *
 * 安全闸：
 *  - hasObservedRealExecution：进程内至少出现过一次真实工具执行才允许降权。
 *    单测/离线基准只调 buildDomainPreloadTools 不真实执行工具 → 永不降权，
 *    预载确定性（同语料同 query 恒同输出）在测试环境不受影响。
 *  - AGENT_TOOL_PRELOAD_FEEDBACK=off 一键关闭（A/B 基线与故障回退）。
 *  - 仅影响预载通道；Core/晋升常驻/延迟目录可达性一概不动。
 */

/** 降权判定：累计预载次数阈值（约等于「连续 8 轮占槽零转化」） */
export const PRELOAD_DEWEIGHT_INJECTION_THRESHOLD = 8;
/** 降权冷却时长：期满自动恢复观察 */
export const PRELOAD_DEWEIGHT_COOLDOWN_MS = 30 * 60 * 1000;

type PreloadFeedbackEntry = {
  injections: number;
  executions: number;
  deweightedAt: number | null;
};

const feedbackState = new Map<string, PreloadFeedbackEntry>();
let hasObservedRealExecution = false;

function isFeedbackEnabled(): boolean {
  const raw = process.env.AGENT_TOOL_PRELOAD_FEEDBACK?.trim().toLowerCase();
  return raw !== "off";
}

/** 注入侧（buildDomainPreloadTools 出口）：记录本轮实际预载的工具名。 */
export function recordPreloadInjection(names: readonly string[]): void {
  if (!isFeedbackEnabled() || names.length === 0) return;
  const now = Date.now();
  for (const name of names) {
    if (!name) continue;
    let entry = feedbackState.get(name);
    if (!entry) {
      if (feedbackState.size >= 512) feedbackState.clear(); // 观测数据，粗暴防膨胀
      entry = { injections: 0, executions: 0, deweightedAt: null };
      feedbackState.set(name, entry);
    }
    if (entry.deweightedAt !== null) continue; // 冷却中不重复计
    entry.injections += 1;
    if (
      hasObservedRealExecution &&
      entry.executions === 0 &&
      entry.injections >= PRELOAD_DEWEIGHT_INJECTION_THRESHOLD
    ) {
      entry.deweightedAt = now;
      console.info(
        `[preload-feedback] "${name}" 预载 ${entry.injections} 次零真实执行 → 冷却降权 ` +
          `${PRELOAD_DEWEIGHT_COOLDOWN_MS / 60_000}min（AGENT_TOOL_PRELOAD_FEEDBACK=off 关闭）`,
      );
    }
  }
}

/** 执行侧（ToolContextFactory.execute）：真实成功执行 → 恢复 + 计数清零。 */
export function recordPreloadExecution(name: string, ok: boolean): void {
  if (!isFeedbackEnabled() || !name) return;
  hasObservedRealExecution = true;
  if (!ok) return; // 只有成功执行证明工具有用；失败不算正证据
  const entry = feedbackState.get(name);
  if (!entry) return;
  entry.executions += 1;
  entry.injections = 0;
  entry.deweightedAt = null;
}

/** 该工具当前是否处于预载冷却降权期（消费方：buildDomainPreloadTools 的 push 闸）。 */
export function isPreloadDeweighted(name: string): boolean {
  if (!isFeedbackEnabled() || !hasObservedRealExecution) return false;
  const entry = feedbackState.get(name);
  if (!entry || entry.deweightedAt === null) return false;
  if (Date.now() - entry.deweightedAt >= PRELOAD_DEWEIGHT_COOLDOWN_MS) {
    // 冷却期满：恢复观察、计数清零（重新从零积累判定证据）
    entry.deweightedAt = null;
    entry.injections = 0;
    return false;
  }
  return true;
}

/** 测试/离线基准用：清空全部反馈状态。 */
export function resetPreloadFeedbackState(): void {
  feedbackState.clear();
  hasObservedRealExecution = false;
}
