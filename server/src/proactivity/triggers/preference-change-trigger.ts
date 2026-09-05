/**
 * 方案 E：记忆变更 → 主动触发链路（PreferenceChangeTrigger）。
 *
 * 监听记忆写入事件（NarrativeMemoryFacade.ingest 的 onWrite 钩子接线），
 * 用确定性正则检测「偏好变更」信号（如「我现在吃素了」「以后不喝咖啡了」），
 * 生成主动提案交统一管道：
 *
 *   - 新偏好（无冲突）：低价值提案（期望价值低），由 Action Utility 评估器
 *     判 silence——记忆系统照常学习，用户无需被打扰（沉默留痕可反问）；
 *   - 偏好反转（信念偏好图同主题旧值与新值矛盾）：高价值确认提案（must 层），
 *     与 UserFactStore 的版本化主键（kind+归一 subject，latest-wins）联动——
 *     subject 归一复用 extractFactSubject，同一主题换值即触发确认，
 *     防「上一版偏好」幽灵残留（用户纠正 → 记忆侧可回滚）。
 *
 * 全链路零 LLM：正则检测 + 事实库比对 + 效用评估，确定可测。
 */
import { extractFactSubject } from "../../services/user-fact-store.js";
import { deriveNotifyValue } from "../action-utility.js";
import type { ProactiveProposal, ProposalUtilityMeta } from "../pipeline-types.js";

/** 信念偏好图最小外观（UserFactStore.getFacts(kind="preference") 的薄包装） */
export interface PreferenceFactSource {
  (actorId: string): Promise<Array<{ subject: string; value: string }>> | Array<{ subject: string; value: string }>;
}

export type PreferenceChangeTriggerDeps = {
  /** 统一管道入口（ProactivePipeline.submitProposal 的薄包装） */
  submit: (p: ProactiveProposal) => void;
  /** 既有偏好事实读取（反转检测）；未注入时只做新偏好低价值提案 */
  getPreferenceFacts?: PreferenceFactSource;
  now?: () => number;
  /** 同主题确认冷却 ms（默认 24h）：短期内同主题不反复确认 */
  cooldownMs?: number;
};

/** 偏好变更信号（第一人称 + 变更动词/经典切换词），确定性正则 */
const PREFERENCE_CHANGE_PATTERNS: RegExp[] = [
  // 我现在吃素了 / 我以后不喝咖啡了 / 我最近开始跑步 / 我从今天起戒糖
  /我(现在|以后|今后|最近|从今天起?|从今往后?)(不|不再|改|换|戒|开始|只|爱|喜欢|讨厌|吃|用|穿|喝|坐)/,
  // 我不吃香菜了 / 我再也不熬夜了 / 我不再喜欢简洁的回答了
  /我(不|不再|再也不)(要|想|吃|喝|用|穿|玩|看|买|坐|熬|喜欢|讨厌|爱|偏好)/,
  // 经典切换词（吃素/戒烟/戒酒……）
  /(吃素|素食|戒烟|戒酒|戒糖|戒咖啡|戒熬夜|戒掉)/,
  // 我改吃素了 / 我换了工作 / 我改用安卓了
  /我(改|换)(了|吃|用|穿|喝|成|到)/,
];

/** 单条写入文本的检测上限（超长多为段落归档而非偏好陈述） */
const MAX_TEXT_LEN = 200;
/** 同主题确认冷却缺省 24h */
const DEFAULT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/**
 * 偏好领域桶（反转检测的兜底匹配）：subject 归一对「我现在吃素了」这类
 * 变更句式会退化为整句，与旧值「我喜欢吃肉」的 subject（吃肉）对不上；
 * 领域关键词命中同一桶 + 值不同 → 视为疑似反转（发确认而非直接覆盖）。
 */
