// E2E v2：修正版全形态真机触发矩阵（2026-09-22）。
// 相比 v1 的修正：
//   1. 任务面异步轮：第一条 done 常为空（source=task_plane 派发），真结果由后台
//      完成后回灌为后续 done —— 本版收集窗口内全部 done，取最后一条非空 finalText；
//   2. schedule：同会话两轮（先建日程再查询），修复空日历数据依赖；
//   3. 内容信号类话术按路由评分器收紧（A/B 标签、纯短标签、长清单、禁联网等）。
import WebSocket from "ws";

const WS_URL = process.env.WS_URL ?? "ws://127.0.0.1:3000/ws";

const ROUNDS = [
  { name: "wallet 钱包卡(异步回灌)", text: "查一下我钱包还剩多少钱" },
  { name: "travel 行程卡(异步回灌)", text: "帮我规划去成都两天的行程" },
  { name: "product_compare 比价卡(异步回灌)", text: "帮我推荐对比一下两款适合油皮的粉底液" },
  { name: "markdown 表格(纯计算)", text: "不要联网。把 3、7、12 这三个数整理成 markdown 表格，三列：数字/平方/立方" },
  { name: "chips 标签胶囊(收紧)", text: "给我5个可以聊的话题。格式必须是每行一个、不超过6个字的短标签，不要序号不要解释不要正文" },
  { name: "comparison_table(收紧)", text: "不要联网。用 A/B 对比格式对比通勤方式：A=地铁，B=自驾，每边各4条要点" },
  { name: "fold_list 折叠清单(收紧)", text: "不要联网。给我一份搬家准备清单，12条，每条一句备注，用短横线列表，不要按时间排" },
  { name: "data_brief 快报(收紧)", text: "不要联网。出一份8月支出快报：总支出4213元，环比-12%，餐饮占比38%，记账23天，最大单笔1602元。做成带结论一句+数据点列表的快报" },
  { name: "summary 详情卡(禁联网)", text: "不要联网搜索。直接凭你的知识写一篇2026年新能源车选购指南，1500字以上，分4个板块，用标题分节" },
  { name: "quote 引用卡(收紧)", text: "帮我把这句话记进今天的心情日记，用 markdown 引用块格式输出（大于号开头）：不是选择正确的那条路，而是把选的路走对" },
];

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function collectEvidence(done) {
  const finalText = String(done.finalText ?? "");
  const blocks = Array.isArray(done.blocks) ? done.blocks : [];
  const ev = new Set();
  for (const m of finalText.matchAll(/\[AGENT_RESULT_CARD_START\]([\s\S]*?)\[AGENT_RESULT_CARD_END\]/g)) {
    try { ev.add(`card:${JSON.parse(m[1].trim()).cardType || "generic"}`); } catch { ev.add("card:<parse-fail>"); }
  }
  for (const b of blocks) {
    if (b && b.type === "card" && b.cardType) ev.add(`block:${b.cardType}`);
    if (b && b.type === "summary") ev.add("block:summary");
  }
  for (const m of finalText.matchAll(/\[RENDER_AS:(\w+)\]/g)) ev.add(`marker:${m[1]}`);
  if (finalText.includes("CONTENT_SUMMARY_V2") || JSON.stringify(done).includes("CONTENT_SUMMARY_V2")) ev.add("marker:CONTENT_SUMMARY_V2");
  const mediaCount = Array.isArray(done.mediaCards) ? done.mediaCards.length : 0;
  if (mediaCount > 0) ev.add(`mediaCards:${mediaCount}`);
  const pipeLines = finalText.split("\n").filter((l) => (l.match(/\|/g) ?? []).length >= 2).length;
  if (pipeLines >= 2) ev.add(`md-table(${pipeLines}行)`);
  if (finalText.includes("```")) ev.add("md-code");
  if (/^>\s+/m.test(finalText)) ev.add("md-quote");
  return [...ev];
}

