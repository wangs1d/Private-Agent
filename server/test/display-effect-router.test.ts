import test from "node:test";
import assert from "node:assert/strict";

import {
  hasBlockquote,
  routeDisplayEffect,
  scoreDisplayEffects,
} from "../src/services/display-effect-router.js";
import {
  formatAgentResultForChat,
  formatQuoteResultForChat,
} from "../src/services/agent-result-formatter.js";

/** 便捷构造：routeDisplayEffect({title, items}) */
function route(
  title: string,
  items: string[],
  toolName?: string,
): string {
  return routeDisplayEffect({
    toolName,
    title,
    items: items.map((text) => ({ text, type: "num" })),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 工具信号（内容为主判据，工具为兜底/加成——见 display-effect-router.ts 头部语义约定）
// ─────────────────────────────────────────────────────────────────────────────

test("tool signals win when no confident content signal", () => {
  // 无内容信号 → 强工具兜底到正确场景
  assert.equal(route("查询结果", ["晴转多云"], "weather.get"), "weather");
  // 高置信内容信号（百分比条目过半）→ 内容胜出强工具（progress 0.78 > weather 0.45）
  assert.equal(
    route("今日天气", ["湿度 60%", "降水概率 80%", "紫外线 50%"], "weather.get"),
    "progress",
  );
  assert.equal(route("日程", ["09:00 开会"], "calendar.list_tasks"), "schedule");
  assert.equal(route("账单", ["支出 100 元"], "wallet.list"), "wallet");
  assert.equal(route("订单", ["已发货"], "order.query"), "order");
  assert.equal(route("文件", ["a.pdf"], "file.read"), "file");
  assert.equal(route("图片", ["结果"], "search_images"), "media");
  assert.equal(route("搜索", ["条目"], "search_web"), "search_result");
  // 文本 A/B（无图）→ comparison_table 双栏卡；compare 双图滑杆只接带图对比
  assert.equal(route("对比", ["A", "B"], "compare_products"), "comparison_table");
  assert.equal(route("行程", ["day1"], "plan_trip"), "timeline");
});

// ─────────────────────────────────────────────────────────────────────────────
// steps 数字步骤卡
// ─────────────────────────────────────────────────────────────────────────────

test("steps: majority items with step markers", () => {
  assert.equal(
    route("安装步骤", ["第1步 下载安装包", "第2步 双击运行", "第3步 完成配置"]),
    "steps",
  );
  assert.equal(
    route("Setup", ["Step 1 download", "Step 2 run", "Step 3 finish"]),
    "steps",
  );
  // 数字编号开头也算步骤
  assert.equal(
    route("流程", ["1. 打开水龙头", "2. 涂泡沫", "3. 冲干净"]),
    "steps",
  );
  // 标题含教程语义 + 部分标记（≥40%）也算
  assert.equal(
    route("新手教程", ["先注册账号", "1. 登录账号", "2. 完善资料", "绑定手机"]),
    "steps",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// progress 文字进度条卡
// ─────────────────────────────────────────────────────────────────────────────

test("progress: majority items with percent or score", () => {
  assert.equal(
    route("本周完成度", ["任务A 45%", "任务B 75%", "任务C 90%"]),
    "progress",
  );
  assert.equal(
    route("评分", ["外观 90/100", "性能 85/100", "续航 70/100"]),
    "progress",
  );
  // 混合但过半
  assert.equal(
    route("进度", ["任务A 45%", "任务B 75%", "备注说明"]),
    "progress",
  );
  // 不过半 → 不命中
  assert.equal(route("杂项", ["任务A 45%", "备注一", "备注二", "备注三"]), "");
});

// ─────────────────────────────────────────────────────────────────────────────
// metric 数据面板卡
// ─────────────────────────────────────────────────────────────────────────────

test("metric: all items are label:number pairs", () => {
  assert.equal(
    route("本月概览", ["销售额：1.2万", "新增用户：3400人", "复购率：38%"]),
    // 仅 1/3 条目带 %，未过半 → 不构成进度信号，整体仍是数据面板
    "metric",
  );
  assert.equal(
    route("本月概览", ["销售额：1.2万", "新增用户：3400人", "退款：12单"]),
    "metric",
  );
  // 2-6 条全数值
  assert.equal(route("屏幕参数", ["尺寸：6.7英寸", "重量：199g"]), "metric");
  // 混入非数值条目 → 不命中
  assert.equal(
    route("概览", ["销售额：1.2万", "这是一段普通描述文本行"]),
    "",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// carousel 轮播卡
// ─────────────────────────────────────────────────────────────────────────────

test("carousel: majority items embed image urls", () => {
  assert.equal(
    route(
      "推荐商品",
      [
        "产品A ¥299 https://img.example.com/a.jpg",
        "产品B ¥399 https://img.example.com/b.png",
        "产品C ¥499 https://img.example.com/c.webp",
      ],
    ),
    "carousel",
  );
  // 图片 URL 占比不足 → 不命中
  assert.equal(
    route(
      "清单",
      [
        "产品A https://img.example.com/a.jpg",
        "产品B 无图",
        "产品C 无图",
      ],
    ),
    "",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// timeline 时间轴（内容判定）
// ─────────────────────────────────────────────────────────────────────────────

test("timeline: majority items start with time markers", () => {
  assert.equal(
    route(
      "周末安排",
      ["09:00 起床吃早餐", "10:30 健身房", "12:00 午饭", "14:00 电影"],
    ),
    "timeline",
  );
  assert.equal(
    route("行程", ["周六 逛展", "周日 爬山", "周一 收心"]),
    "timeline",
  );
  // 时间条目不过半 → 不命中
  assert.equal(
    route("安排", ["09:00 起床", "然后吃早饭", "再去散步", "晚上看书"]),
    "",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// chips 标签行
// ─────────────────────────────────────────────────────────────────────────────

test("chips: all items are short tags", () => {
  assert.equal(
    route("你的兴趣标签", ["健身", "摄影", "烘焙", "旅行", "桌游"]),
    "chips",
  );
  // 条目过长 → 不命中
  assert.equal(
    route("标签", ["健身", "摄影", "周末长距离骑行训练"]),
    "",
  );
  // 带句末标点 → 不算纯标签
  assert.equal(route("列表", ["健身。", "摄影。", "烘焙。", "旅行。"]), "");
});

// ─────────────────────────────────────────────────────────────────────────────
// fold_list 折叠列表
// ─────────────────────────────────────────────────────────────────────────────

test("fold_list: long list collapses", () => {
  const ten = Array.from({ length: 10 }, (_, i) => `清单条目 ${i + 1}`);
  assert.equal(route("购物清单", ten), "fold_list");
  // 7 条以内不折叠
  const seven = Array.from({ length: 7 }, (_, i) => `清单条目 ${i + 1}`);
  assert.equal(route("购物清单", seven), "");
});

// ─────────────────────────────────────────────────────────────────────────────
// quote 引用强调
// ─────────────────────────────────────────────────────────────────────────────

test("quote: title-only payload with quote signals", () => {
  assert.equal(route("「今天的不开心就到此为止吧」", []), "quote");
  assert.equal(route("总之，这套方案的性价比最高", []), "quote");
  // 无引用信号的普通标题 → 不命中
  assert.equal(route("周末行程已规划", []), "");
});

// ─────────────────────────────────────────────────────────────────────────────
// 通用列表卡兜底
// ─────────────────────────────────────────────────────────────────────────────

test("generic list card as fallback", () => {
  assert.equal(
    route("已完成的任务", ["买菜", "取快递", "交水电费"]),
    "",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// hasBlockquote / formatQuoteResultForChat
// ─────────────────────────────────────────────────────────────────────────────

test("hasBlockquote detects markdown quote lines", () => {
  assert.equal(hasBlockquote("普通文本\n第二行"), false);
  assert.equal(hasBlockquote("> 这是一句结论"), true);
  assert.equal(hasBlockquote("前导文本\n> 引用内容\n后面"), true);
  // 过短的引用不算
  assert.equal(hasBlockquote("> ok"), false);
});

test("formatQuoteResultForChat extracts quote card with footer", () => {
  const out = formatQuoteResultForChat(
    "我查了下资料，结论是：\n\n> 马尔代夫雨季是5-10月，但价格便宜一半。\n\n——来自旅游攻略",
  );
  assert.ok(out);
  assert.ok(out!.includes("[AGENT_RESULT_CARD_START]"));
  const m = out!.match(/\[AGENT_RESULT_CARD_START\]\n(.*)\n\[AGENT_RESULT_CARD_END\]/);
  assert.ok(m);
  const payload = JSON.parse(m![1]!);
  assert.equal(payload.cardType, "quote");
  assert.equal(payload.title, "马尔代夫雨季是5-10月，但价格便宜一半。");
  assert.equal(payload.footer, "——来自旅游攻略");
  assert.equal(payload.items.length, 0);
  // 前导文本保留
  assert.ok(out!.startsWith("我查了下资料，结论是："));
});

test("formatQuoteResultForChat returns null without blockquote", () => {
  assert.equal(formatQuoteResultForChat("普通文本没有引用块"), null);
});

test("formatAgentResultForChat falls back to quote card when no list segment", () => {
  const out = formatAgentResultForChat(
    "帮你看完了，一句话总结：\n\n> 这本书值得在周末一口气读完。",
  );
  assert.ok(out);
  const m = out!.match(/\[AGENT_RESULT_CARD_START\]\n(.*)\n\[AGENT_RESULT_CARD_END\]/);
  const payload = JSON.parse(m![1]!);
  assert.equal(payload.cardType, "quote");
});

// ─────────────────────────────────────────────────────────────────────────────
// 端到端：formatAgentResultForChat 全类型路由（证明接线生效）
// ─────────────────────────────────────────────────────────────────────────────

function extractCardType(marked: string | null): string {
  assert.ok(marked, "should produce card markup");
  const m = marked!.match(/\[AGENT_RESULT_CARD_START\]\n(.*)\n\[AGENT_RESULT_CARD_END\]/);
  assert.ok(m, "card block should exist");
  return JSON.parse(m![1]!).cardType ?? "";
}

test("e2e: steps card routed from list text", () => {
  const marked = formatAgentResultForChat(
    "安装步骤如下：\n1. 下载安装包\n2. 双击运行\n3. 完成配置\n4. 重启电脑",
  );
  assert.equal(extractCardType(marked), "steps");
});

test("e2e: progress card routed from percent list", () => {
  const marked = formatAgentResultForChat(
    "本周任务完成度：\n- 任务A 45%\n- 任务B 75%\n- 任务C 90%",
  );
  assert.equal(extractCardType(marked), "progress");
});

test("e2e: fold_list card routed from long list", () => {
  const items = Array.from({ length: 9 }, (_, i) => `- 物品${i + 1}`);
  const marked = formatAgentResultForChat("采购清单：\n" + items.join("\n"));
  assert.equal(extractCardType(marked), "fold_list");
});

test("e2e: metric card routed from label-value list", () => {
  const marked = formatAgentResultForChat(
    "屏幕参数：\n- 尺寸：6.7英寸\n- 重量：199g\n- 亮度：2000nit",
  );
  assert.equal(extractCardType(marked), "metric");
});

test("e2e: timeline card routed from time-prefixed list", () => {
  const marked = formatAgentResultForChat(
    "周末安排：\n- 09:00 起床吃早餐\n- 10:30 健身房\n- 12:00 午饭",
  );
  assert.equal(extractCardType(marked), "timeline");
});

test("e2e: chips card routed from short tag list", () => {
  const marked = formatAgentResultForChat(
    "你的兴趣标签：\n- 健身\n- 摄影\n- 烘焙\n- 旅行",
  );
  assert.equal(extractCardType(marked), "chips");
});

test("e2e: carousel card routed from url-embedded list", () => {
  const marked = formatAgentResultForChat(
    "推荐商品：\n- 产品A https://img.example.com/a.jpg\n- 产品B https://img.example.com/b.jpg\n- 产品C https://img.example.com/c.jpg",
  );
  assert.equal(extractCardType(marked), "carousel");
});

test("e2e: confident content signal wins over tool fallback", () => {
  // 条目含百分比（progress 内容信号）且过半 → 内容胜出 weather 工具兜底
  const marked = formatAgentResultForChat(
    "今日天气：\n- 温度 28 度\n- 湿度 60%\n- 降水概率 30%",
    "weather.get",
  );
  assert.equal(extractCardType(marked), "progress");
});

// ─────────────────────────────────────────────────────────────────────────────
// 内容语义路径：普通文本/长文也能命中结构化卡（不依赖列表语法）
// ─────────────────────────────────────────────────────────────────────────────

import {
  extractSemanticItems,
  routeDisplayEffectByForm,
} from "../src/services/display-effect-router.js";
import { formatSemanticResultForChat } from "../src/services/agent-result-formatter.js";

test("extractSemanticItems splits narrative without list markers", () => {
  const items = extractSemanticItems(
    "先把水烧开，然后放入面条，最后加上调料拌一拌。",
  );
  // 按句号切开成独立语义条目
  assert.ok(items.length >= 2);
  assert.ok(items.some((i) => i.includes("烧开")));
});

test("extractSemanticItems drops heading-guide lines", () => {
  // 标题引导行（结尾冒号）不应被当作文本条目
  const items = extractSemanticItems("屏幕参数：\n尺寸：6.7英寸\n重量：199g");
  assert.ok(!items.some((i) => i === "屏幕参数："));
  assert.equal(items[0], "尺寸：6.7英寸");
});

test("routeDisplayEffect hits steps for narrative via intent; pure-form misses it", () => {
  const input = {
    title: "",
    items: [{ text: "先把水烧开" }, { text: "然后放入面条" }, { text: "最后加上调料" }],
    fullText: "先把水烧开，然后放入面条，最后加上调料拌一拌，就可以开吃了。",
  };
  // 含意图加成：步骤语义词（先/然后/最后）→ steps 卡
  assert.equal(routeDisplayEffect(input), "steps");
  // 纯形态（关意图）：没有"第X步/数字."标记 → 不命中（需意图加成）
  assert.equal(routeDisplayEffectByForm(input), "");
});

test("timeline weak-intent without form proof stays plain (no false card)", () => {
  // 闲聊里出现"安排/明天"等弱意图词，但无真实时间戳形态 → 守卫拦截，保持纯文本
  const marked = formatSemanticResultForChat(
    "我帮你把明天的安排记一下，到时候提醒你，你今晚好好休息就行。",
  );
  assert.equal(marked, null);
});

test("timeline with real timestamps gets a card", () => {
  const marked = formatSemanticResultForChat(
    "明天的安排：早上9点开会，10点半约客户，中午12点吃饭，下午2点健身。",
    "schedule.make",
  );
  assert.ok(marked, "real timeline content should produce a card");
  const m = marked!.match(/\[AGENT_RESULT_CARD_START\]\n(.*)\n\[AGENT_RESULT_CARD_END\]/);
  assert.ok(m);
  const payload = JSON.parse(m![1]!);
  assert.equal(payload.cardType, "timeline");
});

test("formatSemanticResultForChat builds steps card from narrative", () => {
  const marked = formatSemanticResultForChat(
    "做法很简单。先把水烧开，然后放入面条，最后加上调料拌一拌，就可以开吃了。",
    "cooking.make",
  );
  assert.ok(marked, "should produce content card from plain text");
  const m = marked!.match(/\[AGENT_RESULT_CARD_START\]\n(.*)\n\[AGENT_RESULT_CARD_END\]/);
  assert.ok(m);
  const payload = JSON.parse(m![1]!);
  assert.equal(payload.cardType, "steps");
});

test("formatSemanticResultForChat returns null for chit-chat", () => {
  // 普通闲聊无结构化信号 → 不生成卡片（保持纯文本）
  assert.equal(
    formatSemanticResultForChat(
      "好的，这个问题我记下来了，等我查一下资料再回复你，你稍等一下哦。",
    ),
    null,
  );
});

test("formatSemanticResultForChat returns null for conversational narrative with single connective", () => {
  // 真实误判回归（2026-08-29 印尼行程追问轮）：对话叙述只含一个「然后」，
  // 且逗号碎片能凑满 fold_list 的条目数——修复前被切成碎片卡片。
  // 修复：steps 意图需 ≥2 个不同顺序引导词；fold_list 移出纯文本路径白名单。
  assert.equal(
    formatSemanticResultForChat(
      "雅加达开个头不错，第一天先落地歇脚嘛。不过雅加达本身海景一般，待两天就够了。\n\n" +
        "我的想法是：雅加达2天然后飞巴厘岛或者去日惹，剩下5天好好玩。\n\n" +
        "你更想海滩晒太阳，还是历史文化加自然风光？这个你定，我按你的偏好排。",
    ),
    null,
  );
  // 单个「怎么弄」的闲聊问句同样不上卡（教程词单独出现降为 0.5，不足以建卡）
  assert.equal(
    formatSemanticResultForChat(
      "这个报名流程有点复杂啊，到底要怎么弄才对，你之前办过吗？跟我说说呗。",
    ),
    null,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 路由精度回归（2026-08-30 文本效果路由优化）：内容必须落到对应的效果
// ─────────────────────────────────────────────────────────────────────────────

test("comparison_table: text A/B comparisons route to the two-column card", () => {
  // 修复前：纯文本对比路由到 compare，但 compare 卡是双图滑杆，
  // 前端因无图静默回退通用卡（路由决策与实际渲染断链）。
  // 修复后：compare 内容/意图分要求图片在场；文本 A/B 由 comparison_table 承接。
  assert.equal(
    routeDisplayEffect({
      title: "",
      items: [{ text: "方案A 便宜" }, { text: "方案B 灵活" }, { text: "看你预算" }],
      fullText: "方案A和方案B有什么区别？哪个更适合我？",
    }),
    "comparison_table",
  );
  assert.equal(
    routeDisplayEffect({
      title: "",
      items: [{ text: "方案A 价格低" }, { text: "方案B 功能全" }, { text: "各有侧重" }],
      fullText: "这两款怎么选？方案A相比方案B价格更低",
    }),
    "comparison_table",
  );
  // 带图片的对比仍走 compare 双图滑杆
  assert.equal(
    routeDisplayEffect({
      title: "",
      items: [
        { text: "A 持妆前 https://img.example.com/before.jpg" },
        { text: "B 持妆后 https://img.example.com/after.jpg" },
      ],
      fullText: "对比一下持妆效果",
    }),
    "compare",
  );
});

test("travel itinerary: numbered/day-marked plan under travel.* tool keeps travel card", () => {
  // 修复前：编号行程按 steps 形态计 1 分（0.78），压过纯工具分 0.45，
  // 导致 formatter 丢失 travelPlan 结构化注入、双面板行程卡退化成步骤卡。
  const input = {
    toolName: "travel.plan",
    title: "巴厘岛5日行程",
    items: [{ text: "到达乌布，入住酒店" }, { text: "圣泉寺+梯田" }, { text: "情人崖看日落" }],
    fullText: "巴厘岛5日行程：\n1. 到达乌布，入住酒店\n2. 圣泉寺+梯田\n3. 情人崖看日落",
    numberedItemRatio: 1,
  };
  assert.equal(routeDisplayEffect(input), "travel_itinerary");
  // Day 标记形态同样互证
  assert.equal(
    routeDisplayEffect({
      toolName: "travel.plan",
      title: "京都三日游",
      items: [{ text: "Day 1 清水寺" }, { text: "Day 2 伏见稻荷" }, { text: "Day 3 岚山" }],
    }),
    "travel_itinerary",
  );
  // 无 travel 工具时同形态绝不误判成行程卡（普通编号清单仍是 steps）
  assert.equal(
    routeDisplayEffect({
      title: "待办清单",
      items: [{ text: "买菜" }, { text: "取快递" }, { text: "交水电费" }],
      numberedItemRatio: 1,
    }),
    "steps",
  );
});

test("metric: dual-representation scoring keeps form score despite prose noise", () => {
  // 修复前：语义碎片条目数 ≥ 结构化条目时整体替换，前导碎句打破
  // metric 的 every() 校验（1.0 掉到 0.5），遇强工具竞争即丢卡。
  const input = {
    toolName: "calendar.list_tasks",
    title: "手机参数",
    items: [{ text: "屏幕尺寸：6.7英寸" }, { text: "机身重量：199g" }, { text: "峰值亮度：2000nit" }],
    fullText:
      "帮你整理好了这款手机的参数。\n- 屏幕尺寸：6.7英寸\n- 机身重量：199g\n- 峰值亮度：2000nit\n需要我再对比续航吗",
  };
  const detail = scoreDisplayEffects(input).find((d) => d.type === "metric");
  assert.ok(detail, "metric should be a candidate");
  assert.equal(detail.contentScore, 1, "structural items should still score full form");
  assert.equal(routeDisplayEffect(input), "metric");
});

test("generic containers (fold_list/chips) yield to strong tool scene", () => {
  const nineItems = Array.from({ length: 9 }, (_, i) => ({ text: `搜索结果条目${i + 1}` }));
  const fullText = "搜索结果：\n" + Array.from({ length: 9 }, (_, i) => `- 搜索结果条目${i + 1}`).join("\n");
  // 修复前：fold_list 内容分 0.65 → 0.507，抢走 search_result 的 0.45
  assert.equal(
    routeDisplayEffect({ toolName: "search_web", title: "搜索结果", items: nineItems, fullText }),
    "search_result",
  );
  // chips 同理让位（强工具在场）；无工具时不受折减、照常命中
  const tags = [{ text: "健身" }, { text: "摄影" }, { text: "烘焙" }, { text: "旅行" }];
  assert.equal(
    routeDisplayEffect({ toolName: "search_web", title: "热门标签", items: tags }),
    "search_result",
  );
  assert.equal(routeDisplayEffect({ title: "你的兴趣标签", items: tags }), "chips");
  // 无工具时 9 条长清单仍折叠（折减只作用于强工具场景）
  assert.equal(
    routeDisplayEffect({ title: "购物清单", items: nineItems, fullText }),
    "fold_list",
  );
});

test("e2e: travel numbered plan routes to travel_itinerary card", () => {
  const marked = formatAgentResultForChat(
    "巴厘岛5日行程：\n1. 到达乌布，入住酒店\n2. 圣泉寺+梯田\n3. 情人崖看日落\n4. 金巴兰海滩",
    "travel.plan",
  );
  assert.equal(extractCardType(marked), "travel_itinerary");
});

// ─────────────────────────────────────────────────────────────────────────────
// 真实对话触发率回归（2026-08-30）：口语化回复（无 markdown 列表）必须能上卡
// ─────────────────────────────────────────────────────────────────────────────

function semanticCard(text: string, toolName?: string): string {
  const marked = formatSemanticResultForChat(text, toolName);
  assert.ok(marked, `should produce a card: ${text}`);
  const m = marked!.match(/\[AGENT_RESULT_CARD_START\]\n(.*)\n\[AGENT_RESULT_CARD_END\]/);
  assert.ok(m, "card block should exist");
  return JSON.parse(m![1]!).cardType;
}

test("real-dialog: 2-item schedule with clock times becomes timeline card", () => {
  assert.equal(
    semanticCard("上午10点部门例会，下午3点见客户。"),
    "timeline",
  );
});

test("real-dialog: 先/再/最后 narrative steps become steps card", () => {
  assert.equal(semanticCard("先把数据导出，再清洗一遍，最后跑模型。"), "steps");
});

test("real-dialog: inline Chinese-numeral enumeration becomes steps card", () => {
  // 修复前：isValidSemanticEntry 把「二、续签合同」当标题引导行丢弃，
  // 只剩首段，凑不出条目集
  assert.equal(
    semanticCard("本周要办三件事：一、交报表；二、续签合同；三、回复客户邮件。"),
    "steps",
  );
});

test("real-dialog: colloquial label+value+unit list becomes metric card", () => {
  // 修复前：条目带尾部句读（"重量199克，"），尾部锚定的形态校验全灭
  assert.equal(
    semanticCard("这款屏幕尺寸是6.7英寸，重量199克，峰值亮度2000尼特。"),
    "metric",
  );
});

test("real-dialog: two colon metric items become metric card", () => {
  assert.equal(semanticCard("屏幕尺寸：6.7英寸，重量：199g。"), "metric");
});

test("real-dialog: bare A/B labeled items become comparison_table card", () => {
  // 修复前：compare 意图（区别/怎么选）有分但缺形态证据，被 ByForm 门拦下，
  // 即使路由到 compare 也因无图在前端静默回退通用卡；
  // 修复后：A/B 成对条目直接上 comparison_table 双栏对比卡。
  assert.equal(
    semanticCard("两款手机的区别主要在屏幕和续航。A便宜些，B性能强，看你怎么选。"),
    "comparison_table",
  );
});

test("real-dialog: 2-item day-word-only narrative stays plain (no clock)", () => {
  // 2 条目 timeline 门槛收紧：必须带钟点，日期泛指（明天/后天）不算
  assert.equal(formatSemanticResultForChat("明天上午可能下雨，后天下午就放晴了。"), null);
});

test("real-dialog: 2-item step-ish narrative stays plain", () => {
  // 2 条目只放行 timeline/metric；「先A，再B」两步闲聊不上卡
  assert.equal(formatSemanticResultForChat("先把碗筷收好，再擦一遍桌子。"), null);
});

test("real-dialog: 第X天 narrative itinerary becomes timeline card", () => {
  // 修复前：TIME_MARK_RE 不认「第X天」，多日行程叙事上不了时间轴
  assert.equal(
    semanticCard("第一天去乌布看梯田，第二天去圣泉寺，第三天金巴兰看日落。"),
    "timeline",
  );
});

test("real-dialog: date-range plan becomes timeline card", () => {
  // 2 条目守门认精确日期（X月X号），泛指日期（明天/后天）仍不上卡
  assert.equal(semanticCard("3月5号出发，3月8号回程。"), "timeline");
});

test("real-dialog: 8+ item markdown list folds into fold_list card", () => {
  // 修复前：routeRender 的 result_card 上限 7 条，8-12 条 markdown 清单
  // 永远上不了卡（带意图词的问句还会被推去 structured 富文本）
  const items = Array.from({ length: 8 }, (_, i) => `- 物品${i + 1}`).join("\n");
  assert.equal(
    extractCardType(formatAgentResultForChat(`采购清单：\n${items}`, undefined)),
    "fold_list",
  );
});

test("real-dialog: 顿号 enumeration becomes chips card", () => {
  // 修复前：顿号不在子句切分符里（语义路径看不见并列项）；
  // 修复后切分、且尾顿号/短名词句号被剥掉，chips 标点护栏不再误伤
  assert.equal(
    semanticCard("去超市需要买：苹果、香蕉、橙子、牛奶、鸡蛋。"),
    "chips",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// steps 意图标记回归（2026-09-02「性感一点的女生照片」案例）：
// 「先/再」是口语最高频的连接词，不构成步骤语义——修复前含「你先看看…
// 我再往红毯那边翻翻」的纯闲聊被切成 8 条编号碎片上步骤卡。
// ─────────────────────────────────────────────────────────────────────────────

test("steps intent ignores 先/再 connectives (photo-chat regression)", () => {
  const reply =
    "给你找了几张景甜的，偏温婉甜美那一挂，也有套海蓝色亮片薄纱裙的，带点清凉性感味。" +
    "你先看看合不合口味。要是想要更性感火辣的那种，我再往红毯活动造型那边翻翻。";
  const items = extractSemanticItems(reply).map((text) => ({ text, type: "num" }));
  // 全文只有「先/再」两个口语连接词 → steps 意图分为 0，不路由到 steps
  const type = routeDisplayEffect({ title: "", items, fullText: reply });
  assert.ok(type !== "steps", `闲聊不应上步骤卡，实际: ${type}`);
  // 闲聊文本整体不上任何内容卡（保持纯文本聊天节奏）
  assert.equal(formatSemanticResultForChat(reply), null);
});

test("steps intent still fires on strong sequence markers", () => {
  // 「先A，然后B，最后C」含 然后+最后 两个强标记 → 步骤语义保留
  const marked = formatSemanticResultForChat(
    "先把水烧开，然后放入面条，最后加上调料拌一拌，就可以开吃了。",
    "cooking.make",
  );
  assert.ok(marked, "强顺序标记的叙述仍应上步骤卡");
  const m = marked!.match(/\[AGENT_RESULT_CARD_START\]\n(.*)\n\[AGENT_RESULT_CARD_END\]/);
  assert.ok(m);
  assert.equal(JSON.parse(m![1]!).cardType, "steps");
});

// ── 财务能力域（finance.*）工具路由 ──────────────────────────────

test("finance tools route to their domain cards", () => {
  // 订阅清单 → 折叠列表卡（强工具）
  assert.equal(
    routeDisplayEffect({ toolName: "finance.list_subscriptions", title: "订阅盘点", items: [{ text: "Netflix：¥45.00/月" }] }),
    "fold_list",
  );
  // 预算执行 → 数据面板卡（强工具）
  assert.equal(
    routeDisplayEffect({ toolName: "finance.get_budget_status", title: "预算执行", items: [{ text: "餐饮：¥85.00 / ¥100.00" }] }),
    "metric",
  );
  // 消费分析 → 数据面板倾向（弱工具，无内容信号时保底）
  assert.equal(
    routeDisplayEffect({ toolName: "finance.analyze_spending", title: "消费分析", items: [] }),
    "metric",
  );
  // 报告导出 → 文件卡（强工具）
  assert.equal(
    routeDisplayEffect({ toolName: "finance.export_report", title: "财务报告", items: [{ text: "report.md" }] }),
    "file",
  );
});
