/**
 * 流式聊天响应的 provider-agnostic 抽象层。
 *
 * 背景：
 *  - 思考类模型（Kimi K2.5 / o1* / DeepSeek-R1 / Qwen-QwQ / Claude thinking…）会先把推理过程放进
 *    流里，字段名五花八门：`reasoning_content`（Moonshot/DeepSeek）/ `reasoning`（部分代理）/
 *    `thinking`（个别本地推理端点）/ `reasoning_text`（Google）/ `reasoning_delta`（Anthropic）。
 *  - 历史上每个 Provider 自己写 `for await (const part of stream)` 的循环，只读 `content`，
 *    导致模型只推 reasoning 时 `full === ""` → 上层走兜底文案（"抱歉，我暂时无法生成回复…"）。
 *
 * 这个模块把累积逻辑收敛到一处，做到「任何模型都能修正」：
 *  - 定义一个与具体 SDK 解耦的统一 chunk 形态 `NormalChatChunk`。
 *  - 核心 consumer `consumeNormalizedStream` 只接受这个统一形态，**不耦合任何特定 provider 的字段名**。
 *  - 给出 OpenAI Chat Completions 的 normalizer adapter；其它 provider（Anthropic / Google /
 *    自研 SDK）只需写一个 normalizer 即可复用同一套兜底逻辑。
 *  - 内置一个**自适配的 generic normalizer**：当你不确定 provider 用的是哪个字段时，
 *    它会从首个 chunk 自动嗅探 reasoning 字段名，无需为每个厂商硬编码。
 *  - `pickVisibleText` 在 content 为空但 reasoning 非空时，自动降级到 reasoning（清掉 think 标签）。
 *  - `EmptyStreamContentError` 让上层能区分「真正失败」和「模型没出文本」两种语义。
 */

/* ------------------------------------------------------------------ *
 * 1. Provider-agnostic chunk 形态                                    *
 * ------------------------------------------------------------------ */

export type NormalToolCall = {
  /** stream 里 tool_calls 的 index（同一 index 跨 chunk 累积） */
  index: number;
  /** tool call id；中途可能为 null（由调用方决定兜底） */
  id?: string | null;
  /** 函数名 */
  name?: string;
  /** 增量参数（arguments JSON 字符串片段） */
  argumentsChunk?: string;
};

/** 与具体 SDK 解耦的流式 chunk 形态。每个 provider 的 normalizer 把原生 chunk 映射到这里。 */
export type NormalChatChunk = {
  /** 正式回复文本增量（不包含思考过程） */
  content?: string;
  /** 思考/推理过程文本增量；可来自 reasoning_content / reasoning / thinking 等任意字段 */
  reasoning?: string;
  /** 流最后的 finish_reason；普通模式下通常 "stop" / "length" / "tool_calls" / "content_filter" */
  finishReason?: string | null;
  /** 工具调用增量；空数组 = 无 */
  toolCalls?: NormalToolCall[];
};

/* ------------------------------------------------------------------ *
 * 2. 核心 consumer（provider-agnostic）                               *
 * ------------------------------------------------------------------ */

export type StreamConsumeOptions = {
  /** 每收到一段 content delta 触发；不传则只在 `pickVisibleText` 后统一推最终文本 */
  onContentDelta?: (delta: string) => void;
  /** 工具调用累积完成时触发（按 index 升序逐个调用） */
  onToolCallsComplete?: (calls: NormalToolCall[]) => void;
  /** 是否打印「content 为空、reasoning 兜底」等诊断日志。默认 true；`STREAM_CHAT_HELPERS_DEBUG=0` 关闭 */
  debug?: boolean;
  /** 标识 provider（"moonshot-kimi" / "openai" / "failover" / "anthropic" …） */
  providerId?: string;
  /** 标识 model，方便日志排错 */
  model?: string;
  /**
   * 两个 chunk 之间的最大空闲时间（毫秒）。超过则中断流并抛出 `StreamIdleTimeoutError`。
   * 默认从环境变量 `STREAM_IDLE_TIMEOUT_MS` 读取，未设则 30000ms。
   * 设为 0 可禁用。
   */
  idleTimeoutMs?: number;
};

