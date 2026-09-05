// ProactiveOutboundMessageService 统一管道收敛单测：
// 注入 pipelineSubmit 后 send() 组装 ProactiveProposal 转投（kind 映射 / urgency→importance /
// directText 直投 / dedupKey 指纹）；未注入时保持 legacy 直发路径（向后兼容）。
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ProactiveOutboundMessageService,
  type ProactivePipelineSubmitter,
} from "../src/services/proactive-outbound-message-service.js";
import type { ArbitrationDecision, ProactiveProposal } from "../src/proactivity/pipeline-types.js";

const ACTOR = "user-a";

function decisionOf(verdict: ArbitrationDecision["verdict"]): ArbitrationDecision {
  return {
    proposal: {} as ProactiveProposal,
    verdict,
    reasonChain: [verdict],
  };
}

test("pipelineSubmit 注入：send 组装提案转投管道（care 映射 / urgency→importance）", async () => {
  const captured: ProactiveProposal[] = [];
  const submit: ProactivePipelineSubmitter = (p) => {
    captured.push(p);
    return decisionOf("delivered");
  };
  const svc = new ProactiveOutboundMessageService(null, null, submit);
  const sent = await svc.send({
    actorId: ACTOR,
    title: "记得休息",
    text: "你已连续工作 5 小时了，休息一下吧",
    reason: "anticipation:care",
    meta: { urgency: 7.2 },
  });

  assert.equal(sent, true);
  assert.equal(captured.length, 1);
  const p = captured[0];
  assert.equal(p.actorId, ACTOR);
  assert.equal(p.kind, "care", "anticipation:care 应映射到频控器已知 kind");
  assert.equal(p.tier, "social");
  assert.equal(p.importance, "medium", "urgency 7.2 → medium");
  assert.equal(p.directText, "你已连续工作 5 小时了，休息一下吧");
  assert.ok(p.dedupKey.startsWith(`outbound:anticipation:care:${ACTOR}:`));
  assert.equal(p.source, "legacy-runtime");
});

test("pipelineSubmit 注入：urgency 8+ 映射 high；warning 类映射 life_reminder", async () => {
  const captured: ProactiveProposal[] = [];
  const submit: ProactivePipelineSubmitter = (p) => {
    captured.push(p);
    return decisionOf("delivered");
  };
  const svc = new ProactiveOutboundMessageService(null, null, submit);
  await svc.send({
    actorId: ACTOR,
    title: "电费异常",
    text: "本月电费较上月上涨 300%",
    reason: "anticipation:warning",
    meta: { urgency: 8.5 },
  });
  assert.equal(captured[0].importance, "high");
  assert.equal(captured[0].kind, "life_reminder");
});

test("pipelineSubmit 注入：verdict=deferred 时 send 返回 false 但消息仍进管道（离线挂起）", async () => {
  const captured: ProactiveProposal[] = [];
  const svc = new ProactiveOutboundMessageService(null, null, (p) => {
    captured.push(p);
    return decisionOf("deferred");
  });
  const sent = await svc.send({
    actorId: ACTOR,
    title: "周报提醒",
    text: "该写周报了",
    reason: "anticipation:follow_up",
  });
  assert.equal(sent, false);
  assert.equal(captured.length, 1, "提案已提交管道（挂起待重连），不是丢消息");
  assert.equal(captured[0].kind, "followup");
  assert.equal(svc.getRecent(ACTOR).length, 1, "本地历史照常记录（线程上下文依赖）");
});

test("未注入 pipelineSubmit：保持 legacy 直发路径（envelope 结构不变）", async () => {
  const envelopes: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const svc = new ProactiveOutboundMessageService(async (_userId, payload) => {
    envelopes.push(payload as { type: string; payload: Record<string, unknown> });
    return true;
  });
  const sent = await svc.send({
    actorId: ACTOR,
    title: "问候",
    text: "早上好",
    reason: "greeting",
  });
  assert.equal(sent, true);
  assert.equal(envelopes.length, 1);
  assert.equal(envelopes[0].type, "agent.proactive_message");
});
