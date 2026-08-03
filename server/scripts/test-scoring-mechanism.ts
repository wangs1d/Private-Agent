/**
 * 统一打分机制测试：验证全维度渐进式更新、信号类型分类、权重分级、防漂移。
 *
 * 测试项：
 *   1. 信号类型分类：explicit_strong / explicit_weak / inferred / style_request
 *   2. stability 渐进累积：不同信号类型有不同的累积速度
 *   3. effectiveWeight 分级：definitive / probable / hint / none
 *   4. 交互风格平滑过渡：progress 逐步推进
 *   5. 纠正后降权：stability 衰减
 *   6. 防漂移验证：单次表达不会突变
 *
 * 运行：npx tsx scripts/test-scoring-mechanism.ts
 */
import { OnlineLearningCortex } from "../src/brain/online-learning-cortex.js";

const cortex = new OnlineLearningCortex();
const actorId = "test-user";

// 辅助：构造路由决策
function makeRoute(mode: "fast" | "complex" = "fast") {
  return { mode, confidence: 0.7, reason: "test", matchedRules: [] };
}

// 辅助：获取条目有效权重
function weight(cortex: OnlineLearningCortex, actorId: string): number {
  const p = cortex.getProfile(actorId);
  return p.interactionStyle.stability * p.interactionStyle.confidence;
}

// 辅助：获取偏好条目的有效权重
function prefWeight(cortex: OnlineLearningCortex, actorId: string, key: string): number | null {
  const p = cortex.getProfile(actorId);
  const entry = p.preferences.find((e) => e.key === key);
  if (!entry) return null;
  return entry.stability * entry.confidence;
}

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
  if (condition) {
    console.log(`  ✓ ${msg}`);
    passed++;
  } else {
    console.log(`  ✗ ${msg}`);
    failed++;
  }
}

function assertApprox(actual: number, expected: number, tolerance: number, msg: string): void {
  const diff = Math.abs(actual - expected);
  assert(diff <= tolerance, `${msg}（期望≈${expected.toFixed(3)}，实际=${actual.toFixed(3)}，差=${diff.toFixed(3)}）`);
}

// ============================================================================
// 测试 1：信号类型分类与初始 stability
// ============================================================================
console.log("\n" + "=".repeat(70));
console.log("  测试 1：信号类型分类与初始 stability");
console.log("=".repeat(70));

// explicit_strong："我喜欢Python"
cortex.observe(actorId, { text: "我喜欢Python" }, makeRoute());
const prof1 = cortex.getProfile(actorId);
const pref1 = prof1.preferences.find((e) => e.value === "Python" || e.value.includes("Python"));
assert(pref1 !== undefined, "explicit_strong 偏好被提取");
assert(pref1?.signalType === "explicit_strong", "信号类型为 explicit_strong");
assertApprox(pref1?.stability ?? 0, 0.35, 0.01, "explicit_strong 初始 stability=0.35");
assertApprox(pref1?.confidence ?? 0, 0.8, 0.01, "explicit_strong 初始 confidence=0.8");
const w1 = (pref1?.stability ?? 0) * (pref1?.confidence ?? 0);
assertApprox(w1, 0.28, 0.02, "effectiveWeight = 0.35×0.8 = 0.28（hint 级别）");

// explicit_weak："还行"
cortex.observe(actorId, { text: "Java还可以" }, makeRoute());
const prof2 = cortex.getProfile(actorId);
const pref2 = prof2.preferences.find((e) => e.key === "weak_preference");
assert(pref2 !== undefined, "explicit_weak 偏好被提取");
assert(pref2?.signalType === "explicit_weak", "信号类型为 explicit_weak");
assertApprox(pref2?.stability ?? 0, 0.15, 0.01, "explicit_weak 初始 stability=0.15");
assertApprox(pref2?.confidence ?? 0, 0.5, 0.01, "explicit_weak 初始 confidence=0.5");

// inferred：从路由推断习惯
cortex.observe(actorId, { text: "查一下天气" }, makeRoute("complex"));
const prof3 = cortex.getProfile(actorId);
const habit1 = prof3.habits.find((e) => e.key === "task_preference" && e.value === "complex_tasks");
assert(habit1 !== undefined, "inferred 习惯被提取");
assert(habit1?.signalType === "inferred", "信号类型为 inferred");
assertApprox(habit1?.stability ?? 0, 0.08, 0.01, "inferred 初始 stability=0.08");

// ============================================================================
// 测试 2：stability 渐进累积
// ============================================================================
console.log("\n" + "=".repeat(70));
console.log("  测试 2：stability 渐进累积（同一偏好多次观察）");
console.log("=".repeat(70));

