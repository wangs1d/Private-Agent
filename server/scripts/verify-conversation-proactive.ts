/**
 * 对话内主动性端到端判定探针。
 *
 * 验证：普通对话中命中「对话内主动钩子」→ 产出的 conversation_proactive 信号
 * （严格复刻 AgentCore.maybeTriggerConversationProactive.publish 的形态）→
 * 喂给真实 ProactionCortex.decide → outcome === "speak"。
 * speak 即进入现有「主动决策闭环」→ scheduleProactive → executeProactiveDecision
 * 投递 `agent.proactive_message`（即是真的会主动发起对话）。
 *
 * 运行：cd server && npx tsx scripts/verify-conversation-proactive.ts
 */
import { ProactionCortex } from "../src/brain/proaction-cortex.js";
import {
  detectConversationProactiveHook,
} from "../src/services/agent-core.js";
import type { BrainSignalInput } from "../src/brain/types.js";

async function buildSignal(
  hookText: string,
  actorId: string,
): Promise<BrainSignalInput | null> {
  const hook = detectConversationProactiveHook(hookText);
  if (!hook) {
    console.log(`  [i] "${hookText}" 未命中任何主动钩子(正确静默)`);
    return null;
  }
  // 严格复刻 AgentCore.maybeTriggerConversationProactive 的 publish 形态
  return {
    actorId,
    kind: "conversation_proactive",
    title: hook.title,
    summary: `${hook.title}。用户原话：${hookText.slice(0, 64)}`,
    importance: hook.importance,
    metadata: {
      source: "agent_inference",
      tags: [hook.kind, "conversation"],
      occurredAt: new Date().toISOString(),
    },
  };
}

async function main() {
  // 每个用例独立 actorId，隔离 recency/repeat_suppress（真实场景有 8 分钟
  // cooldown，同一用户不会短时间连发两条钩子；repeat_suppress 本就是防打扰设计）。
  const cortex = new ProactionCortex();

  // 未注册 AwarenessCortex → activityPenalty=0；未注册 ContactPolicy → policy 放行。
  const cases: Array<{ label: string; text: string }> = [
    { label: "健康关怀(care)", text: "今天加班到好累，真的有点睡不着" },
    { label: "跟进(followup)", text: "简历HR让我等结果，帮我盯着点" },
    { label: "普通闲聊(应静默)", text: "周末去爬山，山里空气不错" },
  ];

  let pass = 0;
  let fail = 0;
  for (const c of cases) {
    const actorId = `probe-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const signal = await buildSignal(c.text, actorId);
    if (!signal) {
      console.log(`✔ [静默正确] ${c.label}`);
      continue;
    }
    const d = await cortex.decide(signal);
    const ok = d.outcome === "speak";
    console.log(
      `${ok ? "✔" : "✘"} [${c.label}] importance=${signal.importance} outcome=${d.outcome} rationale=${String(d.rationale ?? "")}`,
    );
    ok ? pass++ : fail++;
  }

  console.log(`\n结论：对话内主动信号 → ProactionCortex 判定 speak=${pass}/${pass + fail}` +
    (fail === 0 ? " → 会真的主动发起对话 ✔" : " → 存在未通过的场景 ✘"));

  // 明确说明投递层（复用既有链路，非本次范围）
  console.log(
    `\n说明：outcome=speak 后由既有闭环接管：scheduleProactive → executeProactiveDecision\n` +
    `      → SynapseBus.sendToUser 投递 agent.proactive_message（Agent 主动联系）。`,
  );
}

main().catch((err) => {
  console.error("[探针] 失败:", err);
  process.exit(1);
});