/**
 * Schema 瘦身共享原语（2026-10-01 收口）。
 *
 * 此前两套口径各自为政：Core 注入侧有 slimToolSchema（首句描述+剥字段说明），
 * 检索发现通道（tool_discover 结果 / 意图预召回）却回传全文 description +
 * 完整参数 schema——实测 21/21 条 discover 载荷超过 LLM 视图压缩预算（800 字符，
 * p50 4037），尾部 match 被结构性截断，检索得越"多"丢得越全。
 *
 * 本模块是瘦身纪律的唯一事实源：
 *   - firstSentence：描述压首句（Core 注入与发现线格式共用同一截断语义）
 *   - slimJsonSchema：参数 schema 剥字段级 description（保留类型/必填/枚举——
 *     模型发起 tool_call 需要的是形状不是参数手册）
 *   - lane-tool-sets 的 slimToolSchema 与 tool-search 的发现线格式都从这里取原语
 *
 * 无依赖叶子模块：两侧（external-model / tool-search）都可安全 import，不成环。
 */

/** 压到首个句末边界（。！？.!?\n），超长截断加省略号。同输入恒同输出。 */
export function firstSentence(text: string, maxChars: number): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  const m = /^.{1,200}?[。！？.!?\n]/.exec(trimmed);
  const head = m ? m[0] : trimmed;
  return head.length > maxChars ? `${head.slice(0, maxChars)}…` : head;
}

type JsonSchemaLike = {
  type?: string;
  properties?: Record<string, unknown>;
  required?: unknown;
  [key: string]: unknown;
};

/**
 * 参数 schema 瘦身：剥 properties 各字段的 description（确定性，同输入恒同输出）。
 * 保留类型/required/enum——执行调用需要形状信息，字段级说明文本是纯上下文税。
 */
export function slimJsonSchema(
  params: unknown,
): unknown {
  if (!params || typeof params !== "object") return params;
  const schema = params as JsonSchemaLike;
  if (!schema.properties || typeof schema.properties !== "object") return params;
  const properties: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema.properties)) {
    if (value && typeof value === "object" && "description" in (value as Record<string, unknown>)) {
      const { description: _drop, ...rest } = value as Record<string, unknown>;
      properties[key] = rest;
    } else {
      properties[key] = value;
    }
  }
  return { ...schema, properties };
}
