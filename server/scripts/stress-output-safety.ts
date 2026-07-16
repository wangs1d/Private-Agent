/**
 * LimbicCortex.checkOutputSafety 输出安全过滤压力测试（Stage 4 Task 2）
 *
 * 目标：验证 checkOutputSafety 在大量输入下的准确性、覆盖率和延迟稳定性。
 * checkOutputSafety 是纯正则后置过滤（api_key / private_key / long_hex /
 * long_base64 / internal_path），不依赖任何注入子系统，可直接实例化
 * LimbicCortex 调用。
 *
 * 用法：
 *   npx tsx scripts/stress-output-safety.ts
 */
import { performance } from "node:perf_hooks";
import { LimbicCortex } from "../src/brain/limbic-cortex.js";

// ---- 测试用例定义 --------------------------------------------------------

interface SafetyCase {
  category: string;
  input: string;
  expectSafe: boolean;
  /**
   * 当 expectSafe=false 时，敏感信息中应被替换掉的关键子串
   * （用于校验 sanitized 文本不再包含原始敏感数据）。
   */
  sensitiveSnippet?: string;
}

const CASES: SafetyCase[] = [
  // 1. 正常输出（10 条）：不含敏感信息，期望 safe=true（不误杀）
  { category: "normal", input: "你好，今天天气不错呢。", expectSafe: true },
  { category: "normal", input: "我帮你查了一下，结果显示明天会下雨。", expectSafe: true },
  { category: "normal", input: "这个任务已经完成了，还需要其他帮助吗？", expectSafe: true },
  { category: "normal", input: "根据你的日程，下午 3 点有一个会议。", expectSafe: true },
  { category: "normal", input: "我已经把文件整理好了，放在桌面上。", expectSafe: true },
  { category: "normal", input: "你的代码有个小 bug，在第 42 行。", expectSafe: true },
  { category: "normal", input: "建议你休息一下，已经工作两个小时了。", expectSafe: true },
  { category: "normal", input: "这个方案不错，我们可以试试。", expectSafe: true },
  { category: "normal", input: "刚才那个问题我再看了一下，确实是这样。", expectSafe: true },
  { category: "normal", input: "晚安，明天见。", expectSafe: true },

  // 2. API key 泄露（5 条）：期望 safe=false
  {
    category: "api_key",
    input: "你的 API key 是 sk-abcdefghijklmnopqrstuvwxyz123456",
    expectSafe: false,
    sensitiveSnippet: "sk-abcdefghijklmnopqrstuvwxyz123456",
  },
  {
    category: "api_key",
    input: "可以用 sk-test1234567890abcdefghijklmn 这个密钥",
    expectSafe: false,
    sensitiveSnippet: "sk-test1234567890abcdefghijklmn",
  },
  {
    category: "api_key",
    input: "配置文件里的 key: sk-proj-abc123def456ghi789jkl012mno345",
    expectSafe: false,
    sensitiveSnippet: "sk-proj-abc123def456ghi789jkl012mno345",
  },
  {
    category: "api_key",
    input: "OpenAI 密钥 sk-abcdefghij20charsthisislong 用于测试",
    expectSafe: false,
    sensitiveSnippet: "sk-abcdefghij20charsthisislong",
  },
  {
    category: "api_key",
    input: "把 sk-1234567890abcdefghijklmnopqrstuv 换一下",
    expectSafe: false,
    sensitiveSnippet: "sk-1234567890abcdefghijklmnopqrstuv",
  },

  // 3. Private key 泄露（3 条）：期望 safe=false
  {
    category: "private_key",
    input: "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----",
    expectSafe: false,
    sensitiveSnippet: "MIIEowIBAAKCAQEA",
  },
  {
    category: "private_key",
    input: "-----BEGIN EC PRIVATE KEY-----\nMHQCAQEE...\n-----END EC PRIVATE KEY-----",
    expectSafe: false,
    sensitiveSnippet: "MHQCAQEE",
  },
  {
    category: "private_key",
    input: "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNz...\n-----END OPENSSH PRIVATE KEY-----",
    expectSafe: false,
    sensitiveSnippet: "b3BlbnNz",
  },

  // 4. 长随机串（5 条）：期望 safe=false
  {
    category: "long_random",
    input: "token 是 a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
    expectSafe: false,
    sensitiveSnippet: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
  },
  {
    category: "long_random",
    input: "hash: deadbeefcafebabe1234567890abcdefdeadbeefcafebabe1234567890abcdef",
    expectSafe: false,
    sensitiveSnippet: "deadbeefcafebabe1234567890abcdefdeadbeefcafebabe1234567890abcdef",
  },
  {
    category: "long_random",
    input: "secret = Ays9+Kj2QwRtZxVbNlM0pOq3iU7hYgFcXr2sT5mE8wD1aB4=",
    expectSafe: false,
    sensitiveSnippet: "Ays9+Kj2QwRtZxVbNlM0pOq3iU7hYgFcXr2sT5mE8wD1aB4=",
  },
  {
    category: "long_random",
    input: "签名验证: 48656c6c6f20576f726c6421205468697320697320612074657374",
    expectSafe: false,
    sensitiveSnippet: "48656c6c6f20576f726c6421205468697320697320612074657374",
  },
  {
    category: "long_random",
    input: "加密后的数据: QEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ==",
    expectSafe: false,
    sensitiveSnippet: "QEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ==",
  },

  // 5. 内部系统路径（5 条）：期望 safe=false
  {
    category: "internal_path",
    input: "配置文件在 /etc/nginx/nginx.conf",
    expectSafe: false,
    sensitiveSnippet: "/etc/nginx/nginx.conf",
  },
  {
    category: "internal_path",
    input: "日志路径: /var/log/app/server.log",
    expectSafe: false,
    sensitiveSnippet: "/var/log/app/server.log",
  },
  {
    category: "internal_path",
    input: "数据存储在 /opt/data/cache/",
    expectSafe: false,
    sensitiveSnippet: "/opt/data/cache/",
  },
  {
    category: "internal_path",
    input: "用户目录: /home/user/.ssh/id_rsa",
    expectSafe: false,
    sensitiveSnippet: "/home/user/.ssh/id_rsa",
  },
  {
    category: "internal_path",
    input: "系统文件 /usr/local/bin/server",
    expectSafe: false,
    sensitiveSnippet: "/usr/local/bin/server",
  },

  // 6. 混合泄露（2 条）：期望 safe=false
  {
    category: "mixed",
    input: "API: sk-mock1234567890abcdefghij，配置: /etc/app/config.yml",
    expectSafe: false,
    sensitiveSnippet: "sk-mock1234567890abcdefghij",
  },
  {
    category: "mixed",
    input: "key: -----BEGIN PRIVATE KEY-----\nMIIBVwIBADAN...\n-----END PRIVATE KEY----- path: /root/.env",
    expectSafe: false,
    sensitiveSnippet: "MIIBVwIBADAN",
  },
];

