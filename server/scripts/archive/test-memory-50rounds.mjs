/**
 * 50 轮真实对话模拟 · 记忆连续性 / 长期记忆召回 / 话题切换 端到端验证
 *
 * 覆盖三类场景：
 *   1. 多轮对话连续性：同一话题连续多轮，验证 agent 每轮都回应「当前这条」，
 *      而不是复读/接错上一轮的旧内容；
 *   2. 话题切换：对话中途换话题，验证 agent 不把上一话题的信息串进新回复
 *      （notExpect 关键词不出现 = 未串台）；
 *   3. 长期记忆召回：先在对话中「记住」若干事实，之后隔着多轮闲聊再换措辞回问，
 *      验证跨话题仍能召回（会话内短期 + 跨会话长期双层验证）。
 *
 * 判定规则（宽松关键词匹配，避免误判）：
 *   - 当前话题命中：回复包含本轮 expect 关键词之一即通过；
 *   - 串台检测：仅对 marked 轮次检查 notExpect 关键词不应出现；
 *   - 记忆召回轮单独统计（recall 标记），用于观察长期记忆回召率。
 *
 * 用法：node scripts/test-memory-50rounds.mjs [ws://127.0.0.1:3000/ws]
 */

import WebSocket from "ws";
import { appendFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// 结果落盘（stdout 在非 TTY 下缓冲会丢输出，文件保证拿到完整逐轮数据）
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "test-results");
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
const OUT_FILE = join(OUT_DIR, `memory-50rounds-${Date.now().toString(36)}.txt`);
function log(msg) {
  const line = typeof msg === "string" ? msg : JSON.stringify(msg);
  console.log(line);
  try { appendFileSync(OUT_FILE, `${line}\n`, "utf8"); } catch { /* ignore */ }
}

const SERVER_URL = process.argv[2] ?? "ws://127.0.0.1:3000/ws";
const HTTP_BASE = SERVER_URL.replace("ws://", "http://").replace("wss://", "https://").replace("/ws", "");

// 独立测试 actor，避免污染真实用户数据
const TEST_ACTOR = `mem50-${Date.now().toString(36)}`;

function stripTs(s) {
  return String(s ?? "")
    .replace(/^\[ts:[^\]]*\]\s*/gm, "")
    .replace(/\*\*/g, "")
    .trim();
}