const cortex2 = new OnlineLearningCortex();
const actor2 = "test-stability";

// 第1次："我喜欢Python" → stability=0.35
cortex2.observe(actor2, { text: "我喜欢Python" }, makeRoute());
let p = cortex2.getProfile(actor2);
let entry = p.preferences.find((e) => e.key === "preference")!;
assertApprox(entry.stability, 0.35, 0.01, "第1次 stability=0.35");
assertApprox(entry.confidence, 0.8, 0.01, "第1次 confidence=0.8");

// 第2次："我特别喜欢Python" → stability=0.35+0.30=0.65
cortex2.observe(actor2, { text: "我特别喜欢Python" }, makeRoute());
p = cortex2.getProfile(actor2);
entry = p.preferences.find((e) => e.key === "preference" && (e.value === "Python" || e.value.includes("Python")))!;
assertApprox(entry.stability, 0.65, 0.01, "第2次 stability=0.65（+0.30）");
assertApprox(entry.confidence, 0.9, 0.01, "第2次 confidence=0.90（+0.10）");

// 第3次："我喜欢Python" → stability=0.95
cortex2.observe(actor2, { text: "我喜欢Python" }, makeRoute());
p = cortex2.getProfile(actor2);
entry = p.preferences.find((e) => e.key === "preference" && (e.value === "Python" || e.value.includes("Python")))!;
assertApprox(entry.stability, 0.95, 0.01, "第3次 stability=0.95（+0.30）");

// effectiveWeight 此时 = 0.95 × 1.0 = 0.95 ≥ 0.6 → definitive
const w = entry.stability * entry.confidence;
assert(w >= 0.6, `第3次 effectiveWeight=${w.toFixed(2)} ≥ 0.6 → definitive 级别`);

// ============================================================================
// 测试 3：effectiveWeight 分级
// ============================================================================
console.log("\n" + "=".repeat(70));
console.log("  测试 3：effectiveWeight 分级（hint → probable → definitive）");
console.log("=".repeat(70));

const cortex3 = new OnlineLearningCortex();
const actor3 = "test-weight";

// 第1次：weight = 0.35×0.8 = 0.28 → hint 级别
cortex3.observe(actor3, { text: "我喜欢Rust" }, makeRoute());
let pw = prefWeight(cortex3, actor3, "preference");
assert(pw !== null && pw >= 0.15 && pw < 0.3, `第1次 weight=${pw?.toFixed(2)} → hint 级别`);

// 第2次：stability=0.65, confidence=0.9 → weight=0.585 → probable
cortex3.observe(actor3, { text: "我喜欢Rust" }, makeRoute());
pw = prefWeight(cortex3, actor3, "preference");
assert(pw !== null && pw >= 0.3 && pw < 0.6, `第2次 weight=${pw?.toFixed(2)} → probable 级别`);

// 第3次：stability=0.95, confidence=1.0 → weight=0.95 → definitive
cortex3.observe(actor3, { text: "我喜欢Rust" }, makeRoute());
pw = prefWeight(cortex3, actor3, "preference");
assert(pw !== null && pw >= 0.6, `第3次 weight=${pw?.toFixed(2)} → definitive 级别`);

// ============================================================================
// 测试 4：交互风格平滑过渡
// ============================================================================
console.log("\n" + "=".repeat(70));
console.log("  测试 4：交互风格平滑过渡（balanced → concise）");
console.log("=".repeat(70));

const cortex4 = new OnlineLearningCortex();
const actor4 = "test-style";

// 初始风格 = balanced
let styleProf = cortex4.getProfile(actor4);
assert(styleProf.interactionStyle.value === "balanced", "初始风格 = balanced");
assert(styleProf.styleTransition === undefined, "初始无过渡状态");

// 第1次说"简洁一点" → 开始过渡，progress=0.3
cortex4.observe(actor4, { text: "简洁一点" }, makeRoute());
styleProf = cortex4.getProfile(actor4);
assert(styleProf.styleTransition !== undefined, "第1次：建立过渡状态");
assertApprox(styleProf.styleTransition!.progress, 0.3, 0.01, "第1次：progress=0.30");
assert(styleProf.interactionStyle.value === "balanced", "第1次：value 仍为 balanced（未完成过渡）");

// 第2次普通对话 → tickTransition 推进 +0.05 = 0.35
cortex4.observe(actor4, { text: "今天天气怎么样" }, makeRoute());
styleProf = cortex4.getProfile(actor4);
assertApprox(styleProf.styleTransition!.progress, 0.35, 0.01, "第2次（普通对话）：progress=0.35（被动+0.05）");

