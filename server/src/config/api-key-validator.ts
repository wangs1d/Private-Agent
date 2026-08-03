/**
 * 检测 OpenAI API key 是否是占位符/未配置的真实 key。
 * 返回 true 表示"看起来不是真 key"，应降级或禁用，不发请求。
 *
 * 防御场景：
 * - 留空 / 仅有空格
 * - 常见的占位符前缀（sk-placeholder-, your-key, replace-me 等）
 * - 长度 < 20（OpenAI key 至少 40+ 字符）
 * - 不以 "sk-" 开头（OpenAI 官方 key 标准前缀）
 *
 * 用法：
 *   if (isPlaceholderApiKey(process.env.OPENAI_API_KEY)) return null;
 */
export function isPlaceholderApiKey(apiKey: string | undefined | null): boolean {
  if (!apiKey) return true;
  const trimmed = apiKey.trim();
  if (!trimmed) return true;
  const lower = trimmed.toLowerCase();

  // 常见占位符模式（包含匹配，覆盖各种变体）
  const placeholderPatterns = [
    "sk-placeholder",
    "replace-me",
    "replace_me",
    "your-key",
    "your_key",
    "your-key-here",
    "xxxxx",
    "<your",
    "{your",
    "dummy",
    "fake",
    "example",
    "test-key",
    "test_key",
  ];
  for (const pattern of placeholderPatterns) {
    if (lower.includes(pattern)) return true;
  }

  // 长度防御：OpenAI key 至少 40+ 字符（保守取 20）
  if (trimmed.length < 20) return true;

  // 前缀防御：OpenAI 官方 key 以 "sk-" 开头
  // 其他兼容端点（Azure / 自部署）通常也用 "sk-" 前缀
  if (!trimmed.startsWith("sk-")) return true;

  return false;
}
