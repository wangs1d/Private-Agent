/**
 * PlannerCortex.shouldDelegate 规则层压力测试（Task 6）
 *
 * 目标：验证 shouldDelegate 在大量输入下的准确性、覆盖率和延迟稳定性。
 * shouldDelegate 是纯规则判断（白名单 + 委派倾向词 + 步骤数估算 + agentType 映射），
 * 不依赖任何注入子系统，可直接实例化 PlannerCortex 调用。
 *
 * 用法：
 *   npx tsx scripts/stress-should-delegate.ts
 */
import { performance } from "node:perf_hooks";
import { PlannerCortex } from "../src/brain/planner-cortex.js";
import type { SubAgentType } from "../src/services/master-agent-types.js";

// ---- 测试用例定义 --------------------------------------------------------

interface DelegateCase {
  category: string;
  input: string;
  expectDelegate: boolean;
  expectAgentType?: SubAgentType;
}

const CASES: DelegateCase[] = [
  // 1. 不委派-白名单（15 条）：时间/天气/打招呼/感谢/告别
  { category: "whitelist", input: "现在几点", expectDelegate: false },
  { category: "whitelist", input: "今天天气怎么样", expectDelegate: false },
  { category: "whitelist", input: "你好", expectDelegate: false },
  { category: "whitelist", input: "早上好", expectDelegate: false },
  { category: "whitelist", input: "谢谢", expectDelegate: false },
  { category: "whitelist", input: "再见", expectDelegate: false },
  { category: "whitelist", input: "hi", expectDelegate: false },
  { category: "whitelist", input: "hello", expectDelegate: false },
  { category: "whitelist", input: "晚安", expectDelegate: false },
  { category: "whitelist", input: "拜拜", expectDelegate: false },
  { category: "whitelist", input: "现在什么时间", expectDelegate: false },
  { category: "whitelist", input: "外面下雨吗", expectDelegate: false },
  { category: "whitelist", input: "嗨", expectDelegate: false },
  { category: "whitelist", input: "多谢", expectDelegate: false },
  { category: "whitelist", input: "回见", expectDelegate: false },
  { category: "whitelist", input: "今天星期几", expectDelegate: false },

  // 2. 不委派-单步操作（10 条）：单步搜索/查询，步骤数 ≤ 3
  { category: "single-step", input: "帮我搜索Python教程", expectDelegate: false },
  { category: "single-step", input: "查一下北京的天气", expectDelegate: false },
  { category: "single-step", input: "找一首歌", expectDelegate: false },
  { category: "single-step", input: "搜索附近的餐厅", expectDelegate: false },
  { category: "single-step", input: "查个单词的意思", expectDelegate: false },
  { category: "single-step", input: "帮我查个航班", expectDelegate: false },
  { category: "single-step", input: "搜索如何做菜", expectDelegate: false },
  { category: "single-step", input: "找个电影", expectDelegate: false },
  { category: "single-step", input: "查一下新闻", expectDelegate: false },
  { category: "single-step", input: "帮我查个电话号码", expectDelegate: false },

  // 3. 委派-tech（15 条）：多步 RPA/系统操作，步骤数 > 3
  { category: "tech", input: "打开浏览器查三个网站并对比价格然后生成报告", expectDelegate: true, expectAgentType: "tech" },
  { category: "tech", input: "打开记事本输入文字然后保存再关闭", expectDelegate: true, expectAgentType: "tech" },
  { category: "tech", input: "批量重命名桌面上的所有文件然后整理到不同文件夹", expectDelegate: true, expectAgentType: "tech" },
  { category: "tech", input: "打开IDE运行项目然后截图发给我", expectDelegate: true, expectAgentType: "tech" },
  { category: "tech", input: "配置系统环境变量然后重启服务再验证", expectDelegate: true, expectAgentType: "tech" },
  { category: "tech", input: "打开控制面板修改设置然后清理临时文件再重启", expectDelegate: true, expectAgentType: "tech" },
  { category: "tech", input: "自动化操作Excel导入数据然后生成图表再导出PDF", expectDelegate: true, expectAgentType: "tech" },
  { category: "tech", input: "打开邮件客户端批量发送邮件然后归档", expectDelegate: true, expectAgentType: "tech" },
  { category: "tech", input: "操作桌面应用填写表单然后提交再截图", expectDelegate: true, expectAgentType: "tech" },
  { category: "tech", input: "打开命令行执行多个命令然后收集输出", expectDelegate: true, expectAgentType: "tech" },
  { category: "tech", input: "配置开发环境然后克隆仓库再安装依赖最后运行测试", expectDelegate: true, expectAgentType: "tech" },
  { category: "tech", input: "打开浏览器登录系统然后导出数据再分析", expectDelegate: true, expectAgentType: "tech" },
  { category: "tech", input: "批量处理图片然后压缩打包再上传", expectDelegate: true, expectAgentType: "tech" },
  { category: "tech", input: "打开任务管理器结束进程然后清理注册表", expectDelegate: true, expectAgentType: "tech" },
  { category: "tech", input: "自动化RPA流程操作三个应用然后汇总结果", expectDelegate: true, expectAgentType: "tech" },

  // 4. 委派-info（10 条）：多步研究/调研/对比
  { category: "info", input: "研究一下市场然后对比三个产品接着分析价格再生成报告", expectDelegate: true, expectAgentType: "info" },
  { category: "info", input: "调研三个竞品的功能然后对比优缺点再总结", expectDelegate: true, expectAgentType: "info" },
  { category: "info", input: "深度分析行业趋势然后查找数据再生成报告", expectDelegate: true, expectAgentType: "info" },
  { category: "info", input: "搜索多个来源对比信息然后综合分析", expectDelegate: true, expectAgentType: "info" },
  { category: "info", input: "查多个网站的价格然后对比再给出建议", expectDelegate: true, expectAgentType: "info" },
  { category: "info", input: "研究技术方案然后对比三个选项再推荐", expectDelegate: true, expectAgentType: "info" },
  { category: "info", input: "调研用户评价然后分析趋势再总结", expectDelegate: true, expectAgentType: "info" },
  { category: "info", input: "查找三篇论文然后对比方法再综合", expectDelegate: true, expectAgentType: "info" },
  { category: "info", input: "搜索市场数据然后分析竞品再生成报告", expectDelegate: true, expectAgentType: "info" },
  { category: "info", input: "深度研究课题然后对比资料再写总结", expectDelegate: true, expectAgentType: "info" },

  // 5. 委派-life（10 条）：多步生活服务
  { category: "life", input: "订餐然后打车再预订酒店接着买票最后下单", expectDelegate: true, expectAgentType: "life" },
  { category: "life", input: "购物下单然后预订餐厅再叫车最后买电影票", expectDelegate: true, expectAgentType: "life" },
  { category: "life", input: "点外卖然后买药再预订挂号最后打车去医院", expectDelegate: true, expectAgentType: "life" },
  { category: "life", input: "订机票然后订酒店再租车最后预订餐厅", expectDelegate: true, expectAgentType: "life" },
  { category: "life", input: "买早餐然后打车去公司再订午餐最后买下午茶", expectDelegate: true, expectAgentType: "life" },
  { category: "life", input: "购物清单下单然后预订家政再叫快递最后付账单", expectDelegate: true, expectAgentType: "life" },
  { category: "life", input: "订花然后买礼物再预订餐厅最后打车去约会", expectDelegate: true, expectAgentType: "life" },
  { category: "life", input: "点餐然后买电影票再预订KTV最后打车回家", expectDelegate: true, expectAgentType: "life" },
  { category: "life", input: "买菜然后订餐再买药最后下单日用品", expectDelegate: true, expectAgentType: "life" },
  { category: "life", input: "预订健身房然后买课程再订装备最后下单补剂", expectDelegate: true, expectAgentType: "life" },
];