// 第3次说"简洁" → tick +0.05=0.40, 主动推进 +0.3 = 0.70
cortex4.observe(actor4, { text: "简洁点说" }, makeRoute());
styleProf = cortex4.getProfile(actor4);
assertApprox(styleProf.styleTransition!.progress, 0.70, 0.01, "第3次（再次要求简洁）：progress=0.70（tick+主动）");

// 第4次普通对话 → tickTransition +0.05 = 0.75
cortex4.observe(actor4, { text: "帮我查个东西" }, makeRoute());
styleProf = cortex4.getProfile(actor4);
assertApprox(styleProf.styleTransition!.progress, 0.75, 0.01, "第4次（普通对话）：progress=0.75");

// 继续推进直到完成
for (let i = 0; i < 10; i++) {
  cortex4.observe(actor4, { text: `普通对话第${i}轮` }, makeRoute());
}
styleProf = cortex4.getProfile(actor4);
assert(styleProf.styleTransition === undefined, "过渡完成：styleTransition 被清理");
assert(styleProf.interactionStyle.value === "concise", "过渡完成：value 切换为 concise");

// ============================================================================
// 测试 5：纠正后 stability 降权
// ============================================================================
console.log("\n" + "=".repeat(70));
console.log("  测试 5：纠正后 stability 降权");
console.log("=".repeat(70));

const cortex5 = new OnlineLearningCortex();
const actor5 = "test-correction";

// 先建立偏好
cortex5.observe(actor5, { text: "我喜欢Java" }, makeRoute());
let cp = cortex5.getProfile(actor5);
let cEntry = cp.preferences.find((e) => e.key === "preference")!;
const beforeStab = cEntry.stability;
const beforeConf = cEntry.confidence;
console.log(`  纠正前：stability=${beforeStab.toFixed(2)}, confidence=${beforeConf.toFixed(2)}`);

// 纠正
cortex5.recordCorrection(actor5, "不对，应该是Python");
cp = cortex5.getProfile(actor5);

// 旧偏好被降权
cEntry = cp.preferences.find((e) => e.key === "preference" && (e.value === "Java" || e.value.includes("Java")))!;
if (cEntry) {
  assert(cEntry.stability < beforeStab, `纠正后旧偏好 stability 下降（${cEntry.stability.toFixed(2)} < ${beforeStab.toFixed(2)}）`);
} else {
  // 如果旧偏好被降权后 observations <= 3 也可能存在
  console.log("  (旧偏好 Java 可能已被移除或降权)");
}

// 纠正确认的新偏好存在
const corrected = cp.preferences.find((e) => e.key === "corrected_preference" && e.value === "Python");
assert(corrected !== undefined, "纠正后新偏好 corrected_preference=Python 被提取");
assertApprox(corrected?.stability ?? 0, 0.35, 0.01, "纠正偏好 stability=0.35（explicit_strong）");

// negativeFeedbackCount 增加
assert(cp.negativeFeedbackCount === 1, "negativeFeedbackCount=1");

// ============================================================================
// 测试 6：防漂移验证 — 单次表达不会突变
// ============================================================================
console.log("\n" + "=".repeat(70));
console.log("  测试 6：防漂移验证（单次表达不会突变）");
console.log("=".repeat(70));

const cortex6 = new OnlineLearningCortex();
const actor6 = "test-nodrift";

// 单次说"我喜欢Go" → weight = 0.35×0.8 = 0.28，只是 hint 级别
cortex6.observe(actor6, { text: "我喜欢Go" }, makeRoute());
const p6 = cortex6.getProfile(actor6);
const e6 = p6.preferences.find((e) => e.key === "preference")!;
const w6 = e6.stability * e6.confidence;
assert(w6 < 0.3, `单次表达 weight=${w6.toFixed(2)} < 0.3，未达到 probable 级别，不会突变`);

// 检查 applyToPrompt 的输出：应该是"似乎有此偏好"而非"用户偏好"
const prompt6 = cortex6.applyToPrompt(actor6);
assert(prompt6.includes("似乎"), `单次表达 prompt 包含"似乎"（提示性引导）：${prompt6.slice(0, 80)}...`);
assert(!prompt6.includes("用户偏好："), `单次表达 prompt 不包含确定性"用户偏好："`);

