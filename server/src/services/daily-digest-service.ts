import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { NarrativeMemoryPort } from "./narrative-memory-port.js";
import {
  getCalendarDay,
  getShortTermMemoryConfig,
  type ShortTermMemoryConfig,
} from "./short-term-memory-config.js";
import {
  dedupeMemoryLines,
  limitLinesByChars,
  semanticFingerprint,
} from "./memory-record-utils.js";
import { redactSensitiveText } from "../utils/redact.js";

type DigestRecord = {
  day: string;
  actorId: string;
  text: string;
  turnCount: number;
  updatedAt: string;
  archived?: boolean;
  keyLines?: string[];
  recentTurns?: string[];
  summaryLayer?: string[];
};

type PersistedShape = {
  digests: Record<string, DigestRecord>;
};

function digestKey(actorId: string, day: string): string {
  return `${actorId}::${day}`;
}

function firstLine(text: string, maxLen: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return "";
  return t.length > maxLen ? `${t.slice(0, maxLen)}...` : t;
}

function compactDigestField(text: string, maxLen: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return "";
  return t.length > maxLen ? `${t.slice(0, maxLen)}...` : t;
}

function materializeDigestText(rec: DigestRecord): string {
  const layered = [
    ...(rec.summaryLayer ?? []),
    ...(rec.keyLines ?? []),
    ...(rec.recentTurns ?? []),
  ]
    .map((line) => line.trim())
    .filter(Boolean);
  if (layered.length > 0) {
    return layered.join("\n");
  }
  return rec.text?.trim() ?? "";
}

function compressDigestLines(lines: string[]): string[] {
  if (lines.length === 0) return [];
  const compacted = dedupeMemoryLines(lines.map((line) => formatDigestPromptLine(line)), {
    preferLatest: true,
  });
  return compacted.slice(-10);
}

function formatDigestPromptLine(line: string): string {
  const rememberMatch = line.match(/^\[用户要求记住\]\s*(.+)$/);
  if (rememberMatch?.[1]) {
    return `- mem|${compactDigestField(rememberMatch[1], 80)}`;
  }

  const conclusionMatch = line.match(/^\[Agent 承诺\/结论\]\s*(.+)$/);
  if (conclusionMatch?.[1]) {
    return `- agent|${compactDigestField(conclusionMatch[1], 80)}`;
  }

  const turnMatch = line.match(/^\[(\d{2}:\d{2})\]\s*用户:\s*(.+?)\s*\|\s*Agent:\s*(.+)$/);
  if (turnMatch) {
    const [, timeLabel, userText, assistantText] = turnMatch;
    return `- turn|${timeLabel}|u=${compactDigestField(userText, 36)}|a=${compactDigestField(assistantText, 36)}`;
  }

  return `- note|${compactDigestField(line, 96)}`;
}

function extractQueryTerms(text: string): string[] {
  return Array.from(
    new Set(
      (text.toLowerCase().match(/[\u4e00-\u9fff]{2,}|[a-z]{3,}/g) ?? []).filter(Boolean),
    ),
  ).slice(0, 12);
}

function scoreDigestLine(
  line: string,
  queryTerms: string[],
  recencyRank: number,
  totalLines: number,
): number {
  if (queryTerms.length === 0) return 0;

  const lower = line.toLowerCase();
  let score = 0;
  let matched = false;
  for (const term of queryTerms) {
    if (lower.includes(term)) {
      score += term.length >= 4 ? 2 : 1;
      matched = true;
    }
  }

  if (/\[用户要求记住\]|\[Agent 承诺\/结论\]/.test(line)) {
    score += 2.5;
  }

  if (!matched) return 0;

  const recencyBoost =
    totalLines <= 1 ? 0 : (recencyRank / Math.max(totalLines - 1, 1)) * 1.5;
  return score + recencyBoost;
}

export class DailyDigestService {
  private readonly config: ShortTermMemoryConfig;
  private readonly filePath: string;
  private data: PersistedShape = { digests: {} };
  private persistChain: Promise<void> = Promise.resolve();
  private schedulerTimer: NodeJS.Timeout | null = null;
  private lastArchiveDay = "";
  private narrativeMemory: NarrativeMemoryPort | null = null;

  constructor(config?: ShortTermMemoryConfig) {
    this.config = config ?? getShortTermMemoryConfig();
    this.filePath = join(process.cwd(), this.config.digestFile);
  }

