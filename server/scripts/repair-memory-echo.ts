/**
 * 记忆回声与覆盖缺失修复脚本（root fix 配套数据修复，2026-09 复盘）
 *
 * 修复三类历史污染（代码层已加根源治理，本脚本清洗存量数据）：
 *   1. human-memory 图谱：作废"助手对关系主题的摇摆/求证发言"（「到底哪位是正主」）
 *      与同主题不同值的旧断言 —— 走 HumanLikeMemoryService.repairSupersedeForActor，
 *      与运行时 ingest 同一套 supersede 规则；
 *   2. agent-memory-sync KV：从 user_profile 画像中移除/改写与用户明确声明矛盾的
 *      暧昧行（「关系未确认，保持中立」「候选/备选」），从各记忆槽位剔除助手回声行；
 *   3. user-facts：把关系类事实的变体 subject（「我的老婆是X」「我的未来老婆是X」）
 *      归并到同一规范 subject（「配偶/伴侣」），恢复 latest-wins。
 *
 * 运行（务必先停服务，避免与运行中进程双写）：
 *   cd server && npx tsx scripts/repair-memory-echo.ts [--actor session-mvp-001] [--value 刘浩存] [--dry-run]
 */

import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { HumanLikeMemoryService } from "../src/services/human-like-memory-service.js";
import { extractFactSubject } from "../src/services/user-fact-store.js";
import {
  extractRelationshipAssertion,
  isRelationshipHedgeLine,
} from "../src/services/memory-relationship-assertion.js";
import { classifyMemorySourceRole } from "../src/services/memory-source-role.js";
import type { MemoryNodeRecord } from "../src/services/human-like-memory-service.js";

function parseArgs(): { actor: string; value: string; dryRun: boolean } {
  const args = process.argv.slice(2);
  const get = (name: string, fallback: string): string => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
  };
  return {
    actor: get("--actor", "session-mvp-001"),
    value: get("--value", "刘浩存"),
    dryRun: args.includes("--dry-run"),
  };
}

function listAffectedNodes(service: HumanLikeMemoryService, actorId: string, value: string): MemoryNodeRecord[] {
  return service.getAllNodes(actorId).filter((node) => {
    if (node.deletionStage === "soft_deleted" || node.deletionStage === "hard_deleted") return false;
    // 与运行时 shouldSupersedeForAssertion 完全同判据：
    //   1) 助手对关系主题的摇摆/求证发言（到底哪位是正主…）
    if (classifyMemorySourceRole(node.summary) === "assistant" && isRelationshipHedgeLine(node.summary)) {
      return true;
    }
    //   2) 同主题、不同值的旧断言（疑问句提取不到值，天然不会被误杀）
    const assertion = extractRelationshipAssertion(node.summary);
    return !!assertion && !!assertion.value && assertion.value !== value;
  });
}

const PROFILE_LINE_RULES: Array<{ match: RegExp; replace: string | null; why: string }> = [
  {
    // 兴趣行：把"关注列表里的并列"改为"明确关系声明 + 普通关注"
    match: /关注演员刘浩存（称「未来的老婆」）、景甜及鞠婧祎，会主动要求查看其照片/,
    replace:
      "关注演员刘浩存（用户明确称其为「未来的老婆」，此前说过「我老婆」）及鞠婧祎，会主动要求查看其照片；景甜为其普通关注的演员",
    why: "兴趣行把刘浩存（未来的老婆）与景甜并列，是模型回答摇摆的画像层来源之一",
  },
  {
    // 备注行：与用户明确声明矛盾的"保持中立"指令改为"以用户声明为准"
    match: /- 用户提及「你知道她是谁吗 还发短信」[^\n]*/,
    replace:
      "- 用户已明确表示「未来的老婆」是刘浩存（此前称「我老婆」），涉及该话题直接以用户声明回应；其他用户未说明身份的联系人，先倾听、不打听、不预设",
    why: "「身份与关系未确认，应保持中立」与用户明确声明冲突，直接导致回复敷衍",
  },
];

const ECHO_SLOT_KEYS = ["memory_summary", "memory_summary_forgotten", "session_recap", "memory_facts"];

