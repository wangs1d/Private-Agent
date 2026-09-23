import assert from "node:assert/strict";
import test from "node:test";

import { enforceReplyStyle } from "../src/agent/execution/reply-style-guard.js";
import { TurnFinalizer } from "../src/agent/execution/turn-finalizer.js";
import { TurnLifecycle } from "../src/agent/turn-lifecycle.js";
import type { ExternalChatProvider } from "../src/external-model/types.js";

// 真机轨迹 3b22ae220b1a4a97（2026-09-22 17:27「她微博最近发了什么」）的原始回复：
// 4 大段道歉式找补 + 连环让步收尾，用户定调的反面教材，作为校准夹具。
const REAL_BAD_REPLY = [
  "王哥，实话说——**她微博最近发了啥，我没查到**。",
  "刚翻了一圈，出来的全是别人的动态：杨幂粉丝团、李惠利回归微博、林青霞、本兮超话……**没有一条是刘浩存本人的微博内容**。这事儿我不编，怕给你看了假消息反倒糟心。",
  "我的问题在于：我看不到她微博账号的实时主页，只能搜到别人转发或二手报道的内容，所以本人发了什么、什么时候发的，我抓不着。",
  "你那边要是刷到她发了啥，截图丢给我，我帮你存着；或者你想让我盯着她的新剧新图，有公开报道出来我就吱一声。她最近有什么公开活动",
].join("\n\n");

test("真机反面教材：道歉式找补+连环让步被整形为简短回复，chips 块保真", () => {
  const withChips = `${REAL_BAD_REPLY}\n\n[NEXT_UP_START]\n有她的新剧消息就告诉我\n搜一下《主角》的剧照\n[NEXT_UP_END]`;
  const result = enforceReplyStyle(withChips, "chat");

  assert.equal(result.changed, true);
  assert.ok(result.violations.includes("hedge_pileup"));
  assert.ok(result.violations.includes("offer_pileup"));
  // 找补句与让步句被删
  assert.equal(result.text.includes("我不编"), false);
  assert.equal(result.text.includes("糟心"), false);
  assert.equal(result.text.includes("丢给我"), false);
  assert.equal(result.text.includes("我帮你存"), false);
  // 事实句保留
  assert.ok(result.text.includes("没查到"));
  assert.ok(result.text.includes("没有一条是刘浩存本人的微博内容"));
  // 协议块原样拼回
  assert.ok(result.text.includes("[NEXT_UP_START]"));
  assert.ok(result.text.includes("搜一下《主角》的剧照"));
  // 正文句数收到上限内（不含 chips 块）
  const body = result.text.split("[NEXT_UP_START]")[0] ?? "";
  const sentenceCount = (body.match(/[^。！？!?；;\n]+[。！？!?；;]/gu) ?? []).length;
  assert.ok(sentenceCount <= 2, `期望 ≤2 句，实际 ${sentenceCount} 句：${body}`);
  // 能力自诉句（同义反复的废话本体）被删
  assert.equal(result.text.includes("我的问题在于"), false);
});

test("简短正常回复零接触（一个字节都不动）", () => {
  const replies = [
    "已订好，周四14:00，出票短信随后到。",
    "没查到她本人的微博，搜出来的全是别人的动态。有公开消息我再跟你说。",
    "这个真没查到，不瞎编。",
  ];
  for (const text of replies) {
    const result = enforceReplyStyle(text, "chat");
    assert.equal(result.changed, false, `不应动这条回复：${text}`);
    assert.equal(result.text, text);
  }
});

test("结构化交付（表格/列表/链接）不做长度手术", () => {
  const delivery = [
    "她最近的公开动态整理如下：",
    "",
    "| 时间 | 事 |",
    "|---|---|",
    "| 2026-08-07 | 央视电视剧频道专访，红裙跳舞 |",
    "| 2026-04 | CMG 中国电影盛典露面 |",
    "| 2026 年 | 第38届大众电影百花奖文化使者 |",
    "",
    "新剧《主角》已开播，饰易青娥。详细行程可以看这里 https://example.com/x",
  ].join("\n");
  const result = enforceReplyStyle(delivery, "chat");
  assert.equal(result.changed, false, "结构化交付不应被砍长度");
});

