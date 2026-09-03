import { RHYTHM_MARK, isTriviaTask } from "../../services/schedule-task-service.js";
import type { ScheduleTaskRecord } from "../../services/schedule-task-service.js";
import type { LifeRhythmEngine } from "../engine.js";
import type { RhythmConsumer, RhythmProfileUpdate } from "../types.js";
import { circularHourDiff, clamp, formatHour, localHourInTimezone, nextLocalOccurrenceIso } from "../time-utils.js";

/** 消费方依赖的最小日程服务接口（真实 ScheduleTaskService 结构兼容） */
export type ReschedulerScheduleService = {
  listAllTasks(): ScheduleTaskRecord[];
  updateTask(taskId: string, input: { runAt: string }): Promise<ScheduleTaskRecord>;
};

// 调整策略参数：渐进式（每天最多 ±15 分钟），方向由锚点决定
const DAILY_STEP_HOURS = 0.25;
/** 小于 10 分钟的偏移不值得动（避免每天无意义重排） */
const MIN_SHIFT_HOURS = 1 / 6;
/** 睡觉提醒允许追到学习窗口（距初始时刻最多 3 小时） */
const SLEEP_MAX_SHIFT_HOURS = 3;
/** 喝水/运动只做局部微调（距初始时刻最多 1.5 小时） */
const DEFAULT_MAX_SHIFT_HOURS = 1.5;
/** 接受度低于该值视为"时机不对" */
const LOW_ACCEPTANCE = 0.35;
/** 至少 3 次反馈才允许按接受度调整 */
const MIN_ATTEMPTS_FOR_FEEDBACK = 3;
/** 同一任务两次调整的最小间隔 */
const READJUST_COOLDOWN_MS = 24 * 60 * 60 * 1000;
/** 接受度驱动调整需要接受度模型本身有点数据 */
const MIN_RECEPTIVITY_ATTEMPTS = 4;

export type ReschedulerPreset = "sleep" | "water" | "exercise" | "unknown";

/** 从任务 description 的节律标记解析预设（[节律提醒:sleep] ...） */
export function presetOfTask(task: ScheduleTaskRecord): ReschedulerPreset {
  const marked = task.description.startsWith(RHYTHM_MARK);
  if (!marked) return "unknown";
  const preset = task.description.slice(RHYTHM_MARK.length, task.description.indexOf("]"));
  return preset === "sleep" || preset === "water" || preset === "exercise" ? preset : "unknown";
}

/**
 * 出口 A：节律提醒时间自适应重排。
 *
 * - sleep 预设：锚定学习到的入睡窗口前推 30 分钟（置信度需满：≥7 个晚样本）
 * - water/exercise：仅在用户连续忽略（接受度 EWMA < 0.35）时，向触达接受度
 *   更高的相邻小时缓慢移动
 * - 渐进式：每次最多 ±15 分钟；用户改过时间（pinned）永不调整；24h 冷却
 */
export function createReminderReschedulerConsumer(
  scheduleTaskService: ReschedulerScheduleService,
  engine: LifeRhythmEngine,
): RhythmConsumer {
  return async (update: RhythmProfileUpdate) => {
    const { actorId, profile, confidences } = update;
    const sleep = profile.dimensions.sleep;
    const receptivity = profile.dimensions.receptivity;
    // 用分析时间而非系统时间做冷却判断（夜间任务/补跑的确定性语义）
    const now = new Date(update.profile.updatedAt);

    const rhythmTasks = scheduleTaskService
      .listAllTasks()
      .filter(
        (task) =>
          task.sessionId === actorId &&
          task.status === "active" &&
          task.recurrence === "daily" &&
          !task.cronExpression &&
          isTriviaTask(task) &&
          presetOfTask(task) !== "unknown",
      );

    for (const task of rhythmTasks) {
      try {
        if (!task.nextRunAt) continue;
        const preset = presetOfTask(task);
        const currentHour = localHourInTimezone(new Date(task.nextRunAt), task.timezone);
        if (!profile.reminderSlots[task.taskId]) {
          await engine.registerReminderSlot(actorId, task.taskId, currentHour);
        }
        const slot = profile.reminderSlots[task.taskId];
        if (!slot || slot.pinnedByUser) continue;
        if (slot.lastAdjustedAt && now.getTime() - Date.parse(slot.lastAdjustedAt) < READJUST_COOLDOWN_MS) {
          continue;
        }

        let targetHour: number | null = null;
        let maxShift = DEFAULT_MAX_SHIFT_HOURS;
        if (preset === "sleep") {
          if (confidences.sleep < 1 || sleep.windowStartHour === null) continue;
          targetHour = sleep.windowStartHour - 0.5;
          maxShift = SLEEP_MAX_SHIFT_HOURS;
        } else {
          const lowAcceptance =
            slot.acceptanceEwma !== null &&
            slot.attempts >= MIN_ATTEMPTS_FOR_FEEDBACK &&
            slot.acceptanceEwma < LOW_ACCEPTANCE;
          if (!lowAcceptance || receptivity.attempts < MIN_RECEPTIVITY_ATTEMPTS) continue;
          const candidate = bestNearbyHour(receptivity.byHour, Math.floor(currentHour));
          if (candidate === null) continue;
          targetHour = candidate + (currentHour - Math.floor(currentHour));
        }

        const diff = circularHourDiff(targetHour, currentHour);
        if (Math.abs(diff) < MIN_SHIFT_HOURS) continue;
        const totalFromOriginal = circularHourDiff(currentHour + clamp(diff, -DAILY_STEP_HOURS, DAILY_STEP_HOURS), slot.originalHour);
        if (Math.abs(totalFromOriginal) > maxShift) continue;

        const newHour = ((currentHour + clamp(diff, -DAILY_STEP_HOURS, DAILY_STEP_HOURS)) % 24 + 24) % 24;
        await scheduleTaskService.updateTask(task.taskId, {
          runAt: nextLocalOccurrenceIso(newHour, task.timezone, now),
        });
        await engine.markSlotAdjusted(
          actorId,
          task.taskId,
          Math.round(newHour * 100) / 100,
          diff < 0 ? "earlier" : "later",
          now,
        );
        console.log(
          `[RhythmRescheduler] ${actorId} 任务 ${task.taskId}（${preset}）调整 ${formatHour(currentHour)} → ${formatHour(newHour)}`,
        );
      } catch (error) {
        console.error(`[RhythmRescheduler] task ${task.taskId} adjust failed:`, error);
      }
    }
  };
}

/** 在 ±2 小时内找接受度最高的整点（当前时刻自身除外） */
function bestNearbyHour(byHour: number[], current: number): number | null {
  const candidates: Array<{ hour: number; score: number }> = [];
  for (const delta of [-2, -1, 1, 2]) {
    const hour = ((current + delta) % 24 + 24) % 24;
    candidates.push({ hour, score: byHour[hour] ?? 0 });
  }
  const best = candidates.sort((a, b) => b.score - a.score)[0];
  if (!best || best.score <= (byHour[current] ?? 0) + 0.1) return null;
  return best.hour;
}