// ---- 压测执行 ------------------------------------------------------------

interface CaseResult {
  case: DelegateCase;
  actualDelegate: boolean;
  actualAgentType?: SubAgentType;
  actualReason?: string;
  passed: boolean;
  latencyMs: number;
}

function runOnce(cortex: PlannerCortex, c: DelegateCase): CaseResult {
  const t0 = performance.now();
  const result = cortex.shouldDelegate(c.input, { actorId: "stress-test" });
  const t1 = performance.now();

  const actualDelegate = result.delegate;
  const actualAgentType = result.agentType;
  const actualReason = result.reason;

  let passed: boolean;
  if (c.expectDelegate) {
    passed =
      actualDelegate === true && actualAgentType === c.expectAgentType;
  } else {
    passed = actualDelegate === false;
  }

  return {
    case: c,
    actualDelegate,
    actualAgentType,
    actualReason,
    passed,
    latencyMs: t1 - t0,
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, idx))];
}

function main(): void {
  // shouldDelegate 是纯规则方法，不依赖任何注入子系统，直接 new 即可
  const cortex = new PlannerCortex();

  console.log("=".repeat(72));
  console.log("PlannerCortex.shouldDelegate 压力测试（Task 6）");
  console.log("=".repeat(72));
  console.log(`总用例数: ${CASES.length}`);
  console.log(`  - whitelist (不委派-白名单): ${CASES.filter((c) => c.category === "whitelist").length}`);
  console.log(`  - single-step (不委派-单步): ${CASES.filter((c) => c.category === "single-step").length}`);
  console.log(`  - tech (委派-tech): ${CASES.filter((c) => c.category === "tech").length}`);
  console.log(`  - info (委派-info): ${CASES.filter((c) => c.category === "info").length}`);
  console.log(`  - life (委派-life): ${CASES.filter((c) => c.category === "life").length}`);
  console.log("-".repeat(72));

  // 先做一次 warmup（让 V8 JIT 预热），不计入统计
  for (const c of CASES) {
    cortex.shouldDelegate(c.input, { actorId: "warmup" });
  }

  // 正式压测：每个用例执行一次并计时
  const results: CaseResult[] = CASES.map((c) => runOnce(cortex, c));

  // ---- 逐用例明细 ----
  console.log("逐用例结果：");
  console.log(
    "  # | 类别        | 通过 | 预期(delegate/type)        | 实际(delegate/type)        | 延迟(ms)",
  );
  let idx = 1;
  for (const r of results) {
    const expectStr = r.case.expectDelegate
      ? `true/${r.case.expectAgentType ?? "-"}`
      : "false/-";
    const actualStr = r.actualDelegate
      ? `true/${r.actualAgentType ?? "-"}`
      : "false/-";
    const mark = r.passed ? "OK" : "FAIL";
    console.log(
      `  ${String(idx).padStart(2)} | ${r.case.category.padEnd(11)} | ${mark.padEnd(4)} | ${expectStr.padEnd(26)} | ${actualStr.padEnd(26)} | ${r.latencyMs.toFixed(4)}`,
    );
    idx++;
  }
  console.log("-".repeat(72));

  // ---- 准确率统计 ----
  const passedCount = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed);
  const accuracy = (passedCount / results.length) * 100;

  // 按类别统计
  const byCategory = new Map<string, { total: number; passed: number }>();
  for (const r of results) {
    const cat = r.case.category;
    const entry = byCategory.get(cat) ?? { total: 0, passed: 0 };
    entry.total++;
    if (r.passed) entry.passed++;
    byCategory.set(cat, entry);
  }

  console.log("按类别准确率：");
  for (const [cat, stat] of byCategory) {
    const catAcc = (stat.passed / stat.total) * 100;
    console.log(`  ${cat.padEnd(12)}: ${stat.passed}/${stat.total} = ${catAcc.toFixed(1)}%`);
  }
  console.log("-".repeat(72));

  // ---- 延迟统计 ----
  const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  const totalLatency = latencies.reduce((s, x) => s + x, 0);
  const avgLatency = totalLatency / latencies.length;
  const p50 = percentile(latencies, 50);
  const p95 = percentile(latencies, 95);
  const p99 = percentile(latencies, 99);
  const maxLatency = latencies[latencies.length - 1];
  const minLatency = latencies[0];

  console.log("延迟统计（单次 shouldDelegate 调用，单位 ms）：");
  console.log(`  总耗时       : ${totalLatency.toFixed(4)} ms`);
  console.log(`  最小延迟     : ${minLatency.toFixed(4)} ms`);
  console.log(`  平均延迟     : ${avgLatency.toFixed(4)} ms`);
  console.log(`  P50 延迟     : ${p50.toFixed(4)} ms`);
  console.log(`  P95 延迟     : ${p95.toFixed(4)} ms`);
  console.log(`  P99 延迟     : ${p99.toFixed(4)} ms`);
  console.log(`  最大延迟     : ${maxLatency.toFixed(4)} ms`);
  console.log("-".repeat(72));

  // ---- 失败用例详情 ----
  if (failed.length > 0) {
    console.log(`失败用例详情（${failed.length} 条）：`);
    for (const r of failed) {
      const expectStr = r.case.expectDelegate
        ? `delegate=true, agentType=${r.case.expectAgentType}`
        : "delegate=false";
      const actualStr = r.actualDelegate
        ? `delegate=true, agentType=${r.actualAgentType}, reason="${r.actualReason ?? ""}"`
        : "delegate=false";
      console.log(`  [${r.case.category}] input="${r.case.input}"`);
      console.log(`      预期: ${expectStr}`);
      console.log(`      实际: ${actualStr}`);
    }
    console.log("-".repeat(72));
  } else {
    console.log("失败用例详情：无");
    console.log("-".repeat(72));
  }

  // ---- 验收标准判定 ----
  const accPass = accuracy >= 95;
  const avgPass = avgLatency < 5;
  const p95Pass = p95 < 10;

  console.log("验收标准判定：");
  console.log(`  准确率 ≥ 95%        : ${accuracy.toFixed(1)}%  → ${accPass ? "PASS" : "FAIL"}`);
  console.log(`  平均延迟 < 5ms       : ${avgLatency.toFixed(4)} ms → ${avgPass ? "PASS" : "FAIL"}`);
  console.log(`  P95 延迟 < 10ms      : ${p95.toFixed(4)} ms → ${p95Pass ? "PASS" : "FAIL"}`);
  console.log(`  无崩溃/无异常        : PASS`);
  const overall = accPass && avgPass && p95Pass;
  console.log("-".repeat(72));
  console.log(`总体结论: ${overall ? "PASS（通过验收标准）" : "FAIL（未通过验收标准）"}`);
  console.log("=".repeat(72));
}

main();
