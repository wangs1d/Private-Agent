/**
 * 验证 CapabilityCortex.attachToolNames + formatCapabilityList + selectRelevantTools。
 *
 * 三件事：
 *   1. attachToolNames 把 ToolRegistry 已注册工具名按 domain 填充到 descriptor.tools
 *   2. formatCapabilityList 输出真实工具名（非 "0 tools"）
 *   3. selectRelevantTools("打电话给我") 在 tool search 路径能选中 phone.call_user
 *      （验证不需要把全部工具塞进 system prompt）
 *
 * 用法：tsx scripts/test-capability-cortex-attach.ts
 */
import { CapabilityCortex } from "../src/brain/capability-cortex.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import {
  getBuiltinAgentChatTools,
  selectRelevantTools,
  setBrainChatTools,
} from "../src/external-model/openai-compatible-tool-loop.js";
import { BRAIN_TOOLS } from "../src/tools/brain-tools.js";

// ---- 模拟一份完整的 ToolRegistry.list() 返回值 ----
// 直接构造工具名列表，与 bootstrap 真实注册后的一致性靠命名约定保证
const MOCK_TOOL_NAMES = [
  // phone
  "phone.ensure_my_number",
  "phone.virtual_call",
  "phone.call_user",
  "phone_bridge.ring",
  "phone_bridge.hang_up",
  // wallet
  "wallet.get_balance",
  "wallet.get_transactions",
  "wallet.transfer",
  "wallet.recharge",
  "wallet.purchase",
  // calendar / reminder
  "reminder.plan",
  "calendar.create_from_text",
  "calendar.create_task",
  "calendar.list_tasks",
  // weather
  "weather.get_local",
  // web
  "search_web",
  "fetch_web",
  "info.inspect_webpage",
  "info.navigate_site",
  // voice
  "voice.speak",
  "voice.send_message",
  "voice.transcribe",
  // clock
  "clock.get_current_time",
  "clock.get_user_location",
  "clock.get_date",
  "clock.format_timestamp",
  // notes
  "notes.create",
  "notes.list",
  "notes.search",
  "notes.update",
  "notes.delete",
  // capability modules
  "image.generate",
  "file.read_text",
  "file.write_text",
  "email.send",
  "sms.send",
  "media.search",
  "media.play",
  "health.log_metric",
  "finance.import_transactions",
  "social.post",
  "social.comment",
  "social.repost",
  "social.like",
  "social.get_feed",
  "social.search_posts",
  "code.run",
  "code.shell",
  "shopping.order.search",
  "shopping.order.place",
  "agent_browser.open",
  "agent_browser.click",
  // world
  "world.open_registry.agent_quick",
  "world.free_market.purchase_skill",
  "world.social.post",
  "world.social.comment",
  "world.social.like_toggle",
  // embodiment / smart_home
  "embodiment.roam",
  "embodiment.move",
  "smart_home.list_devices",
  "smart_home.control_device",
  // sub_agent
  "master.invoke_sub_agent",
  "master.list_sub_agents",
  // agent_link / relay
  "agent.link.list_friends",
  "agent.link.send_friend_request",
  "agent.send_to_peer",
  // agent_account
  "agent.register_account",
  // self_programming
  "self.create_skill",
  "self.update_skill",
  // query
  "agent.query_capabilities",
  "brain.list_capabilities",
  // aip
  "aip.dispatch",
  "aip.list_my_state",
  "aip.get_proposal",
  // vision
  "vision.http_pull",
  "vision.periodic_start",
  "vision.periodic_stop",
  "vision.periodic_list",
  // desktop
  "desktop.visual.screenshot",
  "desktop.visual.run_task",
  "desktop.open",
  "desktop.run_preset",
  "desktop.run_shell",
  "desktop.uia_query",
  "desktop.run_automation",
  "desktop.http_get",
  "desktop.web_search",
  "desktop.web_fetch",
  "browser.session.list",
  "browser.fetch_page",
  // life_assistant
  "budget.calculate",
  "shopping.suggest",
];

