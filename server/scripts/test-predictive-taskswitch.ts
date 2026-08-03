// PredictiveCoding × TaskSwitchingCortex 联动验证脚本
// 验证：任务切换信号能让 PredictiveCoding 在下一轮给出更准确的预测
//
// 运行：npx tsx scripts/test-predictive-taskswitch.ts

import {
  PredictiveCodingCortex,
  TaskSwitchingCortex,
  WorkingMemoryCortex,
} from "../src/brain/index.js";

async function main() {
  console.log("=".repeat(70));
  console.log("🧪 PredictiveCoding × TaskSwitchingCortex 联动验证");
  console.log("=".repeat(70));

  // 对比组：不联动 TaskSwitchingCortex
  const pcAlone = new PredictiveCodingCortex();
  pcAlone.registerWorkingMemory(new WorkingMemoryCortex());

  // 实验组：联动 TaskSwitchingCortex
  const pcLinked = new PredictiveCodingCortex();
  pcLinked.registerWorkingMemory(new WorkingMemoryCortex());
  const ts = new TaskSwitchingCortex();
  pcLinked.registerTaskSwitching(ts);

  // 测试场景：每对 (上轮, 本轮) 预期本轮的预测是否合理
  const scenarios: Array<{
    name: string;
    turns: Array<{ text: string; expectSwitchType?: string }>;
    expectLinkedBetterThanAlone: boolean;
    explanation: string;
  }> = [
    {
      name: "switch 切换话题 → 提出新问题",
      turns: [
        { text: "帮我查一下天气" },
        { text: "换个话题，最近有什么新闻", expectSwitchType: "switch" },
        { text: "人工智能发展到什么程度了" },
      ],
      expectLinkedBetterThanAlone: true,
      explanation: "联动后第 3 轮应预测 new_question；不联动可能仍预测 task_followup",
    },
    {
      name: "pause 暂停任务 → 闲聊/告别",
      turns: [
        { text: "帮我处理这个报告" },
        { text: "先暂停一下", expectSwitchType: "pause" },
        { text: "今天有点累" },
      ],
      expectLinkedBetterThanAlone: true,
      explanation: "联动后第 3 轮应预测 casual_chat；不联动可能预测 task_followup",
    },
    {
      name: "resume 恢复任务 → 追问任务",
      turns: [
        { text: "继续处理刚才的报告", expectSwitchType: "resume" },
        { text: "进度怎么样了" },
      ],
      expectLinkedBetterThanAlone: true,
      explanation: "联动后第 2 轮应预测 task_followup",
    },
    {
      name: "complete 完成任务 → 告别",
      turns: [
        { text: "搞定了", expectSwitchType: "complete" },
        { text: "拜拜" },
      ],
      expectLinkedBetterThanAlone: true,
      explanation: "联动后第 2 轮应预测 farewell",
    },
    {
      name: "普通对话无切换 → 联动不破坏原预测",
      turns: [
        { text: "你好" },
        { text: "嗨" },
      ],
      expectLinkedBetterThanAlone: false,
      explanation: "无切换信号，两组表现应相同（都走原预测路径）",
    },
  ];

  let passCount = 0;
  let failCount = 0;

  for (const s of scenarios) {
    console.log(`\n--- 场景：${s.name} ---`);
    console.log(`  说明：${s.explanation}`);

    // 重置两个 PC 实例的内部状态
    pcAlone.stop();
    pcLinked.stop();

    const alonePredictions: string[] = [];
    const linkedPredictions: string[] = [];
    const switchTypes: string[] = [];

    for (let i = 0; i < s.turns.length; i++) {
      const turn = s.turns[i];

      // 单独 PC
      const aloneRecent = pcAlone.getRecentTurns("u1");
      const alonePred = pcAlone.predict("u1", aloneRecent);
      const aloneError = pcAlone.compareError("u1", turn.text);
      pcAlone.updatePrediction("u1", {
        text: turn.text,
        intent: aloneError.actualIntent,
        timestamp: new Date().toISOString(),
      });
      alonePredictions.push(alonePred.predictedIntent);

      // 联动 PC：通过 taskSwitching 识别本轮切换
      const switchIntent = ts.recognizeIntent(turn.text);
      switchTypes.push(switchIntent.type);
      const linkedRecent = pcLinked.getRecentTurns("u1");
      const linkedPred = pcLinked.predict("u1", linkedRecent);
      const linkedError = pcLinked.compareError("u1", turn.text);
      pcLinked.updatePrediction("u1", {
        text: turn.text,
        intent: linkedError.actualIntent,
        timestamp: new Date().toISOString(),
        switchIntent: switchIntent.type,
      });
      linkedPredictions.push(linkedPred.predictedIntent);
    }

    console.log(`  切换信号: ${switchTypes.join(" → ")}`);
    console.log(`  独立预测: ${alonePredictions.join(" → ")}`);
    console.log(`  联动预测: ${linkedPredictions.join(" → ")}`);

    // 最后一轮的预测对比（关键观察点）
    const lastAlone = alonePredictions[alonePredictions.length - 1];
    const lastLinked = linkedPredictions[linkedPredictions.length - 1];

    let pass = false;
    if (s.expectLinkedBetterThanAlone) {
      // 期望联动后预测更合理（与场景描述匹配）
      const expectedLastIntent = s.name.includes("新问题") ? "new_question" :
        s.name.includes("闲聊/告别") ? "casual_chat" :
        s.name.includes("追问任务") ? "task_followup" :
        s.name.includes("告别") ? "farewell" : "";
      pass = expectedLastIntent === "" || lastLinked === expectedLastIntent;
      if (!pass) {
        console.log(`  ❌ 期望最后一轮预测为 ${expectedLastIntent}，实际为 ${lastLinked}`);
      }
    } else {
      // 期望两组相同（无切换场景）
      pass = lastAlone === lastLinked;
      if (!pass) {
        console.log(`  ❌ 无切换场景，两组应相同：alone=${lastAlone} linked=${lastLinked}`);
      }
    }

    // 同时验证：含 expectSwitchType 的轮次确实识别出对应切换
    for (let i = 0; i < s.turns.length; i++) {
      const t = s.turns[i];
      if (t.expectSwitchType && switchTypes[i] !== t.expectSwitchType) {
        pass = false;
        console.log(`  ❌ 第 ${i + 1} 轮应识别 ${t.expectSwitchType}，实际 ${switchTypes[i]}`);
      }
    }

    if (pass) {
      console.log(`  ✅ 通过`);
      passCount++;
    } else {
      failCount++;
    }
  }

  // 统计
  const linkedStats = pcLinked.getStats();
  console.log(`\n${"=".repeat(70)}`);
  console.log(`📊 联动 PC 统计：predictions=${linkedStats.predictions} ` +
    `taskSwitchAdjusted=${linkedStats.taskSwitchAdjusted} bypass=${linkedStats.bypassCount}`);
  console.log(`✅ 通过 ${passCount} / ❌ 失败 ${failCount}`);
  console.log("=".repeat(70));

  if (failCount > 0) process.exit(1);
}

main().catch((err) => {
  console.error("❌ 测试异常:", err);
  process.exit(1);
});