const PREFERENCE_DOMAINS: Array<{ domain: string; keywords: string[] }> = [
  {
    domain: "饮食",
    keywords: ["吃", "喝", "素", "荤", "辣", "甜", "咸", "咖啡", "茶", "烟", "酒", "糖", "肉", "香菜", "牛奶", "饮料", "奶茶"],
  },
  { domain: "作息", keywords: ["熬夜", "早起", "晚睡", "午睡", "睡眠", "作息"] },
  { domain: "运动", keywords: ["跑步", "健身", "锻炼", "运动", "游泳", "瑜伽", "打球"] },
  { domain: "通勤", keywords: ["地铁", "开车", "骑车", "步行", "通勤", "公交", "打车"] },
];

/** 文本命中的偏好领域（可能多个；无命中返回空） */
function hitDomains(text: string): Set<string> {
  const hits = new Set<string>();
  for (const { domain, keywords } of PREFERENCE_DOMAINS) {
    if (keywords.some((kw) => text.includes(kw))) hits.add(domain);
  }
  return hits;
}

export type PreferenceChangeKind =
  | "preference_reversal_confirm" // 偏好反转 → 确认提案（must/high）
  | "preference_change_noted"; // 新偏好 → 低价值提案（评估器判 silence）

export function detectPreferenceChangeSignal(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > MAX_TEXT_LEN) return false;
  return PREFERENCE_CHANGE_PATTERNS.some((re) => re.test(t));
}

let proposalSeq = 0;

/** 句尾语气助词剥离（subject 比较前的归一：「…回答了」vs「…回答」应是同一槽位） */
function trimTrailingParticles(s: string): string {
  return s.replace(/[了吗呢吧呀啊]+$/u, "");
}

/** 偏好陈述的首个动作动词（反转精确化：吃素 vs 喝奶茶是同域不同对象，不应互证） */
const ACTION_VERB_RE = /(吃|喝|用|穿|坐|玩|熬|抽|点|买|看|听|戴)/;

function primaryActionVerb(text: string): string | null {
  const m = text.match(ACTION_VERB_RE);
  return m?.[1] ?? null;
}

/**
 * 反转判定（三级，从严到宽）：
 *   ① subject 归一相等（版本化主键，最强信号）；
 *   ② 领域桶重叠 且 动作动词相同（吃素 vs 吃红烧肉 → 反转；吃素 vs 喝奶茶 → 不算）；
 *   领域桶重叠但动词不同/缺失 → 仅视为同域新偏好（低价值 noted，不确认）。
 */
function isReversal(oldFact: { subject: string; value: string }, text: string, subject: string): boolean {
  if (oldFact.value.trim() === text.trim()) return false; // 精确同文 = 重放，非反转
  if (trimTrailingParticles(oldFact.subject) === subject) return true;
  const newDomains = hitDomains(text);
  if (!newDomains.size) return false;
  const hasDomainOverlap = [...hitDomains(oldFact.value)].some((d) => newDomains.has(d));
  if (!hasDomainOverlap) return false;
  const oldVerb = primaryActionVerb(oldFact.value);
  const newVerb = primaryActionVerb(text);
  return oldVerb !== null && oldVerb === newVerb;
}

export class PreferenceChangeTrigger {
  /** 同主题最近确认提案时刻（冷却去重） */
  private readonly lastFiredAt = new Map<string, number>();

  constructor(private readonly deps: PreferenceChangeTriggerDeps) {}

