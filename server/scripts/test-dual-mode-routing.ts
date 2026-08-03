/**
 * 双模式路由实际场景测试。
 * 验证 Fast/Complex 双模式在各种真实用户消息下的路由决策。
 */
import { routeLlmExecution } from "../src/agent/task-router.js";
import { shouldEmitInterimAck, shouldUsePhasedAsyncConversation } from "../src/agent/interim-ack.js";

const config = {
  masterDelegation: { enabled: true },
} as Parameters<typeof routeLlmExecution>[1];

interface TestCase {
  label: string;
  message: string;
  expectMode: "fast" | "complex";
}

const cases: TestCase[] = [
  // ---- Fast 模式场景 ----
  { label: "寒暄", message: "你好呀，在吗", expectMode: "fast" },
  { label: "简单问答", message: "请简单解释一下什么是向量数据库", expectMode: "fast" },
  { label: "代码解释", message: "帮我解释一下 Python 里列表推导式和 for 循环的区别", expectMode: "fast" },
  { label: "查天气", message: "帮我查一下今天北京的天气", expectMode: "fast" },
  { label: "查时间", message: "现在几点了", expectMode: "fast" },
  { label: "追问", message: "那个具体说说", expectMode: "fast" },
  { label: "陈述数据", message: "今天20到26度", expectMode: "fast" },

  // ---- Complex 模式场景 ----
  { label: "多步调研", message: "帮我调研对比一下三款主流向量数据库的优缺点", expectMode: "complex" },
  { label: "购物下单", message: "帮我在京东下单买一个蓝牙耳机", expectMode: "complex" },
  { label: "桌面自动化", message: "打开微信帮我发消息给张三", expectMode: "complex" },
  { label: "写文案", message: "帮我写一篇关于新产品的营销文案", expectMode: "complex" },
  { label: "多步任务", message: "先搜索三个网站的价格然后对比最后生成报告", expectMode: "complex" },
];

console.log("=".repeat(70));
console.log("双模式路由实际场景测试");
console.log("=".repeat(70));

let pass = 0;
let fail = 0;

for (const tc of cases) {
  const route = routeLlmExecution(tc.message, config);
  const interim = shouldEmitInterimAck(tc.message, route.mode);
  const phased = shouldUsePhasedAsyncConversation(tc.message, route.mode);
  const ok = route.mode === tc.expectMode;

  const icon = ok ? "✓" : "✗";
  const modeTag = route.mode === "fast" ? "[FAST]" : "[COMPLEX]";
  const interimTag = interim ? "垫词" : "无垫词";
  const phasedTag = phased ? "分步" : "单回";

  console.log(`${icon} ${modeTag} ${tc.label.padEnd(8)} | ${interimTag} ${phasedTag} | "${tc.message.slice(0, 30)}"`);

  if (!ok) {
    console.log(`  → 预期 ${tc.expectMode}，实际 ${route.mode}，reasons: ${route.reasons.join(",")}`);
    fail++;
  } else {
    pass++;
  }
}

console.log("=".repeat(70));
console.log(`结果: ${pass}/${cases.length} 通过, ${fail} 失败`);
console.log("=".repeat(70));
