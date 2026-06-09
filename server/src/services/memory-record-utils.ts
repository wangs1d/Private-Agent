const TIMESTAMP_PREFIX_RE = /^\[[^\]]+\]\s*/;
const TOPIC_TAG_RE = /^\[[A-Z_:-]+\]\s*/i;

export function stripMemoryLineDecorators(line: string): string {
  return line
    .replace(TIMESTAMP_PREFIX_RE, "")
    .replace(TOPIC_TAG_RE, "")
    .replace(/\[fast-path\]\s*/gi, "")
    .replace(/\[(?:用户要求记住|Agent 承诺\/结论|关系线程)\]\s*/gi, "")
    .trim();
}

export function normalizeMemoryLine(line: string): string {
  return stripMemoryLineDecorators(line)
    .toLowerCase()
    .replace(/[“”"'`]/g, "")
    .replace(/[，。！？、,:;|()[\]{}<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function semanticFingerprint(line: string): string {
  const normalized = normalizeMemoryLine(line);
  if (!normalized) return "";
  return normalized
    .split(" ")
    .filter((token) => token.length >= 2)
    .slice(0, 10)
    .join(" ");
}

export function extractOverwriteKey(line: string): string | null {
  const plain = stripMemoryLineDecorators(line);
  const patterns: RegExp[] = [
    /(?:喜欢|不喜欢|讨厌|偏好|习惯|总是|从不|不要|别)\s*([^，。！？\n]{2,24})/,
    /(?:生日|纪念日|住在|住址|城市|学校|公司|职业|工作是)\s*([^，。！？\n]{2,24})/,
    /(?:提醒我|记住|记得)\s*([^，。！？\n]{2,24})/,
  ];
  for (const pattern of patterns) {
    const match = plain.match(pattern);
    if (match?.[1]) {
      return `${pattern.source}:${normalizeMemoryLine(match[1]).slice(0, 48)}`;
    }
  }
  const normalized = normalizeMemoryLine(plain);
  return normalized ? normalized.slice(0, 48) : null;
}

export function areLinesConflicting(a: string, b: string): boolean {
  const keyA = extractOverwriteKey(a);
  const keyB = extractOverwriteKey(b);
  if (!keyA || !keyB || keyA !== keyB) return false;
  return normalizeMemoryLine(a) !== normalizeMemoryLine(b);
}

export function dedupeMemoryLines(
  lines: string[],
  opts?: { preferLatest?: boolean; keepAtLeast?: number },
): string[] {
  const keepAtLeast = Math.max(0, opts?.keepAtLeast ?? 0);
  const ordered = opts?.preferLatest ? [...lines].reverse() : [...lines];
  const seen = new Set<string>();
  const byOverwriteKey = new Map<string, string>();
  const result: string[] = [];

  for (const line of ordered) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const fingerprint = semanticFingerprint(trimmed);
    if (fingerprint && seen.has(fingerprint)) continue;

    const overwriteKey = extractOverwriteKey(trimmed);
    if (overwriteKey && byOverwriteKey.has(overwriteKey)) {
      const existing = byOverwriteKey.get(overwriteKey)!;
      if (areLinesConflicting(existing, trimmed)) {
        continue;
      }
    }

    if (fingerprint) seen.add(fingerprint);
    if (overwriteKey) byOverwriteKey.set(overwriteKey, trimmed);
    result.push(trimmed);
  }

  const restored = opts?.preferLatest ? result.reverse() : result;
  if (keepAtLeast <= 0 || restored.length <= keepAtLeast) return restored;
  return restored.slice(-keepAtLeast);
}

export function limitLinesByChars(
  lines: string[],
  maxChars: number,
  opts?: { preserveTail?: boolean },
): { kept: string[]; evicted: string[] } {
  if (maxChars <= 0) return { kept: [], evicted: [...lines] };
  const kept: string[] = [];
  const evicted: string[] = [];
  const source = opts?.preserveTail ? [...lines].reverse() : [...lines];
  let used = 0;

  for (const line of source) {
    const next = used === 0 ? line.length : used + 1 + line.length;
    if (next <= maxChars) {
      kept.push(line);
      used = next;
    } else {
      evicted.push(line);
    }
  }

  if (opts?.preserveTail) {
    kept.reverse();
    evicted.reverse();
  }
  return { kept, evicted };
}
