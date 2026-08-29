/**
 * 端到端记忆场景测试：指代消解（"她"→刘浩存）
 *
 * 场景（对齐用户描述）：
 *   1. "帮我搜一下刘浩存最近的照片"   —— 搜索 + 记忆写入
 *   2. "再帮我找找刘浩存的写真"       —— 再次搜索，加强记忆
 *   3. "好想她"                       —— 测试 agent 能否通过记忆/上下文识别"她"=刘浩存
 *
 * 运行：cd server && npx tsx scripts/e2e-memory-reference-liu.ts
 */
import "../src/config/load-server-env.js";

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { createAppServices } from "../src/bootstrap/create-app-services.js";
import { initializeRuntimeState } from "../src/bootstrap/initialize-runtime-state.js";
import { runChatTurnForActor } from "../src/services/chat-turn-runner.js";

const actorId = `mem-e2e-liu-${Date.now()}`;
console.log("[actor]", actorId);
console.log("[boot] 装配服务（真实链路）…\n");

const services = await createAppServices();
await initializeRuntimeState(services);
const { agentCore } = services;
console.log("[boot] 完成\n");

const turns = [
  "帮我搜一下刘浩存最近的照片",
  "再帮我找找刘浩存的写真",
  "好想她",
];

for (let i = 0; i < turns.length; i++) {
  const text = turns[i];
  console.log(`========== 第 ${i + 1} 轮 ==========`);
  console.log(`[USER] ${text}`);
  const t0 = Date.now();
  const r = await runChatTurnForActor(agentCore, actorId, {
    text,
    userId: actorId,
    messageId: `m-${i}-${Date.now()}`,
    preferFullPipeline: true,
  });
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  if (r.ok) {
    console.log(`[AGENT · ${dt}s] ${r.finalText}`);
  } else {
    console.log(`[ERR · ${dt}s] ${r.message}`);
  }
  // 留出时间让记忆/画像异步写入
  await new Promise((res) => setTimeout(res, 2500));
}

console.log("\n\n========== 画像文件（USER_PROFILE.md） ==========");
try {
  const profilePath = join(
    process.cwd(),
    "data",
    "user_profiles",
    actorId,
    "USER_PROFILE.md",
  );
  const content = await readFile(profilePath, "utf8");
  console.log(content);
} catch (e) {
  console.log(`[无画像文件] ${String(e)}`);
}

console.log("\n========== 记忆 KV 摘要 ==========");
try {
  const snap = services.agentMemorySyncService.getSnapshot(actorId);
  for (const key of Object.keys(snap.entries)) {
    const val = String(snap.entries[key] ?? "");
    console.log(`\n--- ${key} ---`);
    console.log(val.slice(0, 600));
  }
} catch (e) {
  console.log(`[无记忆 KV] ${String(e)}`);
}

console.log("\n[e2e] 结束");
process.exit(0);
