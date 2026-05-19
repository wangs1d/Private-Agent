import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { redactSensitiveText } from "../utils/redact.js";

export class AuditService {
  constructor(private readonly filePath: string = join(process.cwd(), "logs", "audit.log")) {}

  async record(event: Record<string, unknown>): Promise<void> {
    const safeEvent = this.sanitize(event);
    await mkdir(dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, `${JSON.stringify(safeEvent)}\n`, "utf8");
  }

  private sanitize(event: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(event)) {
      if (typeof value === "string") {
        out[key] = redactSensitiveText(value);
      } else {
        out[key] = value;
      }
    }
    return out;
  }
}
