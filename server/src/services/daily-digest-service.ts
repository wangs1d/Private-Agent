import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { NarrativeMemoryPort } from "./narrative-memory-port.js";
import {
  getCalendarDay,
  getShortTermMemoryConfig,
  type ShortTermMemoryConfig,
} from "./short-term-memory-config.js";
import { redactSensitiveText } from "../utils/redact.js";

type DigestRecord = {
  day: string;
  actorId: string;
  text: string;
  turnCount: number;
  updatedAt: string;
  archived?: boolean;
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
  for (const term of queryTerms) {
    if (lower.includes(term)) score += term.length >= 4 ? 2 : 1;
  }

  if (/\[用户要求记住\]|\[Agent 承诺\/结论\]/.test(line)) score += 2.5;

  const recencyBoost =
    totalLines <= 1 ? 0 : (recencyRank / Math.max(totalLines - 1, 1)) * 1.5;
  score += recencyBoost;
  return score;
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
    if (!rec?.text?.trim()) return undefined;
    const max = this.config.digestPromptMaxChars;
    const body = rec.text.trim();
    return body.length > max ? `...(earlier entries truncated)\n${body.slice(-max)}` : body;
  }

  getRelevantPromptDigest(
    actorId: string,
    query: string,
    day = getCalendarDay(),
  ): string | undefined {
    if (!this.config.digestEnabled) return undefined;
    const rec = this.data.digests[digestKey(actorId, day)];
    if (!rec?.text?.trim()) return undefined;

    const lines = rec.text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0) return undefined;

    const queryTerms = extractQueryTerms(query);
    if (queryTerms.length === 0) {
      return this.getPromptDigest(actorId, day);
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
      return this.getPromptDigest(actorId, day);
    }

    let text = ranked.join("\n");
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

    let text = prev?.text?.trim() ? `${prev.text.trim()}\n${lines.join("\n")}` : lines.join("\n");
    if (text.length > this.config.digestMaxChars) {
      text = `...(earlier entries truncated)\n${text.slice(-this.config.digestMaxChars)}`;
    }

    this.data.digests[key] = {
      day,
      actorId,
      text,
      turnCount: (prev?.turnCount ?? 0) + 1,
      updatedAt: now,
    };
    this.schedulePersist();
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
    const body = rec.text.trim();
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
