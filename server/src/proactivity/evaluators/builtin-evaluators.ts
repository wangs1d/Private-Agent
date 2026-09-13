// 内置评估器（builtin-evaluators）—— 全部零 LLM 的确定性规则集。
//
// 贾维斯式主动性原则的落地：每次主动都能源于"被持续追踪的状态发生了变化"。
// 数据来自 SensorKernel 信号流 + bootstrap 注入的服务快照；文本来自
// voice-templates 模板族。评估器只产出 AttentionEvent，发不发/何时发由
// ArbiterV2 裁决——两层彻底分离。
import { renderProactiveText, renderDigestCard } from "../voice-templates.js";
import type { AttentionEvent, Evaluator } from "./evaluator-chain.js";
import type { Signal } from "../sensors/types.js";

/** 评估器外部数据源（bootstrap 注入；缺省的段自动跳过） */
export type BuiltinServices = {
  /** 今日任务（晨间简报/心跳回顾拼接） */
  listTodayTasks?: () => Array<{ title: string; runAt?: number | string }>;
  /** 将在 withinMs 内到期的承诺（承诺守约链） */
  commitmentsDue?: (withinMs: number) => Array<{ id: string; title: string; dueAt?: number }>;
  /** 天气一句话（简报/预警拼接） */
  weatherLine?: () => string | null;
  /** 当前未读消息发件人列表（消息爆发摘要） */
  unreadSenders?: () => string[];
  /** 已就绪的目标/预执行结果（ReadyTray） */
  readyGoals?: () => Array<{ title: string; body: string }>;
  /** 兴趣池摘要行（简报拼接） */
  interestLines?: () => string[];
  /** 记忆召回（会前准备包：上次相关交互） */
  recallMemory?: (query: string, limit: number) => Promise<string[]> | string[];
};

type SignalPayload = Record<string, unknown>;

