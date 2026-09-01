import { resolveChatToolPlanForStream } from "../../src/external-model/resolve-chat-tools.js";
import { getFastLaneTools } from "../../src/external-model/openai-compatible-tool-loop.js";
import { routeLlmExecution } from "../../src/agent/task-router.js";

const fast = getFastLaneTools();
console.log("fastLane tool count (incl escalate):", fast.length);
console.log(fast.map((t) => t.function?.name).join(", "));

const queries = [
  "查一下最近有什么新闻",
  "帮我搜一下景甜最近怎么样了",
  "今天天气怎么样",
  "现在几点",
  "帮我创建一个提醒",
  "写一个方案",
];
for (const q of queries) {
  const plan = resolveChatToolPlanForStream(q, {
    chatToolsBuiltin: fast,
    chatToolsExtra: [],
    toolExposureProfile: "contextual",
    disableToolSearch: true,
    pinnedToolNames: ["agent.escalate_to_complex"],
  });
  const names = plan.visibleTools.map((t) => t.function?.name);
  console.log(`\n[query] ${q}`);
  console.log("  visible(", names.length, "):", names.join(", "));
  console.log(
    "  has search_web:",
    names.includes("search_web"),
    "| has escalate:",
    names.includes("agent.escalate_to_complex"),
  );
  const d = routeLlmExecution(q);
  console.log("  route:", d.mode, d.reasons.join(","));
}
