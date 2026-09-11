/**
 * 亲密关系断言识别与助手"摇摆发言"检测（root fix，2026-09 复盘）
 *
 * 背景：配偶/伴侣类主题（老婆/正主/对象…）曾在没有任何覆盖机制的情况下新旧值并存
 * （"候选人锁定刘浩存，景甜降级成备选"），叠加助手把求证当事实（"到底哪位是正主"），
 * 导致同一字段多值同时注入 prompt。本模块提供三个纯函数：
 *
 * 1. extractRelationshipAssertion：从一句用户陈述中识别"关系主题 + 值"，
 *    subject 归一（"未来老婆"/"老婆"/"正主" → spouse），供写入侧 latest-wins 覆盖
 *    与召回侧同主题冲突消解共用一个 key；
 * 2. isRelationshipHedgeLine：识别助手对关系主题的"摇摆/求证"发言
 *    （"到底哪位是正主""前脚一个…后脚一个""不敢乱记"）——这类发言永远不是事实，
 *    用户给出明确断言后应作废，召回时直接剔除；
 * 3. 断言识别必须是"陈述"而非"疑问"：疑问句（"老婆是谁"）返回 null，不会被当作断言。
 */

export type RelationshipSubject = "spouse" | "partner" | "fiance" | "location";

export interface RelationshipAssertion {
  subject: RelationshipSubject;
  /** 断言指向的值（人名/城市） */
  value: string;
}

const SUBJECT_KEYWORDS: Array<{ re: RegExp; subject: RelationshipSubject }> = [
  { re: /老婆|媳妇|妻子|夫人|爱人|正主|正宫/, subject: "spouse" },
  { re: /女朋友|女友/, subject: "partner" },
  { re: /未婚妻|未婚夫/, subject: "fiance" },
  { re: /住在|定居|搬到|移居|居住地/, subject: "location" },
];

/** 不能作为断言值的词（疑问词、泛称、上下文噪音） */
const VALUE_STOPWORDS = new Set([
  "是谁", "谁", "什么", "哪个", "哪位", "真的", "到底", "演员", "明星", "照片", "近照",
  "正主", "真主", "候选", "备选", "本人", "她", "他", "我", "你", "不", "没", "还记得",
  "记住", "记得", "的样子", "才是", "就是", "哪里", "这儿", "那里",
]);

function cleanValue(raw: string, subject: RelationshipSubject): string | null {
  let value = raw.trim();
  if (subject === "location") {
    // 城市值后可能紧跟动词（"搬到上海定居了"），剥掉非地名尾巴
    value = value.replace(/(?:定居|安家|生活|工作|落户)+$/g, "");
  }
  value = value.replace(/(?:的照片|最近的?|近照|呢|啊|呀|哦|了|吗|吧|哈)+$/g, "").trim();
  if (!value) return null;
  if (VALUE_STOPWORDS.has(value)) return null;
  // 值里不应再含主题词（"老婆是谁"之类）或明显非人名token
  if (/(?:老婆|媳妇|妻子|未婚|对象|正主|真主|女朋友|女友|哪位|哪个|谁)/.test(value)) return null;
  if (value.length < 2 || value.length > 10) return null;
  return value;
}

/**
 * 从文本中提取关系断言。仅在"主题词 + 断言动词 + 值"或"值 + 才是 + 主题词"
 * 同句共现时返回，疑问/调侃无值时返回 null。
 */
export function extractRelationshipAssertion(text: string): RelationshipAssertion | null {
  const raw = (text ?? "").trim();
  if (!raw) return null;
  // 去掉行首装饰（时间戳/topic tag/日志固化头），避免干扰句内匹配
  const plain = raw
    .replace(/^\[[^\]]*\]\s*/g, "")
    .replace(/日志固化[^·]*·(?:用户|助手|fact|prefer|commit)\]\s*/g, "");

  for (const sentence of plain.split(/[，。！？;；\n]/)) {
    const subject = SUBJECT_KEYWORDS.find((k) => k.re.test(sentence))?.subject;
    if (!subject) continue;

    if (subject === "location") {
      // 居住地：住在X / 定居X / 搬到X / 移居X
      const m = sentence.match(/(?:住在|定居在|定居于|定居|搬到|移居到?|落户)([\u4e00-\u9fa5A-Za-z]{2,8})/);
      if (m?.[1]) {
        const value = cleanValue(m[1], subject);
        if (value) return { subject, value };
      }
      continue;
    }

    // 直接式：老婆是X / 未来的老婆是X / 正主是X / 对象叫X
    const direct = sentence.match(
      /(?:老婆|媳妇|妻子|夫人|爱人|未婚妻|未婚夫|正主|对象|女朋友|女友)(?:是|就是|叫|指的是?|才?是真主|才?是正主)\s*([\u4e00-\u9fa5A-Za-z·]{2,12})/,
    );
    if (direct?.[1]) {
      const value = cleanValue(direct[1], subject);
      if (value) return { subject, value };
    }

    // 倒装式：X才是真主 / X才是（未来的）老婆 / X就是正主
    // （动词后的主题词为必填，防止"…的话就是真理"这类普通陈述误报）
    const inverted = sentence.match(
      /([\u4e00-\u9fa5A-Za-z·]{2,6})\s*(?:才是|就是)\s*(?:真主|正主|我?未来的?)?\s*(?:老婆|媳妇|正主|真主|未婚妻|对象|女朋友|女友)/,
    );
    if (inverted?.[1]) {
      const value = cleanValue(inverted[1], subject);
      if (value) return { subject, value };
    }
  }
  return null;
}

/**
 * 两段文本是否谈论同一断言主题（如都在谈居住地/配偶）。
 * 词面零重叠但同主题时（"搬到上海定居了" vs "住在哪个城市"），
 * 检索侧用它给词法分兜底，避免同主题新事实被相关性下限误杀。
 */
export function sharedAssertionSubject(a: string, b: string): RelationshipSubject | null {
  if (!a || !b) return null;
  for (const k of SUBJECT_KEYWORDS) {
    if (k.re.test(a) && k.re.test(b)) return k.subject;
  }
  return null;
}

/**
 * 助手对关系主题的"摇摆/求证/调侃候选"发言：
 * 「到底哪位是正主」「前脚一个X后脚一个Y」「说法飘忽」「不敢乱记」「记岔了」
 * 「降级成备选」「候选人锁定」等。这类发言永远不构成事实，也不值得召回。
 */
export function isRelationshipHedgeLine(text: string): boolean {
  const raw = (text ?? "").trim();
  if (!raw) return false;
  const subjectHit =
    SUBJECT_KEYWORDS.some((k) => k.re.test(raw)) || /正主|真主/.test(raw);
  if (!subjectHit) return false;
  return (
    /(到底)?(哪位|哪个|谁)(是|才是)?(正主|真主)/.test(raw) ||
    /说法[^。]{0,6}飘忽|飘忽/.test(raw) ||
    /不敢乱记|记岔|拿不准.*哪位|哪个才是/.test(raw) ||
    /前脚一个[^。]{0,16}后脚一个/.test(raw) ||
    /位子换得勤|换得勤/.test(raw) ||
    /降级成备选|降级为备选/.test(raw) ||
    /候选人锁定|排在头一位/.test(raw)
  );
}
