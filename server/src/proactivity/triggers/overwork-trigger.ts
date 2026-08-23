// ProactivityHub —— 过劳关怀干预触发器
//
// body.rhythm.overwork_detected（连续工作 ≥3h 或深夜活跃 ≥2 次）触发：
//  mode=act+speak 复合干预——
//   act：搜并播放轻音乐 + 给明晚排休息提醒（静默后台执行）
//   speak：发布 overwork_care 信号告知用户做了什么（现有 ProactionCortex 闭环生成话术）
// 这是"主动感知 → 干预 → 后台执行任务"的典型场景。
import type { ProactiveActStep, ProactiveIntent } from "../proactivity-types.js";

/** body.rhythm.overwork_detected 信号的 payload 形态（rhythm-core 发布） */
export type OverworkRhythmPayload = {
  /** 连续工作小时数（0 表示未达连续阈值，靠深夜计数触发） */
  continuousWorkHours?: number;
  /** 当日深夜（23-5 点）活跃次数 */
  lateNightActiveCount?: number;
  detectedAt?: string;
};

/** 计算明晚 20:00 的本地 ISO 时间（休息提醒 runAt） */
export function tomorrowEveningRunAt(now: Date = new Date()): string {
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  d.setHours(20, 0, 0, 0);
  // toISOString 是 UTC；本地时区偏移后仍能被 ScheduleTaskService 的 naive 解析容忍，
  // 但为稳妥直接输出带 +08:00 偏移的本地 ISO（Asia/Shanghai 默认时区一致）
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}${sign}${hh}:${mm}`;
  return iso;
}

/** 过劳干预意图：act（放音乐 + 排休息日程）+ speak 告知 */
export function buildOverworkIntent(
  actorId: string,
  payload: OverworkRhythmPayload | undefined,
): ProactiveIntent {
  const workHours = payload?.continuousWorkHours ?? 0;
  const lateNights = payload?.lateNightActiveCount ?? 0;
  const why: string[] = [];
  if (workHours >= 3) why.push(`连续工作了约 ${workHours} 小时`);
  if (lateNights >= 2) why.push(`今晚已活跃 ${lateNights} 次（深夜）`);

  const steps: ProactiveActStep[] = [
    {
      tool: "media.search",
      args: { query: "轻音乐 放松", limit: 3 },
    },
    {
      // 从第 0 步（media.search）结果取第一条播放
      tool: "media.play",
      args: {},
      fromStep: 0,
    },
    {
      tool: "calendar.create_task",
      args: {
        kind: "reminder",
        title: "休息提醒",
        shortTitle: "该休息啦",
        description: "Agent 检测到连续加班，主动安排的休息提醒：今晚早点收工，放松一下。",
        runAt: tomorrowEveningRunAt(),
      },
    },
  ];

  return {
    actorId,
    kind: "overwork_care",
    importance: "high",
    title: "用户连续加班/深夜活跃，主动关怀干预",
    summary:
      `${why.join("；")}。Agent 已在后台放了一首轻音乐、并给明晚排了休息提醒。` +
      `基于此简短告知用户：像朋友一样心疼一句，顺便说你放了歌/排了提醒，别说教。`,
    mode: "act",
    actArgs: steps,
    source: "rhythm",
  };
}
