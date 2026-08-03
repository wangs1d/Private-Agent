/**
 * RuntimeKernel 多用户隔离验证
 *
 * 改造后架构：getRuntimeKernel(actorId) 返回 per-actor 实例，默认共享 singleton 作 fallback
 *
 * 验证场景：用户 A / B 并发使用 Agent
 *   1. A 把 identity 改为 "tech-buddy-A"，B 的 buildSessionSystem 应不受影响
 *   2. A 修改 bannedPatterns，B 的 postValidate 应使用 B 自己的规则
 *   3. A 切到 legacy，B 应仍保持 minimal
 *   4. A 的修改不污染默认 singleton（新 actor 加入时继承默认而非 A 的修改）
 */
import {
  getRuntimeKernel,
  resetActorRuntimeKernelsForTest,
} from "../src/agent/runtime-kernel.js";

function section(title: string): void {
  console.log("\n" + "=".repeat(80));
  console.log(title);
  console.log("=".repeat(80));
}

async function main(): Promise<void> {
  resetActorRuntimeKernelsForTest();
  const defaultKernel = getRuntimeKernel(); // 默认 singleton

  section("0. 初始状态");
  const initialSnap = defaultKernel.snapshot();
  console.log(`默认 persona: ${initialSnap.identity.persona.join("/")}`);
  console.log(`默认 promptMode: ${initialSnap.promptMode}`);
  console.log(`默认 bannedPatterns count: ${initialSnap.postValidation.bannedPatterns.length}`);

  section("1. 用户 A 通过 per-actor API 修改身份");
  const kernelA = getRuntimeKernel("actor-A");
  kernelA.update({
    identity: {
      persona: ["tech-buddy-A", "pair-programmer"],
      values: ["code-first"],
      style: ["terse"],
    },
  });
  console.log("A 的 buildSessionSystem():");
  console.log("  " + (kernelA.buildSessionSystem() ?? "").replace(/\n/g, "\n  "));

  section("2. 用户 B 同时使用 Agent（per-actor 独立实例）");
  const kernelB = getRuntimeKernel("actor-B");
  const bSessionSys = kernelB.buildSessionSystem() ?? "";
  console.log(`B 的 sessionSys: ${bSessionSys}`);
  const bSeesAIdentity = bSessionSys.includes("tech-buddy-A");
  console.log(`→ B 是否受 A 身份污染：${bSeesAIdentity ? "❌ 是（污染）" : "✅ 否（隔离）"}`);

  section("3. 用户 A 修改 bannedPatterns");
  kernelA.update({
    postValidation: {
      bannedPatterns: ["A-only-secret-pattern", "how to hack server"],
    },
  });
  console.log("A 的 bannedPatterns: " + kernelA.snapshot().postValidation.bannedPatterns.join(", "));
  console.log("B 的 bannedPatterns: " + kernelB.snapshot().postValidation.bannedPatterns.join(", "));

  section("4. 用户 B 的 postValidate 应使用 B 自己的规则");
  const bPostResult = kernelB.postValidate("how to hack server");
  console.log(`B 测试 "how to hack server" → ${bPostResult.ok ? "✅ 通过（B 不受 A 规则影响）" : "❌ 违规"}`);
  const aPostResult = kernelA.postValidate("how to hack server");
  console.log(`A 测试 "how to hack server" → ${aPostResult.ok ? "✅ 通过" : "❌ 违规（A 的规则生效）"}`);
  console.log(`→ B 是否受 A 的 bannedPatterns 污染：${bPostResult.ok ? "✅ 否（隔离）" : "❌ 是（污染）"}`);

  section("5. 用户 A 切换 promptMode 到 legacy");
  kernelA.update({ promptMode: "legacy" });
  const bPlan = kernelB.planTurn("今天天气怎么样");
  const aPlan = kernelA.planTurn("今天天气怎么样");
  console.log(`A 的 planTurn.promptMode = ${aPlan.promptMode}（应为 legacy）`);
  console.log(`B 的 planTurn.promptMode = ${bPlan.promptMode}（应为 minimal）`);
  console.log(`→ B 是否受 A 的 promptMode 污染：${bPlan.promptMode === "minimal" ? "✅ 否（隔离）" : "❌ 是（污染）"}`);

  section("6. 新用户 C 加入时继承默认 singleton，不受 A 修改影响");
  const kernelC = getRuntimeKernel("actor-C");
  const cSnap = kernelC.snapshot();
  console.log(`C 的 persona: ${cSnap.identity.persona.join("/")}（应为 private-butler 默认）`);
  console.log(`C 的 promptMode: ${cSnap.promptMode}（应为 minimal）`);
  const cInheritsDefault = cSnap.identity.persona[0] === "private-butler" && cSnap.promptMode === "minimal";
  console.log(`→ C 是否正确继承默认而非 A 的修改：${cInheritsDefault ? "✅ 是" : "❌ 否"}`);

  section("总结");
  const issues = [
    { issue: "身份隔离（A 改 persona → B 不受影响）", ok: !bSeesAIdentity },
    { issue: "bannedPatterns 隔离（A 改规则 → B 不受影响）", ok: bPostResult.ok },
    { issue: "promptMode 隔离（A 切模式 → B 不受影响）", ok: bPlan.promptMode === "minimal" },
    { issue: "新 actor 继承默认 singleton（不受 A 修改污染）", ok: cInheritsDefault },
  ];
  for (const i of issues) {
    console.log(`  ${i.ok ? "✅" : "❌"} ${i.issue}`);
  }
  const allIsolated = issues.every((i) => i.ok);
  console.log(`\n结论：${allIsolated ? "✅ 多用户隔离良好" : "❌ 仍有污染问题"}`);

  resetActorRuntimeKernelsForTest();
  process.exit(allIsolated ? 0 : 1);
}

void main();