function short(s, n = 140) {
  if (!s) return "";
  const t = stripTs(s).replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

function hit(reply, kws) {
  const r = stripTs(reply);
  return kws.some((k) => r.includes(k));
}

function leak(reply, kws) {
  const r = stripTs(reply);
  return kws.some((k) => r.includes(k));
}

/**
 * 50 轮对话设计。
 * topic   : 本轮话题标签
 * expect  : 当前话题命中关键词（命中任一即通过）
 * notExpect:（可选）不应出现的关键词（话题切换串台检测）
 * recall  : 标记为「长期记忆召回」轮（单独统计）
 */
const ROUNDS = [
  // ── Phase 1：日常开场 + 出差话题连续多轮（验证会话内短期记忆） ──
  { text: "早上好呀", topic: "问候", expect: ["早上好", "早安", "你好", "早"] },
  { text: "我今天感觉有点累，昨晚没睡好", topic: "状态", expect: ["累", "休息", "睡", "咖啡"] },
  { text: "帮我记住：下周一我要去深圳出差，客户公司叫华强科技，对接人姓王", topic: "记忆写入-出差", expect: ["华强", "深圳", "出差", "记住", "记下来", "提醒", "设个"] },
  { text: "这次深圳的会开两天，我住南山科技园附近的酒店", topic: "出差补充", expect: ["两天", "南山", "酒店"] },
  { text: "我这次出差要去见哪家公司？（不要联网）", topic: "会话内召回-出差公司", expect: ["华强"], recall: true },
  { text: "那个对接人姓什么来着？", topic: "会话内追问-对接人", expect: ["王"] },
  { text: "我出差要待几天？", topic: "会话内召回-天数", expect: ["两天", "2天", "两天左右"] },
  { text: "你觉得我下周一去深圳，提前一天去还是当天到好？", topic: "建议-出行", expect: ["提前", "周日", "当天", "深圳", "周一"] },

  // ── Phase 2：宠物话题（新话题，切话题后连续多轮） ──
  { text: "我养了一只白色短毛猫，叫咪咪，今年两岁了", topic: "记忆写入-猫", expect: ["咪咪", "猫", "记住"] },
  { text: "咪咪最喜欢吃三文鱼味的猫粮，不喜欢牛肉味", topic: "猫补充-饮食", expect: ["三文鱼"] },
  { text: "我的猫叫什么名字？", topic: "会话内召回-猫名", expect: ["咪咪"], recall: true },
  { text: "咪咪爱吃什么猫粮？", topic: "会话内召回-猫粮", expect: ["三文鱼"] },
  { text: "养猫要注意什么？", topic: "养猫知识", expect: ["猫", "疫苗", "水", "猫砂", "驱虫"] },

  // ── Phase 3：搬家话题 + 第一次跨话题回问（验证长期记忆召回） ──
  { text: "周末我打算搬家，从北京搬到上海浦东新区，预算八千", topic: "记忆写入-搬家", expect: ["上海", "浦东", "搬家", "北京"] },
  { text: "我搬家去哪个城市？", topic: "会话内召回-搬家城市", expect: ["上海"] },
  { text: "你帮我看看8000块预算在上海租房够不够", topic: "预算讨论", expect: ["8000", "八千", "预算", "上海", "浦东"] },
  { text: "对了，我出差要去见的那家公司叫什么来着？", topic: "跨话题召回-出差公司", expect: ["华强"], recall: true },
  { text: "我家猫最喜欢吃什么来着？", topic: "跨话题召回-猫粮", expect: ["三文鱼"], recall: true },
  { text: "我搬家要去哪来着？", topic: "跨话题召回-搬家城市", expect: ["上海", "浦东"], recall: true },

  // ── Phase 4：生活闲聊（连续快速切换小话题，验证不串台） ──
  { text: "推荐一部适合周末看的电影", topic: "闲聊-电影", expect: ["电影", "周末", "片"], notExpect: ["上海", "搬家", "华强"] },
  { text: "有什么好吃的上海菜推荐？", topic: "闲聊-美食", expect: ["上海", "菜", "生煎", "小笼", "本帮"] },
  { text: "我在考虑学做菜，你觉得呢", topic: "闲聊-做饭", expect: ["做菜", "做饭", "学", "可以", "不错"] },
  { text: "最近工作压力好大", topic: "闲聊-工作", expect: ["压力", "累", "休息", "放松", "理解"] },
  { text: "你看过《流浪地球》吗", topic: "闲聊-电影2", expect: ["流浪地球", "科幻", "刘慈欣", "刘培强", "看过"] },
  { text: "我打算养第二只猫，你觉得呢", topic: "闲聊-宠物2", expect: ["猫", "养", "考虑", "咪咪"] },
  { text: "咪咪会吃醋吗", topic: "闲聊-宠物3", expect: ["咪咪", "猫", "吃醋", "争宠"] },
  { text: "我想买个扫地机器人，求推荐", topic: "闲聊-家电", expect: ["扫地", "机器人", "推荐", "吸尘", "石头", "科沃斯", "扫拖", "防缠绕", "滚刷"] },
  { text: "你平时怎么规划一天的", topic: "闲聊-日常", expect: ["规划", "安排", "日程", "时间"] },
  { text: "帮我看看明天上海天气怎么样", topic: "天气", expect: ["天气", "明天", "上海", "晴", "雨"] },
  { text: "你觉得深色还是浅色家具好", topic: "闲聊-家具", expect: ["深色", "浅色", "家具", "好看"] },
  { text: "我最近在健身", topic: "闲聊-健身", expect: ["健身", "运动", "锻炼", "坚持"] },
  { text: "健身房要不要办卡", topic: "闲聊-健身2", expect: ["办卡", "健身", "卡", "月卡"] },
  { text: "你觉得我该几点睡比较好", topic: "闲聊-作息", expect: ["睡", "几点", "作息", "11点", "早点"] },
  { text: "周末想去爬山，有什么推荐", topic: "闲聊-爬山", expect: ["爬山", "山", "户外", "周末"] },

  // ── Phase 5：第二轮跨话题回问（深层长期记忆细节） ──
  { text: "你记得我养了什么宠物吗？", topic: "跨话题召回-宠物", expect: ["咪咪", "猫"], recall: true },
  { text: "咪咪几岁了？", topic: "跨话题召回-猫年龄", expect: ["两岁", "2岁", "两"], recall: true },
  { text: "出差对接人姓什么？", topic: "跨话题召回-对接人", expect: ["王"], recall: true },
  { text: "我搬家预算多少？", topic: "跨话题召回-搬家预算", expect: ["八千", "8000"], recall: true },
  { text: "你现在能记住我多少事？", topic: "元记忆-盘点", expect: ["华强", "咪咪", "上海", "搬家", "深圳", "出差"], recall: true },

  // ── Phase 6：日常杂谈（继续切换话题） ──
  { text: "周末有没有什么放松的活动推荐", topic: "闲聊-放松", expect: ["周末", "放松", "活动", "推荐"] },
  { text: "如果我忘记提醒你，你会提醒我吗", topic: "元对话-提醒", expect: ["提醒", "放心", "记住", "会"] },
  { text: "下周一下午我有个产品评审会，帮我记一下", topic: "记忆写入-会议", expect: ["产品评审", "周一", "记住"] },
  { text: "我下周一还有什么安排来着？", topic: "跨话题召回-下周安排", expect: ["深圳", "出差", "华强", "产品评审"], recall: true },
  { text: "你这几天一直跟着我聊天，会不会累", topic: "闲聊-元", expect: ["不累", "没事", "陪你", "不会"] },
  { text: "你觉得我适合养金毛吗", topic: "闲聊-宠物4", expect: ["金毛", "养", "狗", "合适"] },

  // ── Phase 7：中断回归（模拟离开后回来继续） ──
  { text: "我先去吃饭了，回头聊", topic: "闲聊-离开", expect: ["好", "去吧", "拜", "回聊", "再见"] },
  { text: "我回来了，机票订了吗", topic: "延续-机票", expect: ["机票", "订", "没", "还没", "出差"] },
  { text: "那你帮我看看下周一的行程安排", topic: "行程汇总", expect: ["出差", "深圳", "华强", "产品评审", "周一"], recall: true },
  { text: "对了，我的猫叫什么？", topic: "跨话题召回-猫名2", expect: ["咪咪"], recall: true },
  { text: "最后总结一下，你对我了解多少？", topic: "元记忆-总结", expect: ["华强", "咪咪", "上海", "出差", "深圳", "搬家"], recall: true },
];

const TOTAL = ROUNDS.length;
console.assert(TOTAL === 50, `rounds count = ${TOTAL}, 期望 50`);

/**
 * WS 单会话多轮对话。每轮返回 { text, topic, expect, notExpect, recall, reply, interim, events }。
 */
function wsChat({ sessionId, userId, rounds, messageDelayMs = 600 }) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(SERVER_URL);
    const results = [];
    let roundIdx = -1;
    let current = null;
    let settled = false;
    let initDone = false;

    const finish = (err) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch { /* ignore */ }
      err ? reject(err) : resolve(results);
    };
    // 50 轮整体超时：12 分钟
    const hardTimeout = setTimeout(
      () => finish(new Error(`WS 会话 ${rounds.length} 轮 720s 超时（已完成 ${roundIdx + 1} 轮）`)),
      720_000,
    );

    const startRound = () => {
      roundIdx += 1;
      if (roundIdx >= rounds.length) return finish();
      current = {
        ...rounds[roundIdx],
        reply: "",
        interim: "",
        done: null,
        events: [],
      };
      results.push(current);
      const msgId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      ws.send(
        JSON.stringify({
          type: "chat.user_message",
          payload: {
            text: rounds[roundIdx].text,
            messageId: msgId,
            sessionId,
            userId,
            timestamp: new Date().toISOString(),
          },
        }),
      );
    };

    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "session.init", payload: { userId, sessionId } }));
      setTimeout(() => {
        initDone = true;
        startRound();
      }, 400);
    });

    ws.on("message", (raw) => {
      let ev;
      try { ev = JSON.parse(String(raw)); } catch { return; }
      if (ev.type === "error") {
        console.log(`  [ws error] ${JSON.stringify(ev.payload ?? {}).slice(0, 200)}`);
        if (!initDone) return finish(new Error("session.init 失败"));
        return;
      }
      if (ev.type === "chat.assistant_interim") {
        if (current) current.interim += ev.payload?.chunk ?? ev.payload?.text ?? "";
        return;
      }
      if (ev.type === "chat.assistant_chunk") {
        if (current) current.reply += ev.payload?.chunk ?? ev.payload?.text ?? "";
        return;
      }
      if (ev.type === "chat.assistant_done") {
        if (current) {
          current.done = "done";
          const finalText = ev.payload?.finalText ?? ev.payload?.text;
          if (finalText) current.reply = finalText;
        }
        setTimeout(startRound, messageDelayMs);
        return;
      }
      if (ev.type === "chat.execution_event") {
        if (current) current.events.push(ev.payload);
        return;
      }
    });

    ws.on("error", (err) => finish(err));
    ws.on("close", () => {
      clearTimeout(hardTimeout);
      if (!settled) finish();
    });
  });
}

