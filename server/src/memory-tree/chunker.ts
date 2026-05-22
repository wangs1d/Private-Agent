import { createHash } from "node:crypto";

import { tokenizeForBm25 } from "../agent/retrieval/bm25-lite.js";
import { getMemoryTreeChunkMaxTokens } from "./env.js";

export type TextChunk = {
  chunkId: string;
  body: string;
  tokenCount: number;
};

export function estimateTokenCount(text: string): number {
  const tokens = tokenizeForBm25(text);
  return tokens.length || Math.ceil(text.length / 4);
}

export function contentAddressedChunkId(
  actorId: string,
  sourceId: string,
  canonicalBody: string,
): string {
  return createHash("sha256")
    .update(`${actorId}\n${sourceId}\n${canonicalBody}`)
    .digest("hex");
}

export function canonicalizeMarkdown(
  markdown: string,
  provenance: { at: string; messageId?: string; toolName?: string },
): string {
  const lines: string[] = [];
  lines.push("---");
  lines.push(`at: ${provenance.at}`);
  if (provenance.messageId) lines.push(`messageId: ${provenance.messageId}`);
  if (provenance.toolName) lines.push(`tool: ${provenance.toolName}`);
  lines.push("---");
  lines.push("");
  lines.push(markdown.trim());
  return lines.join("\n");
}

/** 将 canonical markdown 切为 ≤maxTokens 的确定性片段 */
export function chunkCanonicalText(
  actorId: string,
  sourceId: string,
  canonical: string,
  maxTokens = getMemoryTreeChunkMaxTokens(),
): TextChunk[] {
  const paras = canonical.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  if (paras.length === 0) return [];

  const chunks: TextChunk[] = [];
  let buf: string[] = [];
  let bufTokens = 0;

  const flush = (): void => {
    if (!buf.length) return;
    const body = buf.join("\n\n");
    const tokenCount = estimateTokenCount(body);
    const chunkId = contentAddressedChunkId(actorId, sourceId, body);
    chunks.push({ chunkId, body, tokenCount });
    buf = [];
    bufTokens = 0;
  };

  for (const p of paras) {
    const t = estimateTokenCount(p);
    if (t > maxTokens) {
      flush();
      const sliceLen = Math.max(400, Math.floor((maxTokens * 4) / 1.2));
      for (let i = 0; i < p.length; i += sliceLen) {
        const part = p.slice(i, i + sliceLen);
        const body = part;
        chunks.push({
          chunkId: contentAddressedChunkId(actorId, sourceId, body),
          body,
          tokenCount: estimateTokenCount(body),
        });
      }
      continue;
    }
    if (bufTokens + t > maxTokens && buf.length) flush();
    buf.push(p);
    bufTokens += t;
  }
  flush();
  return chunks;
}