// 再说一次 → weight 应该上升但仍未到 definitive
cortex6.observe(actor6, { text: "我喜欢Go" }, makeRoute());
const p6b = cortex6.getProfile(actor6);
const e6b = p6b.preferences.find((e) => e.key === "preference")!;
const w6b = e6b.stability * e6b.confidence;
assert(w6b >= 0.3 && w6b < 0.6, `两次表达 weight=${w6b.toFixed(2)} → probable 级别（0.3-0.6）`);

const prompt6b = cortex6.applyToPrompt(actor6);
assert(prompt6b.includes("可能"), `两次表达 prompt 包含"可能"（概率性引导）：${prompt6b.slice(0, 80)}...`);

// 第三次 → definitive
cortex6.observe(actor6, { text: "我喜欢Go" }, makeRoute());
const p6c = cortex6.getProfile(actor6);
const e6c = p6c.preferences.find((e) => e.key === "preference")!;
const w6c = e6c.stability * e6c.confidence;
assert(w6c >= 0.6, `三次表达 weight=${w6c.toFixed(2)} → definitive 级别（≥0.6）`);

const prompt6c = cortex6.applyToPrompt(actor6);
assert(prompt6c.includes("用户偏好："), `三次表达 prompt 包含确定性"用户偏好："`);
// 检查偏好部分不再包含"似乎"（但习惯部分可能仍包含，因为 inferred 较慢）
const prefSection6c = prompt6c.split("\n").filter((l) => l.includes("偏好")).join("\n");
assert(!prefSection6c.includes("似乎"), `三次表达偏好部分不再包含"似乎"`);

// ============================================================================
// 测试 7：inferred 信号比 explicit 慢
// ============================================================================
console.log("\n" + "=".repeat(70));
console.log("  测试 7：inferred 信号比 explicit 慢");
console.log("=".repeat(70));

const cortex7 = new OnlineLearningCortex();
const actor7 = "test-speed";

// inferred：5 次路由推断
for (let i = 0; i < 5; i++) {
  cortex7.observe(actor7, { text: `查询${i}` }, makeRoute("complex"));
}
const p7 = cortex7.getProfile(actor7);
const h7 = p7.habits.find((e) => e.key === "task_preference" && e.value === "complex_tasks")!;
const w7 = h7.stability * h7.confidence;
console.log(`  inferred 5次后：stability=${h7.stability.toFixed(2)}, confidence=${h7.confidence.toFixed(2)}, weight=${w7.toFixed(2)}`);
assert(w7 < 0.6, `inferred 5 次后 weight=${w7.toFixed(2)} < 0.6（仍未到 definitive）`);

// explicit_strong：2 次就能到 definitive
const cortex7b = new OnlineLearningCortex();
const actor7b = "test-speed-2";
cortex7b.observe(actor7b, { text: "我喜欢Kotlin" }, makeRoute());
cortex7b.observe(actor7b, { text: "我喜欢Kotlin" }, makeRoute());
const p7b = cortex7b.getProfile(actor7b);
const e7b = p7b.preferences.find((e) => e.key === "preference")!;
const w7b = e7b.stability * e7b.confidence;
console.log(`  explicit_strong 2次后：stability=${e7b.stability.toFixed(2)}, confidence=${e7b.confidence.toFixed(2)}, weight=${w7b.toFixed(2)}`);
assert(w7b >= 0.3, `explicit_strong 2 次后 weight=${w7b.toFixed(2)} ≥ 0.3（已达 probable）`);

// ============================================================================
// 测试 8：不同 key 的偏好可以共存
// ============================================================================
console.log("\n" + "=".repeat(70));
console.log("  测试 8：不同 key/value 的偏好可以共存（不删除旧值）");
console.log("=".repeat(70));

const cortex8 = new OnlineLearningCortex();
const actor8 = "test-coexist";

cortex8.observe(actor8, { text: "我喜欢Python" }, makeRoute());
cortex8.observe(actor8, { text: "我喜欢Rust" }, makeRoute());
const p8 = cortex8.getProfile(actor8);
// 两个偏好应该都存在（不同的 value）
const pyEntry = p8.preferences.find((e) => e.value === "Python" || e.value.includes("Python"));
const rsEntry = p8.preferences.find((e) => e.value === "Rust" || e.value.includes("Rust"));
assert(pyEntry !== undefined, "偏好 Python 存在");
assert(rsEntry !== undefined, "偏好 Rust 存在");
assert(p8.preferences.length >= 2, `两个偏好共存（共 ${p8.preferences.length} 条）`);

// ============================================================================
// 总结
// ============================================================================
console.log("\n" + "=".repeat(70));
console.log(`  测试完成：${passed} 通过，${failed} 失败`);
console.log("=".repeat(70));

if (failed > 0) {
  process.exit(1);
}
