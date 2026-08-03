/**
 * 统一的 fallback 兜底文案与 apology 检测。
 *
 * 设计原则：
 * 1. 文案统一：所有「agent 无法回复」的兜底走同一文案，避免用户感知不一致。
 * 2. 信息不泄漏：原始错误（含 stack/API key/文件路径）绝不直接给用户。
 * 3. 可观测：apology 文案命中时记日志（由调用方负责），便于定位根因。
 * 4. 区分场景：通用兜底 / 工具超时 / 排队繁忙 三种语义独立。
 * 5. 不再使用"抱歉/再说一遍"等机械道歉口吻，改用"换个说法重试"引导式提示。
 * 6. 文案变体：每种 fallback 类型提供多条变体随机选取，避免高频失败时用户看到重复文案。
 */

// ── 文案变体池（随机选取，避免重复感）──

const FALLBACK_GENERAL_VARIANTS = [
  "我没找到合适的内容，换个说法我再试试？",
  "这个我没太接住，你能再说具体点吗？",
  "嗯…这个我不太确定，换个角度问问看？",
  "我这边没拿到理想的结果，要不换个问法？",
  "这个问题有点难住我了，你能补充点细节吗？",
];

const FALLBACK_BUSY_VARIANTS = [
  "现在有点忙不过来，稍等下再发一次呗～",
  "消息有点多，我刚处理完上一条，再发一次试试？",
  "稍等一下哦，我正在处理别的请求，马上就好。",
];

const FALLBACK_BACKGROUND_FAILED_VARIANTS = [
  "后台任务没跑通，可能是工具暂时不可用，要不我换个方式试试？",
  "刚才那个任务执行中出了点状况，我重新来一次吧。",
  "后台执行遇到了点问题，不过没关系，我换个思路再来。",
];

function pickVariant(variants: string[]): string {
  return variants[Math.floor(Math.random() * variants.length)];
}

/** 通用兜底文案（agent 无内容产出时） — 引导用户换个说法 */
export const FALLBACK_TEXT_GENERAL = () => pickVariant(FALLBACK_GENERAL_VARIANTS);

/** 工具执行超时（注入到 LLM 上下文，不直接给用户） */
export const FALLBACK_TEXT_TOOL_TIMEOUT = (ms: number) =>
  `工具执行超时（${ms}ms），可能服务繁忙，请稍后再试或换个方式。`;

/** 全局并发排队超时（直接给用户） */
export const FALLBACK_TEXT_BUSY = () => pickVariant(FALLBACK_BUSY_VARIANTS);

/** 后台任务失败（直接给用户，通过 WS 推送） */
export const FALLBACK_TEXT_BACKGROUND_FAILED = () => pickVariant(FALLBACK_BACKGROUND_FAILED_VARIANTS);

/** 子 Agent 委派失败（注入到 LLM 上下文） */
export const FALLBACK_TEXT_SUBAGENT_FAILED =
  "子任务执行没成功，可能是工具暂时不可用或信息不足。请向用户说明，并给出你能确定的部分或建议换个方式。";

// ── 向后兼容：导出字符串常量(取第一条变体)供旧代码直接引用 ──
export const FALLBACK_TEXT_GENERAL_CONST = FALLBACK_GENERAL_VARIANTS[0];
export const FALLBACK_TEXT_BUSY_CONST = FALLBACK_BUSY_VARIANTS[0];

// 注:LLM 级熔断由 external-model/circuit-breaker.ts 的 CircuitBreaker(三态状态机) +
// failover-chat-provider.ts 的 FailoverChatProvider 在 provider 层处理,此处不重复实现。

/**
 * 检测文本是否为 LLM 自发生成的 apology 风格 fallback。
 * 命中条件：含「抱歉/对不起/无法/不能/暂时/稍后重试/换个问法」等关键词
 * 且文本较短（< 120 字），避免误判长回复里偶然出现的"抱歉"。
 */
const APOLOGY_RE =
  /(抱歉|对不起|不好意思|无法|不能|暂时|稍后重试|换个问法|换个方式|过会儿|卡住了|卡壳|没反应过来|出了点小问题|出了点状况|搞不定|帮不上忙|查不了|没法查|暂时查|没(?:太|有)?(?:听清|听到|清楚|收到)|再说一遍|没听明白|没懂你的意思|啊\?没听|嗯\.\.\.我这会儿)/i;

export function isApologyStyleFallback(text: string): boolean {
  if (!text) return false;
  const t = text.trim();
  if (!t) return false;
  if (t.length > 120) return false;
  return APOLOGY_RE.test(t);
}