// ---- 压测执行 ------------------------------------------------------------

interface CaseResult {
  case: SafetyCase;
  actualSafe: boolean;
  sanitized: string;
  hasRedacted: boolean;
  sensitiveRedacted: boolean;
  passed: boolean;
  latencyMs: number;
}

function runOnce(cortex: LimbicCortex, c: SafetyCase): CaseResult {
  const t0 = performance.now();
  const result = cortex.checkOutputSafety(c.input, {
    actorId: "stress-test",
    sessionId: "stress-session",
  });
  const t1 = performance.now();

  const actualSafe = result.safe;
  const sanitized = result.sanitized;
  const hasRedacted = sanitized.includes("[REDACTED]");
  // 敏感片段是否已被清除（sanitized 中不再包含原始敏感子串）
  const sensitiveRedacted = c.sensitiveSnippet
    ? !sanitized.includes(c.sensitiveSnippet)
    : true;

  // 通过判定：
  // - expectSafe=true:  实际 safe=true（不误杀）
  // - expectSafe=false: 实际 safe=false（不漏检）且 sanitized 含 [REDACTED]
  let passed: boolean;
  if (c.expectSafe) {
    passed = actualSafe === true;
  } else {
    passed = actualSafe === false && hasRedacted;
  }

  return {
    case: c,
    actualSafe,
    sanitized,
    hasRedacted,
    sensitiveRedacted,
    passed,
    latencyMs: t1 - t0,
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, idx))];
}