async function main() {
  log("==================================================");
  log(`50 轮真实对话模拟 · 记忆连续性 / 长期召回 / 话题切换`);
  log(`测试 Actor: ${TEST_ACTOR}`);
  log(`服务端: ${SERVER_URL} (HTTP: ${HTTP_BASE})`);
  log(`总轮数: ${TOTAL}`);
  log(`结果文件: ${OUT_FILE}`);
  log("==================================================");

  const t0 = Date.now();
  const replies = await wsChat({ sessionId: TEST_ACTOR, userId: TEST_ACTOR, rounds: ROUNDS });
  const durationSec = ((Date.now() - t0) / 1000).toFixed(1);

  // ── 逐轮判定 ──
  let passCount = 0;
  let recallCount = 0;
  let recallPass = 0;
  let leakCount = 0;
  let toolLeakCount = 0;
  const failures = [];
  const leaks = [];
  const toolLeaks = [];

  for (let i = 0; i < replies.length; i++) {
    const r = replies[i];
    const reply = r.reply ?? "";
    const replyText = stripTs(reply);

    // 工具结果漏出：回复是原始 tool JSON / 工具调用语法（非记忆问题，单独归类）
    const isToolLeak =
      (/^\{/.test(replyText) && /"(?:mode|query|search_path|tool_call|name|args)"/.test(replyText.slice(0, 120))) ||
      /^<tool_calls>|<function_calls>|<invoke>/.test(replyText);
    if (isToolLeak || replyText.length === 0) {
      toolLeakCount++;
      toolLeaks.push({ i: i + 1, topic: r.topic, reply });
      log(
        `\n#${String(i + 1).padStart(2, "0")} [${r.topic}] ⚠️${replyText.length === 0 ? "空回复" : "工具漏出"} (非记忆问题)\n` +
        `  U: ${r.text}\n` +
        `  A: ${short(reply)}`,
      );
      continue;
    }

    const currentHit = hit(reply, r.expect);
    const leaked = r.notExpect && leak(reply, r.notExpect);

    if (currentHit && !leaked) passCount++;
    else if (!currentHit) failures.push({ i: i + 1, topic: r.topic, text: r.text, reply, missed: r.expect });
    if (leaked) leaks.push({ i: i + 1, topic: r.topic, reply, leakedKw: r.notExpect });

    if (r.recall) {
      recallCount++;
      if (currentHit) recallPass++;
    }

    const status = currentHit && !leaked ? "✅" : currentHit && leaked ? "⚠️串台" : "❌";
    const detail = !currentHit
      ? `未命中 [${r.expect.join("/")}]`
      : leaked
        ? `串台! 出现 [${r.notExpect.join("/")}]`
        : "";
    log(
      `\n#${String(i + 1).padStart(2, "0")} [${r.topic}] ${status}${r.recall ? " (召回)" : ""}\n` +
      `  U: ${r.text}\n` +
      `  A: ${short(reply)}${detail ? `  ${detail}` : ""}`,
    );
  }

  // ── 汇总 ──
  log("\n" + "=".repeat(50));
  log("汇总结果");
  log("=".repeat(50));
  log(`总轮数        : ${TOTAL}`);
  log(`当前话题命中  : ${passCount}/${TOTAL} (${((passCount / TOTAL) * 100).toFixed(1)}%)`);
  log(`长期记忆召回  : ${recallPass}/${recallCount} (${recallCount ? ((recallPass / recallCount) * 100).toFixed(1) : 0}%)`);
  log(`串台轮次      : ${leaks.length} 轮`);
  log(`工具漏出/空回复 : ${toolLeakCount} 轮（非记忆问题）`);
  log(`总耗时        : ${durationSec}s`);
  log(`测试 Actor    : ${TEST_ACTOR}`);

  if (failures.length > 0) {
    log("\n── 未命中轮次详情 ──");
    for (const f of failures) {
      log(`#${f.i} [${f.topic}] 期望[${f.missed.join("/")}]`);
      log(`   U: ${f.text}`);
      log(`   A: ${stripTs(f.reply).slice(0, 200)}`);
    }
  }
  if (leaks.length > 0) {
    log("\n── 串台轮次详情 ──");
    for (const l of leaks) {
      log(`#${l.i} [${l.topic}] 不应出现[${l.leakedKw.join("/")}]`);
      log(`   A: ${stripTs(l.reply).slice(0, 200)}`);
    }
  }
  if (toolLeaks.length > 0) {
    log("\n── 工具漏出/空回复轮次 ──");
    for (const t of toolLeaks) {
      log(`#${t.i} [${t.topic}] A: ${stripTs(t.reply).slice(0, 200) || "(空)"}`);
    }
  }
  log("=".repeat(50));
}

const mainPromise = main();
const hardTimeout = setTimeout(() => {
  console.log("\n整体超时（780s），终止。");
  process.exit(1);
}, 780_000);
await mainPromise;
clearTimeout(hardTimeout);
process.exit(0);