export type StreamConsumeResult = {
  /** 累计的正式回复 content（原始，未 trim） */
  content: string;
  /** 累计的 reasoning（原始，未去 think 标签） */
  reasoning: string;
  /** 流最后给出的 finish_reason */
  finishReason: string | null;
  /** 累计到的 tool_calls（按 index 升序） */
  toolCalls: NormalToolCall[];
};

const REASONING_FALLBACK_LOG_PREFIX = "[stream-chat]";

/** 默认 chunk 间空闲超时：30s 无新 chunk 则判定流卡死。可用 `STREAM_IDLE_TIMEOUT_MS` 覆盖。 */
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;

function resolveIdleTimeoutMs(explicit?: number): number {
  if (typeof explicit === "number") return explicit;
  const env = process.env.STREAM_IDLE_TIMEOUT_MS;
  if (env) {
    const n = Number.parseInt(env, 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return DEFAULT_IDLE_TIMEOUT_MS;
}

function isDebugEnabled(opt?: boolean): boolean {
  if (opt === false) return false;
  const env = process.env.STREAM_CHAT_HELPERS_DEBUG;
  if (env === "0" || env === "false") return false;
  return true;
}

/**
 * 流式响应中两个 chunk 之间空闲超时（网络半开 / 模型卡住 / 代理中断但未关流）。
 * 抛出后上层可走 failover / 兜底文案，而不是干等到 OpenAI SDK 的 10 分钟默认超时。
 */
export class StreamIdleTimeoutError extends Error {
  readonly providerId?: string;
  readonly model?: string;
  readonly idleMs: number;
  readonly partialContent: string;

  constructor(params: {
    providerId?: string;
    model?: string;
    idleMs: number;
    partialContent: string;
  }) {
    super(
      `Stream idle timeout: no chunk for ${params.idleMs}ms ` +
        `(provider=${params.providerId ?? "?"} model=${params.model ?? "?"} ` +
        `partial_bytes=${params.partialContent.length})`,
    );
    this.name = "StreamIdleTimeoutError";
    this.providerId = params.providerId;
    this.model = params.model;
    this.idleMs = params.idleMs;
    this.partialContent = params.partialContent;
  }
}

/**
 * 消费一段 provider-agnostic 的流，自动处理：
 *  - content / reasoning 累积；
 *  - tool_calls 跨 chunk 累积（按 index 合并）；
 *  - finish_reason 取最后一个非空值；
 *  - **chunk 间空闲超时**：超过 `idleTimeoutMs` 无新 chunk 则抛 `StreamIdleTimeoutError`，
 *    避免网络半开 / 模型卡住时干等 OpenAI SDK 默认 10 分钟超时。
 *
 * 这个函数**不**关心来源是 OpenAI / Anthropic / 自研 SDK，只看 NormalChatChunk 形态。
 */
export async function consumeNormalizedStream(
  source: AsyncIterable<NormalChatChunk>,
  options: StreamConsumeOptions = {},
): Promise<StreamConsumeResult> {
  let content = "";
  let reasoning = "";
  let finishReason: string | null = null;
  const toolAccByIndex = new Map<number, NormalToolCall>();

  const idleMs = resolveIdleTimeoutMs(options.idleTimeoutMs);
  const useIdleGuard = idleMs > 0;

  // 把 AsyncIterable 包装成「带空闲超时的 iterator」。
  // 每次取下一个 chunk 时用 Promise.race 让「下一个 chunk」与「超时定时器」竞速。
  // 超时则抛 StreamIdleTimeoutError，携带已累积的 partial content 供上层兜底。
  const iterator = source[Symbol.asyncIterator]();

  try {
    while (true) {
      const nextPromise = iterator.next();
      let result: IteratorResult<NormalChatChunk>;

      if (useIdleGuard) {
        let timer: NodeJS.Timeout | undefined;
        try {
          result = await Promise.race<IteratorResult<NormalChatChunk>>([
            nextPromise,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () =>
                  reject(
                    new StreamIdleTimeoutError({
                      providerId: options.providerId,
                      model: options.model,
                      idleMs,
                      partialContent: content,
                    }),
                  ),
                idleMs,
              );
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      } else {
        result = await nextPromise;
      }

      if (result.done) break;
      const chunk = result.value;

      if (chunk.content && chunk.content.length > 0) {
        content += chunk.content;
        options.onContentDelta?.(chunk.content);
      }
      if (chunk.reasoning && chunk.reasoning.length > 0) {
        reasoning += chunk.reasoning;
      }
      if (chunk.finishReason != null) {
        finishReason = chunk.finishReason;
      }
      if (chunk.toolCalls && chunk.toolCalls.length > 0) {
        for (const tc of chunk.toolCalls) {
          const idx = typeof tc.index === "number" ? tc.index : 0;
          let acc = toolAccByIndex.get(idx);
          if (!acc) {
            acc = { index: idx };
            toolAccByIndex.set(idx, acc);
          }
          if (tc.id != null) acc.id = tc.id;
          if (tc.name) acc.name = tc.name;
          if (tc.argumentsChunk) acc.argumentsChunk = (acc.argumentsChunk ?? "") + tc.argumentsChunk;
        }
      }
    }
  } finally {
    // 确保底层 iterator 被释放（尤其是超时中断后，避免底层 HTTP 流泄漏）
    try {
      await iterator.return?.();
    } catch {
      // ignore
    }
  }

  const toolCalls: NormalToolCall[] = [...toolAccByIndex.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => v);
  if (toolCalls.length > 0) {
    options.onToolCallsComplete?.(toolCalls);
  }

  const debug = isDebugEnabled(options.debug);
  if (debug && !content.trim() && reasoning.trim()) {
    // eslint-disable-next-line no-console
    console.info(
      `${REASONING_FALLBACK_LOG_PREFIX} provider=${options.providerId ?? "?"} ` +
        `model=${options.model ?? "?"} content=empty, reasoning_len=${reasoning.length} ` +
        `→ will fall back to reasoning as visible text`,
    );
  }

  return { content, reasoning, finishReason, toolCalls };
}

/* ------------------------------------------------------------------ *
 * 3. 可见文本选择 + think-tag 清理                                    *
 * ------------------------------------------------------------------ */

/**
 * 清理 reasoning 中的 `<thinking>…</thinking>` / `<think>…</think>` 包裹（Kimi K2.5、DeepSeek-R1
 * 的 reasoning 经常把正式答案也写在 reasoning 里，外面包一层 think 标签）。
 * 同时把多余的空白行合并。
 */
export function stripThinkTags(reasoning: string): string {
  if (!reasoning) return "";
  let cleaned = reasoning;
  // 闭合标签包裹（think/thinging/reasoning）
  cleaned = cleaned.replace(/<\s*\/?\s*(?:think(?:ing)?|reasoning)\s*>/gi, "");
  // 处理未闭合的 <think>（部分模型在 reasoning 末尾忘了闭合）
  cleaned = cleaned.replace(/<\s*think(?:ing)?\s*>/gi, "");
  // 收尾的多余换行
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n");
  return cleaned.trim();
}

/**
 * 决定「对外展示什么文本」。
 * 规则（按顺序）：
 *  1. 若 `content.trim()` 非空：返回 content（已经是最终态）。
 *  2. 若 `content` 为空但 `reasoning` 非空：清洗掉 think 标签后返回 reasoning。
 *     这是关键兜底：思考模型经常把「思考过程 + 正式答案」都写进 reasoning，外面包 think 标签。
 *  3. 两者都为空：返回空串（让上层走 EmptyStreamContentError）。
 */
export function pickVisibleText(
  content: string,
  reasoning: string,
): string {
  const c = content.trim();
  if (c) return content;
  const r = reasoning.trim();
  if (!r) return "";
  return stripThinkTags(reasoning);
}

/* ------------------------------------------------------------------ *
 * 4. 兜底异常                                                        *
 * ------------------------------------------------------------------ */

export class EmptyStreamContentError extends Error {
  readonly providerId?: string;
  readonly model?: string;
  readonly finishReason: string | null;
  readonly reasoningBytes: number;
  readonly hadToolCalls: boolean;

  constructor(params: {
    providerId?: string;
    model?: string;
    finishReason: string | null;
    reasoningBytes: number;
    hadToolCalls: boolean;
  }) {
    super(
      `Empty streamed content (provider=${params.providerId ?? "?"} ` +
        `model=${params.model ?? "?"} finish_reason=${params.finishReason ?? "?"} ` +
        `reasoning_bytes=${params.reasoningBytes} tool_calls=${params.hadToolCalls})`,
    );
    this.name = "EmptyStreamContentError";
    this.providerId = params.providerId;
    this.model = params.model;
    this.finishReason = params.finishReason;
    this.reasoningBytes = params.reasoningBytes;
    this.hadToolCalls = params.hadToolCalls;
  }
}

/**
 * 一站式工具：消费流 → 决定可见文本 → 若空抛 EmptyStreamContentError。
 * 任何 provider 的非工具聊天路径都可以直接用这个，省掉重复 try/catch + 兜底模板。
 */
export async function consumeAndPickVisibleText(
  source: AsyncIterable<NormalChatChunk>,
  options: StreamConsumeOptions = {},
): Promise<{ text: string; result: StreamConsumeResult }> {
  const result = await consumeNormalizedStream(source, options);
  const text = pickVisibleText(result.content, result.reasoning);
  if (!text) {
    throw new EmptyStreamContentError({
      providerId: options.providerId,
      model: options.model,
      finishReason: result.finishReason,
      reasoningBytes: result.reasoning.length,
      hadToolCalls: result.toolCalls.length > 0,
    });
  }
  return { text, result };
}

/* ------------------------------------------------------------------ *
 * 5. Normalizer adapters                                             *
 * ------------------------------------------------------------------ */

/**
 * 把任意 plain object 形态的 chunk 适配成 NormalChatChunk 的「自适配」工厂。
 *
 * 工作机制：从首个非空 chunk 里**嗅探**出 content / reasoning / tool_calls / finish_reason
 * 实际使用的字段名（按下面的优先级匹配），然后用嗅探到的字段名去映射后续所有 chunk。
 * 之后再来新字段名也不会再切换。
 *
 * 嗅探优先级（reasoning 候选）：
 *   `reasoning_content` → `reasoning_text` → `reasoning` → `thinking` → `thinking_content` →
 *   `redacted_thinking` → `reasoning_delta`
 * 嗅探优先级（content 候选）：
 *   `content` → `text` → `delta` → `message`
 * 嗅探优先级（tool_calls 候选）：
 *   `tool_calls` → `tool_use` → `function_call` → `tool_call_delta`
 * 嗅探优先级（finish_reason 候选）：
 *   `finish_reason` → `stop_reason` → `finishReason`
 *
 * 适用场景：你不确定第三方代理 / 新厂商用的是哪个字段名。
 */
const REASONING_FIELD_CANDIDATES = [
  "reasoning_content",
  "reasoning_text",
  "reasoning",
  "thinking",
  "thinking_content",
  "redacted_thinking",
  "reasoning_delta",
] as const;
const CONTENT_FIELD_CANDIDATES = ["content", "text", "delta", "message"] as const;
const TOOL_CALL_FIELD_CANDIDATES = [
  "tool_calls",
  "tool_use",
  "function_call",
  "tool_call_delta",
] as const;
const FINISH_REASON_FIELD_CANDIDATES = [
  "finish_reason",
  "stop_reason",
  "finishReason",
] as const;

type GenericSourceChunk = {
  choices?: Array<{
    delta?: Record<string, unknown>;
    finish_reason?: string | null;
  }>;
} & Record<string, unknown>;

function pickField(
  obj: Record<string, unknown>,
  candidates: readonly string[],
): string | null {
  for (const k of candidates) {
    if (k in obj && obj[k] != null) return k;
  }
  return null;
}

/**
 * 「自适配」normalizer：从首个非空 chunk 嗅探字段名后再做映射。
 * 强烈推荐用在不确定厂商字段名的场景（例如自建代理、第三方转发）。
 */
export function createAdaptiveNormalizer() {
  let resolved:
    | {
        contentField: string;
        reasoningField: string | null;
        toolCallField: string | null;
        finishReasonField: string | null;
      }
    | null = null;

  function resolveOnce(chunk: GenericSourceChunk): typeof resolved {
    if (resolved) return resolved;
    // 优先从 choices[0].delta 里找（OpenAI / Anthropic / Moonshot 都在这里）
    const delta = (chunk.choices?.[0]?.delta ?? {}) as Record<string, unknown>;
    const finishReasonDelta = chunk.choices?.[0]?.finish_reason;
    const finishReasonRoot = pickField(chunk, FINISH_REASON_FIELD_CANDIDATES);

    // content：在 delta 里找第一个 string-typed candidate
    let contentField: string | null = null;
    for (const k of CONTENT_FIELD_CANDIDATES) {
      if (typeof delta[k] === "string" && (delta[k] as string).length > 0) {
        contentField = k;
        break;
      }
    }
    if (!contentField) {
      // 没找到就降级：把 delta 上 string-typed 的字段挨个试
      for (const k of Object.keys(delta)) {
        if (typeof delta[k] === "string" && k !== "role") {
          contentField = k;
          break;
        }
      }
    }

    // reasoning：嗅探后存为字段名
    const reasoningField = pickField(delta, REASONING_FIELD_CANDIDATES);

    // tool_calls：嗅探数组
    let toolCallField: string | null = null;
    for (const k of TOOL_CALL_FIELD_CANDIDATES) {
      if (Array.isArray(delta[k])) {
        toolCallField = k;
        break;
      }
    }

    // finish_reason：先看 choices[0]，再看根
    const finishReasonField =
      finishReasonDelta != null
        ? null // 直接从 choices[0].finish_reason 读，无需字段名
        : finishReasonRoot;

    resolved = {
      contentField: contentField ?? "content",
      reasoningField,
      toolCallField,
      finishReasonField,
    };
    return resolved;
  }

  function adapt(chunk: GenericSourceChunk): NormalChatChunk | null {
    if (!chunk || typeof chunk !== "object") return null;
    const fields = resolveOnce(chunk);
    if (!fields) return null;
    const delta = (chunk.choices?.[0]?.delta ?? {}) as Record<string, unknown>;
    const choiceFinish = chunk.choices?.[0]?.finish_reason;

    const out: NormalChatChunk = {};

    const c = delta[fields.contentField];
    if (typeof c === "string" && c.length > 0) out.content = c;

    if (fields.reasoningField) {
      const r = delta[fields.reasoningField];
      if (typeof r === "string" && r.length > 0) out.reasoning = r;
    }

    if (fields.toolCallField) {
      const tcs = delta[fields.toolCallField];
      if (Array.isArray(tcs)) {
        out.toolCalls = (tcs as Array<Record<string, unknown>>).map((tc, i) => {
          const fn =
            (tc.function as Record<string, unknown> | undefined) ??
            (tc as Record<string, unknown>);
          return {
            index: typeof tc.index === "number" ? (tc.index as number) : i,
            id: (tc.id as string | null | undefined) ?? null,
            name: typeof fn.name === "string" ? (fn.name as string) : undefined,
            argumentsChunk:
              typeof fn.arguments === "string" ? (fn.arguments as string) : undefined,
          };
        });
      }
    }

    if (choiceFinish != null) {
      out.finishReason = String(choiceFinish);
    } else if (fields.finishReasonField) {
      const fr = chunk[fields.finishReasonField];
      if (typeof fr === "string" && fr.length > 0) out.finishReason = fr;
    }

    return out;
  }

  return { adapt, peek: () => resolved };
}

/* ------------------------------------------------------------------ *
 * 6. OpenAI 兼容 Chat Completions 专用 normalizer                     *
 * ------------------------------------------------------------------ */

import type OpenAI from "openai";
import type {
  ChatCompletionChunk,
  ChatCompletionMessageToolCall,
} from "openai/resources/chat/completions";

/**
 * 把一个 OpenAI ChatCompletionChunk 适配成 NormalChatChunk。
 * 直接用 ChatCompletionChunk 类型，避免 any。
 */
export function adaptOpenAiChatCompletionChunk(
  chunk: ChatCompletionChunk,
): NormalChatChunk | null {
  const choice = chunk.choices?.[0];
  if (!choice) return null;
  const out: NormalChatChunk = {};

  if (typeof choice.finish_reason === "string") {
    out.finishReason = choice.finish_reason;
  }

  const delta = choice.delta as
    | (Record<string, unknown> & {
        content?: string | null;
        tool_calls?: Array<{
          index?: number;
          id?: string | null;
          function?: { name?: string; arguments?: string };
        }>;
      })
    | null
    | undefined;
  if (!delta) return out;

  if (typeof delta.content === "string" && delta.content.length > 0) {
    out.content = delta.content;
  }

  // 嗅探 reasoning 字段（OpenAI 标准没有，但 Moonshot/DeepSeek 扩展为 reasoning_content）
  const rc =
    (delta as { reasoning_content?: unknown }).reasoning_content ??
    (delta as { reasoning?: unknown }).reasoning ??
    (delta as { thinking?: unknown }).thinking;
  if (typeof rc === "string" && rc.length > 0) {
    out.reasoning = rc;
  }

  if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
    out.toolCalls = delta.tool_calls.map((tc, i) => ({
      index: typeof tc.index === "number" ? tc.index : i,
      id: tc.id ?? null,
      name: tc.function?.name,
      argumentsChunk: tc.function?.arguments,
    }));
  }

  return out;
}

/**
 * 把 OpenAI ChatCompletionChunk 流整条适配成 NormalChatChunk 流。
 * 这是最常用的入口：直接喂给 `consumeNormalizedStream` / `consumeAndPickVisibleText`。
 */
export async function* adaptOpenAiChatCompletionStream(
  source: AsyncIterable<ChatCompletionChunk>,
): AsyncIterable<NormalChatChunk> {
  for await (const chunk of source) {
    const n = adaptOpenAiChatCompletionChunk(chunk);
    if (n) yield n;
  }
}

/**
 * 把 NormalToolCall[] 物化为 OpenAI SDK 期望的 ChatCompletionMessageToolCall[] 形态。
 * 给那些仍然需要 SDK 类型（mongo 持久化 / protocol 序列化）的旧调用方使用。
 */
export function materializeOpenAiToolCalls(
  toolCalls: NormalToolCall[],
  model?: string,
): ChatCompletionMessageToolCall[] {
  return toolCalls.map((v, idx) => {
    let parsedArgs: Record<string, unknown> = {};
    const args = v.argumentsChunk ?? "";
    if (args) {
      try {
        const obj = JSON.parse(args);
        if (obj && typeof obj === "object" && !Array.isArray(obj)) {
          parsedArgs = obj as Record<string, unknown>;
        }
      } catch {
        // 半截 JSON 时保留空对象
      }
    }
    if (!v.id) {
      // eslint-disable-next-line no-console
      console.warn(
        `[openai-tool-loop] tool_calls[${idx}].id is empty from stream; ` +
          `fallback to random id. model=${model ?? "?"} name=${v.name ?? "?"}`,
      );
    }
    const callId =
      v.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${idx}`;
    return {
      id: callId,
      type: "function" as const,
      function: {
        name: v.name ?? "",
        arguments: args || "{}",
      },
      ...({ parsedArgs } as object),
    } as ChatCompletionMessageToolCall & { parsedArgs: Record<string, unknown> };
  });
}
