// Fast-Complex 判定与交接：FastVerdict 结构化块解析。
// 设计：fast 回复在末尾附一段隐藏 JSON 块 `<<<verdict:{json}>>>`，
// 由服务端流式解析取出后剥离（不推给用户），用于：
//   - 判定本 turn 是否需要并行 complex（need_complex / difficulty）
//   - 产出要交给 complex 的封闭任务规范 task_spec
// 解析失败一律返回 null（回退既有路径），绝不阻塞。

export type FastVerdictDifficulty = "simple" | "needs_external" | "multi_step";

export interface FastTaskSpec {
  goal: string;
  expected_output?: string;
  constraints?: string;
  tool_hints?: string[];
  budget?: {
    max_tool_rounds?: number;
    max_llm_calls?: number;
  };
}

export interface FastVerdict {
  need_complex: boolean;
  difficulty: FastVerdictDifficulty;
  task_spec?: FastTaskSpec;
}

const OPEN_MARK = "<<<verdict:";
const CLOSE_MARK = ">>>";
// 悬停窗口：略小于 OPEN_MARK 长度，让跨分片的标记能够被完整识别。
// 常规正文不受影响（只悬停末尾 ≤MARK_LEN-1 字符），标记出现时整块吞掉。
const HOLD_SIZE = OPEN_MARK.length - 1;

/**
 * 流式尾部防漏 guard：包裹 fast 车道的 onAssistantDelta，
 * 让 `<<<verdict:{...}>>>` 块在 live 流上被识别并吞掉，绝不推给前端。
 * 常规正文近实时流出（末尾仅悬停 ≤10 字符）；无标记则 end() 时原样补发。
 */
export class VerdictStreamGuard {
  private buf = "";
  private inVerdict = false;
  private swallowed = false;

  constructor(private readonly emit: (delta: string) => void) {}

  /** 每个流式 delta 进入。 */
  push(delta: string): void {
    if (this.swallowed) return; // verdict 已闭合，吞掉其后任何内容
    this.buf += delta;

    if (this.inVerdict) {
      const closeIdx = this.buf.indexOf(CLOSE_MARK);
      if (closeIdx === -1) {
        this.buf = this.buf.slice(-CLOSE_MARK.length); // 只保留可能截断的闭合尾部
        return;
      }
      // 之后不应再有用户可见内容（verdict 位于回复末尾）
      this.swallowed = true;
      this.buf = "";
      return;
    }

    const markerIdx = this.buf.lastIndexOf(OPEN_MARK);
    if (markerIdx !== -1) {
      this.emit(this.buf.slice(0, markerIdx)); // 标记之前的正文照常流出
      this.buf = this.buf.slice(markerIdx); // 从标记处起拦截
      this.inVerdict = true;
      const closeIdx2 = this.buf.indexOf(CLOSE_MARK);
      if (closeIdx2 !== -1) {
        this.buf = this.buf.slice(closeIdx2 + CLOSE_MARK.length);
        this.swallowed = true;
        this.buf = "";
      }
      return;
    }

    // 无标记：流出除末尾悬停窗口外的全部，继续识别可能跨分片起头的标记。
    const flushLen = this.buf.length - HOLD_SIZE;
    if (flushLen > 0) {
      this.emit(this.buf.slice(0, flushLen));
      this.buf = this.buf.slice(flushLen);
    }
  }

  /** 流结束：补发悬停的尾部（无标记时为正常正文）。 */
  end(): void {
    if (this.swallowed) return;
    if (this.buf) this.emit(this.buf.trim());
    this.buf = "";
  }
}

/**
 * 从 fast 回复文本中剥离 FastVerdict 块（含其后的任意密接内容），返回对用户可见的正文。
 * 仅处理最后一个 `<<<verdict:`..`>>>` 段，其余正文原样保留。
 */