test("道歉开场+长篇解释：道歉句被删，事实句保留", () => {
  const text = [
    "抱歉，这个真没查到。",
    "刚刚我翻了几个网站，都没有相关信息。",
    "不好意思啊，可能是我搜索的方式不太对，你可以换个问法试试，或者过会儿再来问我。",
  ].join("\n");
  const result = enforceReplyStyle(text, "chat");
  assert.equal(result.changed, true);
  assert.ok(result.violations.includes("apology_persona"));
  assert.ok(result.text.includes("没查到"));
  assert.ok(result.text.includes("翻了几个网站"));
  assert.equal(result.text.includes("不好意思"), false);
});

test("道歉句承载事实时不可删（永不变差）", () => {
  const text = "抱歉，我这边确实没查到。你要的信息我这儿没有来源。";
  const result = enforceReplyStyle(text, "chat");
  // 没有可安全删除的道歉句 → 原文放行
  assert.equal(result.changed, false);
  assert.equal(result.text, text);
});

test("单处坦诚不算越形：一句『这个真没查到，不瞎编』放行", () => {
  const text = "这个真没查到，不瞎编。你要是刷到了发我就行。";
  const result = enforceReplyStyle(text, "chat");
  assert.equal(result.changed, false);
});

test("能力自诉句被删：结论已给，『我的问题在于…』是废话", () => {
  const text =
    "没查到她本人的微博。我的问题在于：我看不到她微博账号的实时主页，只能搜到二手报道。";
  const result = enforceReplyStyle(text, "chat");
  assert.ok(result.violations.includes("self_explain"));
  assert.equal(result.changed, true);
  assert.equal(result.text.includes("我的问题在于"), false);
  assert.ok(result.text.includes("没查到她本人的微博"));
});

test("弱自诉句（我只能…）在事实句承载结论且已越形时随案删除", () => {
  const text =
    "抱歉，这个真没查到。搜了一圈全是别人的动态。我只能搜到别人转发或二手报道的内容，所以她本人发了什么我抓不着。你那边要是刷到了截图丢给我，我帮你存着；或者你想让我盯着新剧，有报道我就吱一声。";
  const result = enforceReplyStyle(text, "chat");
  assert.equal(result.changed, true);
  assert.ok(result.violations.length >= 2);
  assert.equal(result.text.includes("抓不着"), false);
  assert.ok(result.text.includes("没查到"));
});

test("单句回复的能力自诉不删（那是回答本身）", () => {
  const text = "我看不到她的微博实时主页。";
  const result = enforceReplyStyle(text, "chat");
  assert.equal(result.changed, false);
});

test("task 车道不做长度手术，长交付原样放行", () => {
  const longDelivery = Array.from(
    { length: 12 },
    (_, i) => `第${i + 1}步：检查第${i + 1}项配置是否正确，确认无遗漏。`,
  ).join("");
  const result = enforceReplyStyle(longDelivery, "task");
  assert.equal(result.changed, false);
});

test("REPLY_STYLE_GATE=off 整闸旁路", () => {
  process.env.REPLY_STYLE_GATE = "off";
  try {
    const result = enforceReplyStyle(REAL_BAD_REPLY, "chat");
    assert.equal(result.changed, false);
    assert.equal(result.text, REAL_BAD_REPLY);
  } finally {
    delete process.env.REPLY_STYLE_GATE;
  }
});

test("整形结果永不空：全句皆让步时原文放行", () => {
  const text = "要不要我帮你盯着？或者你也可以让我再搜搜看。";
  const result = enforceReplyStyle(text, "chat");
  assert.equal(result.changed, false);
  assert.equal(result.text, text);
});