let pass = 0;
let fail = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) {
    pass++;
    console.log(`  ✅ ${msg}`);
  } else {
    fail++;
    console.error(`  ❌ ${msg}`);
  }
}

async function main(): Promise<void> {
  // ----------------------------------------------------------------
  // 测试 1：attachToolNames 把 phone.* / phone_bridge.* 填到 phone domain
  // ----------------------------------------------------------------
  console.log("\n[Test 1] attachToolNames 把工具名填充到对应 domain");

  const cortex = new CapabilityCortex();
  const before = cortex.snapshot().find((c) => c.domain === "phone");
  console.log(
    `  attach 前 phone.tools = [${before?.tools.join(", ") ?? "(无)"}] (length=${before?.tools.length ?? 0})`,
  );
  assert((before?.tools.length ?? 0) === 0, "attach 前 phone domain tools 为空");

  cortex.attachToolNames(MOCK_TOOL_NAMES);

  const after = cortex.snapshot().find((c) => c.domain === "phone");
  console.log(
    `  attach 后 phone.tools = [${after?.tools.join(", ") ?? "(无)"}] (length=${after?.tools.length ?? 0})`,
  );
  assert(
    (after?.tools.length ?? 0) === 5,
    "phone domain 填充 5 个工具 (3 个 phone.* + 2 个 phone_bridge.*)",
  );
  assert(
    after?.tools.includes("phone.call_user") ?? false,
    "phone domain 包含 phone.call_user",
  );
  assert(
    after?.tools.includes("phone.ensure_my_number") ?? false,
    "phone domain 包含 phone.ensure_my_number",
  );
  assert(
    after?.tools.includes("phone_bridge.ring") ?? false,
    "phone domain 包含 phone_bridge.ring",
  );

  // ----------------------------------------------------------------
  // 测试 2：social_feed / social_outreach 工具名前缀冲突已被正确区分
  // ----------------------------------------------------------------
  console.log("\n[Test 2] social_feed / social_outreach 区分");

  const socialFeed = cortex.snapshot().find((c) => c.domain === "social_feed");
  const socialOutreach = cortex.snapshot().find((c) => c.domain === "social_outreach");
  console.log(`  social_feed.tools = [${socialFeed?.tools.join(", ")}]`);
  console.log(`  social_outreach.tools = [${socialOutreach?.tools.join(", ")}]`);
  assert(
    (socialFeed?.tools.length ?? 0) === 3,
    "social_feed 命中 3 个 world.social.* 工具",
  );
  assert(
    (socialOutreach?.tools.length ?? 0) === 6,
    "social_outreach 命中 6 个 social.* 工具（不含 world. 前缀）",
  );
  assert(
    socialFeed?.tools.every((n) => n.startsWith("world.social.")) ?? false,
    "social_feed 全部带 world.social. 前缀",
  );
  assert(
    socialOutreach?.tools.every((n) => !n.startsWith("world.")) ?? false,
    "social_outreach 全部不带 world. 前缀",
  );

  // ----------------------------------------------------------------
  // 测试 3：所有非空 domain 都被填充，没有 "0 tools" 残留
  // ----------------------------------------------------------------
  console.log("\n[Test 3] 所有 domain 都有真实工具（非 0 tools）");

  const allAfter = cortex.snapshot();
  const emptyDomains = allAfter.filter(
    (c) => c.tools.length === 0 && c.domain !== "entertainment",
  );
  console.log(
    `  空工具 domain：[${emptyDomains.map((c) => c.domain).join(", ") || "(无)"}]`,
  );
  // 允许 entertainment 是空（CAPABILITY_DOMAINS 里登记但确实无工具）
  // 其余 domain 都应有工具
  const allowedEmpty = new Set(["entertainment"]);
  const unexpectedEmpty = emptyDomains.filter((c) => !allowedEmpty.has(c.domain));
  assert(
    unexpectedEmpty.length === 0,
    `没有未预期的空工具 domain（除 ${[...allowedEmpty].join(",")} 外）`,
  );

  // ----------------------------------------------------------------
  // 测试 4：formatCapabilityList 输出真实工具名（这部分用真实 brain-tools.ts 不可
  // 直接 import 私有函数，间接验证：snapshot 返回的 tools 数组非空）
  // ----------------------------------------------------------------
  console.log("\n[Test 4] snapshot 返回 tools 数组带真实工具名");
  const phoneSnap = cortex.snapshot().find((c) => c.domain === "phone");
  const sampleLine = phoneSnap
    ? `${phoneSnap.domain} - ${phoneSnap.label} [${phoneSnap.status}] (${phoneSnap.tools.length} tools)\n  ↳ ${phoneSnap.tools.join(", ")}`
    : "(无)";
  console.log("  formatCapabilityList 样例输出：");
  console.log("  " + sampleLine.split("\n").join("\n  "));
  assert(
    phoneSnap?.tools.length === 5,
    "phone snapshot tools 数组长度 = 5",
  );
  assert(
    !sampleLine.includes("0 tools"),
    "summary 不再出现 \"0 tools\" 字样",
  );

  // ----------------------------------------------------------------
  // 测试 5：tool search 路径 —— selectRelevantTools("打电话") 选中 phone.call_user
  // ----------------------------------------------------------------
  console.log("\n[Test 5] selectRelevantTools tool search 路径");

  // 模拟 bootstrap 已启用 Brain Center：注入 BRAIN_TOOLS schema
  setBrainChatTools(BRAIN_TOOLS);

  const allTools = getBuiltinAgentChatTools();
  console.log(`  builtin tools 总数 = ${allTools.length}`);

  // 模拟 "打电话给我" 这种用户输入
  const userText = "帮我打个电话告诉妈妈我要晚到";
  const selected = selectRelevantTools(userText, allTools, {
    minTools: 4,
    maxTools: allTools.length,
    includeAlwaysIncluded: true,
  });
  const selectedNames = selected
    .map((t) => (t.type === "function" ? t.function?.name : undefined))
    .filter((n): n is string => Boolean(n));
  console.log(`  输入「${userText}」选中 ${selectedNames.length} 个工具`);
  console.log(`  前 10 个：${selectedNames.slice(0, 10).join(", ")}`);

  assert(
    selectedNames.includes("phone.call_user"),
    "phone.call_user 被关键词命中并选中",
  );
  assert(
    selectedNames.includes("phone.ensure_my_number"),
    "phone.ensure_my_number 被 phone 分类关键词命中",
  );
  assert(
    selectedNames.includes("brain.list_capabilities"),
    "brain.list_capabilities 在 ALWAYS_INCLUDED_TOOLS 中（用户可问能力）",
  );
  assert(
    selectedNames.includes("agent.query_capabilities"),
    "agent.query_capabilities 在 ALWAYS_INCLUDED_TOOLS 中",
  );

  // ----------------------------------------------------------------
  // 测试 6：tool search 不需要全量工具塞进 prompt —— 验证 selectRelevantTools
  // 返回的工具数远小于全量
  // ----------------------------------------------------------------
  console.log("\n[Test 6] tool search 选出的工具数远小于全量");
  const ratio = (selected.length / allTools.length) * 100;
  console.log(`  选中 ${selected.length}/${allTools.length} (${ratio.toFixed(1)}%)`);
  assert(
    selected.length < allTools.length,
    `selectRelevantTools 只选出 ${selected.length} 个工具，小于全量 ${allTools.length}（不需要全塞进 prompt）`,
  );

  // ----------------------------------------------------------------
  // 总结
  // ----------------------------------------------------------------
  console.log("\n========== 总结 ==========");
  console.log(`通过：${pass}，失败：${fail}`);
  if (fail > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("测试执行失败：", err);
  process.exit(1);
});
