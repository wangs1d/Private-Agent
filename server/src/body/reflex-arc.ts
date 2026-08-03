// Agent Body Center —— ReflexArc 反射弧（身体侧硬安全门）
//
// 职责：在动作执行前做硬规则匹配，作为 LimbicCortex（脑侧软安全）的兜底。
// 纯规则匹配（正则 + 子串），绝不调用 LLM，保证最低延迟与最高确定性。
// 命中 deny 直接拒绝；命中 high_risk 默认拒绝（fail-closed，与 LimbicCortex 一致）。
//
// 设计原则：
//   1. builtin patterns 不可删除（构造时初始化），user patterns 可热加载/移除。
//   2. 字符串 pattern 子串匹配（忽略大小写）；RegExp pattern 调用 .test()。
//   3. tool 字段限定：若 pattern.tool 指定，仅当 action.tool 以 pattern.tool 开头时才检查。
//   4. 匹配范围：action.args 中所有字符串值（递归搜索嵌套对象/数组）。
//   5. 审计：拒绝事件输出到 stderr + console.error，含 ISO 时间戳。
//
// 与 brain/limbic-cortex.ts 互补：
//   - LimbicCortex：脑侧软安全，可委托 AgentTaskSafety（结构化语义规则）
//   - ReflexArc：身体侧硬安全门，纯字符串/正则，最低延迟，最后一道闸门

import type { ReflexVerdict } from "./types.js";

/** 反射弧危险模式定义 */
export interface ReflexPattern {
  /** 唯一 id（builtin 用 "builtin:xxx"，user 用 "user:xxx" 或自定义） */
  id: string;
  /** 匹配模式：字符串（子串匹配，忽略大小写）或 RegExp */
  pattern: string | RegExp;
  /** 限定 tool 前缀，如 "desktop.run_shell"；未指定则对所有 tool 生效 */
  tool?: string;
  /** 命中后的拒绝理由 */
  reason: string;
  /** 严重程度：deny 直接拒绝，high_risk 默认拒绝（需审批） */
  severity: "deny" | "high_risk";
  /** 来源：builtin 不可删除，user 可删 */
  source: "builtin" | "user";
}

/** ReflexArc 对外最小化接口（结构兼容即可） */
export interface ReflexArcLike {
  check(action: { tool: string; args: Record<string, unknown> }): ReflexVerdict;
  registerPattern(pattern: ReflexPattern): void;
  listPatterns(): ReflexPattern[];
  /** 审计日志：拒绝事件写入日志（含 actorId / tool / args / reason / timestamp） */
  audit?(
    action: { tool: string; args: Record<string, unknown>; actorId?: string },
    verdict: ReflexVerdict,
    actorId?: string,
  ): void;
}

// ---- 内置危险模式（与 brain/limbic-cortex.ts DENY_PATTERNS 风格一致）---------
//
// builtin patterns 使用 RegExp（与 LimbicCortex 保持一致），source 标记 "builtin"，
// 构造时一次性灌入，运行期不可移除（removePattern 对 builtin 返回 false）。