test("RENDER_HINT 内联标记不参与检测，整形后保真", () => {
  const text = `${REAL_BAD_REPLY}\n\n[RENDER_HINT:structured]`;
  const result = enforceReplyStyle(text, "chat");
  assert.equal(result.changed, true);
  assert.ok(result.text.includes("[RENDER_HINT:structured]"));
});

// ── 确认轮（2026-09-24）：日历/提醒创建成功后的办妥确认 ──

// 真机反面教材（2026-09-24 订阅科技早报确认轮）：一句确认写成了五段导购，
// 靠 bullet 列表吃结构豁免绕过 overlong。作为确认轮校准夹具。
const REAL_VERBOSE_CONFIRM = [
  "早报定好了——明早 08:00 准时送到，标题「科技早报」，到点我会把当天的科技资讯给你端上来。",
  "一件事说清楚：这份早报的内容是明早现查现给的，不是现在提前写好的。科技新闻这东西一天一个样，现在写了明早就馊了，所以我没提前攒稿子，到点现场抓最新的给你。",
  "明早你收到的时候，大概是这么几块：",
  "- 大厂动态——苹果、华为、小米这些当天有什么动作",
  "- AI 前沿——模型发布、产品更新、行业风向",
  "- 硬件新品——手机、芯片、数码圈的新东西",
  "- 值得一看——我会挑几条真有意思的，不给你堆流水账",
  "要是有特别想打的方向（比如只关心 AI，或者只关心手机），现在说一声，明早我就往那个方向使劲。",
].join("\n");

test("普通 chat 轮：列表化废话确认吃结构豁免（旧行为基线，豁免只该保护交付）", () => {
  const result = enforceReplyStyle(REAL_VERBOSE_CONFIRM, "chat");
  assert.equal(result.violations.includes("overlong"), false);
});

test("确认轮：列表化废话确认不吃结构豁免，overlong 定罪", () => {
  const result = enforceReplyStyle(REAL_VERBOSE_CONFIRM, "chat", { confirmationRound: true });
  assert.ok(result.violations.includes("overlong"));
  // 结构化确认的确定性整形只做最小手术（保多条目信息），压缩交给隔离重写臂
  assert.equal(result.changed, false);
});

test("确认轮：简短办妥确认零接触", () => {
  const text = "订好了，明早 8 点准时给你送到。";
  const result = enforceReplyStyle(text, "chat", { confirmationRound: true });
  assert.equal(result.changed, false);
  assert.equal(result.violations.length, 0);
});

test("确认轮：多条目列表确认原文放行（确定性整形不砍，交给重写臂保事实）", () => {
  const multi = [
    "三件事都订好了：",
    "- 明早 08:00 科技早报",
    "- 明天 09:00 提醒吃药",
    "- 明晚 22:00 提醒睡觉",
  ].join("\n");
  const result = enforceReplyStyle(multi, "chat", { confirmationRound: true });
  assert.ok(result.violations.includes("overlong"));
  assert.equal(result.changed, false);
  assert.ok(result.text.includes("22:00 提醒睡觉"));
});

// ── 隔离重写臂（TurnFinalizer 层）──

function makeFinalizer(provider: ExternalChatProvider | null): TurnFinalizer {
  const lifecycle = new TurnLifecycle({
    narrativeMemory: null,
    computeQuotaService: null,
    evolutionLoopService: null,
    userPersonalizationService: null,
    agentMemorySyncService: null,
    shortTermMemoryGateway: null,
  });
  return new TurnFinalizer({
    provider,
    turnLifecycle: lifecycle,
    shortTermMemoryGateway: null,
    getBrainCenter: () => null,
  });
}

function stubProvider(rewrite: string): ExternalChatProvider {
  return {
    id: "stub",
    displayLabel: "stub",
    isEnabled: () => true,
    streamCompletion: async () => rewrite,
  } as unknown as ExternalChatProvider;
}

