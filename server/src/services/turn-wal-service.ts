import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { getCalendarDay, getShortTermMemoryConfig } from "./short-term-memory-config.js";
import { redactSensitiveText } from "../utils/redact.js";

export type TurnWalEntry = {
  ts: string;
  actorId: string;
  userText: string;
  assistantText: string;
  highSignal?: boolean;
  messageId?: string;
  planExecuteUsed?: boolean;
};

/**
 * 回合预写日志（WAL）：每轮先 append JSONL，再更新内存 digest，防崩溃丢当天对话。
 */
export class TurnWalService {
  private readonly config = getShortTermMemoryConfig();

  async append(entry: TurnWalEntry): Promise<void> {
    if (!this.config.walEnabled) return;

    const day = getCalendarDay(new Date(entry.ts));
    const dir = join(process.cwd(), this.config.walDir);
    const filePath = join(dir, `${day}.jsonl`);

    const safe: TurnWalEntry = {
      ...entry,
      userText: redactSensitiveText(entry.userText),
      assistantText: redactSensitiveText(entry.assistantText),
    };

    await mkdir(dir, { recursive: true });
    await appendFile(filePath, `${JSON.stringify(safe)}\n`, "utf8");
  }
}

let singleton: TurnWalService | null = null;

export function getTurnWalService(): TurnWalService {
  if (!singleton) singleton = new TurnWalService();
  return singleton;
}
