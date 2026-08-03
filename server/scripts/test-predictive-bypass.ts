// PredictiveCoding bypass 阈值调参验证脚本
// 验证「你好 → 嗨」「今天天气不错 → 是啊」等寒暄/闲聊场景能真正触发 System 0 快速路径
//
// 运行：npx tsx scripts/test-predictive-bypass.ts

import {
  PredictiveCodingCortex,
  WorkingMemoryCortex,
} from "../src/brain/index.js";

async function main() {
  console.log("=".repeat(70));
  console.log("🧪 PredictiveCoding bypass 阈值调参验证");
  console.log("=".repeat(70));

  const pc = new PredictiveCodingCortex();
  const wm = new WorkingMemoryCortex();
  pc.registerWorkingMemory(wm);

  // 测试场景：每对输入代表「上轮 → 本轮」，预期 bypass
  const scenarios: Array<{
    name: string;
    turns: string[];
    expectBypassAt: number[]; // 哪一轮应该 bypass
  }> = [
    {
      name: "寒暄接力：你好 → 嗨 → 在吗",
      turns: ["你好", "嗨", "在吗"],
      expectBypassAt: [1, 2], // 第 2/3 轮应 bypass
    },
    {
      name: "闲聊延续：今天天气不错 → 是啊 → 挺舒服的",
      turns: ["今天天气不错", "是啊", "挺舒服的"],
      expectBypassAt: [1, 2],
    },
    {
      name: "告别收尾：拜拜 → 再见 → 下次聊",
      turns: ["拜拜", "再见", "下次聊"],
      expectBypassAt: [1, 2],
    },
    {
      name: "正常问答不应 bypass：帮我查天气 → 北京天气怎么样",
      turns: ["帮我查天气", "北京天气怎么样"],
      expectBypassAt: [], // 工具请求类不应 bypass
    },
  ];

  let passCount = 0;
  let failCount = 0;

  for (const s of scenarios) {
    console.log(`\n--- 场景：${s.name} ---`);
    const bypassResults: boolean[] = [];

    for (let i = 0; i < s.turns.length; i++) {
      const text = s.turns[i];
      const recentTurns = pc.getRecentTurns("u1");
      const prediction = pc.predict("u1", recentTurns);
      const error = pc.compareError("u1", text);
      pc.updatePrediction("u1", {
        text,
        intent: error.actualIntent,
        timestamp: new Date().toISOString(),
      });

      const marker = error.shouldBypass ? "⚡BYPASS" : "  cognize";
      console.log(
        `  轮 ${i + 1} 「${text}」 → pred=${prediction.predictedIntent}(${prediction.confidence.toFixed(2)}) ` +
          `actual=${error.actualIntent} err=${error.error.toFixed(2)} ${marker} | ${error.reason}`,
      );
      bypassResults.push(error.shouldBypass);
    }

    // 验证期望
    let allPass = true;
    for (const idx of s.expectBypassAt) {
      if (!bypassResults[idx]) {
        console.log(`  ❌ 第 ${idx + 1} 轮应 bypass 但未 bypass`);
        allPass = false;
        failCount++;
        break;
      }
    }
    if (allPass) {
      // 同时验证不应 bypass 的轮次
      for (let i = 0; i < bypassResults.length; i++) {
        if (!s.expectBypassAt.includes(i) && bypassResults[i]) {
          console.log(`  ❌ 第 ${i + 1} 轮不应 bypass 但 bypass 了`);
          allPass = false;
          failCount++;
          break;
        }
      }
      if (allPass) {
        console.log(`  ✅ 通过`);
        passCount++;
      }
    }
  }

  // 统计
  const stats = pc.getStats();
  console.log(`\n${"=".repeat(70)}`);
  console.log(`📊 统计：predictions=${stats.predictions} bypass=${stats.bypassCount} ` +
    `accurate=${stats.accurateCount} highError=${stats.highErrorCount} bypassRate=${(stats.bypassRate * 100).toFixed(0)}%`);
  console.log(`✅ 通过 ${passCount} / ❌ 失败 ${failCount}`);
  console.log("=".repeat(70));

  if (failCount > 0) process.exit(1);
}

main().catch((err) => {
  console.error("❌ 测试异常:", err);
  process.exit(1);
});