export function stripFastVerdictMarker(replyText: string): string {
  if (!replyText) return "";
  const openIdx = replyText.lastIndexOf(OPEN_MARK);
  if (openIdx === -1) return replyText;
  const contentStart = openIdx + OPEN_MARK.length;
  const closeIdx = replyText.indexOf(CLOSE_MARK, contentStart);
  if (closeIdx === -1) return replyText.slice(0, openIdx).trimEnd();
  return (replyText.slice(0, openIdx) + replyText.slice(closeIdx + CLOSE_MARK.length)).trim();
}

/**
 * 从 fast 回复文本中提取 FastVerdict。
 * - 找到最后一个 `<<<verdict:` 与紧跟的 `>>>` 之间的 JSON 并解析。
 * - 解析失败 / 结构不合法 / 未命中 → 返回 null。
 * @returns 合法 verdict；否则 null（调用方回退既有路径，不阻塞）
 */
export function parseFastVerdict(replyText: string): FastVerdict | null {
  if (!replyText) return null;
  const openIdx = replyText.lastIndexOf(OPEN_MARK);
  if (openIdx === -1) return null;
  const contentStart = openIdx + OPEN_MARK.length;
  const closeIdx = replyText.indexOf(CLOSE_MARK, contentStart);
  if (closeIdx === -1) return null;

  const raw = replyText.slice(contentStart, closeIdx).trim();
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    try {
      // 兼容 ```json ... ``` / ``` ... ``` 包裹
      const stripped = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
      parsed = JSON.parse(stripped);
    } catch {
      return null;
    }
  }

  return normalizeFastVerdict(parsed);
}

/** 校验并归一化结构，字段缺失时给出安全默认值。 */
export function normalizeFastVerdict(raw: unknown): FastVerdict | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;

  const needsComplex =
    typeof obj.need_complex === "boolean" ? obj.need_complex : false;
  const difficultyRaw = obj.difficulty;

  // 只有明确判为需要 external/多步，need_complex 才为真。
  const difficulty: FastVerdictDifficulty =
    difficultyRaw === "needs_external" || difficultyRaw === "multi_step"
      ? difficultyRaw
      : "simple";

  // difficulty 与 need_complex 相互强化：任一推进到 complex 即视为需要并行。
  const effectiveNeed =
    needsComplex || difficulty !== "simple";

  if (!effectiveNeed) {
    return { need_complex: false, difficulty };
  }

  const specRaw = obj.task_spec;
  const taskSpec: FastTaskSpec | undefined = normalizeTaskSpec(specRaw);
  // 明确要 complex 但没给任务规范 → 视为不可用，回退（交给既有 needsExternalInfoUpgrade 处理）
  if (!taskSpec || !taskSpec.goal) return null;

  return {
    need_complex: true,
    difficulty,
    task_spec: taskSpec,
  };
}

function normalizeTaskSpec(raw: unknown): FastTaskSpec | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.goal !== "string" || !obj.goal.trim()) return undefined;

  const budgetRaw = obj.budget;
  const budget: FastTaskSpec["budget"] =
    budgetRaw && typeof budgetRaw === "object"
      ? {
          max_tool_rounds:
            typeof (budgetRaw as Record<string, unknown>).max_tool_rounds === "number"
              ? Number((budgetRaw as Record<string, unknown>).max_tool_rounds)
              : undefined,
          max_llm_calls:
            typeof (budgetRaw as Record<string, unknown>).max_llm_calls === "number"
              ? Number((budgetRaw as Record<string, unknown>).max_llm_calls)
              : undefined,
        }
      : undefined;

  const hints = Array.isArray(obj.tool_hints)
    ? (obj.tool_hints as unknown[]).filter((h): h is string => typeof h === "string")
    : undefined;

  return {
    goal: obj.goal.trim(),
    expected_output:
      typeof obj.expected_output === "string" ? obj.expected_output : undefined,
    constraints:
      typeof obj.constraints === "string" ? obj.constraints : undefined,
    tool_hints: hints && hints.length > 0 ? hints : undefined,
    budget: budget && (budget.max_tool_rounds || budget.max_llm_calls) ? budget : undefined,
  };
}