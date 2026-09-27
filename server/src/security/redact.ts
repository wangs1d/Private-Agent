/**
 * 凭据脱敏（2026-09-24，对标 Muse「agent 全程不可见密码/卡号」的本地落法）。
 *
 * 铁律：凭据只进执行层（Playwright 浏览器上下文 / HTTP 客户端签名），绝不进入
 * 模型上下文。本模块是最后一道保险：任何工具把错误消息/调试信息拼进返回值时，
 * 先过 redactCredentials——异常消息里偶尔会带请求头或 URL 查询串，不能赌它不带。
 *
 * 覆盖形态：Cookie/Set-Cookie 头整值、Authorization 头、URL/表单里的
 * password|token|secret|app_secret|access_token|sign 等键值。
 */

/** 单条脱敏规则：命中即把捕获组值替换为「前 4 位…」截断 */
const VALUE_PATTERNS: RegExp[] = [
  // Cookie / Set-Cookie 头整行（值可含分号分隔的多段，整段脱敏）
  /((?:set-)?cookie\s*[:=]\s*)([^\r\n]{8,})/gi,
  // Authorization 头整行（Bearer xxx / Basic xxx 整段脱敏）
  /(authorization\s*[:=]\s*)([^\r\n]{8,})/gi,
  // 查询串/表单键值对：password=xxx / access_token: xxx / app_secret=xxx …
  /((?:password|passwd|pwd|token|access[_-]?token|refresh[_-]?token|secret|app[_-]?secret|api[_-]?key|session[_-]?id)\s*[=:]\s*)([^\s&;,，；"']{6,})/gi,
];

/** 值截断保留头 4 位，足以对日志核对「是哪个值」但不足以还原凭据 */
function maskValue(value: string): string {
  const head = value.slice(0, 4);
  return `${head}…<redacted>`;
}

/** 脱敏任意文本（错误消息/调试串/工具返回值）。非字符串原样返回。 */
export function redactCredentials(input: string): string {
  let out = input;
  for (const re of VALUE_PATTERNS) {
    out = out.replace(re, (_m, prefix: string, value: string) => `${prefix}${maskValue(value)}`);
  }
  return out;
}

/**
 * 深度脱敏一个即将进入模型上下文的结构化返回值：
 * 字符串递归 redactCredentials，其余类型原样（数组/普通对象遍历，循环引用跳过）。
 */
export function redactDeep<T>(value: T, seen = new Set<unknown>()): T {
  if (typeof value === "string") return redactCredentials(value) as unknown as T;
  if (value == null || typeof value !== "object") return value;
  if (seen.has(value)) return value;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => redactDeep(item, seen)) as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = redactDeep(v, seen);
  }
  return out as T;
}
