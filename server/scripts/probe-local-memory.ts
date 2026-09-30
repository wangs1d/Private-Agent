/**
 * 本地内置向量引擎真链探针（零配置记忆底座验收）。
 *
 * 与其他探针不同：本脚本刻意【不加载 dotenv / load-server-env】，进程环境从零
 * 构造——对话 key 手工从 server/.env 解析（真实 DeepSeek，供 mem0 抽取用），
 * 所有 Embedding 远端变量保持未设置，逼出「无远端配置 → 本地 ONNX 引擎自动
 * 点亮」的完整链路：
 *
 *   引擎装配 → 回环 /v1/embeddings → mem0 OpenAIEmbedder → 本地 SQLite 向量库
 *
 * 用法（server 目录下）：
 *   npx tsx scripts/probe-local-memory.ts
 *
 * 断言：端点解析兜底 / 集合按模型打标 / 事实写入 / 语义检索命中 / 旧模型集合隔离。
 * 只输出判定与耗时，不打印任何密钥。
 */

import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync as Database } from "node:sqlite";

import { Memory } from "mem0ai/oss";

import { ensureLocalEmbeddingEndpoint, getLocalEmbeddingEndpoint } from "../src/agentic-memory/local-embedding/local-embedding-endpoint.js";
import { resolveEmbeddingEndpoint } from "../src/services/openai-embedding-client.js";
import { buildAgenticMemoryConfig, resolveAgenticMemoryCollectionName } from "../src/agentic-memory/config.js";

// ── 从 server/.env → .env.local 手工解析对话 key（绝不打印值）。
// 加载顺序与 loadServerEnv 一致（.env.local 覆盖 .env）；刻意不走 dotenv，
// 保证 Embedding 相关远端变量天然为空，逼出本地引擎路径。
function parseEnvKey(name: string, files: string[]): string | null {
  let found: string | null = null;
  for (const file of files) {
    try {
      const text = readFileSync(join(process.cwd(), file), "utf8").replace(/^\uFEFF/, "");
      const re = new RegExp(`^${name}=(.*)$`);
      for (const line of text.split("\n")) {
        const m = line.match(re);
        if (m) {
          const v = m[1]!.trim().replace(/^["']|["']$/g, "");
          if (v) found = v; // 后文件覆盖前文件（与 loadServerEnv 同序）
        }
      }
    } catch { /* 文件不存在跳过 */ }
  }
  return found;
}

const envFiles = [".env", ".env.local"];
// 刻意【文件优先】：本机用户级环境变量里有一把失效的 OPENAI_API_KEY（HKCU，
// 尾号 dRT6），继承 shell 的进程会被它污染；文件链（.env.local 覆盖 .env）才是
// 与生产 loadServerEnv 同源的有效凭据。
const openaiKey = parseEnvKey("OPENAI_API_KEY", envFiles) || process.env.OPENAI_API_KEY?.trim();
const openaiBase = parseEnvKey("OPENAI_BASE_URL", envFiles) || process.env.OPENAI_BASE_URL?.trim();
const openaiModel = parseEnvKey("OPENAI_MODEL", envFiles) || parseEnvKey("FORCE_MODEL", envFiles);
if (!openaiKey) {
  console.error("[probe-local-memory] .env 无可用 OPENAI_API_KEY，无法跑 mem0 抽取链路");
  process.exit(1);
}
process.env.OPENAI_API_KEY = openaiKey;
if (openaiBase) process.env.OPENAI_BASE_URL = openaiBase;
process.env.OPENAI_MODEL = openaiModel || "deepseek-chat";
console.log(
  `[probe-local-memory] LLM: base=${openaiBase ? new URL(openaiBase).host : "(未取到→api.openai.com)"} model=${process.env.OPENAI_MODEL}`,
);
// 隔离：记忆全部落临时目录，不碰真实 data
const tmp = mkdtempSync(join(tmpdir(), "pai-local-mem-"));
process.env.AGENT_AGENTIC_MEMORY_DIR = tmp;
process.env.AGENT_AGENTIC_MEMORY_DB = join(tmp, "agentic-memory.db");

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) { pass++; console.log(`  PASS ${name}${detail ? "  " + detail : ""}`); }
  else { fail++; console.error(`  FAIL ${name}${detail ? "  " + detail : ""}`); }
}