  private get cooldownMs(): number {
    return this.deps.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  }

/**
 * 记忆写入钩子入口（装配层接 NarrativeMemoryFacade onWrite；fire-and-forget）。
 * 非偏好文本直接返回 null（零开销）；偏好变更 → 与事实主库比对 → 提案。
 */
async noteMemoryWrite(
  actorId: string,
  text: string,
  opts?: { sourceRef?: string },
): Promise<ProactiveProposal | null> {
  if (!detectPreferenceChangeSignal(text)) return null;
  const now = this.deps.now?.() ?? Date.now();

  const subject = trimTrailingParticles(extractFactSubject("preference", text)) || text.slice(0, 12);
  // 冷却按领域桶（措辞稳定）：「我现在吃素了」和「我从今天起吃素」同域同窗只确认一次；
  // 无领域命中的偏好退回 subject 键
  const cooldownKey = `${actorId}:${[...hitDomains(text)][0] ?? subject}`;
  const last = this.lastFiredAt.get(cooldownKey);
  if (last !== undefined && now - last < this.cooldownMs) return null;

  // 信念偏好图版本化联动：既有偏好与新表述矛盾 → 偏好反转，升级为确认提案
  let reversal: { previousValue: string } | null = null;
  if (this.deps.getPreferenceFacts) {
    try {
      const facts = await this.deps.getPreferenceFacts(actorId);
      const hit = facts.find((f) => isReversal(f, text, subject));
      if (hit) reversal = { previousValue: hit.value };
    } catch {
      /* 事实库读取失败按无冲突处理（学习照常，只是不做反转确认） */
    }
  }

    this.lastFiredAt.set(cooldownKey, now);
    if (this.lastFiredAt.size > 500) {
      const first = this.lastFiredAt.keys().next().value;
      if (first !== undefined) this.lastFiredAt.delete(first);
    }

    const proposal = reversal
      ? this.buildReversalProposal(actorId, text, subject, reversal.previousValue, now)
      : this.buildNotedProposal(actorId, text, subject, now, opts?.sourceRef);
    this.deps.submit(proposal);
    return proposal;
  }

  /** 偏好反转确认：must 层高价值（记忆一致性确认值得打扰） */
  private buildReversalProposal(
    actorId: string,
    text: string,
    subject: string,
    previousValue: string,
    now: number,
  ): ProactiveProposal {
    const snippet = text.slice(0, 60);
    const utility: ProposalUtilityMeta = {
      risk: { reversible: true, financialImpact: "none", dataSensitivity: "none", thirdPartyImpact: false },
      authorization: "implicit",
      value: deriveNotifyValue("high"),
    };
    return {
      proposalId: `prefrev_${now.toString(36)}_${(proposalSeq++).toString(36)}`,
      actorId,
      kind: "preference_reversal_confirm",
      tier: "must",
      importance: "high",
      dedupKey: `pref_reversal:${actorId}:${subject}:${new Date(now).toISOString().slice(0, 10)}`,
      title: `偏好变化确认：${subject}`,
      summary: `用户偏好疑似反转（主题 ${subject}）：旧值「${previousValue.slice(0, 40)}」→ 新表述「${snippet}」。`,
      evidence: [`subject=${subject}`, `previous=${previousValue.slice(0, 40)}`, `text=${snippet}`],
      directText:
        `我记得你之前是「${previousValue.slice(0, 40)}」，刚才听到你说「${snippet}」。` +
        `是改成这样了吗？我已更新记忆，理解错了随时纠正我。`,
      createdAt: now,
      source: "memory-write",
      utility,
    };
  }

  /** 新偏好（无冲突）：低价值提案，评估器预期判 silence（记忆照常学习，不打扰） */
  private buildNotedProposal(
    actorId: string,
    text: string,
    subject: string,
    now: number,
    sourceRef?: string,
  ): ProactiveProposal {
    const utility: ProposalUtilityMeta = {
      risk: { reversible: true, financialImpact: "none", dataSensitivity: "none", thirdPartyImpact: false },
      authorization: "implicit",
      value: deriveNotifyValue("low"),
    };
    return {
      proposalId: `prefnote_${now.toString(36)}_${(proposalSeq++).toString(36)}`,
      actorId,
      kind: "preference_change_noted",
      tier: "social",
      importance: "low",
      dedupKey: `pref_change:${actorId}:${subject}:${new Date(now).toISOString().slice(0, 10)}`,
      title: `偏好更新：${subject}`,
      summary: `检测到新偏好表述：「${text.slice(0, 60)}」（已入记忆，无需专门告知）。`,
      evidence: [`subject=${subject}`, ...(sourceRef ? [`source=${sourceRef}`] : [])],
      directText: `记下了：${text.slice(0, 60)}。`,
      createdAt: now,
      source: "memory-write",
      utility,
    };
  }
}