async function repairKv(actorId: string, value: string, dryRun: boolean): Promise<void> {
  const filePath = join(process.cwd(), "data", "agent-memory-sync.json");
  const raw = await readFile(filePath, "utf8");
  const data = JSON.parse(raw) as {
    sessions: Record<string, { revision: number; entries: Record<string, unknown> }>;
  };
  const session = data.sessions[actorId];
  if (!session) {
    console.log(`[repair] KV 中无该 actor（${actorId}），跳过 KV 修复`);
    return;
  }

  // 1) 画像矛盾行改写
  const profile = typeof session.entries.user_profile === "string" ? (session.entries.user_profile as string) : "";
  let nextProfile = profile;
  for (const rule of PROFILE_LINE_RULES) {
    if (!rule.match.test(nextProfile)) continue;
    if (rule.replace === null) continue;
    nextProfile = nextProfile.replace(rule.match, rule.replace);
    console.log(`[repair] 画像行改写：${rule.why}`);
  }
  if (nextProfile !== profile && !dryRun) {
    session.entries.user_profile = nextProfile;
  } else if (nextProfile === profile) {
    console.log("[repair] 画像无匹配的矛盾行（可能已修复）");
  }

  // 2) 记忆槽位剔除助手回声行（「到底哪位是正主」类，防止 prompt-builder 按相关度再次注入）
  for (const key of ECHO_SLOT_KEYS) {
    const slot = session.entries[key];
    if (typeof slot !== "string") continue;
    const lines = slot.split("\n").filter(Boolean);
    const kept = lines.filter((line) => !isRelationshipHedgeLine(line));
    if (kept.length !== lines.length) {
      console.log(`[repair] 槽位 ${key}：剔除 ${lines.length - kept.length} 条助手回声行`);
      if (!dryRun) session.entries[key] = kept.join("\n");
    }
  }

  if (!dryRun) {
    await writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
    console.log(`[repair] KV 已写回 ${filePath}`);
  }
}

interface FactFileShape {
  version: number;
  updatedAt: string;
  facts: Array<{
    id: string;
    kind: string;
    subject: string;
    value: string;
    confidence: number;
    seenCount: number;
    sources: string[];
    createdAt: string;
    updatedAt: string;
  }>;
}

async function repairUserFacts(actorId: string, dryRun: boolean): Promise<void> {
  const filePath = join(process.cwd(), "data", "user-facts", `${actorId.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    console.log(`[repair] 无 user-facts 文件（${filePath}），跳过`);
    return;
  }
  const shape = JSON.parse(raw) as FactFileShape;
  const relIdx = shape.facts
    .map((f, i) => ({ f, i }))
    .filter(({ f }) => /(?:我的|未来的?)(?:老婆|媳妇|未婚妻|对象|正主)|配偶\/伴侣/.test(f.subject + f.value));
  if (relIdx.length <= 1) {
    console.log(`[repair] user-facts 关系类事实 ${relIdx.length} 条，无需归并`);
    return;
  }
  // 归并到规范 subject「配偶/伴侣」：保留 seenCount 最高（最稳定）的值
  const canonical = extractFactSubject("fact", relIdx[0].f.value);
  const keep = relIdx.reduce((a, b) => (b.f.seenCount > a.f.seenCount ? b : a));
  const dropIds = relIdx.filter(({ f }) => f.id !== keep.f.id).map(({ f }) => f.id);
  keep.f.subject = canonical;
  // 与 UserFactStore.factId 同构：sha1(`${kind}:${subject}`) 前 16 位
  keep.f.id = createHash("sha1").update(`${keep.f.kind}:${canonical}`).digest("hex").slice(0, 16);
  keep.f.updatedAt = new Date().toISOString();
  const next: FactFileShape = {
    ...shape,
    facts: shape.facts.filter((f) => !dropIds.includes(f.id)),
    updatedAt: new Date().toISOString(),
  };
  console.log(
    `[repair] user-facts：关系类事实 ${relIdx.length} 条归并为 1 条（保留「${keep.f.value}」，删除 ${dropIds.length} 条变体）`,
  );
  if (!dryRun) await writeFile(filePath, JSON.stringify(next, null, 2), "utf8");
}

async function main(): Promise<void> {
  const { actor, value, dryRun } = parseArgs();
  console.log(`[repair] actor=${actor} value=${value} dryRun=${dryRun}`);
  console.warn(
    "[repair] 提醒：请确认服务已停止（PORT=3000 进程），否则运行中的进程会用内存态覆盖本次修复。",
  );

  // 1) 图谱 supersede 修复
  const service = new HumanLikeMemoryService();
  await service.load();
  const affected = listAffectedNodes(service, actor, value);
  console.log(`[repair] 图谱中待作废节点 ${affected.length} 条：`);
  for (const node of affected.slice(0, 20)) {
    console.log(`  - [${node.id}] ${node.summary.slice(0, 90)}`);
  }
  if (affected.length > 20) console.log(`  ...（其余 ${affected.length - 20} 条略）`);
  if (!dryRun) {
    const repaired = service.repairSupersedeForActor(actor, { subject: "spouse", value });
    console.log(`[repair] 图谱实际作废 ${repaired} 条`);
  }
  await service.shutdown();

  // 2) KV 画像 + 槽位
  await repairKv(actor, value, dryRun);
  // 3) user-facts 归并
  await repairUserFacts(actor, dryRun);

  console.log(`[repair] 完成${dryRun ? "（dry-run，未写盘）" : ""}`);
}

main().catch((err) => {
  console.error("[repair] 失败:", err);
  process.exit(1);
});