/** 收集窗口：首条 done 后继续等回灌，非空结果稳定 12s（或硬超时）才收。 */
async function runTurnCollect(text, hardMs = 140_000) {
  const session = `e2e-forms2-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const ws = await connect();
  const dones = [];
  ws.on("message", (raw) => {
    let evt;
    try { evt = JSON.parse(raw.toString()); } catch { return; }
    if (evt.type === "chat.assistant_done") dones.push(evt.payload ?? {});
  });
  ws.send(JSON.stringify({ type: "session.init", payload: { sessionId: session } }));
  await new Promise((r) => setTimeout(r, 1200));
  ws.send(JSON.stringify({
    type: "chat.user_message",
    payload: { sessionId: session, messageId: `e2e-${Date.now()}`, text, timestamp: new Date().toISOString() },
  }));
  const start = Date.now();
  let lastNonEmptyAt = 0;
  let sawNonEmpty = false;
  while (Date.now() - start < hardMs) {
    await new Promise((r) => setTimeout(r, 600));
    const nonEmpty = dones.find((d) => String(d.finalText ?? "").trim().length > 0);
    if (nonEmpty && !sawNonEmpty) { sawNonEmpty = true; lastNonEmptyAt = Date.now(); }
    const countGrew = dones.length;
    if (sawNonEmpty && Date.now() - lastNonEmptyAt > 12_000 && countGrew === dones.length) break;
  }
  ws.close();
  const nonEmptyReversed = [...dones].reverse().find((d) => String(d.finalText ?? "").trim().length > 0);
  const chosen = nonEmptyReversed ?? dones[dones.length - 1] ?? {};
  return { done: chosen, doneCount: dones.length, source: chosen.source ?? "" };
}

const matrix = [];
for (const round of ROUNDS) {
  const { done, doneCount, source } = await runTurnCollect(round.text);
  const evidence = collectEvidence(done);
  const preview = String(done.finalText ?? "").trim().replace(/\s+/g, " ").slice(0, 90);
  matrix.push({ name: round.name, evidence });
  console.log(`\n### ${round.name}  (done数=${doneCount}${source ? ", source=" + source : ""})`);
  console.log(`    证据: [${evidence.join(", ") || "无"}]`);
  console.log(`    正文: ${preview || "(空)"}`);
}

// schedule：同会话两轮（先建日程再查询）
{
  const session = `e2e-forms2-sched-${Date.now()}`;
  const ws = await connect();
  const dones = [];
  ws.on("message", (raw) => {
    let evt;
    try { evt = JSON.parse(raw.toString()); } catch { return; }
    if (evt.type === "chat.assistant_done") dones.push(evt.payload ?? {});
  });
  ws.send(JSON.stringify({ type: "session.init", payload: { sessionId: session } }));
  await new Promise((r) => setTimeout(r, 1200));
  const send = (text) => ws.send(JSON.stringify({
    type: "chat.user_message",
    payload: { sessionId: session, messageId: `e2e-${Date.now()}`, text, timestamp: new Date().toISOString() },
  }));
  send("帮我建一个日程：明天上午10点项目周会，地点3楼会议室");
  const waitNonEmpty = async (before) => {
    const deadline = Date.now() + 140_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 600));
      const d = dones.slice(before).find((x) => String(x.finalText ?? "").trim().length > 0);
      if (d && Date.now() - dones.length * 0 > 0) {
        await new Promise((r) => setTimeout(r, 8000));
        return;
      }
    }
  };
  const before = dones.length;
  await waitNonEmpty(before);
  console.log(`\n### schedule 建日程轮  正文: ${(String(dones[dones.length - 1]?.finalText ?? "")).replace(/\s+/g, " ").slice(0, 90)}`);
  const mark = dones.length;
  send("查一下明天我有什么日程");
  await waitNonEmpty(mark);
  const last = [...dones].reverse().find((d) => String(d.finalText ?? "").trim().length > 0) ?? {};
  const evidence = collectEvidence(last);
  console.log(`### schedule 查询轮  (done数=${dones.length - mark})`);
  console.log(`    证据: [${evidence.join(", ") || "无"}]`);
  console.log(`    正文: ${String(last.finalText ?? "").replace(/\s+/g, " ").slice(0, 90)}`);
  matrix.push({ name: "schedule 日程卡(建后查)", evidence });
  ws.close();
}

console.log("\n===== v2 触发矩阵汇总 =====");
for (const m of matrix) {
  console.log(`${m.name.padEnd(28)} => ${m.evidence.join(", ") || "(未触发)"}`);
}
process.exit(0);