/** 内置绝对禁止模式（命中即 deny） */
const BUILTIN_DENY_PATTERNS: ReflexPattern[] = [
  // Linux/Mac 递归强制删除：rm -rf / rm -rf / / rm -rf C:\ / rm -rf ~ / rm -rf *
  {
    id: "builtin:rm_rf",
    pattern: /\brm\s+-rf\b/i,
    reason: "递归强制删除命令 rm -rf",
    severity: "deny",
    source: "builtin",
  },
  // 格式化（含 format C:）
  {
    id: "builtin:format",
    pattern: /\bformat(\s+[a-z]:)?\b/i,
    reason: "格式化磁盘命令 format",
    severity: "deny",
    source: "builtin",
  },
  // 关机/重启：shutdown / shutdown /s / shutdown /r
  {
    id: "builtin:shutdown",
    pattern: /\bshutdown\b/i,
    reason: "关机/重启命令 shutdown",
    severity: "deny",
    source: "builtin",
  },
  // Windows 递归删除：del /s / del /f /s /q
  {
    id: "builtin:del_recursive",
    pattern: /\bdel\s+\/[fs]/i,
    reason: "Windows 递归删除 del /s|/f",
    severity: "deny",
    source: "builtin",
  },
  // Windows 递归删除目录：rd /s /q / rmdir /s
  {
    id: "builtin:rd_rmdir_recursive",
    pattern: /\b(rd|rmdir)\s+\/s/i,
    reason: "Windows 递归删除目录 rd/rmdir /s",
    severity: "deny",
    source: "builtin",
  },
  // 注册表删除
  {
    id: "builtin:reg_delete",
    pattern: /\breg\s+delete\b/i,
    reason: "注册表删除 reg delete",
    severity: "deny",
    source: "builtin",
  },
  // 注册表强制写入：reg add ... /f
  {
    id: "builtin:reg_add_force",
    pattern: /\breg\s+add\b.*\/f\b/i,
    reason: "注册表强制写入 reg add /f",
    severity: "deny",
    source: "builtin",
  },
  // 取得所有权 / 修改权限
  {
    id: "builtin:takeown",
    pattern: /\btakeown\b/i,
    reason: "夺取文件所有权 takeown",
    severity: "deny",
    source: "builtin",
  },
  {
    id: "builtin:icacls",
    pattern: /\bicacls\b/i,
    reason: "修改文件权限 icacls",
    severity: "deny",
    source: "builtin",
  },
  // 启动配置修改
  {
    id: "builtin:bcdedit",
    pattern: /\bbcdedit\b/i,
    reason: "修改启动配置 bcdedit",
    severity: "deny",
    source: "builtin",
  },
  // 磁盘分区脚本
  {
    id: "builtin:diskpart",
    pattern: /\bdiskpart\b/i,
    reason: "磁盘分区脚本 diskpart",
    severity: "deny",
    source: "builtin",
  },
  // 用户/用户组管理：net user / net localgroup
  {
    id: "builtin:net_user",
    pattern: /\bnet\s+(user|localgroup)\b/i,
    reason: "用户/用户组管理 net user/localgroup",
    severity: "deny",
    source: "builtin",
  },
  // PowerShell Base64 编码执行（常见绕过检测）
  {
    id: "builtin:powershell_enc",
    pattern: /\bpowershell\b.*-enc(od(?:edcommand)?)?\b/i,
    reason: "PowerShell Base64 编码执行（绕过检测）",
    severity: "deny",
    source: "builtin",
  },
  // fork bomb 进程炸弹：:(){:|:&};:
  {
    id: "builtin:fork_bomb",
    pattern: /\:\s*\(\s*\)\s*\{\s*\:\s*\|\s*\:\s*&\s*\}\s*;\s*\:/i,
    reason: "fork bomb 进程炸弹",
    severity: "deny",
    source: "builtin",
  },
  // 路径穿越：../
  {
    id: "builtin:path_traversal",
    pattern: /\.\.[\/\\]/i,
    reason: "路径穿越 ../ 或 ..\\",
    severity: "deny",
    source: "builtin",
  },
  // 系统敏感文件：etc/passwd / etc/shadow / /etc/ / system32
  {
    id: "builtin:system_files",
    pattern: /etc\/passwd|etc\/shadow|\/etc\/|windows[\/\\]system32|[\/\\]system32[\/\\]/i,
    reason: "访问系统敏感文件（etc/passwd / system32 等）",
    severity: "deny",
    source: "builtin",
  },
  // prompt injection：ignore previous / ignore all previous / disregard prior
  {
    id: "builtin:prompt_injection",
    pattern: /ignore\s+(all\s+)?previous|disregard\s+prior/i,
    reason: "prompt injection：试图忽略先前指令",
    severity: "deny",
    source: "builtin",
  },
  // 代码注入：child_process / exec( / system( / eval( / Function(
  {
    id: "builtin:code_injection",
    pattern: /child_process|exec\s*\(|system\s*\(|eval\s*\(|Function\s*\(/i,
    reason: "代码注入：child_process / exec / system / eval / Function",
    severity: "deny",
    source: "builtin",
  },
];

/** 内置高风险模式（命中即 high_risk，默认拒绝，需人工审批） */
const BUILTIN_HIGH_RISK_PATTERNS: ReflexPattern[] = [
  // cmd /c 包装外部命令（高危）
  {
    id: "builtin:cmd_c",
    pattern: /\bcmd\s+\/c\b/i,
    reason: "cmd /c 执行外部命令（高风险）",
    severity: "high_risk",
    source: "builtin",
  },
  // wget/curl 拉取外部脚本（高危）
  {
    id: "builtin:curl_wget",
    pattern: /\b(curl|wget)\b/i,
    reason: "curl/wget 拉取外部脚本（高风险）",
    severity: "high_risk",
    source: "builtin",
  },
];

// ---- 辅助函数 ---------------------------------------------------------

/** 当前 ISO 时间戳 */
function nowIso(): string {
  return new Date().toISOString();
}

/** 把任意值安全序列化为字符串（循环引用/异常时退化为 String()） */
function safeStringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * 递归收集 args 中所有字符串值。
 *
 * 遍历嵌套对象/数组，把所有 string 类型值收集到 sink 中，
 * 用于后续对每个字符串做 pattern 匹配。
 */
function collectStringValues(value: unknown, sink: string[]): void {
  if (typeof value === "string") {
    sink.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) {
      collectStringValues(item, sink);
    }
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) {
      collectStringValues(v, sink);
    }
  }
}

// ---- ReflexArc 主类 ----------------------------------------------------

/**
 * 反射弧：身体侧硬安全门。
 *
 * 与 LimbicCortex（脑侧软安全）互补：
 *   - LimbicCortex 可调用 LLM 做语义安全审查（柔性）
 *   - ReflexArc 纯规则匹配，无 LLM，最低延迟、最高确定性（硬性）
 *
 * 命中策略（fail-closed，与 LimbicCortex 一致）：
 *   - deny severity → 直接 verdict=deny
 *   - high_risk severity → verdict=deny（默认拒绝，需人工审批才能放行）
 *   - 未命中 → verdict=allow
 *
 * builtin patterns 不可删除；user patterns 可通过 registerPattern 热加载、
 * 通过 removePattern 移除。
 */
export class ReflexArc implements ReflexArcLike {
  /** 全部 patterns：builtin + user（按注册顺序） */
  private readonly patterns: ReflexPattern[] = [];
  /** 已注册 id 集合，避免重复注册 */
  private readonly ids = new Set<string>();

  constructor() {
    // builtin patterns 一次性灌入，运行期不可移除
    for (const p of BUILTIN_DENY_PATTERNS) {
      this.patterns.push({ ...p });
      this.ids.add(p.id);
    }
    for (const p of BUILTIN_HIGH_RISK_PATTERNS) {
      this.patterns.push({ ...p });
      this.ids.add(p.id);
    }
  }

  /**
   * 检查单次动作是否安全。
   *
   * 纯规则匹配，绝不调用 LLM。遍历所有 patterns（builtin + user），
   * 按 tool 前缀过滤后对 args 的所有字符串值做匹配。
   *
   * 命中任一 pattern 即返回 deny：
   *   - deny severity → 直接拒绝
   *   - high_risk severity → fail-closed 拒绝（reason 标注需审批）
   * 未命中返回 allow。
   */
  check(action: { tool: string; args: Record<string, unknown> }): ReflexVerdict {
    const tool = action.tool ?? "";
    const args = action.args ?? {};
    // 收集 args 中所有字符串值（递归嵌套对象/数组）
    const strings: string[] = [];
    collectStringValues(args, strings);

    for (const p of this.patterns) {
      // tool 字段限定：若 pattern.tool 指定，仅当 action.tool 以其开头才检查
      if (p.tool && !tool.startsWith(p.tool)) {
        continue;
      }
      if (this.matchPattern(p, strings)) {
        if (p.severity === "deny") {
          return {
            verdict: "deny",
            reason: p.reason,
            matchedPattern: p.id,
            severity: "deny",
          };
        }
        // high_risk: fail-closed，默认拒绝，需人工审批
        return {
          verdict: "deny",
          reason: "high_risk operation requires approval",
          matchedPattern: p.id,
          severity: "high_risk",
        };
      }
    }
    return { verdict: "allow" };
  }

  /**
   * 单个 pattern 对一组字符串的匹配。
   *
   * - 字符串 pattern：子串匹配（忽略大小写）
   * - RegExp pattern：调用 .test()，g 标志时每次 reset lastIndex
   *
   * 任一字符串命中即视为命中该 pattern。
   */
  private matchPattern(p: ReflexPattern, strings: string[]): boolean {
    if (typeof p.pattern === "string") {
      const needle = p.pattern.toLowerCase();
      for (const s of strings) {
        if (s && s.toLowerCase().includes(needle)) {
          return true;
        }
      }
      return false;
    }
    const re = p.pattern;
    const isGlobal = re.flags.includes("g");
    for (const s of strings) {
      if (!s) continue;
      if (isGlobal) re.lastIndex = 0;
      if (re.test(s)) return true;
    }
    return false;
  }

  /**
   * 热加载新危险模式。
   *
   * source 强制设为 "user"（builtin 只能构造时灌入）。
   * id 重复时跳过（幂等，便于热加载调用方重试）。
   */
  registerPattern(pattern: ReflexPattern): void {
    const p: ReflexPattern = { ...pattern, source: "user" };
    if (this.ids.has(p.id)) {
      // id 重复：跳过（幂等）
      return;
    }
    this.patterns.push(p);
    this.ids.add(p.id);
  }

  /** 列出所有 patterns（builtin + user），返回浅拷贝避免外部篡改 */
  listPatterns(): ReflexPattern[] {
    return this.patterns.map((p) => ({ ...p }));
  }

  /**
   * 移除指定 id 的 pattern。
   *
   * 仅允许删除 source="user" 的 pattern；builtin 不可删（返回 false）。
   * id 不存在也返回 false。
   */
  removePattern(id: string): boolean {
    const idx = this.patterns.findIndex((p) => p.id === id);
    if (idx < 0) return false;
    if (this.patterns[idx].source === "builtin") return false;
    this.patterns.splice(idx, 1);
    this.ids.delete(id);
    return true;
  }

  /**
   * 审计日志：拒绝事件输出到 stderr + console.error。
   *
   * 格式：`[ReflexArc DENY] { timestamp, actorId, tool, argsPreview, reason, matchedPattern }`
   * argsPreview 截断到 120 字符，避免日志爆炸。
   *
   * 注：调用方负责仅在 verdict=deny 时调用；本方法不判断 verdict。
   *
   * @param action 动作描述（含 tool/args/actorId）
   * @param verdict 反射弧判定结果（deny 时携带 reason/matchedPattern）
   * @param actorId 触发该动作的 actor id（可选；优先取 action.actorId，再取本参数）
   */
  audit(
    action: { tool: string; args: Record<string, unknown>; actorId?: string },
    verdict: ReflexVerdict,
    actorId?: string,
  ): void {
    const resolvedActorId = action.actorId ?? actorId ?? "";
    const entry = {
      timestamp: nowIso(),
      actorId: resolvedActorId,
      tool: action.tool ?? "",
      argsPreview: safeStringify(action.args ?? {}).slice(0, 120),
      reason: verdict.reason ?? "",
      matchedPattern: verdict.matchedPattern ?? "",
    };
    const line = `[ReflexArc DENY] ${JSON.stringify(entry)}`;
    // stderr + console.error 双通道，确保审计可见
    process.stderr.write(line + "\n");
    console.error(line);
  }
}