async function main(): Promise<void> {
  console.log("[probe-local-memory] 1) 无远端配置时端点解析应为空");
  check("初始 resolveEmbeddingEndpoint=null（无远端配置）", resolveEmbeddingEndpoint() === null);

  console.log("[probe-local-memory] 2) 本地引擎点亮");
  const t0 = Date.now();
  const ep = await ensureLocalEmbeddingEndpoint();
  check("ensureLocalEmbeddingEndpoint 就绪", ep !== null);
  check("端点绑定 127.0.0.1 回环", ep !== null && ep.baseUrl.startsWith("http://127.0.0.1:"));
  check("模型为内置 bge-small-zh-v1.5", ep?.model === "bge-small-zh-v1.5", `load+listen=${Date.now() - t0}ms`);

  console.log("[probe-local-memory] 3) 端点解析兜底生效");
  const resolved = resolveEmbeddingEndpoint();
  check("resolveEmbeddingEndpoint 兜底到本地", resolved?.model === "bge-small-zh-v1.5" && resolved.baseUrl === getLocalEmbeddingEndpoint()?.baseUrl);
  const config = buildAgenticMemoryConfig();
  check("buildAgenticMemoryConfig 非空", config !== null);
  const vs = config?.vectorStore?.config as { collectionName?: string; dimension?: number } | undefined;
  check("集合名按模型打标", vs?.collectionName === resolveAgenticMemoryCollectionName("bge-small-zh-v1.5"), vs?.collectionName);
  check("维度 512", vs?.dimension === 512);

  console.log("[probe-local-memory] 4) mem0 真实 embedder + 真实向量库（免 LLM 抽取）");
  // 说明：mem0 add() 的 LLM 事实抽取是生产既有链路（依赖对话 key），与本探针
  // 验证的「本地向量引擎」正交——这里直接用 mem0 导出的 OpenAIEmbedder（真实类、
  // 真实回环端点）+ MemoryVectorStore（Memory 实际用的本地 SQLite 库）打全链。
  const actorId = "probe-local-memory";
  const { OpenAIEmbedder, MemoryVectorStore } = await import("mem0ai/oss");
  const embedder = new OpenAIEmbedder({ apiKey: ep!.apiKey, model: ep!.model, baseURL: ep!.baseUrl });
  const embedAsVec = async (t: string): Promise<number[]> =>
    (await (embedder as unknown as { embed: (x: string) => Promise<number[]> }).embed(t)) as number[];

  const dbPath = join(tmp, "vectors-bge-small-zh-v1.5.db");
  const store = new MemoryVectorStore({ dimension: 512, dbPath });
  const facts = [
    "用户最喜欢吃的水果是苹果，每天都要吃一个。",
    "用户对花生过敏，不能吃含花生的零食。",
    "用户养了一只叫煤球的黑猫，今年三岁。",
  ];
  const t1 = Date.now();
  const vectors: number[][] = [];
  for (const f of facts) vectors.push(await embedAsVec(f));
  console.log(`  （3 条文本本地向量化耗时 ${Date.now() - t1}ms）`);
  check("本地引擎向量维度=512", vectors.every((v) => v.length === 512), vectors.map((v) => v.length).join(","));
  await store.insert(
    vectors,
    facts.map((_, i) => `probe-${i}`),
    facts.map((f) => ({ data: { memory: f }, user_id: actorId })),
  );

  console.log("[probe-local-memory] 5) 语义检索（query 向量化走本地引擎）");
  const t2 = Date.now();
  const fruitVec = await embedAsVec("用户喜欢吃什么水果？");
  const fruitHits = (await store.search(fruitVec, 3, { user_id: actorId })) as Array<{
    payload?: { data?: { memory?: string } }; score?: number;
  }>;
  console.log(`  （检索耗时 ${Date.now() - t2}ms, top score=${fruitHits[0]?.score?.toFixed(4)}）`);
  const fruitTexts = fruitHits.map((h) => String(h.payload?.data?.memory ?? ""));
  check("水果 query 命中苹果记忆", fruitTexts.some((t) => t.includes("苹果")), JSON.stringify(fruitTexts));
  const tabooVec = await embedAsVec("有什么饮食禁忌？");
  const tabooHits = (await store.search(tabooVec, 3, { user_id: actorId })) as Array<{
    payload?: { data?: { memory?: string } }; score?: number;
  }>;
  const tabooTexts = tabooHits.map((h) => String(h.payload?.data?.memory ?? ""));
  check("禁忌 query 命中花生过敏", tabooTexts.some((t) => t.includes("花生")), JSON.stringify(tabooTexts));

  console.log("[probe-local-memory] 6) 向量库取证（按模型分库 + 维度持久化）");
  check("按模型命名的向量库已生成", existsSync(dbPath), "vectors-bge-small-zh-v1.5.db");
  const db = new Database(dbPath, { readOnly: true });
  const rows = db.prepare("SELECT length(vector) AS bytes FROM vectors").all() as Array<{ bytes: number }>;
  db.close();
  check("库内向量字节长=512×4", rows.length === 3 && rows.every((r) => r.bytes === 2048), `rows=${rows.length}, bytes=${rows.map((r) => r.bytes).join(",")}`);

  console.log("[probe-local-memory] 7) mem0 完整 add→search 真链（LLM 抽取=DeepSeek，向量化=本地引擎）");
  try {
    const memory = new Memory(config!);
    const t3 = Date.now();
    await memory.add(
      [{ role: "user", content: "提醒我周六上午十点去牙医复诊，地点在滨江诊所。" }],
      { userId: actorId },
    );
    console.log(`  （add 含 LLM 抽取耗时 ${Date.now() - t3}ms）`);
    const fullHit = (await memory.search("牙医复诊是什么时候？", {
      filters: { user_id: actorId },
      limit: 3,
    })) as { results?: Array<{ memory?: string; score?: number }> };
    const fullTexts = (fullHit.results ?? []).map((r) => String(r.memory ?? ""));
    check("完整链路：复诊 query 命中牙医记忆", fullTexts.some((t) => t.includes("牙医") || t.includes("复诊")), JSON.stringify(fullTexts).slice(0, 200));
  } catch (err) {
    check("完整链路：mem0 add→search", false, err instanceof Error ? err.message.slice(0, 200) : String(err));
  }

  console.log(`\n[probe-local-memory] 结果: ${pass} pass / ${fail} fail  （临时目录: ${tmp}）`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[probe-local-memory] 异常:", err instanceof Error ? err.message : err);
  process.exit(1);
});