  setNarrativeMemory(port: NarrativeMemoryPort | null): void {
    this.narrativeMemory = port;
  }

  async load(): Promise<void> {
    if (!this.config.digestEnabled) return;
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as PersistedShape;
      if (parsed?.digests && typeof parsed.digests === "object") {
        this.data = parsed;
        this.pruneStaleFromMemory();
      }
    } catch (e: unknown) {
      const code =
        e && typeof e === "object" && "code" in e
          ? String((e as NodeJS.ErrnoException).code)
          : "";
      if (code !== "ENOENT") throw e;
    }
  }

  startScheduler(): void {
    if (!this.config.digestEnabled || this.schedulerTimer) return;
    this.schedulerTimer = setInterval(() => this.tickArchive(), 60_000);
    this.tickArchive();
  }

  stopScheduler(): void {
    if (this.schedulerTimer) clearInterval(this.schedulerTimer);
    this.schedulerTimer = null;
  }

  getPromptDigest(actorId: string, day = getCalendarDay()): string | undefined {
    if (!this.config.digestEnabled) return undefined;
    const rec = this.data.digests[digestKey(actorId, day)];
    const raw = rec ? materializeDigestText(rec) : "";
    if (!raw.trim()) return undefined;
    const max = this.config.digestPromptMaxChars;
    const body = raw.trim();
    return body.length > max ? `...(earlier entries truncated)\n${body.slice(-max)}` : body;
  }

  getRelevantPromptDigest(
    actorId: string,
    query: string,
    day = getCalendarDay(),
  ): string | undefined {
    if (!this.config.digestEnabled) return undefined;
    const rec = this.data.digests[digestKey(actorId, day)];
    const raw = rec ? materializeDigestText(rec) : "";
    if (!raw.trim()) return undefined;

    const lines = raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0) return undefined;

    const queryTerms = extractQueryTerms(query);
    if (queryTerms.length === 0) {
      return undefined;
    }

    const ranked = lines
      .map((line, index) => ({
        line,
        index,
        score: scoreDigestLine(line, queryTerms, index, lines.length),
      }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || b.index - a.index)
      .slice(0, 6)
      .sort((a, b) => a.index - b.index)
      .map((entry) => entry.line);

    if (ranked.length === 0) {
      return undefined;
    }

    let text = [
      `DIGEST|hits=${ranked.length}`,
      ...ranked.map((line) => formatDigestPromptLine(line)),
    ].join("\n");
    if (text.length > this.config.digestPromptMaxChars) {
      text = `${text.slice(0, this.config.digestPromptMaxChars)}...`;
    }
    return text;
  }

  observeTurn(
    actorId: string,
    userText: string,
    assistantText: string,
    opts?: { priorityLines?: string[] },
  ): void {
    if (!this.config.digestEnabled) return;

    const day = getCalendarDay();
    const key = digestKey(actorId, day);
    const now = new Date().toISOString();
    const prev = this.data.digests[key];

    const timeLabel = new Intl.DateTimeFormat("zh-CN", {
      timeZone: this.config.digestTimezone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date());

    const lines: string[] = [];
    if (opts?.priorityLines?.length) {
      for (const line of opts.priorityLines) {
        lines.push(redactSensitiveText(line));
      }
    }
    lines.push(
      `[${timeLabel}] 用户: ${firstLine(userText, 120)} | Agent: ${firstLine(assistantText, 120)}`,
    );

    const nextRec: DigestRecord = prev ?? {
      day,
      actorId,
      text: "",
      turnCount: 0,
      updatedAt: now,
      keyLines: [],
      recentTurns: [],
      summaryLayer: [],
    };
    nextRec.keyLines = dedupeMemoryLines(
      [...(nextRec.keyLines ?? []), ...(opts?.priorityLines ?? []).map((line) => redactSensitiveText(line))],
      { preferLatest: true },
    ).slice(-12);
    nextRec.recentTurns = [...(nextRec.recentTurns ?? []), lines[lines.length - 1]!].slice(-24);
    this.rebalanceRecord(nextRec);
    const text = materializeDigestText(nextRec);

    this.data.digests[key] = {
      ...nextRec,
      day,
      actorId,
      text,
      turnCount: (prev?.turnCount ?? 0) + 1,
      updatedAt: now,
    };
    this.schedulePersist();
  }

  listActorIds(): string[] {
    return [...new Set(Object.values(this.data.digests).map((rec) => rec.actorId).filter(Boolean))];
  }

  private tickArchive(): void {
    if (!this.config.digestEnabled || !this.config.deferTurnArchive) return;

    const today = getCalendarDay();
    if (this.lastArchiveDay === today) return;

    const now = new Date();
    const hour = Number(
      new Intl.DateTimeFormat("en-US", {
        timeZone: this.config.digestTimezone,
        hour: "numeric",
        hour12: false,
      }).format(now),
    );
    const minute = Number(
      new Intl.DateTimeFormat("en-US", {
        timeZone: this.config.digestTimezone,
        minute: "numeric",
      }).format(now),
    );

    if (hour !== 0 || minute >= 5) return;

    this.lastArchiveDay = today;
    const yesterday = getCalendarDay(new Date(now.getTime() - 86_400_000));
    void this.archiveDayForAllActors(yesterday);
  }

  private async archiveDayForAllActors(day: string): Promise<void> {
    for (const rec of Object.values(this.data.digests)) {
      if (rec.day !== day || rec.archived || !rec.text.trim()) continue;
      await this.archiveRecord(rec);
    }
    this.schedulePersist();
  }

  private async archiveRecord(rec: DigestRecord): Promise<void> {
    if (!this.narrativeMemory) return;
    const header = `Daily digest ${rec.day} | ${rec.turnCount} turns`;
    const body = materializeDigestText(rec).trim();
    try {
      await this.narrativeMemory.ingest(
        rec.actorId,
        `${header}\n${body}`,
        "chat:daily_digest",
      );
      rec.archived = true;
    } catch {
      /* fire-and-forget */
    }
  }

  private pruneStaleFromMemory(): void {
    const today = getCalendarDay();
    const keepDays = new Set([today]);
    const yesterday = getCalendarDay(new Date(Date.now() - 86_400_000));
    keepDays.add(yesterday);

    for (const [key, rec] of Object.entries(this.data.digests)) {
      if (!keepDays.has(rec.day) && rec.archived) {
        delete this.data.digests[key];
      }
    }
  }

  private rebalanceRecord(rec: DigestRecord): void {
    const keyLines = dedupeMemoryLines(rec.keyLines ?? [], { preferLatest: true }).slice(-12);
    const recentTurns = dedupeMemoryLines(rec.recentTurns ?? [], { preferLatest: true }).slice(-24);
    const summaryLayer = dedupeMemoryLines(rec.summaryLayer ?? [], { preferLatest: true }).slice(-10);

    const allLines = [...summaryLayer, ...keyLines, ...recentTurns];
    const limited = limitLinesByChars(allLines, this.config.digestMaxChars, { preserveTail: true });
    const keptSet = new Set(limited.kept.map((line) => semanticFingerprint(line) || line));
    const overflowRecent = recentTurns.filter((line) => !keptSet.has(semanticFingerprint(line) || line));
    const nextSummary = dedupeMemoryLines(
      [...summaryLayer, ...compressDigestLines(overflowRecent)],
      { preferLatest: true },
    ).slice(-10);

    const recomposed = [...nextSummary, ...keyLines, ...recentTurns];
    const trimmed = limitLinesByChars(recomposed, this.config.digestMaxChars, { preserveTail: true }).kept;
    const trimmedSet = new Set(trimmed.map((line) => semanticFingerprint(line) || line));

    rec.summaryLayer = nextSummary.filter((line) => trimmedSet.has(semanticFingerprint(line) || line));
    rec.keyLines = keyLines.filter((line) => trimmedSet.has(semanticFingerprint(line) || line));
    rec.recentTurns = recentTurns.filter((line) => trimmedSet.has(semanticFingerprint(line) || line));
    rec.text = materializeDigestText(rec);
  }

  private schedulePersist(): void {
    this.persistChain = this.persistChain.then(() => this.flushToDisk());
  }

  private async flushToDisk(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(this.data, null, 2)}\n`, "utf8");
  }
}

let singleton: DailyDigestService | null = null;

export function getDailyDigestService(): DailyDigestService {
  if (!singleton) singleton = new DailyDigestService();
  return singleton;
}
