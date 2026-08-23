// ProactivityHub —— 语义触发匹配器（SemanticTriggerMatcher）
//
// 对话钩子检测的泛化层：替代纯关键词正则的"硬编码智能"。
//
// 设计（种子先验 + 在线学习，蒸馏式）：
//  - 正则关键词 = 高精度种子先验（保留在 conversation-triggers，命中即触发）
//  - 本匹配器 = 泛化层：范例（exemplar）驱动的中文 2-gram 覆盖率评分，
//    覆盖换一种说法的强线索（正则写不完的表达方式）
//  - learn()：InitiativeEngine 通用路径做出主动决策后，把命中的对话文本
//    蒸馏回喂为该类新范例——快路径的召回随使用持续增长（LLM 当老师，
//    零额外 token：决策本身已发生，学习是免费的副产品）
//
// 评分模型（零 LLM、微秒级）：
//   score = |features(query) ∩ features(exemplar)| / |features(query)|
//   对某类取所有范例的最大覆盖率；≥2 个重叠特征且覆盖率达标才算命中。
//   特征 = 中文相邻 2-gram + 英文/数字 token（与项目词法检索同型）。

/** 触发范例类别（与 ConversationProactiveHookKind 对齐） */
export type TriggerExemplarKind = "care" | "followup";

/** 覆盖率命中阈值：查询特征被范例覆盖的比例 */
const MATCH_COVERAGE_THRESHOLD = 0.35;
/** 最少重叠特征数（防止 1 个偶合 bigram 误命中） */
const MIN_OVERLAP_FEATURES = 2;
/** 每类范例上限（learn 滚动淘汰最旧，防无限膨胀） */
const MAX_EXEMPLARS_PER_KIND = 40;
/** learn 的最短文本（太短的文本无区分度，不当范例） */
const MIN_LEARN_TEXT_LEN = 4;

/**
 * 种子范例（初始先验，正则词的周边说法扩展）。
 * 后续增长完全来自 LLM 决策蒸馏（learn），不再人工扩充。
 */
const SEED_EXEMPLARS: Record<TriggerExemplarKind, string[]> = {
  care: [
    "最近加班有点撑不住了",
    "感觉最近压力好大",
    "快被工作榨干了",
    "身心俱疲",
    "好想休息一下",
    "这几天都没睡好",
    "整个人都不好了",
    "心情有点低落",
    "什么都不想干",
    "感觉快崩溃了",
    "头疼得厉害",
    "状态特别差",
    "好压抑",
    "最近很丧",
    "心态有点崩",
  ],
  followup: [
    "帮我留意一下那个通知",
    "等他回复我",
    "这事儿先放放，过两天再弄",
    "别忘了明天要交的东西",
    "回头提醒我看一眼",
    "晚点再处理吧",
    "下周再约",
    "到时候提醒我",
    "结果出来了我还没看",
    "盯着那个进度",
    "记得跟进",
    "有空再弄",
    "这个周末再搞",
  ],
};

/** 提取文本词法特征：中文相邻 2-gram + 英文/数字 token（小写） */
export function extractTextFeatures(text: string): string[] {
  const feats: string[] = [];
  if (!text) return feats;
  const runs = text.match(/[\u4e00-\u9fff]+|[A-Za-z0-9]+/g) ?? [];
  for (const run of runs) {
    if (/^[A-Za-z0-9]+$/.test(run)) {
      feats.push(run.toLowerCase());
    } else {
      for (let i = 0; i + 1 < run.length; i++) {
        feats.push(run.slice(i, i + 2));
      }
    }
  }
  return feats;
}

/** 文本语义指纹（特征去重排序后拼接；内容相同则指纹相同，顺序无关） */
export function fingerprintText(text: string): string {
  return [...new Set(extractTextFeatures(text))].sort().join("|");
}

type MatcherState = {
  exemplars: Record<TriggerExemplarKind, string[]>;
  /** 已学习的指纹（去重：同文本只学一次） */
  learnedFingerprints: Set<string>;
};

const state: MatcherState = {
  exemplars: {
    care: [...SEED_EXEMPLARS.care],
    followup: [...SEED_EXEMPLARS.followup],
  },
  learnedFingerprints: new Set(),
};

export type SemanticHookMatch = {
  kind: TriggerExemplarKind;
  /** 命中范例对查询特征的覆盖率（0-1，置信度参考） */
  coverage: number;
};

/**
 * 语义层钩子检测：查询文本对某类范例的最大特征覆盖率达标即命中。
 * 与正则种子层（conversation-triggers 内）并联使用——正则管精度，这里管泛化。
 */
export function detectSemanticHook(text: string | undefined | null): SemanticHookMatch | null {
  if (!text) return null;
  const queryFeats = extractTextFeatures(text);
  if (queryFeats.length < MIN_OVERLAP_FEATURES) return null;
  const querySet = new Set(queryFeats);

  let best: SemanticHookMatch | null = null;
  for (const kind of ["care", "followup"] as const) {
    for (const ex of state.exemplars[kind]) {
      let overlap = 0;
      for (const f of extractTextFeatures(ex)) {
        if (querySet.has(f)) overlap += 1;
      }
      if (overlap < MIN_OVERLAP_FEATURES) continue;
      const coverage = overlap / queryFeats.length;
      if (coverage >= MATCH_COVERAGE_THRESHOLD && coverage > (best?.coverage ?? 0)) {
        best = { kind, coverage };
      }
    }
  }
  return best;
}

/**
 * 蒸馏学习：把 LLM 通用路径确认过的对话文本固化为该类新范例。
 * @returns 是否真正学入（去重 / 长度不足时返回 false）
 */
export function learnExemplar(kind: TriggerExemplarKind, text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < MIN_LEARN_TEXT_LEN) return false;
  const fp = fingerprintText(trimmed);
  if (state.learnedFingerprints.has(fp)) return false;
  state.learnedFingerprints.add(fp);
  const list = state.exemplars[kind];
  list.push(trimmed.slice(0, 80));
  if (list.length > MAX_EXEMPLARS_PER_KIND) list.shift();
  return true;
}

/** 范例统计（诊断/测试） */
export function exemplarStats(): Record<TriggerExemplarKind, { total: number; learned: number }> {
  return {
    care: {
      total: state.exemplars.care.length,
      learned: state.exemplars.care.length - SEED_EXEMPLARS.care.length,
    },
    followup: {
      total: state.exemplars.followup.length,
      learned: state.exemplars.followup.length - SEED_EXEMPLARS.followup.length,
    },
  };
}

/** 重置为种子范例（测试隔离用） */
export function resetExemplars(): void {
  state.exemplars.care = [...SEED_EXEMPLARS.care];
  state.exemplars.followup = [...SEED_EXEMPLARS.followup];
  state.learnedFingerprints.clear();
}