test("隔离重写臂：越形回复经最小上下文微调用压缩，chips 保真", async () => {
  const finalizer = makeFinalizer(
    stubProvider("没刷到她本人的微博，出来的全是别人的动态。有消息我再跟你说。"),
  );
  const reply = await finalizer.finish("style-gate-test", "她微博最近发了什么", `${REAL_BAD_REPLY}\n\n[NEXT_UP_START]\n有她的新剧消息就告诉我\n[NEXT_UP_END]`, {
    streamedChunks: true,
    modelCallsConsumed: 1,
    planExecuteUsed: false,
    pePlan: null,
    peExhausted: false,
    trajCap: undefined,
    lane: "chat",
  });
  assert.ok(reply.text.startsWith("没刷到她本人的微博"));
  assert.ok(reply.text.includes("[NEXT_UP_START]"));
  assert.equal(reply.text.includes("糟心"), false);
});

test("隔离重写产物越形时回退确定性整形结果（永不变差）", async () => {
  const finalizer = makeFinalizer(
    stubProvider("王哥，实话说——我没查到，这事儿我不编，怕给你看了假消息反倒糟心。我的问题在于我看不到她的实时主页。"),
  );
  const reply = await finalizer.finish("style-gate-test", "她微博最近发了什么", REAL_BAD_REPLY, {
    streamedChunks: true,
    modelCallsConsumed: 1,
    planExecuteUsed: false,
    pePlan: null,
    peExhausted: false,
    trajCap: undefined,
    lane: "chat",
  });
  // 回退产物：无找补词（hedge 句已被确定性整形删掉）
  assert.equal(reply.text.includes("我不编"), false);
  assert.equal(reply.text.includes("糟心"), false);
  assert.ok(reply.text.includes("没查到"));
});

test("无 provider 时越形回复仍走确定性整形", async () => {
  const finalizer = makeFinalizer(null);
  const reply = await finalizer.finish("style-gate-test", "她微博最近发了什么", REAL_BAD_REPLY, {
    streamedChunks: true,
    modelCallsConsumed: 1,
    planExecuteUsed: false,
    pePlan: null,
    peExhausted: false,
    trajCap: undefined,
    lane: "chat",
  });
  assert.equal(reply.text.includes("糟心"), false);
  assert.ok(reply.text.includes("没查到"));
});

test("确认轮隔离重写臂：废话确认被压成两句短话", async () => {
  const finalizer = makeFinalizer(
    stubProvider("订好了，明早 8 点科技早报准时送到。"),
  );
  const reply = await finalizer.finish(
    "style-gate-test",
    "每天早上八点给我一份科技早报",
    REAL_VERBOSE_CONFIRM,
    {
      streamedChunks: true,
      modelCallsConsumed: 1,
      planExecuteUsed: false,
      pePlan: null,
      peExhausted: false,
      trajCap: undefined,
      lane: "chat",
      confirmationRound: true,
    },
  );
  assert.ok(reply.text.startsWith("订好了"));
  assert.equal(reply.text.includes("现查现给"), false);
  assert.equal(reply.text.includes("大厂动态"), false);
});

test("合格回复不触发重写臂（零调用、零改动）", async () => {
  let called = 0;
  const provider = stubProvider("不该被调用");
  provider.streamCompletion = (() => {
    called += 1;
    return Promise.resolve("不该被调用");
  }) as ExternalChatProvider["streamCompletion"];
  const finalizer = makeFinalizer(provider);
  const good = "已订好，周四14:00，出票短信随后到。";
  const reply = await finalizer.finish("style-gate-test", "帮我订周四的位", good, {
    streamedChunks: true,
    modelCallsConsumed: 1,
    planExecuteUsed: false,
    pePlan: null,
    peExhausted: false,
    trajCap: undefined,
    lane: "chat",
  });
  assert.equal(called, 0);
  assert.equal(reply.text, good);
});
