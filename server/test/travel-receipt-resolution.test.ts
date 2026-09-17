import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 旅游行程卡 done 阶段投递链路回归（2026-09-18 漏卡根因锁定）：
 *
 * 真实轮次回放发现：任务面（task_plane）收尾此前没有冷层回捞兜底，且 WS 路径
 * 在 reply.toolName 落在其他工具（如 travel.destination-info）时会被短路掉
 * 冷层回捞——行程已生成落盘，但最终消息里没有 travel_itinerary 独立卡。
 *
 * 本文件锁定 resolveTravelReceipt 的三路裁决语义，以及
 * attach → normalizeReplyCardLayout → buildReplyBlocks 全链产物中
 * 行程卡必须作为最后一个 card 块下发。
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "travel-receipt-test-"));
process.env.TRAVEL_PLAN_STORE_DIR = tmpDir;

// 环境变量须在模块导入前设置（travelPlanStore 单例构造时读取）
const { travelPlanStore } = await import(
  "../src/skills/travel-planning/travel-plan-store.js"
);
const { resolveTravelReceipt, attachDeterministicCards } = await import(
  "../src/services/deterministic-card-chain.js"
);
const { normalizeReplyCardLayout, buildReplyBlocks } = await import(
  "../src/services/reply-envelope.js"
);

const NOW = Date.now();

function savePlan(
  planId: string,
  destination: string,
  createdAtOffsetMs: number,
): void {
  travelPlanStore.save({
    planId,
    destination,
    title: `${destination}3日游`,
    startDate: "2026-10-01",
    endDate: "2026-10-03",
    createdAt: NOW + createdAtOffsetMs,
    days: [
      {
        date: "2026-10-01",
        items: [
          {
            type: "attraction",
            name: `${destination}老城`,
            startTime: "09:00",
            latitude: 30,
            longitude: 120,
            address: "",
            priceInfo: "",
            description: "",
          },
        ],
      },
    ],
  });
}

const SLIM_RECEIPT = {
  ok: true,
  id: "plan-slim-1",
  title: "厦门3日游·海景/海鲜",
  destination: "厦门",
  dayCount: 3,
};

test("回执裁决：直跑瘦身回执（只有 id）→ 交给 attach 按 planId 冷层补全", () => {
  const r = resolveTravelReceipt({
    replyToolName: "travel.plan-itinerary",
    replyToolResult: SLIM_RECEIPT,
    nowMs: NOW,
  });
  assert.equal(r.toolName, "travel.plan-itinerary");
  assert.equal(r.result?.id, "plan-slim-1");
});

test("回执裁决：reply.toolName 是其他工具（destination-info）不短路——捕获的行程回执仍生效", () => {
  const r = resolveTravelReceipt({
    replyToolName: "travel.destination-info",
    replyToolResult: { ok: true, destination: "厦门", visa: "免签" },
    executedReceipt: SLIM_RECEIPT,
    nowMs: NOW,
  });
  assert.equal(r.toolName, "travel.plan-itinerary");
  assert.equal(r.result?.id, "plan-slim-1");
});

test("回执裁决：捕获漏拍 → 冷层近窗回捞，正文点名目的地优先", () => {
  savePlan("plan-old-1", "杭州", -10 * 60 * 1000); // 窗口外
  savePlan("plan-fresh-xian", "西安", -5 * 1000);
  savePlan("plan-fresh-xiamen", "厦门", -3 * 1000);
  const r = resolveTravelReceipt({
    goal: "帮我规划去厦门的行程",
    finalText: "你的行程已经排好了，重点帮你列一下。",
    nowMs: NOW,
  });
  assert.equal(r.toolName, "travel.plan-itinerary");
  assert.equal((r.result as { planId?: string }).planId, "plan-fresh-xiamen");
});

test("回执裁决：正文不含目的地 → 取窗口内最新一份", () => {
  const r = resolveTravelReceipt({
    goal: "帮我规划一下",
    finalText: "行程排好了。",
    nowMs: NOW,
  });
  assert.equal(r.toolName, "travel.plan-itinerary");
  assert.equal((r.result as { planId?: string }).planId, "plan-fresh-xiamen");
});

test("回执裁决：窗口内无行程 → 不附卡", () => {
  const r = resolveTravelReceipt({
    goal: "今天天气怎么样",
    finalText: "今天晴。",
    nowMs: NOW + 60 * 60 * 1000, // 全部超出窗口
  });
  assert.equal(r.toolName, undefined);
  assert.equal(r.result, undefined);
});

test("回执裁决：规划执行失败 → 不回捞旧行程误挂到失败轮", () => {
  const r = resolveTravelReceipt({
    replyToolName: "travel.plan-itinerary",
    replyToolResult: { ok: false, error: "规划失败" },
    nowMs: NOW,
  });
  assert.equal(r.toolName, undefined);
  assert.equal(r.result, undefined);
});

test("全链产物：attach → 版式归一 → blocks，行程卡必须是最后一个 card 块", () => {
  savePlan("plan-tail-1", "厦门", 0);
  // 瘦身回执的 id 必须能在冷层命中（与真实链路一致：skill 先落盘再返回回执）
  const slimReceiptForTail = { ...SLIM_RECEIPT, id: "plan-tail-1", title: "厦门3日游" };
  const resolved = resolveTravelReceipt({
    executedReceipt: slimReceiptForTail,
    goal: "去厦门玩3天",
    finalText: "厦门的行程帮你排好了。",
    nowMs: NOW,
  });
  assert.ok(resolved.result);

  // 模型总览卡（LLM 口语回复被切成通用卡）+ 正文 + 确定性附行程卡
  let text =
    "[AGENT_RESULT_CARD_START]{\"title\":\"厦门行程概览\",\"items\":[{\"type\":\"num\",\"text\":\"Day 1 集美学村\"}],\"footer\":\"\"}[AGENT_RESULT_CARD_END]\n\n厦门的行程帮你排好了。";
  text = attachDeterministicCards({
    text,
    travelToolName: resolved.toolName,
    travelResult: resolved.result,
  });
  text = normalizeReplyCardLayout(text);
  const blocks = buildReplyBlocks(text);
  assert.ok(blocks, "blocks 应下发（无 v1 未支持标记）");

  const cardIdxs = blocks!
    .map((b, i) => (b.type === "card" ? i : -1))
    .filter((i) => i >= 0);
  assert.equal(cardIdxs.length, 2, "应有总览卡 + 行程卡两个 card 块");
  const first = blocks![cardIdxs[0]];
  const last = blocks![cardIdxs[1]];
  if (!("card" in first) || !("card" in last)) return assert.fail("unreachable");
  assert.notEqual(
    (first.card as Record<string, unknown>).cardType,
    "travel_itinerary",
    "总览卡置首",
  );
  assert.equal(
    (last.card as Record<string, unknown>).cardType,
    "travel_itinerary",
    "行程卡独立收尾在最后",
  );
  assert.ok(
    ((last.card as Record<string, unknown>).title as string).includes("厦门"),
  );
});