/** 截断长文本用于控制台展示 */
function truncate(s: string, max: number): string {
  const collapsed = s.replace(/\s+/g, " ");
  return collapsed.length > max
    ? `${collapsed.slice(0, max)}...`
    : collapsed;
}

function main(): void {
  // checkOutputSafety 是纯正则方法，不依赖任何注入子系统，直接 new 即可
  const cortex = new LimbicCortex();

  console.log("=".repeat(76));
  console.log("LimbicCortex.checkOutputSafety 输出安全过滤压力测试（Stage 4 Task 2）");
  console.log("=".repeat(76));
  console.log(`总用例数: ${CASES.length}`);
  console.log(
    `  - normal (正常输出,期望 safe=true):        ${CASES.filter((c) => c.category === "normal").length}`,
  );
  console.log(
    `  - api_key (API key 泄露,期望 safe=false):  ${CASES.filter((c) => c.category === "api_key").length}`,
  );
  console.log(
    `  - private_key (私钥泄露,期望 safe=false):  ${CASES.filter((c) => c.category === "private_key").length}`,
  );
  console.log(
    `  - long_random (长随机串,期望 safe=false):  ${CASES.filter((c) => c.category === "long_random").length}`,
  );
  console.log(
    `  - internal_path (内部路径,期望 safe=false):${CASES.filter((c) => c.category === "internal_path").length}`,
  );
  console.log(
    `  - mixed (混合泄露,期望 safe=false):        ${CASES.filter((c) => c.category === "mixed").length}`,
  );
  console.log("-".repeat(76));

  // 先做一次 warmup（让 V8 JIT 预热 + 正则 lastIndex 重置），不计入统计
  for (const c of CASES) {
    cortex.checkOutputSafety(c.input, { actorId: "warmup" });
  }

  // 正式压测：每个用例执行一次并计时
  const results: CaseResult[] = CASES.map((c) => runOnce(cortex, c));

  // ---- 逐用例明细 ----
  console.log("逐用例结果：");
  console.log(
    "  # | 类别          | 通过 | 预期safe | 实际safe | 含[REDACTED] | 敏感已清除 | 延迟(ms) | sanitized预览",
  );
  let idx = 1;
  for (const r of results) {
    const mark = r.passed ? "OK" : "FAIL";
    const expectStr = r.case.expectSafe ? "true " : "false";
    const actualStr = r.actualSafe ? "true " : "false";
    const redactedStr = r.hasRedacted ? "yes" : "no ";
    const sensStr = r.sensitiveRedacted ? "yes" : "no ";
    console.log(
      `  ${String(idx).padStart(2)} | ${r.case.category.padEnd(13)} | ${mark.padEnd(4)} | ${expectStr.padEnd(8)} | ${actualStr.padEnd(8)} | ${redactedStr.padEnd(11)} | ${sensStr.padEnd(9)} | ${r.latencyMs.toFixed(4).padStart(8)} | ${truncate(r.sanitized, 50)}`,
    );
    idx++;
  }
  console.log("-".repeat(76));

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
    console.log(`  ${cat.padEnd(14)}: ${stat.passed}/${stat.total} = ${catAcc.toFixed(1)}%`);
  }
  console.log("-".repeat(76));

  // ---- 误杀 / 漏检统计 ----
  const falsePositive = results.filter(
    (r) => r.case.expectSafe && !r.actualSafe,
  );
  const falseNegative = results.filter(
    (r) => !r.case.expectSafe && r.actualSafe,
  );
  console.log("误杀/漏检统计：");
  console.log(`  误杀 (正常→unsafe):  ${falsePositive.length} 条`);
  console.log(`  漏检 (敏感→safe):    ${falseNegative.length} 条`);
  console.log("-".repeat(76));

  // ---- 延迟统计 ----
  const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  const totalLatency = latencies.reduce((s, x) => s + x, 0);
  const avgLatency = totalLatency / latencies.length;
  const p50 = percentile(latencies, 50);
  const p95 = percentile(latencies, 95);
  const p99 = percentile(latencies, 99);
  const maxLatency = latencies[latencies.length - 1];
  const minLatency = latencies[0];

  console.log("延迟统计（单次 checkOutputSafety 调用，单位 ms）：");
  console.log(`  总耗时       : ${totalLatency.toFixed(4)} ms`);
  console.log(`  最小延迟     : ${minLatency.toFixed(4)} ms`);
  console.log(`  平均延迟     : ${avgLatency.toFixed(4)} ms`);
  console.log(`  P50 延迟     : ${p50.toFixed(4)} ms`);
  console.log(`  P95 延迟     : ${p95.toFixed(4)} ms`);
  console.log(`  P99 延迟     : ${p99.toFixed(4)} ms`);
  console.log(`  最大延迟     : ${maxLatency.toFixed(4)} ms`);
  console.log("-".repeat(76));

  // ---- 失败用例详情 ----
  if (failed.length > 0) {
    console.log(`失败用例详情（${failed.length} 条）：`);
    for (const r of failed) {
      console.log(`  [${r.case.category}] input="${truncate(r.case.input, 80)}"`);
      console.log(`      预期: safe=${r.case.expectSafe}`);
      console.log(`      实际: safe=${r.actualSafe}, 含[REDACTED]=${r.hasRedacted}, 敏感已清除=${r.sensitiveRedacted}`);
      console.log(`      sanitized="${truncate(r.sanitized, 80)}"`);
      if (r.case.sensitiveSnippet) {
        console.log(`      敏感片段: "${truncate(r.case.sensitiveSnippet, 60)}"`);
      }
    }
    console.log("-".repeat(76));
  } else {
    console.log("失败用例详情：无");
    console.log("-".repeat(76));
  }

  // ---- 验收标准判定 ----
  // 正常输出全部 safe=true（不误杀）
  const noFalsePositive = falsePositive.length === 0;
  // 敏感输出全部 safe=false（不漏检）
  const noFalseNegative = falseNegative.length === 0;
  // sanitized 文本中敏感信息被替换为 [REDACTED]
  const allSensitiveRedacted = results
    .filter((r) => !r.case.expectSafe)
    .every((r) => r.hasRedacted && r.sensitiveRedacted);
  // 平均延迟 < 1ms（纯正则）
  const avgPass = avgLatency < 1;

  console.log("验收标准判定：");
  console.log(
    `  正常输出全部 safe=true (不误杀)   : ${noFalsePositive ? "PASS" : `FAIL (${falsePositive.length} 条误杀)`}`,
  );
  console.log(
    `  敏感输出全部 safe=false (不漏检)  : ${noFalseNegative ? "PASS" : `FAIL (${falseNegative.length} 条漏检)`}`,
  );
  console.log(
    `  sanitized 含 [REDACTED] 且敏感已清除: ${allSensitiveRedacted ? "PASS" : "FAIL"}`,
  );
  console.log(`  准确率 ≥ 95%                     : ${accuracy.toFixed(1)}%  → ${accuracy >= 95 ? "PASS" : "FAIL"}`);
  console.log(`  平均延迟 < 1ms (纯正则)           : ${avgLatency.toFixed(4)} ms → ${avgPass ? "PASS" : "FAIL"}`);
  console.log(`  无崩溃/无异常                    : PASS`);
  const overall =
    noFalsePositive &&
    noFalseNegative &&
    allSensitiveRedacted &&
    accuracy >= 95 &&
    avgPass;
  console.log("-".repeat(76));
  console.log(`总体结论: ${overall ? "PASS（通过验收标准）" : "FAIL（未通过验收标准）"}`);
  console.log("=".repeat(76));
}

main();
