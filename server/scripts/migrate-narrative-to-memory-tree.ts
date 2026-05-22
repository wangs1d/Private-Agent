/**
 * 可选：将 Qdrant narrative 点按 text 重建 chunkId 并写入 Memory Tree（需 Qdrant + OPENAI_API_KEY）。
 *
 * 用法：npx tsx scripts/migrate-narrative-to-memory-tree.ts [actorId]
 */
import { QdrantClient } from "@qdrant/js-client-rest";

import { MemoryTreeIngestService } from "../src/memory-tree/ingest.js";
import { MemoryTreeStore } from "../src/memory-tree/store.js";

const url = process.env.AGENT_QDRANT_URL?.trim();
const collection = process.env.AGENT_QDRANT_COLLECTION?.trim() || "narrative_chunks";
const actorFilter = process.argv[2]?.trim();

async function main(): Promise<void> {
  if (!url) {
    console.error("AGENT_QDRANT_URL is required");
    process.exit(1);
  }
  const client = new QdrantClient({ url, apiKey: process.env.AGENT_QDRANT_API_KEY?.trim() });
  const store = new MemoryTreeStore();
  const ingest = new MemoryTreeIngestService(store);

  const scroll = await client.scroll(collection, {
    limit: 500,
    with_payload: true,
    filter: actorFilter ?
        { must: [{ key: "actorId", match: { value: actorFilter } }] }
      : undefined,
  });

  let n = 0;
  for (const p of scroll.points) {
    const payload = p.payload as Record<string, unknown> | null | undefined;
    if (!payload) continue;
    const actorId = String(payload.actorId ?? "");
    const text = String(payload.text ?? "");
    const source = String(payload.source ?? "legacy:migrate");
    if (!actorId || !text) continue;
    await ingest.ingestText(actorId, `legacy:${source}`, text);
    n++;
  }
  console.log(`Migrated ${n} points into Memory Tree under ${store.rootDir}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
