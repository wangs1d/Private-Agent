import { OnlineLearningCortex } from "../src/brain/online-learning-cortex.js";

const ACTOR = "test-user-001";

function makeRoute(mode: "fast" | "complex") {
  return {
    mode,
    confidence: 0.8,
    reason: "test",
    matchedRules: ["test"],
    system: "system1" as const,
  };
}

async function main() {
  console.log("=========================================");
  console.log("  主动学习循环功能测试");
  console.log("=========================================\n");

  const cortex = new OnlineLearningCortex();

  // =========================================================
  // 测试 1：3 轮正常对话，验证 observeCount 递增
  // =========================================================
  console.log("─── 测试 1：3 轮正常对话，observeCount 递增 ───\n");

  const round1 = "你好，今天天气不错";
  cortex.observe(ACTOR, { text: round1 }, makeRoute("fast"));
  console.log(`第 1 轮 observe 后 observeCount = ${cortex.getStats().observeCount}（期望 1）`);

  const round2 = "帮我查一下北京的天气";
  cortex.observe(ACTOR, { text: round2 }, makeRoute("fast"));
  console.log(`第 2 轮 observe 后 observeCount = ${cortex.getStats().observeCount}（期望 2）`);

  const round3 = "我喜欢简洁的回答";
  cortex.observe(ACTOR, { text: round3 }, makeRoute("fast"));
  console.log(`第 3 轮 observe 后 observeCount = ${cortex.getStats().observeCount}（期望 3）`);

  const pass1 = cortex.getStats().observeCount === 3;
  console.log(`  → 结果: ${pass1 ? "✓ 通过" : "✗ 失败"}\n`);

  // =========================================================
  // 测试 2：recordCorrection() 验证 negativeFeedbackCount 增加
  // =========================================================
  console.log("─── 测试 2：recordCorrection() 增加 negativeFeedbackCount ───\n");

  const profileBefore = cortex.getProfile(ACTOR);
  console.log(`纠正前 negativeFeedbackCount = ${profileBefore.negativeFeedbackCount}（期望 0）`);

  cortex.recordCorrection(ACTOR, "不是这样，应该是有Python");
  const profileAfter = cortex.getProfile(ACTOR);
  console.log(`纠正后 negativeFeedbackCount = ${profileAfter.negativeFeedbackCount}（期望 1）`);

  const pass2 = profileAfter.negativeFeedbackCount === 1;
  console.log(`  → 结果: ${pass2 ? "✓ 通过" : "✗ 失败"}\n`);

  // =========================================================
  // 测试 3：纠正后偏好置信度被降权
  // =========================================================
  console.log("─── 测试 3：纠正后偏好置信度被降权 ───\n");

  // 先观察几句带偏好的文本，建立偏好条目
  cortex.observe(ACTOR, { text: "我偏爱用Python写脚本" }, makeRoute("complex"));
  const preCorrection = cortex.getProfile(ACTOR);
  const prefBefore = preCorrection.preferences.find((e) => e.key === "preference");
  console.log(`纠正前偏好 confidence = ${prefBefore?.confidence?.toFixed(2) ?? "N/A"}`);

  // 再纠正
  cortex.recordCorrection(ACTOR, "你理解错了，应该是Java");

  const postCorrection = cortex.getProfile(ACTOR);
  // 降权：observations <= 3 的条目 confidence × 0.5，下限 0.1
  // 初始 confidence 是 0.6（explicit），经历 observe 一次会 +0.2 变成 0.8
  // 降权后变成 0.8 * 0.5 = 0.4
  console.log("纠正后偏好条目状态：");
  for (const p of postCorrection.preferences) {
    console.log(`  key=${p.key}, value=${p.value}, confidence=${p.confidence.toFixed(2)}, observations=${p.observations}`);
  }

  // 找到被降权的条目（observations <= 3 的 preference 条目）
  const downgraded = postCorrection.preferences.filter(
    (e) => e.observations <= 3 && e.key === "preference",
  );
  // 降权逻辑：confidence * 0.5，下限 0.1
  // 原始 confidence 0.8（explicit 0.6 + observe 一次 +0.2），降权后 = max(0.1, 0.8 * 0.5) = 0.4
  const pass3 = downgraded.length > 0 && downgraded.every((e) => e.confidence <= 0.5);
  console.log(`  → 结果: ${pass3 ? "✓ 通过" : "✗ 失败"}（降权后 confidence ≤ 0.5）\n`);

  // =========================================================
  // 测试 4："应该是有Python" 提取正确信号
  // =========================================================
  console.log("─── 测试 4：「应该是有Python」提取正确信号 ───\n");

  // 创建一个新的 actor 测试信号提取
  cortex.recordCorrection("test-signal-extract", "不对，应该是有Python");

  const signalProfile = cortex.getProfile("test-signal-extract");
  const correctedEntry = signalProfile.preferences.find(
    (e) => e.key === "corrected_preference",
  );
  console.log(`提取到的 corrected_preference value = "${correctedEntry?.value ?? "N/A"}"（期望 "有Python"）`);

  const pass4 = correctedEntry?.value === "有Python";
  console.log(`  → 结果: ${pass4 ? "✓ 通过" : "✗ 失败"}\n`);

  // =========================================================
  // 汇总
  // =========================================================
  console.log("=========================================");
  console.log("  测试汇总");
  console.log("=========================================");
  console.log(`  测试 1 (observeCount 递增):    ${pass1 ? "✓ 通过" : "✗ 失败"}`);
  console.log(`  测试 2 (negativeFeedbackCount): ${pass2 ? "✓ 通过" : "✗ 失败"}`);
  console.log(`  测试 3 (置信度降权):           ${pass3 ? "✓ 通过" : "✗ 失败"}`);
  console.log(`  测试 4 (信号提取):             ${pass4 ? "✓ 通过" : "✗ 失败"}`);
  console.log("=========================================");

  if (pass1 && pass2 && pass3 && pass4) {
    console.log("\n🎉 全部测试通过！\n");
  } else {
    console.log("\n❌ 部分测试失败，请检查上面日志。\n");
  }
}

main().catch(console.error);