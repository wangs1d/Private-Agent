/**
 * 用户称呼解析（共享纯函数，问候/播报/提示词共用）。
 *
 * 业务硬规则：**绝不直呼用户大名**。
 *   1. 用户明确指定/偏好的称呼最优先（「可称"王哥"」「叫我老王」「昵称：小张」
 *      「（用户指定）」标记…）；
 *   2. 没有指定时，记录值本身已是得体称呼（王哥/王先生/老王/小张/王总…）→ 原样用；
 *   3. 记录值是连名带姓的大名（王铭川/欧阳文山）→ 转为「姓氏 + 先生」（王先生）；
 *   4. 解析不出来 → 空串（问候省略称呼），绝不回退成大名。
 *
 * 注意：档案里存「称呼：王铭川」是事实记录（问"我叫什么"要能答对），
 * 本模块只负责「拿来称呼用户」时的得体化，不改档案本身。
 */

/** 称呼长度上限（与晨报接口既有约束一致） */
const APPELLATION_MAX_CHARS = 20;

/** 常见复姓：三/四字中文名优先按复姓截姓氏 */
const COMPOUND_SURNAMES = [
  "欧阳", "司马", "上官", "诸葛", "东方", "夏侯", "皇甫", "尉迟", "公孙",
  "令狐", "慕容", "司徒", "长孙", "宇文", "南宫", "西门", "独孤", "司空",
  "端木", "申屠", "万俟", "闻人", "澹台", "公冶", "拓跋", "轩辕", "呼延",
  "东郭", "百里", "钟离", "鲜于", "谷梁", "漆雕", "巫马", "公西",
];

/** 常见单字姓氏（覆盖《百家姓》常用部分，做「像不像大名」的启发式判断） */
const SINGLE_SURNAMES =
  "王李张刘陈杨黄赵吴周徐孙马朱胡郭何林罗高郑梁谢宋唐许韩冯邓曹彭曾肖田董潘袁蔡蒋余于杜叶程魏苏吕丁任卢姚沈钟姜崔谭陆范汪廖石金韦贾夏付方邹熊白孟秦邱侯江尹薛闫段雷龙黎史陶贺毛郝顾龚邵万钱严覃武戴莫孔向汤温康施文柯柴倪凌米谷代桂";

/** 尾缀是称谓词（王哥/王姐/王总/王先生/王老师…）→ 本身就是得体称呼 */
const HONORIFIC_TAIL_RE =
  /(先生|女士|小姐|老师|教授|博士|医生|大夫|老板|同学|哥|姐|弟|妹|叔|姨|伯|婶|舅|总|工|师)$/;

/** 头缀是昵称前缀（老王/小张/阿强…）→ 本身就是得体称呼 */
const NICKNAME_HEAD_RE = /^(老|小|阿|大)/;

/**
 * 显式偏好称呼的引导词：「可称"王哥"」「叫我小张」「昵称：老王」…
 * 捕获组取引导词后的首个短词（容忍引号/冒号）。
 */
const PREFERRED_LEAD_RE =
  /(?:可称|可以称|称作|称我为|称呼为|称呼我|叫我|喊我|昵称|花名|绰号)\s*[:：]?[「"'『']?([^\s「」"'『』（）()；;，,。！!？?]{1,12})/;

/** 用户显式指定标记（profile-heuristics 写入「称呼：X（用户指定）」） */
const EXPLICIT_MARKER_RE = /[（(]\s*(?:用户指定|用户要求|用户明确指定)\s*[）)]/;

function clampAppellation(v: string): string {
  return v.trim().slice(0, APPELLATION_MAX_CHARS);
}

/**
 * 解析「称呼」行内容 → 用于问候的得体称呼。
 * 入参是「称呼：」后面的整行（可含括号备注、分号补充，如
 * 「王铭川（可称"王哥"）；自称「小弟」」）。解析失败返回空串。
 */
export function resolvePoliteAppellation(raw: string): string {
  const line = raw?.trim();
  if (!line) return "";

  // 1) 用户显式指定标记：「王铭川（用户指定）」→ 用户就是要这么被叫
  if (EXPLICIT_MARKER_RE.test(line)) {
    const head = stripWrappingQuotes(
      (line.split(EXPLICIT_MARKER_RE)[0] ?? "").split(/[；;，,。]/)[0] ?? "",
    );
    if (head) return clampAppellation(head);
  }

  // 2) 引导词命名的偏好称呼（括号内外都找）：可称"王哥" → 王哥
  const preferred = PREFERRED_LEAD_RE.exec(stripWrappingQuotes(line))?.[1]?.trim();
  if (preferred) return clampAppellation(preferred);

  // 3) 主称呼（括号/分号/逗号前）做得体化
  const primary = stripWrappingQuotes(
    line.split(/[（(【\[]/)[0]?.split(/[；;，,。]/)[0] ?? "",
  );
  if (!primary) return "";
  return clampAppellation(toPoliteAddress(primary));
}

/**
 * 单个称呼值的得体化：已是称呼（含称谓尾缀/昵称前缀/非中文名）原样返回；
 * 看起来是连名带姓的大名 → 「姓氏 + 先生」。
 */
export function toPoliteAddress(name: string): string {
  const v = name.trim();
  if (!v) return "";
  if (HONORIFIC_TAIL_RE.test(v) || NICKNAME_HEAD_RE.test(v)) return v;
  // 纯中文才做大名判断（压缩内部空白）；非纯中文（英文名/带数字等）原样不动
  const compact = v.replace(/\s+/g, "");
  if (!/^[一-鿿]{2,4}$/.test(compact)) return v;

  const compound = COMPOUND_SURNAMES.find((s) => compact.startsWith(s));
  if (compound) {
    // 复姓 + 至少 1 字名（≥3 字）→ 大名；纯复姓（2 字）当名字保留
    return compact.length >= 3 ? `${compound}先生` : v;
  }

  if (compact.length === 2) {
    // 两字：首字是常见姓氏且尾字不是称谓词 → 视为双字大名（王芳 → 王先生）
    const head = compact[0] ?? "";
    const tail = compact[1] ?? "";
    if (SINGLE_SURNAMES.includes(head) && !HONORIFIC_TAIL_RE.test(tail)) {
      return `${head}先生`;
    }
    return v;
  }

  // 三/四字：首字是常见姓氏 → 大名（王铭川 → 王先生）；否则当名字类昵称保留
  if (SINGLE_SURNAMES.includes(compact[0] ?? "")) return `${compact[0]}先生`;
  return v;
}

function stripWrappingQuotes(v: string): string {
  return v.replace(/^[「"'『'（(]+/, "").replace(/[」"'』'）)]+$/, "").trim();
}