function payloadOf(signal: Signal | undefined): SignalPayload {
  return signal?.payload ?? {};
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** 事件构造快捷函数 */
function event(partial: Omit<AttentionEvent, "id" | "at"> & { at?: number }): AttentionEvent {
  return { id: `ev_${partial.kind}_${Date.now().toString(36)}`, at: Date.now(), ...partial };
}

/**
 * 构建全部内置评估器。services 全部可选——缺哪个数据源就自动跳过对应段，
 * 系统在最小依赖下也能运行（真实使用的鲁棒性要求）。
 */
export function buildBuiltinEvaluators(services: BuiltinServices): Evaluator[] {
  return [
    // 1. away_return：用户长时间离开后回归 —— 久别问候 / 接续话题的时机
    {
      id: "away_return",
      streams: ["presence"],
      eval(ctx) {
        const st = ctx.state;
        const idleSince = (st.get("idleSince") as number | null) ?? null;
        const out: AttentionEvent[] = [];
        for (const sig of ctx.recent("presence")) {
          const state = str(payloadOf(sig).state);
          if ((state === "idle" || state === "offline") && idleSince === null) {
            st.set("idleSince", sig.at);
          }
          if (state === "active" && idleSince !== null) {
            const awayMin = Math.round((sig.at - idleSince) / 60_000);
            st.set("idleSince", null);
            const hour = ctx.now.getHours();
            if (awayMin >= 240 && hour >= 7 && hour < 23) {
              const awayLabel = awayMin >= 480 ? `${Math.round(awayMin / 60)} 小时` : `${awayMin} 分钟`;
              out.push(
                event({
                  kind: "away_return",
                  // alert 档：久别问候值得中等打扰（用户刚"停下来"，是天然开口时机）
                  urgency: "alert",
                  proposalKind: "away_return", // 独立频控维度（不与晨间问候共享 24h 冷却）
                  tier: "social",
                  importance: "low",
                  actorId: ctx.actorIdOf(sig),
                  title: `用户离开了 ${awayLabel} 后回归`,
                  body: renderProactiveText("away_return", { dedupKey: `away:${sig.at}`, now: ctx.now }),
                  dedupKey: `away_return:${new Date(sig.at).toISOString().slice(0, 10)}`,
                  salience: "medium",
                }),
              );
            }
          }
        }
        return out;
      },
    },

    // 2. meeting_soon：临近日程双提前量（60min normal / 15min alert）+ 会前准备包
    {
      id: "meeting_soon",
      streams: ["schedule"],
      tickEveryMs: 60_000,
      async eval(ctx) {
        const st = ctx.state;
        const announced = (st.get("announced") as Map<string, number>) ?? new Map();
        st.set("announced", announced);
        const out: AttentionEvent[] = [];
        const sig = ctx.latest("schedule");
        if (!sig) return out;
        const min = num(payloadOf(sig).nextEventMin);
        const runAt = num(payloadOf(sig).nextRunAt);
        const title = str(payloadOf(sig).nextTitle) || "下一个安排";
        if (min === null || runAt === null || min <= 0) return out;
        // 过期清理（runAt 已过/已提醒超过一天的键）
        for (const [k, v] of announced) if (runAt - v > 24 * 3600_000) announced.delete(k);

        const briefMin = 15;
        const earlyMin = 60;
        if (min <= briefMin && !announced.has(`brief:${runAt}`)) {
          announced.set(`brief:${runAt}`, Date.now());
          const memoryLines = services.recallMemory ? await services.recallMemory(title, 2) : [];
          const body = renderProactiveText("meeting_soon", {
            dedupKey: `meeting:${runAt}`,
            now: ctx.now,
            title,
            minutes: min,
            body: memoryLines.length ? `相关记忆：${memoryLines.join("；")}` : "",
          });
          out.push(
            event({
              kind: "meeting_soon",
              urgency: "alert",
              proposalKind: "schedule_upcoming",
              // must 层：临会提醒是用户点名要的事（原 UpcomingScheduleWatcher 语义，
              // 已收编至此——一个场景一个出口，必达且不占社交预算）
              tier: "must",
              importance: "high",
              title: `「${title}」${min} 分钟后开始`,
              body,
              dedupKey: `meeting_brief:${runAt}`,
              salience: "high",
              expiresAt: runAt,
            }),
          );
        } else if (min > briefMin && min <= earlyMin && !announced.has(`early:${runAt}`)) {
          announced.set(`early:${runAt}`, Date.now());
          out.push(
            event({
              kind: "meeting_soon_early",
              urgency: "normal",
              proposalKind: "life_reminder",
              tier: "social",
              importance: "low",
              title: `「${title}」1 小时内开始`,
              body: renderProactiveText("meeting_soon", {
                dedupKey: `meeting_early:${runAt}`,
                now: ctx.now,
                title,
                minutes: min,
              }),
              dedupKey: `meeting_early:${runAt}`,
              salience: "low",
            }),
          );
        }
        return out;
      },
    },

    // 3. work_marathon：连续编码/终端 ≥3h —— 比 rhythm 过劳检测更实时的休息干预
    {
      id: "work_marathon",
      streams: ["screen"],
      tickEveryMs: 60_000,
      eval(ctx) {
        const st = ctx.state;
        const out: AttentionEvent[] = [];
        const sig = ctx.latest("screen");
        const kind = str(payloadOf(sig).kind);
        const isWork = kind === "coding" || kind === "terminal";
        if (!isWork) {
          st.set("since", null);
          return out;
        }
        let since = (st.get("since") as number | null) ?? null;
        if (since === null) {
          since = ctx.nowMs;
          st.set("since", since);
        }
        const lastAlertAt = (st.get("lastAlertAt") as number) ?? 0;
        const workMin = Math.round((ctx.nowMs - since) / 60_000);
        if (workMin >= 180 && ctx.nowMs - lastAlertAt >= 4 * 3600_000) {
          st.set("lastAlertAt", ctx.nowMs);
          out.push(
            event({
              kind: "work_marathon",
              urgency: "alert",
              proposalKind: "overwork_care",
              tier: "social",
              importance: "medium",
              title: `连续工作 ${Math.round(workMin / 60)} 小时`,
              body: renderProactiveText("work_marathon", {
                dedupKey: `marathon:${new Date(ctx.nowMs).toISOString().slice(0, 10)}`,
                now: ctx.now,
                hours: Math.round(workMin / 60),
              }),
              dedupKey: `work_marathon:${new Date(ctx.nowMs).toISOString().slice(0, 10)}`,
              salience: "medium",
            }),
          );
        }
        return out;
      },
    },

    // 4. unread_burst：30min 内 ≥3 条入站消息 —— 有空时提一句，不抢话
    {
      id: "unread_burst",
      streams: ["message"],
      tickEveryMs: 120_000,
      eval(ctx) {
        const st = ctx.state;
        const list = (st.get("list") as Array<{ at: number; sender: string }>) ?? [];
        const out: AttentionEvent[] = [];
        for (const sig of ctx.recent("message")) {
          const sender = str(payloadOf(sig).sender);
          if (sender) list.push({ at: sig.at, sender });
        }
        const fresh = list.filter((m) => ctx.nowMs - m.at <= 30 * 60_000);
        st.set("list", fresh);
        const bucket = Math.floor(ctx.nowMs / (30 * 60_000));
        if (fresh.length >= 3 && !st.has(`burst:${bucket}`)) {
          st.set(`burst:${bucket}`, true);
          const senders = [...new Set(fresh.map((m) => m.sender))].slice(0, 3).join("、");
          out.push(
            event({
              kind: "unread_burst",
              urgency: "normal",
              proposalKind: "life_reminder",
              tier: "social",
              importance: "low",
              title: `${fresh.length} 条新消息未读`,
              body: `有 ${fresh.length} 条新消息（${senders}），有空看一眼。急的话跟我说，我帮你盯着。`,
              dedupKey: `unread_burst:${bucket}`,
              salience: "low",
            }),
          );
        }
        return out;
      },
    },

    // 5. digest_beat：每天 10/16/21 点的心跳回顾 —— 后台常驻检测的确定性节拍
    {
      id: "digest_beat",
      streams: [],
      tickEveryMs: 10 * 60_000,
      eval(ctx) {
        const st = ctx.state;
        const hour = ctx.now.getHours();
        const slot = hour === 10 ? "midday" : hour === 16 ? "midday" : hour === 21 ? "evening" : null;
        if (!slot) return [];
        const dayKey = ctx.now.toISOString().slice(0, 10);
        const beatKey = `${dayKey}:${hour}`;
        if (st.has(beatKey)) return [];
        st.set(beatKey, true);
        const tasks = (services.listTodayTasks?.() ?? []).map((t) => t.title).slice(0, 4);
        const commitments = (services.commitmentsDue?.(24 * 3600_000) ?? []).map((c) => c.title).slice(0, 3);
        const body = renderDigestCard({
          slot,
          tasks,
          commitments,
          weather: services.weatherLine?.() ?? null,
          unread: services.unreadSenders?.() ?? [],
          interests: services.interestLines?.() ?? [],
          goals: (services.readyGoals?.() ?? []).map((g) => g.title),
        });
        return [
          event({
            kind: "digest_beat",
            urgency: "normal",
            proposalKind: "life_reminder",
            tier: "social",
            importance: "low",
            title: "心跳回顾",
            body,
            dedupKey: `digest:${beatKey}`,
            salience: "low",
          }),
        ];
      },
    },

    // 6. goal_ready：预执行目标就绪 —— "哇"时刻的投递触发
    {
      id: "goal_ready",
      streams: ["goal"],
      eval(ctx) {
        const out: AttentionEvent[] = [];
        for (const sig of ctx.recent("goal")) {
          const goalId = str(payloadOf(sig).goalId);
          if (!goalId) continue;
          out.push(
            event({
              kind: "goal_ready",
              urgency: "normal",
              proposalKind: "life_reminder",
              tier: "social",
              importance: "medium",
              title: str(payloadOf(sig).title) || "有结果了",
              body: str(payloadOf(sig).body) || renderProactiveText("goal_ready", { now: ctx.now }),
              dedupKey: `goal_ready:${goalId}`,
              salience: "medium",
            }),
          );
        }
        return out;
      },
    },

    // 7. sleep_boundary：23 点屏幕仍活跃 —— 节律关怀
    {
      id: "sleep_boundary",
      streams: [],
      tickEveryMs: 15 * 60_000,
      eval(ctx) {
        if (ctx.now.getHours() !== 23) return [];
        const dayKey = ctx.now.toISOString().slice(0, 10);
        if (ctx.state.has(dayKey)) return [];
        const kind = str(payloadOf(ctx.latest("screen")).kind);
        const activeKinds = ["coding", "terminal", "browsing", "video", "game", "office", "chat"];
        if (!activeKinds.includes(kind)) return [];
        ctx.state.set(dayKey, true);
        return [
          event({
            kind: "sleep_boundary",
            urgency: "normal",
            proposalKind: "life_reminder",
            tier: "social",
            importance: "low",
            title: "深夜还在屏幕前",
            body: renderProactiveText("sleep_boundary", { dedupKey: `sleep:${dayKey}`, now: ctx.now }),
            dedupKey: `sleep_boundary:${dayKey}`,
            salience: "low",
          }),
        ];
      },
    },

    // 8. commitment_chain：承诺到期前 2h 的守约链（ask_first 代催）
    {
      id: "commitment_chain",
      streams: [],
      tickEveryMs: 10 * 60_000,
      eval(ctx) {
        const st = ctx.state;
        const out: AttentionEvent[] = [];
        const due = services.commitmentsDue?.(2 * 3600_000) ?? [];
        for (const c of due) {
          if (st.has(`nudged:${c.id}`)) continue;
          st.set(`nudged:${c.id}`, true);
          const min = c.dueAt ? Math.max(1, Math.round((c.dueAt - ctx.nowMs) / 60_000)) : null;
          out.push(
            event({
              kind: "commitment_chain",
              urgency: "alert",
              proposalKind: "action.commitment.nudge",
              tier: "must",
              importance: "high",
              title: `承诺临近：${c.title}`,
              body:
                `答应别人的「${c.title}」${min ? `还有 ${min} 分钟到期` : "快到时间了"}。` +
                `要我帮你催一下吗？`,
              dedupKey: `commit_nudge:${c.id}`,
              salience: "high",
              confirmLabel: "帮我催一下",
            }),
          );
        }
        return out;
      },
    },

    // 9. morning_brief：晨间唤醒触发（7-10 点首次活跃）—— 旗舰预执行场景
    {
      id: "morning_brief",
      streams: ["presence"],
      tickEveryMs: 5 * 60_000,
      eval(ctx) {
        const st = ctx.state;
        const dayKey = ctx.now.toISOString().slice(0, 10);
        const hour = ctx.now.getHours();
        const sig = ctx.latest("presence");
        const presence = str(payloadOf(sig).state) || "offline";
        const lastBriefDay = (st.get("lastBriefDay") as string | null) ?? null;
        if (lastBriefDay === dayKey) return [];
        // 触发：7-10 点且用户变为 active（唤醒/开机），或兜底 8:30 后仍无触发
        const wakeTrigger = presence === "active" && hour >= 7 && hour < 10;
        const fallbackTrigger = hour === 8 && ctx.now.getMinutes() >= 30;
        if (!wakeTrigger && !fallbackTrigger) return [];
        st.set("lastBriefDay", dayKey);
        const tasks = (services.listTodayTasks?.() ?? []).map((t) => t.title);
        const commitments = (services.commitmentsDue?.(24 * 3600_000) ?? []).map((c) => c.title);
        const body = renderDigestCard({
          slot: "morning",
          tasks,
          commitments,
          weather: services.weatherLine?.() ?? null,
          unread: services.unreadSenders?.() ?? [],
          interests: services.interestLines?.() ?? [],
          goals: (services.readyGoals?.() ?? []).map((g) => g.title),
        });
        return [
          event({
            kind: "morning_brief",
            urgency: "normal",
            proposalKind: "greeting",
            tier: "social",
            importance: "low",
            actorId: ctx.actorIdOf(ctx.latest("presence")),
            title: "晨间简报",
            body,
            dedupKey: `morning_brief:${dayKey}`,
            salience: "medium",
          }),
        ];
      },
    },
  ];
}
