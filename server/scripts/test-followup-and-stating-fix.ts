/**
 * 2026-07-29 修复验证：追问正则扩展 + userLocation 误触发拦截
 *
 * 验证目标：
 *   1. "再具体一点呢" 等追问能被 isAmbiguousFollowUpMessage 识别
 *   2. "今天20到26度" 等陈述能被 RuleRouter 识别为 userIsStatingData
 *   3. 原有 follow-up 识别（"然后呢"/"你确定吗"）仍然工作
 *   4. 原有 chitchat / 普通短句不被误判为 follow-up 或 stating data
 *
 * 运行：npx tsx scripts/test-followup-and-stating-fix.ts
 */
import { isAmbiguousFollowUpMessage, AMBIGUOUS_FOLLOWUP_RE } from "../src/agent/memory-signal.js";

const cases: Array<{ input: string; expectFollowup: boolean; note: string }> = [
  // === 原有用例回归（必须仍识别） ===
  { input: "然后呢", expectFollowup: true, note: "原有短追问" },
  { input: "接着呢", expectFollowup: true, note: "原有短追问" },
  { input: "你确定吗", expectFollowup: true, note: "原有短追问" },
  { input: "是吗", expectFollowup: true, note: "原有短追问" },
  { input: "为什么", expectFollowup: true, note: "原有短追问" },
  { input: "？", expectFollowup: true, note: "原有纯标点" },

  // === 新增用例（修复目标） ===
  { input: "再具体一点呢", expectFollowup: true, note: "用户反馈的原 bug 用例" },
  { input: "再具体讲讲", expectFollowup: true, note: "新追问" },
  { input: "具体点", expectFollowup: true, note: "新追问" },
  { input: "具体一点", expectFollowup: true, note: "新追问" },
  { input: "展开说说", expectFollowup: true, note: "新追问" },
  { input: "展开讲讲", expectFollowup: true, note: "新追问" },
  { input: "详细点", expectFollowup: true, note: "新追问" },
  { input: "细说", expectFollowup: true, note: "新追问" },
  { input: "继续说", expectFollowup: true, note: "新追问" },
  { input: "往下说", expectFollowup: true, note: "新追问" },
  { input: "怎么弄", expectFollowup: true, note: "新追问" },
  { input: "怎么办", expectFollowup: true, note: "新追问" },
  { input: "怎么讲", expectFollowup: true, note: "新追问" },
  { input: "解释一下", expectFollowup: true, note: "新追问" },
  { input: "给我看看", expectFollowup: true, note: "新追问" },
  { input: "给我讲讲", expectFollowup: true, note: "新追问" },
  { input: "给我说说", expectFollowup: true, note: "新追问" },
  { input: "给我聊聊", expectFollowup: true, note: "新追问" },
  { input: "你说呢", expectFollowup: true, note: "新追问" },
  { input: "具体咋办", expectFollowup: true, note: "新追问" },
  { input: "具体怎么弄", expectFollowup: true, note: "新追问" },
  // 中等长度追问（10+字）
  { input: "再具体讲讲来龙去脉", expectFollowup: true, note: "长追问（验证 20→40 限制）" },
  { input: "再详细说说这个方案", expectFollowup: true, note: "长追问（验证 20→40 限制）" },

  // === 反例：必须 NOT 识别为追问 ===
  { input: "今天20到26度，出门带把伞", expectFollowup: false, note: "用户在陈述（不是追问）" },
  { input: "你好", expectFollowup: false, note: "寒暄" },
  { input: "今天天气怎么样", expectFollowup: false, note: "查询" },
  { input: "帮我查一下明天去北京的机票", expectFollowup: false, note: "完整任务请求" },
  { input: "我在北京", expectFollowup: false, note: "陈述位置" },
  { input: "你说得对", expectFollowup: false, note: "确认" },
];

