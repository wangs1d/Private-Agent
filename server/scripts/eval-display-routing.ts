/**
 * 展示路由批量评测脚本（金样本语料库 → 准确率 + 混淆矩阵）。
 *
 * 用法：
 *   npm run eval:routing            # 汇总报告
 *   npm run eval:routing -- -v      # 附带逐条明细（含错判样本）
 *
 * 语料：test/fixtures/display-routing-corpus.ts。调整路由权重/阈值/正则
 * 后先跑本脚本看整体准确率与混淆对，再决定是否合入——避免「修好一个
 * 案例、悄悄弄坏另一个」。
 */

import { routeDisplayEffect } from "../src/services/display-effect-router.js";
import { classifyRenderHint } from "../src/services/render-hint-service.js";
import {
  CARD_CORPUS,
  HINT_CORPUS,
  type CardCase,
  type HintCase,
} from "../test/fixtures/display-routing-corpus.js";

const verbose = process.argv.includes("-v") || process.argv.includes("--verbose");

interface Tally {
  total: number;
  correct: number;
  /** expected → got 混淆计数（仅错判） */
  confusion: Map<string, Map<string, string[]>>;
}

function newTally(): Tally {
  return { total: 0, correct: 0, confusion: new Map() };
}

function record(tally: Tally, expected: string, got: string, name: string): void {
  tally.total++;
  if (expected === got) {
    tally.correct++;
    return;
  }
  let byGot = tally.confusion.get(expected);
  if (!byGot) {
    byGot = new Map();
    tally.confusion.set(expected, byGot);
  }
  const names = byGot.get(got) ?? [];
  names.push(name);
  byGot.set(got, names);
}

function evalCard(c: CardCase): { expected: string; got: string } {
  return { expected: c.expected, got: routeDisplayEffect(c.input) };
}

function evalHint(h: HintCase): { expected: string; got: string } {
  const hint = classifyRenderHint(h.text, { toolName: h.toolName, userText: h.userText });
  return { expected: h.expected, got: hint.type };
}

function report(title: string, tally: Tally): void {
  const acc = tally.total === 0 ? 0 : (tally.correct / tally.total) * 100;
  console.log(`\n== ${title} ==`);
  console.log(`样本 ${tally.total}，正确 ${tally.correct}，准确率 ${acc.toFixed(1)}%`);
  if (tally.confusion.size === 0) {
    console.log("无错判。");
    return;
  }
  console.log("混淆（期望 → 实际）：");
  const rows = [...tally.confusion.entries()].sort((a, b) => {
    const sa = [...a[1].values()].reduce((n, l) => n + l.length, 0);
    const sb = [...b[1].values()].reduce((n, l) => n + l.length, 0);
    return sb - sa;
  });
  for (const [expected, byGot] of rows) {
    for (const [got, names] of byGot) {
      console.log(`  ${expected || "(generic)"} → ${got || "(generic)"} ×${names.length}`);
      if (verbose) {
        for (const n of names) console.log(`      - ${n}`);
      }
    }
  }
}

const cardTally = newTally();
for (const c of CARD_CORPUS) {
  const { expected, got } = evalCard(c);
  record(cardTally, expected, got, c.name);
}

const hintTally = newTally();
for (const h of HINT_CORPUS) {
  const { expected, got } = evalHint(h);
  record(hintTally, expected, got, h.name);
}

report("卡片级路由 routeDisplayEffect", cardTally);
report("消息级路由 classifyRenderHint", hintTally);

const total = cardTally.total + hintTally.total;
const correct = cardTally.correct + hintTally.correct;
console.log(`\n总计：${correct}/${total}（${total === 0 ? 0 : ((correct / total) * 100).toFixed(1)}%）`);
