/**
 * Jarvis Reflector — 异步反思循环
 *
 * 借鉴 Letta (MemGPT) 的 self-edit 模式：
 *  1. 周期性扫 episodic memory
 *  2. 提取规律，写入 reflection
 *  3. 高置信度的 reflection 提升为 rule
 *
 * 关键设计：
 *  - 不阻塞主流程（异步跑）
 *  - 不依赖 LLM（先用规则模式，confidence 超过阈值再考虑升级）
 *  - 每次 reflection 都记录 evidence，便于追溯
 */

import type { JarvisMemoryBank } from "./memory-bank.js";
import type { JarvisMemoryEntry } from "./types.js";

export type ReflectorRule = {
  id: string;
  pattern: RegExp;
  buildReflection: (entry: JarvisMemoryEntry) => {
    body: string;
    tags: string[];
    confidence: number;
  } | null;
};

const REFLECTOR_RULES: ReflectorRule[] = [
  // 规则 1：同一 category 连续沉默 → 用户不想听这类
  {
    id: "consecutive_silence_in_category",
    pattern: /^DECISION\[silent\]/,
    buildReflection: (entry) => {
      const cat = entry.tags.find((t) =>
        ["care", "warning", "opportunity", "planning", "completion", "newness", "follow_up", "presence", "social", "finance"].includes(t),
      );
      if (!cat) return null;
      return {
        body: `近期在「${cat}」类主动消息上 agent 选择了沉默，用户可能不希望被打扰。`,
        tags: ["silence_pattern", `category:${cat}`],
        confidence: 0.45,
      };
    },
  },
  // 规则 2：warning 类多次被 ignored → 通道可能不对
  {
    id: "warning_ignored_repeatedly",
    pattern: /^FEEDBACK\[ignored\]/,
    buildReflection: (entry) => {
      const isWarning = entry.tags.some((t) => t === "category:warning");
      if (!isWarning) return null;
      return {
        body: `「warning」类消息被忽略，可能通道选择不当或频繁度过高。`,
        tags: ["channel_review", "category:warning"],
        confidence: 0.5,
      };
    },
  },
  // 规则 3：用户对 negative feedback 给出显式反馈 → 降低同 source 阈值
  {
    id: "explicit_negative_feedback",
    pattern: /^FEEDBACK\[negative\]/,
    buildReflection: (entry) => {
      return {
        body: `用户给出显式负反馈，下一轮同 source 触发时应降低概率并考虑换通道。`,
        tags: ["preference_suppress", "feedback:negative"],
        confidence: 0.75,
      };
    },
  },
  // 规则 4：positive feedback → 强化同 category 信心
  {
    id: "explicit_positive_feedback",
    pattern: /^FEEDBACK\[positive\]/,
    buildReflection: (entry) => {
      return {
        body: `用户给出显式正反馈，类似触发可以更主动。`,
        tags: ["preference_amplify", "feedback:positive"],
        confidence: 0.8,
      };
    },
  },
  // 规则 5：post_mood 下降 → 触发 self 关怀反思
  {
    id: "post_mood_drop",
    pattern: /^FEEDBACK\[post_mood\]/,
    buildReflection: (entry) => {
      return {
        body: `主动消息发出后用户整体情绪下降，说明打扰成本可能高于价值。`,
        tags: ["mood_aftermath", "be_careful"],
        confidence: 0.7,
      };
    },
  },
  // 规则 6：自发性扫描触发的话题被 responded → 自发性有效
  {
    id: "self_scan_effective",
    pattern: /^FEEDBACK\[responded\]/,
    buildReflection: (entry) => {
      const isSelfScan = entry.tags.some((t) => t.startsWith("source:self_scan"));
      if (!isSelfScan) return null;
      return {
        body: `用户对自发性主动消息做出了回应，自发性策略有效。`,
        tags: ["self_scan_effective"],
        confidence: 0.7,
      };
    },
  },
];

export type ReflectorDeps = {
  memory: JarvisMemoryBank;
  logger?: { info: (msg: string) => void; warn: (msg: string) => void };
};

export class JarvisReflector {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  /** 已经被 reflection 处理过的 episodic id（避免重复） */
  private readonly processedIds = new Set<string>();

  constructor(private readonly deps: ReflectorDeps) {}

  start(intervalMs: number): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runOnce().catch((err) => {
        this.deps.logger?.warn(
          `[JarvisReflector] tick failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }, intervalMs);
    this.deps.logger?.info(`[JarvisReflector] started (interval=${intervalMs}ms)`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * 单次反思：对每个 actor 跑一遍规则匹配
   */
  async runOnce(): Promise<{ reflected: number; promoted: number }> {
    if (this.running) return { reflected: 0, promoted: 0 };
    this.running = true;
    let reflected = 0;
    let promoted = 0;
    try {
      const actorIds = this.collectActorIds();
      for (const actorId of actorIds) {
        const episodic = this.deps.memory.episodicFor(actorId, 100);
        const newOnes = episodic.filter((e) => !this.processedIds.has(e.id));
        for (const entry of newOnes) {
          for (const rule of REFLECTOR_RULES) {
            if (!rule.pattern.test(entry.body)) continue;
            const reflection = rule.buildReflection(entry);
            if (!reflection) continue;
            await this.deps.memory.recordReflection(
              actorId,
              reflection.body,
              [...entry.tags, ...reflection.tags, `rule:${rule.id}`],
              reflection.confidence,
              "reflection",
              [entry.id],
            );
            reflected += 1;

            // 提升为 rule 的条件：confidence >= 0.7 且 出现 >= 2 次
            if (reflection.confidence >= 0.7) {
              const occurrences = episodic.filter((e) =>
                rule.pattern.test(e.body),
              ).length;
              if (occurrences >= 2) {
                await this.deps.memory.recordRule(
                  actorId,
                  reflection.body,
                  [...reflection.tags, `promoted_from:${rule.id}`],
                  Math.min(0.95, reflection.confidence + 0.1),
                  [entry.id],
                );
                promoted += 1;
              }
            }
          }
          this.processedIds.add(entry.id);
        }
      }
      if (reflected > 0 || promoted > 0) {
        this.deps.logger?.info(
          `[JarvisReflector] runOnce actors=${actorIds.length} reflected=${reflected} promoted=${promoted}`,
        );
      }
    } finally {
      this.running = false;
    }
    return { reflected, promoted };
  }

  private collectActorIds(): string[] {
    // 通过 episodic 收集（reflection/rule 不用作输入）
    const ids = new Set<string>();
    const snapshot = (this.deps.memory as unknown as {
      episodic: Map<string, unknown[]>;
    }).episodic;
    if (snapshot instanceof Map) {
      for (const key of snapshot.keys()) ids.add(key);
    }
    return [...ids];
  }
}
