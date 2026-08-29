import type { MemoryManagerService } from "./memory-manager-service.js";
import type { DailyDigestService } from "./daily-digest-service.js";
import type { AgentMemorySyncService } from "./agent-memory-sync-service.js";
import type { NarrativeMemoryPort } from "./narrative-memory-port.js";
import { getDailyJournalService } from "./daily-journal-service.js";
import { resolvePrimaryLlmClientConfig } from "../external-model/resolve-provider.js";
import OpenAI from "openai";
import { mkdir, writeFile } from "node:fs/promises";
import { mkdirSync, writeFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";

export type NightlySleepAgentReport = {
  runAt: string;
  actorIds: string[];
  reports: Array<{
    actorId: string;
    dailyCleanupCount: number;
    weeklyMergedCount: number;
    monthlyAbstractedCount: number;
    consistencyFlagCount: number;
    knowledgePromotedCount: number;
    compressionRate: number;
    estimatedRecallPrecision: number;
    plannedActions: number;
    executedActions: number;
    stageReports: Array<{
      stage: string;
      changed: number;
      notes: string[];
    }>;
  }>;
};

export type NightModeConfig = {
  enabled: boolean;
  nightStartHour: number;
  nightEndHour: number;
  timezone: string;
  consolidationBatchSize: number;
};

const DEFAULT_CONFIG: NightModeConfig = {
  enabled: true,
  nightStartHour: 23,
  nightEndHour: 6,
  timezone: "Asia/Shanghai",
  consolidationBatchSize: 50,
};

/**
 * 固化噪音行过滤（P2-6）：U/A 闲聊/语气填充行不进入长期记忆，避免固化噪音污染召回。
 * 高信号行（prefer/fact/commit）不过滤；用户实义陈述与助手有效回答保留。
 */
const CONSOLIDATE_NOISE_RE =
  /^(?:嗯+|哦+|噢+|啊+|诶+|哎|哈|嘿|哟|哦哦|嗯嗯|好的?|好嘞|好滴|好呀|好耶|行|可以|知道了|明白|收到|了解|懂了|是的?|对(?:的|呀|吧)?|没错|随便|没啥|没事|无妨|拜拜|再见|晚安|早上好|下午好|晚上好|你好|嗨|呵呵+|嘿嘿+|哈哈+|算了|好吧|行吧|就这样|没了|没有|不知道|不清楚|不晓得|谢谢(?:你|您)?|多谢|感谢|不用了|别客气|不客气|好的谢谢|可以可以|okk?|okay|sure|yeah|yes|no|thx|thanks?)[。！？!?~,.，\s]*$/i;

/** 内容去掉句读后过短且无实义（如"好的。""嗯""哈哈"）也视为噪音 */
export function isNoiseLogLine(role: string, content: string): boolean {
  if (role === "fact" || role === "prefer" || role === "commit") return false;
  const text = content.replace(/\s+/g, "").replace(/[，。！？!?、；;,.\s]/g, "");
  if (!text) return true;
  return CONSOLIDATE_NOISE_RE.test(content) || text.length <= 1;
}

function loadNightConfig(): NightModeConfig {
  return {
    ...DEFAULT_CONFIG,
    enabled: process.env.NIGHT_MEMORY_MODE !== "0",
    nightStartHour:
      Number.parseInt(process.env.NIGHT_START_HOUR ?? "", 10) || DEFAULT_CONFIG.nightStartHour,
    nightEndHour:
      Number.parseInt(process.env.NIGHT_END_HOUR ?? "", 10) || DEFAULT_CONFIG.nightEndHour,
  };
}

export class NightlyMemoryTaskService {
  private readonly config: NightModeConfig;
  private schedulerTimer: NodeJS.Timeout | null = null;
  private isNightMode = false;
  private lastProcessedDay = "";
  private memoryManager: MemoryManagerService | null = null;
  private dailyDigest: DailyDigestService | null = null;
  private memorySync: AgentMemorySyncService | null = null;
  private narrativeMemory: NarrativeMemoryPort | null = null;
  /**
   * AwarenessCortex 引用（可选）。
   * 注入后，dreaming 触发条件从"仅时间窗"升级为"时间窗 + sleeping 状态"双条件，
   * 避免用户深夜还在密集对话时强行触发 dreaming 造成竞态。
   *
   * 动态窗口扩展：若 getLearnedSleepWindow 可用且样本足够，
   * 用学习到的个性化窗口替换硬编码的 nightStartHour/nightEndHour。
   */
  private awarenessCortex: {
    observe(actorId: string): { activity: string } | null;
    getLearnedSleepWindow?(actorId: string): { startHour: number; endHour: number; sampleCount: number } | null;
  } | null = null;
  /**
   * 记录已触发 dreaming 的 actor，避免同一夜间重复触发。
   * key: actorId, value: 当晚首次触发时间 ISO。
   */
  private dreamingTriggeredActors = new Map<string, string>();
  private readonly reportFilePath =
    process.env.AGENT_MEMORY_SLEEP_REPORT_FILE?.trim() ??
    join(process.cwd(), "data", "nightly-memory-reports.json");
  private latestReport: NightlySleepAgentReport | null = null;
  private recentReports: NightlySleepAgentReport[] = [];

  constructor(config?: Partial<NightModeConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  setDependencies(
    memoryManager: MemoryManagerService | null,
    dailyDigest: DailyDigestService | null,
    memorySync: AgentMemorySyncService | null,
    narrativeMemory?: NarrativeMemoryPort | null,
  ): void {
    this.memoryManager = memoryManager;
    this.dailyDigest = dailyDigest;
    this.memorySync = memorySync;
    this.narrativeMemory = narrativeMemory ?? null;
  }

  /**
   * 注入 AwarenessCortex（缺口 3 修复 + 动态窗口扩展）。
   *
   * 注入后：
   * - tick() 在夜间会检测每个 actor 的 sleeping 状态
   * - 只对处于 sleeping 状态的 actor 触发 dreaming
   * - 动态窗口：若 getLearnedSleepWindow 可用且样本足够，用学习到的窗口替换硬编码
   * - 保留"昼夜切换兜底"：若用户整夜不睡，夜→昼切换时补跑
   */
  setAwarenessCortex(
    svc: {
      observe(actorId: string): { activity: string } | null;
      getLearnedSleepWindow?(actorId: string): { startHour: number; endHour: number; sampleCount: number } | null;
    } | null,
  ): void {
    this.awarenessCortex = svc;
    console.log(
      `[NightlyMemory] ${svc ? "已注入 AwarenessCortex（dreaming 双条件触发 + 动态窗口学习已启用）" : "AwarenessCortex 已清除"}`,
    );
  }

  startScheduler(): void {
    if (!this.config.enabled || this.schedulerTimer) return;

    this.updateNightMode();
    this.schedulerTimer = setInterval(() => this.tick(), 60_000);
    console.log(
      `[NightlyMemory] Scheduler started. Night mode: ${this.config.nightStartHour}:00-${this.config.nightEndHour}:00 (${this.config.timezone})`,
    );
  }

  stopScheduler(): void {
    if (this.schedulerTimer) {
      clearInterval(this.schedulerTimer);
      this.schedulerTimer = null;
    }
  }

  isInNightMode(): boolean {
    return this.isNightMode;
  }

  getLatestReport(): NightlySleepAgentReport | null {
    return this.latestReport;
  }

  getRecentReports(): NightlySleepAgentReport[] {
    return [...this.recentReports];
  }

  shouldDeferConsolidation(): boolean {
    return this.config.enabled && !this.isNightMode;
  }

  async forceRunNightTasks(): Promise<{
    consolidated: boolean;
    archived: boolean;
    synced: boolean;
    error?: string;
  }> {
    const result = {
      consolidated: false,
      archived: false,
      synced: false,
      error: undefined as string | undefined,
    };

    try {
      // 缺口 4 修复：归档必须在 dreaming 之前
      await this.triggerDailyArchiveImmediate();
      result.archived = true;

      await this.runDreamPhase();
      result.consolidated = true;

      await this.syncToLongTermStorage();
      result.synced = true;
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
      console.error("[NightlyMemory] Force run failed:", err);
    }

    return result;
  }

  private tick(): void {
    const wasNight = this.isNightMode;
    this.updateNightMode();

    if (!wasNight && this.isNightMode) {
      // 昼→夜 切换：不再立即触发，而是等待 sleeping 状态（缺口 3 修复）
      // 若未注入 awarenessCortex，则回退到原立即触发行为（向后兼容）
      if (!this.awarenessCortex) {
        console.log("[NightlyMemory] Night mode activated (无 awarenessCortex，回退立即触发)");
        this.runNightTasks().catch((err) => {
          console.error("[NightlyMemory] Night tasks failed:", err);
        });
      } else {
        console.log("[NightlyMemory] Night mode activated, waiting for sleeping state to trigger dreaming...");
        // 进入夜间时清空已触发记录，让新夜晚的 sleeping 重新触发
        this.dreamingTriggeredActors.clear();
      }
    }

    // 缺口 3 修复：夜间每分钟检测 sleeping 状态，逐 actor 触发 dreaming
    if (this.isNightMode && this.awarenessCortex) {
      this.checkSleepingAndTriggerDreaming().catch((err) => {
        console.error("[NightlyMemory] Sleeping-triggered dreaming failed:", err);
      });
    }

    if (wasNight && !this.isNightMode) {
      // 夜→昼 切换：兜底补跑（若整夜未触发）
      const today = this.getTodayKey();
      if (this.lastProcessedDay !== today) {
        console.log("[NightlyMemory] Day mode activated, running missed night tasks as fallback");
        this.runNightTasks().catch((err) => {
          console.error("[NightlyMemory] Fallback night tasks failed:", err);
        });
      } else {
        console.log("[NightlyMemory] Day mode activated, night tasks already processed");
      }
    }

    this.checkMidnightRollover();
  }

  /**
   * 检查每个 actor 的 sleeping 状态，对首次进入 sleeping 的 actor 触发 dreaming。
   *
   * - 注入了 awarenessCortex 才生效
   * - 每个 actor 每晚只触发一次（dreamingTriggeredActors 去重）
   * - sleeping 判定由 awareness-cortex.ts 完成（30min 无桌面活动 + 23:00-6:00）
   */
  private async checkSleepingAndTriggerDreaming(): Promise<void> {
    if (!this.awarenessCortex) return;
    const today = this.getTodayKey();
    // 新一天开始时清空已触发记录
    if (this.dreamingTriggeredActors.size > 0) {
      const firstTriggerDate = this.dreamingTriggeredActors.values().next().value;
      if (firstTriggerDate) {
        const triggerDay = firstTriggerDate.slice(0, 10);
        if (triggerDay !== today) {
          this.dreamingTriggeredActors.clear();
        }
      }
    }

    const actorIds = this.getAllActorIds();
    for (const actorId of actorIds) {
      if (this.dreamingTriggeredActors.has(actorId)) continue;
      try {
        const state = this.awarenessCortex.observe(actorId);
        if (state?.activity === "sleeping") {
          console.log(`[NightlyMemory] Actor ${actorId} entered sleeping, triggering dreaming...`);
          this.dreamingTriggeredActors.set(actorId, new Date().toISOString());
          // 只对该 actor 触发 dreaming（runDreamPhase 内部会遍历所有 actor，
          // 但因 dreamingTriggeredActors 去重，已触发的不会再触发）
          await this.runNightTasks();
        }
      } catch (err) {
        // observe 失败不阻塞其他 actor
        console.log(`[NightlyMemory] observe(${actorId}) failed: ${err}`);
      }
    }
  }

  /**
   * 判定当前是否处于夜间模式。
   *
   * 动态窗口优先级：
   * 1. 若 awarenessCortex.getLearnedSleepWindow 可用且样本足够 → 用学习到的个性化窗口
   * 2. 否则回退到 config.nightStartHour/nightEndHour（默认 23-6 或 env 配置）
   *
   * 多 actor 场景：只要有任一 actor 学习到个性化窗口，就采用该窗口。
   * （通常一个主机只有一个主用户，多 actor 时取第一个有效的即可）
   */
  private updateNightMode(): void {
    const now = new Date();
    // 使用分钟精度判定，避免 23:30 进入 sleeping 但整点判定还在白天的问题
    const hourStr = new Intl.DateTimeFormat("en-US", {
      timeZone: this.config.timezone,
      hour: "numeric",
      minute: "numeric",
      hour12: false,
    }).format(now);
    const [h, m] = hourStr.split(":").map(Number);
    const hourDecimal = h + m / 60;

    // 尝试获取动态学习到的窗口
    let startHour = this.config.nightStartHour;
    let endHour = this.config.nightEndHour;
    let usingDynamic = false;
    if (this.awarenessCortex?.getLearnedSleepWindow) {
      for (const actorId of this.getAllActorIds()) {
        const learned = this.awarenessCortex.getLearnedSleepWindow(actorId);
        if (learned) {
          startHour = learned.startHour;
          endHour = learned.endHour;
          usingDynamic = true;
          break;
        }
      }
    }

    // 跨天窗口（start > end，如 23.5→6.25）：hour >= start OR hour < end
    // 同天窗口（start < end，如 13→14 午休）：start <= hour < end
    if (startHour > endHour) {
      this.isNightMode = hourDecimal >= startHour || hourDecimal < endHour;
    } else {
      this.isNightMode = hourDecimal >= startHour && hourDecimal < endHour;
    }

    // 动态窗口切换日志（仅在切换时打印一次，避免每分钟刷屏）
    if (usingDynamic && !this.loggedDynamicWindow) {
      console.log(
        `[NightlyMemory] 动态睡眠窗口已启用：${startHour.toFixed(2)}→${endHour.toFixed(2)}（基于用户习惯学习）`,
      );
      this.loggedDynamicWindow = true;
    } else if (!usingDynamic && this.loggedDynamicWindow) {
      console.log(
        `[NightlyMemory] 回退默认睡眠窗口：${startHour}:00→${endHour}:00（学习样本不足）`,
      );
      this.loggedDynamicWindow = false;
    }
  }
  private loggedDynamicWindow = false;

  private async runNightTasks(): Promise<void> {
    const today = this.getTodayKey();
    if (this.lastProcessedDay === today) return;
    this.lastProcessedDay = today;

    console.log(`[NightlyMemory] Running night tasks for ${today}`);

    try {
      // 缺口 4 修复：归档必须在 dreaming 之前，让 dream phase 能看到当天对话
      await this.triggerDailyArchiveImmediate();
      // 巩固管线（episodic → semantic）：journal 固化前先做事实提炼，
      // 此时未固化日志仍在，提炼出的稳定事实写入结构化槽位（latest-wins 归并）。
      await this.extractFactsFromJournals();
      // 记忆架构重构：当日对话日志固化（journal → 长期记忆图），
      // 必须在 dreaming 之前完成，让后续合并/衰减阶段能看到新固化内容。
      await this.consolidateDailyJournals();
      await this.runDreamPhase();
      await this.syncToLongTermStorage();
      await this.cleanupOldStorage();
      console.log("[NightlyMemory] All night tasks completed successfully");
    } catch (err) {
      console.error("[NightlyMemory] Night tasks error:", err);
    }
  }

  /**
   * 当日对话日志固化（记忆架构重构核心环节）：
   * - 消费 DailyJournal 未固化日志行（含跨天补跑——服务器隔夜未开机也能追上）；
   * - 写入 narrative 长期记忆（journal:consolidate 来源，偏好/事实行高信号）；
   * - 固化完成后标记已处理（journal 文件归档保留，不删除——可重放可审计）。
   */
  private async consolidateDailyJournals(): Promise<void> {
    const journal = getDailyJournalService();
    if (!journal || !this.narrativeMemory) return;

    const actorIds = this.getAllActorIds();
    let totalIngested = 0;

    for (const actorId of actorIds) {
      try {
        const unconsolidated = await journal.getUnconsolidatedLines(actorId);
        if (unconsolidated.length === 0) continue;

        const dateKeys: string[] = [];
        for (const { dateKey, lines } of unconsolidated) {
          let ingested = 0;
          for (const line of lines) {
            // 行格式: - [HH:mm] sessId? U|A|fact|prefer|commit: content
            const m = line.match(/^- \[(\d{2}:\d{2})\]\s*(.*)$/);
            if (!m) continue;
            const time = m[1]!;
            const body = m[2]!;
            const roleMatch = body.match(/^(?:(\S+)\s+)?(U|A|fact|prefer|commit):\s*(.+)$/);
            if (!roleMatch) continue;
            const role = roleMatch[2]!;
            const content = roleMatch[3]!;
            // P2-6：U/A 闲聊/语气填充行不固化（fact/prefer/commit 恒保留）
            if (isNoiseLogLine(role, content)) continue;
            const roleLabel = role === "U" ? "用户" : role === "A" ? "助手" : role;
            const highSignal = role === "prefer" || role === "fact" || role === "commit";
            await this.narrativeMemory!
              .ingest(
                actorId,
                `[日志固化 ${dateKey} ${time}·${roleLabel}] ${content}`,
                "journal:consolidate",
                { highSignal },
              )
              .catch(() => {});
            ingested += 1;
          }
          if (ingested > 0) dateKeys.push(dateKey);
          totalIngested += ingested;
        }

        if (dateKeys.length > 0) {
          await journal.markConsolidated(actorId, dateKeys);
          console.log(
            `[NightlyMemory] journal 固化: actor=${actorId} dates=${dateKeys.join(",")} 已入长期记忆`,
          );
        }
      } catch (err) {
        console.error(`[NightlyMemory] journal consolidation failed for ${actorId}:`, err);
      }
    }

    if (totalIngested > 0) {
      console.log(`[NightlyMemory] journal consolidation total ingested: ${totalIngested} lines`);
    }
  }

  /**
   * 夜间事实提炼（巩固管线 episodic → semantic）：
   * 在 journal 固化前，把当日（含跨天补跑）对话日志一次性喂给 LLM，
   * 抽取"值得跨会话记住"的稳定偏好/事实/承诺，写入结构化记忆槽位
   * （AgentMemorySyncService.appendMemorySummaryLine 会按 subject/slot
   * 自动做 latest-wins 归并，旧值被新值替换而不是无限累积）。
   *
   * 设计要点：
   * - 单 actor 单次 LLM 批处理调用（替代逐条实时写入决策，便宜且质量更高）；
   * - LLM 不可用 / 提炼失败 → 静默跳过该 actor，不影响后续固化与 dreaming；
   * - 行文本按 kind 加类型前缀，命中槽位分类正则后自动归入对应槽位。
   */
  private async extractFactsFromJournals(): Promise<void> {
    const journal = getDailyJournalService();
    if (!journal || !this.memorySync) return;
    const llm = resolvePrimaryLlmClientConfig();
    if (!llm) return;

    const actorIds = this.getAllActorIds();
    for (const actorId of actorIds) {
      try {
        const unconsolidated = await journal.getUnconsolidatedLines(actorId);
        if (unconsolidated.length === 0) continue;

        // 拼装精简日志（保留日期/时间/角色/内容，过滤噪音行，限最近 120 行）
        const transcriptLines: string[] = [];
        for (const { dateKey, lines } of unconsolidated) {
          for (const line of lines) {
            const m = line.match(/^- \[(\d{2}:\d{2})\]\s*(.*)$/);
            if (!m) continue;
            const roleMatch = m[2]!.match(/^(?:(\S+)\s+)?(U|A|fact|prefer|commit):\s*(.+)$/);
            if (!roleMatch) continue;
            const role = roleMatch[2]!;
            const content = roleMatch[3]!.slice(0, 300);
            if (isNoiseLogLine(role, content)) continue;
            transcriptLines.push(`[${dateKey} ${m[1]} ${role}] ${content}`);
          }
        }
        if (transcriptLines.length < 4) continue;
        const transcript = transcriptLines.slice(-120).join("\n");

        const facts = await this.extractDurableFacts(llm, transcript);
        if (facts.length === 0) continue;

        let written = 0;
        for (const fact of facts) {
          const text = fact.text.trim().slice(0, 200);
          if (!text) continue;
          const prefixed =
            fact.kind === "preference"
              ? `偏好：${text}`
              : fact.kind === "commitment"
                ? `承诺：${text}`
                : text;
          this.memorySync.appendMemorySummaryLine(actorId, prefixed, "consolidate");
          written += 1;
        }
        if (written > 0) {
          console.log(
            `[NightlyMemory] 事实提炼: actor=${actorId} 提取 ${written} 条持久事实写入结构化槽位`,
          );
        }
      } catch (err) {
        console.error(`[NightlyMemory] fact extraction failed for ${actorId}:`, err);
      }
    }
  }

  /** 单次 LLM 调用：从日志中抽取持久事实（失败返回空数组，不抛错） */
  private async extractDurableFacts(
    llm: { apiKey: string; baseURL?: string; model?: string },
    transcript: string,
  ): Promise<Array<{ kind: "preference" | "fact" | "commitment"; text: string }>> {
    const openai = new OpenAI({ apiKey: llm.apiKey, baseURL: llm.baseURL });
    const model =
      process.env.AGENT_MEMORY_DECISION_MODEL?.trim() || llm.model || "gpt-4.1-mini";
    try {
      const response = await openai.chat.completions.create({
        model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "你是记忆巩固器。从对话日志中提取「值得跨会话长期记住」的用户信息，忽略闲聊、临时上下文和一次性任务细节。" +
              "只输出 JSON：{\"facts\":[{\"kind\":\"preference|fact|commitment\",\"text\":\"...\"}]}，最多 12 条。" +
              "规则：preference=稳定偏好/习惯（text 需含「喜欢/偏好/讨厌/习惯」等词）；" +
              "fact=稳定身份/背景事实（text 以「我是/我在/我住在/我的」开头）；" +
              "commitment=需要后续跟进的承诺或待办（text 需含「我会/我将/计划/待办」等词）。" +
              "text 用第一人称中文短句。没有可提取内容时返回 {\"facts\":[]}。",
          },
          { role: "user", content: transcript.slice(0, 12_000) },
        ],
      });
      const content = response.choices[0]?.message?.content?.trim();
      if (!content) return [];
      const parsed = JSON.parse(content) as {
        facts?: Array<{ kind?: string; text?: string }>;
      };
      const validKinds = new Set(["preference", "fact", "commitment"]);
      return (parsed.facts ?? [])
        .filter(
          (f): f is { kind: "preference" | "fact" | "commitment"; text: string } =>
            !!f &&
            typeof f.text === "string" &&
            f.text.trim().length > 0 &&
            typeof f.kind === "string" &&
            validKinds.has(f.kind),
        )
        .slice(0, 12);
    } catch (err) {
      console.log(`[NightlyMemory] extractDurableFacts LLM 调用失败（跳过提炼）: ${err}`);
      return [];
    }
  }

  /**
   * 立即归档今天的 digest（缺口 4 修复）。
   * 调用 DailyDigestService.archiveDayForTodayImmediately()，绕过 tickArchive 时间窗。
   */
  private async triggerDailyArchiveImmediate(): Promise<void> {
    if (!this.dailyDigest) return;
    try {
      console.log("[NightlyMemory] Triggering immediate daily digest archive (before dream phase)");
      const method = this.dailyDigest as unknown as Record<string, (...args: unknown[]) => Promise<void>>;
      if (typeof method.archiveDayForTodayImmediately === "function") {
        await method.archiveDayForTodayImmediately();
      } else {
        // 兜底：降级到原 triggerDailyArchive（带时间窗）
        await this.triggerDailyArchive();
      }
    } catch (err) {
      console.log(`[NightlyMemory] archiveDayForTodayImmediately 失败（降级原逻辑）: ${err}`);
      await this.triggerDailyArchive();
    }
  }

  private async runDreamPhase(): Promise<void> {
    const actorIds = this.getAllActorIds().slice(0, this.config.consolidationBatchSize);
    if (actorIds.length === 0) return;

    console.log(
      `[NightlyMemory] Sleep agent phase: cleanup -> merge -> reinforce -> weaken for ${actorIds.length} actors`,
    );

    for (const actorId of actorIds) {
      try {
        const result = await this.memoryManager?.consolidateNow(actorId);
        if (result && (result.entriesMerged > 0 || result.entriesRemoved > 0)) {
          console.log(
            `[NightlyMemory] Summary consolidation actor=${actorId} merged=${result.entriesMerged} removed=${result.entriesRemoved} remembered=${result.rememberedCount} faded=${result.fadedCount}`,
          );
        }
      } catch (err) {
        console.error(`[NightlyMemory] Summary consolidation failed for ${actorId}:`, err);
      }
    }

    if (this.narrativeMemory) {
      const sleepReports = await this.narrativeMemory.runSleepConsolidation(actorIds).catch((err) => {
        console.error("[NightlyMemory] Human-like sleep consolidation failed:", err);
        return null;
      });
      if (Array.isArray(sleepReports) && sleepReports.length > 0) {
        await this.recordSleepAgentReport(actorIds, sleepReports);
      }
    }
  }

  private async recordSleepAgentReport(
    actorIds: string[],
    reports: Array<{
      actorId: string;
      dailyCleanupCount: number;
      weeklyMergedCount: number;
      monthlyAbstractedCount: number;
      consistencyFlagCount: number;
      knowledgePromotedCount: number;
      compressionRate: number;
      estimatedRecallPrecision: number;
      plannedActions: number;
      executedActions: number;
      stageReports: Array<{ stage: string; changed: number; notes: string[] }>;
    }>,
  ): Promise<void> {
    const payload: NightlySleepAgentReport = {
      runAt: new Date().toISOString(),
      actorIds,
      reports,
    };
    this.latestReport = payload;
    this.recentReports.unshift(payload);
    this.recentReports = this.recentReports.slice(0, 30);

    try {
      await mkdir(dirname(this.reportFilePath), { recursive: true });
      await writeFile(this.reportFilePath, `${JSON.stringify(this.recentReports, null, 2)}\n`, "utf8");
    } catch (err) {
      console.error("[NightlyMemory] Failed to persist sleep agent report:", err);
    }
  }

  private async triggerDailyArchive(): Promise<void> {
    if (!this.dailyDigest) return;

    try {
      console.log("[NightlyMemory] Triggering daily digest archive");
      const method = this.dailyDigest as unknown as Record<string, (...args: unknown[]) => Promise<void>>;
      if (typeof method.tickArchive === "function") {
        await method.tickArchive();
      }
    } catch (err) {
      console.error("[NightlyMemory] Archive trigger failed:", err);
    }
  }

  private async syncToLongTermStorage(): Promise<void> {
    // 缺口 7 修复：真实落地长期存储同步
    // 原策略：只 getSnapshot 打日志，不写入任何长期后端
    // 新策略：把每个 actor 的 memory_summary 持久化到本地文件 data/long-term-memory/<actorId>.json
    //         作为长期归档（崩溃恢复 + 跨实例迁移的备份）
    if (!this.memorySync) return;

    try {
      console.log("[NightlyMemory] Syncing to long-term storage (local archive)");
      const actorIds = this.getAllActorIds();
      const longTermDir = join(process.cwd(), "data", "long-term-memory");
      try {
        mkdirSync(longTermDir, { recursive: true });
      } catch {
        // 目录已存在则忽略
      }

      let syncedCount = 0;
      for (const actorId of actorIds) {
        try {
          const { entries } = this.memorySync.getSnapshot(actorId, [
            "memory_summary",
            "memory_summary_forgotten",
          ]);
          const summary = typeof entries.memory_summary === "string" ? entries.memory_summary : "";
          const forgotten = typeof entries.memory_summary_forgotten === "string" ? entries.memory_summary_forgotten : "";
          if (!summary && !forgotten) continue;

          const archive = {
            actorId,
            syncedAt: new Date().toISOString(),
            memorySummary: summary,
            memorySummaryForgotten: forgotten,
          };
          const filePath = join(longTermDir, `${actorId}.json`);
          writeFileSync(filePath, JSON.stringify(archive, null, 2), "utf-8");
          syncedCount++;
        } catch (err) {
          console.log(`[NightlyMemory] sync ${actorId} 失败: ${err}`);
        }
      }
      console.log(`[NightlyMemory] Long-term storage sync completed: ${syncedCount}/${actorIds.length} actors archived`);
    } catch (err) {
      console.error("[NightlyMemory] Long-term sync failed:", err);
    }
  }

  private async cleanupOldStorage(): Promise<void> {
    // 缺口 7 修复：清理过期的长期存储归档
    // 删除 30 天前的 long-term-memory 归档文件（保留近期备份）
    try {
      const longTermDir = join(process.cwd(), "data", "long-term-memory");
      let files: string[] = [];
      try {
        files = readdirSync(longTermDir);
      } catch {
        return; // 目录不存在则跳过
      }
      const now = Date.now();
      const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 天
      let cleanedCount = 0;
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const filePath = join(longTermDir, file);
        try {
          const stat = statSync(filePath);
          if (now - stat.mtimeMs > MAX_AGE_MS) {
            unlinkSync(filePath);
            cleanedCount++;
          }
        } catch {
          // 单文件清理失败不阻塞
        }
      }
      if (cleanedCount > 0) {
        console.log(`[NightlyMemory] Cleanup: removed ${cleanedCount} expired long-term archive files`);
      }
    } catch (err) {
      console.log(`[NightlyMemory] cleanupOldStorage 失败: ${err}`);
    }
  }

  private checkMidnightRollover(): void {
    const today = this.getTodayKey();
    if (this.lastProcessedDay && this.lastProcessedDay !== today) {
      this.lastProcessedDay = "";
    }
  }

  private getAllActorIds(): string[] {
    const actorIds = new Set<string>();
    for (const actorId of this.memorySync?.listSessionIds?.() ?? []) {
      if (actorId && actorId !== "system") actorIds.add(actorId);
    }
    for (const actorId of this.dailyDigest?.listActorIds?.() ?? []) {
      if (actorId) actorIds.add(actorId);
    }
    return [...actorIds];
  }

  private getTodayKey(): string {
    return this.formatDateKey(new Date());
  }

  private formatDateKey(date: Date): string {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }

  async shutdown(): Promise<void> {
    this.stopScheduler();
    if (this.isNightMode) {
      console.log("[NightlyMemory] Shutdown in night mode, running final tasks...");
      await this.forceRunNightTasks();
    }
  }
}

let singleton: NightlyMemoryTaskService | null = null;

export function getNightlyMemoryTaskService(): NightlyMemoryTaskService | null {
  return singleton;
}

export function initNightlyMemoryTaskService(
  config?: Partial<NightModeConfig>,
): NightlyMemoryTaskService | null {
  const cfg = loadNightConfig();
  if (!cfg.enabled) {
    singleton = null;
    return null;
  }
  singleton = new NightlyMemoryTaskService(config);
  return singleton;
}