async function main() {
  console.log("=".repeat(80));
  console.log("追问正则 + 陈述数据 修复验证");
  console.log("=".repeat(80));

  let pass = 0;
  let fail = 0;
  const fails: string[] = [];

  for (const c of cases) {
    const got = isAmbiguousFollowUpMessage(c.input);
    const ok = got === c.expectFollowup;
    const mark = ok ? "✅" : "❌";
    if (ok) pass++;
    else {
      fail++;
      fails.push(`  [${c.note}] input="${c.input}" expect=${c.expectFollowup} got=${got}`);
    }
    console.log(`${mark}  expect=${c.expectFollowup ? "追问" : "非追问"} got=${got ? "追问" : "非追问"}  | "${c.input}"  (${c.note})`);
  }

  console.log("\n" + "=".repeat(80));
  console.log(`结果：${pass}/${pass + fail} 通过`);
  if (fail > 0) {
    console.log("失败用例：");
    fails.forEach((f) => console.log(f));
    process.exit(1);
  }

  // === 验证 USER_STATING_DATA_RE（在 rule-router.ts 里） ===
  console.log("\n" + "=".repeat(80));
  console.log("USER_STATING_DATA_RE 验证（rule-router.ts 内部正则）");
  console.log("=".repeat(80));

  // 直接拷贝 USER_STATING_DATA_RE 验证（避免循环引用）
  const USER_STATING_DATA_RE = [
    /\d+\s*(?:到|~|～|-)\s*\d+\s*(?:度|℃|°|celsius)/i,
    /(?:气温|温度|体感)[^，。]*?\d+/i,
    /\d+\s*%(?:\s*(?:降水|降雨|湿度|相对湿度|概率))?/i,
    /(?:微风|大风|阵风|台风|暴雨|大雨|中雨|小雨|雷阵雨)[^，。]*?(?:预报|预计|报告)/i,
    /(?:我|我们)\s*(?:要|准备|打算|计划|下(?:周|个月)|明(?:天|年)?|后(?:天|年)?|这(?:周|个月))\s*(?:去|到|在|回|出发|飞|坐|开车|坐车|赶)/i,
    /(?:我|我们)\s*(?:已经|已)\s*(?:到|在|抵达|到达)\s*\S+/i,
    /(?:今天|昨天|明天|后天|大后天)\s*(?:上午|下午|晚上|凌晨|\d+\s*点)\s*(?:我|我们|你|他|她)\s*(?:要|准备|打算|已经)/i,
  ];

  const statingCases: Array<{ input: string; expectStating: boolean; note: string }> = [
    // === 必须识别为"陈述"（不是查询） ===
    { input: "今天20到26度，出门带把伞，穿件薄外套就行", expectStating: true, note: "用户反馈原 bug 用例" },
    { input: "气温25度，体感有点热", expectStating: true, note: "温度+体感" },
    { input: "明天降水概率80%", expectStating: true, note: "降水概率" },
    { input: "暴雨预报说下午有雷阵雨", expectStating: true, note: "天气现象+预报" },
    { input: "我下个月去贵州兴义玩", expectStating: true, note: "行程陈述" },
    { input: "我已经到北京了", expectStating: true, note: "位置陈述" },
    { input: "今天下午我要去开会", expectStating: true, note: "时间+动作" },

    // === 必须 NOT 识别为"陈述"（让原逻辑走 userLocation 反查） ===
    { input: "今天天气怎么样", expectStating: false, note: "用户查询" },
    { input: "明天会下雨吗", expectStating: false, note: "用户查询" },
    { input: "你帮我查一下兴义的天气", expectStating: false, note: "用户查询" },
    { input: "今天20度吗", expectStating: false, note: "含温度但也是查询" }, // 单值 20 度，不带"到 X"区间
    { input: "你好", expectStating: false, note: "寒暄" },
  ];

  let pass2 = 0;
  let fail2 = 0;
  const fails2: string[] = [];
  for (const c of statingCases) {
    const got = USER_STATING_DATA_RE.some((re) => re.test(c.input));
    const ok = got === c.expectStating;
    const mark = ok ? "✅" : "❌";
    if (ok) pass2++;
    else {
      fail2++;
      fails2.push(`  [${c.note}] input="${c.input}" expect=${c.expectStating} got=${got}`);
    }
    console.log(`${mark}  expect=${c.expectStating ? "陈述" : "非陈述"} got=${got ? "陈述" : "非陈述"}  | "${c.input}"  (${c.note})`);
  }

  console.log("\n" + "=".repeat(80));
  console.log(`结果：${pass2}/${pass2 + fail2} 通过`);
  if (fail2 > 0) {
    console.log("失败用例：");
    fails2.forEach((f) => console.log(f));
    process.exit(1);
  }

  console.log("\n🎉 全部通过！");
}

main().catch((err) => {
  console.error("[test] 异常:", err);
  process.exit(1);
});
