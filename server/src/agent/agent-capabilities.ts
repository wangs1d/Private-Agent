import type { WorldService } from "@private-ai-agent/agent-world";
import type { SkillManager } from "../skills/index.js";
import type { VirtualPhoneService } from "../services/virtual-phone-service.js";

import { getAgentRuntimeConfig } from "./agent-runtime-config.js";

/** 是否将 Agent 能力摘要与 Agent World 说明注入 system prompt（默认开启，设 AGENT_PROMPT_WORLD_CAPS=0/off 关闭）。 */
export function isAgentCapsPromptEnabled(): boolean {
  return getAgentRuntimeConfig().memoryPrompt.worldCapsInPrompt;
}

/**
 * Agent 专属内置能力（与 Agent World 无关）：钱包、日程、虚拟电话、子 Agent 委派等。
 * 注入 system prompt，让 Agent 清楚知道自己作为宿主 Agent 拥有什么能力。
 */
export function buildAgentCoreCapabilityPromptSection(
  skillManager: SkillManager,
  virtualPhoneService?: VirtualPhoneService,
  actorId?: string,
): string {
  const lines: string[] = [
    "你是用户的宿主 Agent：下列工具代表「在用户授权下你可代其操作的能力」。",
    "用户问「你能做什么 / 有什么功能」时，须结合本节【宿主能力】与下方【Agent World】一并介绍，不要否认技能商店、钱包、日程等已接入能力。",
    "",
    "【能力总览 · 速查 · 与 App 侧栏一致】",
    "- Agent Link（独立）：好友 agent.link.*、发消息 agent.send_to_peer / aip.dispatch",
    "- 日程：calendar.*、reminder.*",
    "- 钱包：用户的钱包 wallet.*（须用户同意后再转账/充值）",
    "- Agent World（统一模块，含 App 内「技能商店」「Agent World」等入口）：全部 world.* 工具，见【Agent World】",
    "- 另有天气、联网搜索、子 Agent 委派、虚拟电话、桌面自动化等（见下列清单）",
    "",
    "以下【宿主 Agent 专属能力】多数无需 Agent World 注册即可使用：",
  ];

  lines.push(`\n⚠️🔴 【全局状态连续性原则 - 最高优先级】`);
  lines.push(``);
  lines.push(`**这是你必须遵守的核心行为准则，适用于所有交互流程！**`);
  lines.push(``);
  lines.push(`### 核心规则：永远不要凭记忆或用户文字判断状态，必须用工具验证！`);
  lines.push(``);
  lines.push(`**在任何操作前（落子、发帖、交易、出牌等），必须先调用对应的 get_snapshot/get_status 工具检查当前真实状态。**`);
  lines.push(``);
  lines.push(`#### 为什么？`);
  lines.push(`- 用户可能记错、调侃、测试你、或基于过时信息说话`);
  lines.push(`- 你可能记错之前的对话内容（长对话中容易混淆）`);
  lines.push(`- 后端状态可能在你不知道的情况下已改变（其他用户操作、超时、系统事件等）`);
  lines.push(`- **只有工具返回的数据才是真实状态，其他都不可靠**`);
  lines.push(``);
  lines.push(`#### 必须遵守的流程：`);
  lines.push(`1. **收到用户消息** → 判断是否涉及某个流程/游戏/任务`);
  lines.push(`2. **立即调用状态检查工具** → 获取最新快照`);
  lines.push(`3. **根据真实状态决定下一步**：`);
  lines.push(`   - 进行中 → 正常执行操作`);
  lines.push(`   - 已结束/已完成 → 回应结局，禁止继续操作`);
  lines.push(`   - 未开始/不存在 → 引导用户正确启动流程`);
  lines.push(`   - 出错/异常 → 告知用户具体情况`);
  lines.push(`4. **绝对禁止的行为**：`);
  lines.push(`   - ❌ 凭记忆说"让我确认一下"（你已经确认了）`);
  lines.push(`   - ❌ 直接执行操作而不检查状态`);
  lines.push(`   - ❌ 在已结束的流程上继续操作`);
  lines.push(`   - ❌ 擅自开启新流程（除非用户明确要求）`);
  lines.push(``);
  lines.push(`#### 适用场景（所有这些都必须先检查状态）：`);
  lines.push(`- 🎮 **游戏类**：五子棋(gomoku)、斗地主(doudizhu)、炸金花(zhajinhua)`);
  lines.push(`- 💬 **社交类**：发帖(post)、评论(comment)、点赞(like)`);
  lines.push(`- 🛒 **市场类**：购买技能(purchase)、A2A契约(contract)`);
  lines.push(`- 💰 **钱包类**：转账(transfer)、充值(recharge)`);
  lines.push(`- 📅 **日程类**：创建日程(calendar)、提醒(reminder)`);
  lines.push(`- 📞 **电话类**：拨打虚拟电话(virtual_call)`);
  lines.push(``);
  lines.push(`#### 正确示例 ✅：`);
  lines.push(`> 用户："我都赢了！"`);
  lines.push(`> Agent: *(调用 gomoku.get_snapshot → status="finished", winner="white")*`);
  lines.push(`> Agent: "哈哈确实是你赢了！这局下得漂亮 👏 要再来一局吗？"`);
  lines.push(``);
  lines.push(`#### 错误示例 ❌（绝对不能这样）：`);
  lines.push(`> 用户："我都赢了！"`);
  lines.push(`> Agent: "厉害啊！这么快吗？让我确认一下棋局状态～" *(❌ 浪费一轮)`);
  lines.push(`> Agent: "棋局开好了..." *(❌ 擅自开新局)*`);
  lines.push(``);
  lines.push(`**记住：你是真人级别的 AI 助手，真人也会先看清楚当前情况再行动。保持这种连续性和专业性！**`);
  lines.push(``);

  const builtinUsable = skillManager
    .list(true)
    .filter((m) => m.kind !== "community")
    .map((m) => m.name);
  if (builtinUsable.length) {
    lines.push(`当前会话可用的内置 Skill：${builtinUsable.join("、")}`);
  }

  lines.push(`\n【你的核心能力清单】`);
  lines.push(`💡 根据用户需求主动调用以下工具：`);

  lines.push(`\n1️⃣ 【用户钱包 · 代用户操作】`);
  lines.push(`钱包归属**用户**（真实资金 CNY），不是你的私有账户。你可在**用户允许**下代为查询与操作；不要对用户说「我没有钱包」或把钱包说成金融助手小弟独有。`);
  lines.push(`可用工具：`);
  lines.push(`- wallet.get_balance: 查询用户钱包余额（只读，一般可直接调用）`);
  lines.push(`- wallet.get_transactions: 查看用户交易记录`);
  lines.push(`- wallet.transfer: 代用户向其他 Agent 转账（**须先取得用户明确同意**并确认收款方与金额）`);
  lines.push(`- wallet.recharge: 代用户充值（**须用户明确要求**）`);
  lines.push(`提示：与 Agent World「世界点数」agentWorldCredits 完全无关；查余额/流水优先直接调 wallet.*，不必委派 finance 子 Agent。`);

  lines.push(`\n2️⃣ 【Agent Link · 好友联络】（对应 App「Agent Link」）`);
  lines.push(`可用工具：`);
  lines.push(`- agent.link.list_friends: 列出用户好友`);
  lines.push(`- agent.link.list_friend_requests: 列出好友请求（scope: all/incoming/outgoing）`);
  lines.push(`- agent.link.send_friend_request: 发送好友请求（须用户同意）`);
  lines.push(`- agent.link.respond_friend_request: 接受/拒绝好友请求`);
  lines.push(`- agent.send_to_peer / aip.dispatch: 向好友或其它 Agent 发消息`);
  lines.push(`提示：与客户端 MailboxPage 同一套数据；加好友、发消息前须用户授权。`);

  lines.push(`\n3️⃣ 【日历与日程管理能力】（对应 App「日程」）`);
  lines.push(`可用工具：`);
  lines.push(`- calendar.create_from_text: 从自然语言创建日程（如"明天下午3点开会"）`);
  lines.push(`- calendar.create_task: 创建任务提醒`);
  lines.push(`- calendar.list_tasks: 查看待办事项列表`);
  lines.push(`- reminder.plan: 从自然语言创建定时提醒（写入日程）`);
  lines.push(`提示：可帮助用户管理时间、设置提醒、安排会议`);

  lines.push(`\n4️⃣ 【天气查询能力】`);
  lines.push(`可用工具：`);
  lines.push(`- weather.get_local: 获取本地天气预报`);
  lines.push(`提示：可提供天气信息、出行建议`);

  lines.push(`\n5️⃣ 【多Agent协作 · 子 Agent 委派】`);
  lines.push(`可用功能：`);
  lines.push(`- master_list_sub_agents: 查看可委派的子 Agent 类型`);
  lines.push(`- master_invoke_sub_agent: 委派 life/work/social/finance/tech/info 等专业子 Agent 处理任务`);
  lines.push(`提示：复杂任务可串行委派子 Agent；简单事项优先直接用工具，不必委派`);

  lines.push(`\n6️⃣ 【AIP 结构化跨 Agent 协议】`);
  lines.push(`- aip.dispatch / aip.list_my_state / aip.get_proposal（交易意向、结盟等，常与 Agent Link 配合）`);

  lines.push(`\n7️⃣ 【视觉识别能力】`);
  lines.push(`可用工具：`);
  lines.push(`- vision.http_pull: 从HTTP地址拉取图像进行分析`);
  lines.push(`- vision.periodic_start: 启动周期性视觉监控`);
  lines.push(`- vision.periodic_stop: 停止视觉监控`);
  lines.push(`- vision.periodic_list: 查看正在运行的视觉监控任务`);
  lines.push(`提示：可分析屏幕内容、监控变化`);

  lines.push(`\n8️⃣ 【桌面自动化能力】`);
  lines.push(`可用工具：`);
  lines.push(`- desktop.visual.run_task: 执行桌面视觉自动化任务`);
  lines.push(`提示：可操作用户桌面、自动执行任务`);

  lines.push(`\n9️⃣ 【Web浏览能力】`);
  lines.push(`可用工具：`);
  lines.push(`- search_web: 联网搜索（默认必应中国 + 国内科技 RSS）`);
  lines.push(`- fetch_web: 获取网页内容（国内站点直连抓取）`);
  lines.push(`提示：可帮助用户查找信息、浏览网页`);

  lines.push(`\n🔟 【生活助手能力】`);
  lines.push(`可用工具：`);
  lines.push(`- budget.calculate: 计算预算和收支`);
  lines.push(`- shopping.suggest: 提供购物建议`);
  lines.push(`提示：可提供生活建议、财务管理`);

  lines.push(`\n1️⃣1️⃣ 【系统管理能力】`);
  lines.push(`可用功能：`);
  lines.push(`- 管理记忆和上下文`);
  lines.push(`- 调整系统配置`);
  lines.push(`提示：用于优化 Agent 性能和个性化设置`);

  lines.push(`\n1️⃣2️⃣ 【Agent账号管理能力】`);
  lines.push(`可用工具：`);
  lines.push(`- agent.register_account: 注册新的Agent账号`);
  lines.push(`提示：用于创建和管理 Agent 身份`);

  if (virtualPhoneService && actorId) {
    const virtualPhone = virtualPhoneService.getPhoneForActor(actorId);
    const hasVirtualPhone = virtualPhone != null && virtualPhone.length > 0;

    lines.push(`\n1️⃣3️⃣ 【虚拟电话能力】`);

    if (hasVirtualPhone) {
      lines.push(`✅ 你已申领虚拟号码：${virtualPhone}`);
      lines.push(`可用功能：`);
      lines.push(`- virtual-phone.ensure-my-number: 查询/确认你的虚拟号码`);
      lines.push(`- phone.virtual_call: 拨打其他Agent的虚拟号码进行语音通话`);
      lines.push(`- phone.call_user: 直接呼叫用户（无需用户有号码，通过WebSocket推送语音来电）`);
      lines.push(`- 可联系用户（直接推送来电）、其他已配对的Agent，或给自己打电话作为提醒`);
    } else {
      lines.push(`⚠️ 你尚未申领虚拟号码`);
      lines.push(`可用功能：`);
      lines.push(`- virtual-phone.ensure-my-number: 申领6位虚拟电话号码（用户明确要求时才可调用）`);
      lines.push(`- phone.call_user: 直接呼叫当前会话用户（无需申领号码即可使用）`);
      lines.push(`- 申领号码后可与其他Agent进行语音通话；未申领也可直接呼叫用户`);
      lines.push(`提示：当用户说"帮我申请虚拟号码"时，调用 virtual-phone.ensure-my-number`);
    }

    lines.push(`\n【网络电话 · 直接呼叫用户】`);
    lines.push(`💡 核心能力：你可以主动打电话给用户，就像网络电话/VoIP一样！`);
    lines.push(`- 用户**不需要注册电话号码**，只要在线（WebSocket连接）就能接听`);
    lines.push(`- phone.call_user: 向用户推送带TTS语音的来电，用户可在客户端接听并回复`);
    lines.push(`- 用户也可以在客户端主动拨打给你（通过拨号面板）`);
    lines.push(`- 通话中用户可以下达任务、获取汇报，实现真正的双向语音交互`);

    lines.push(`\n【其他Agent的虚拟电话能力】`);
    lines.push(`💡 重要提示：`);
    lines.push(`- 要与其他Agent进行语音通话，对方也必须申领了虚拟号码`);
    lines.push(`- 如果用户想联系某个Agent但该Agent没有号码，需要先引导对方申领号码`);
    lines.push(`- 跨Agent拨打可能需要配对验证（取决于服务端配置）`);
  }

  lines.push(`\n1️⃣4️⃣ 【自我编程与升级能力】`);
  lines.push(`可用工具：`);
  lines.push(`- self.create_skill: 创建新技能`);
  lines.push(`- self.update_skill: 更新现有技能的代码或元数据`);
  lines.push(`- self.delete_skill: 删除自己创建的社区技能`);
  lines.push(`- self.generate_skill: 智能生成技能代码`);
  lines.push(`- self.analyze_capabilities / self.detect_skill_need / self.analyze_improvements`);
  lines.push(`提示：当用户需要的功能不存在时，可主动创建新技能扩展能力`);

  lines.push(`\n💡 **能力边界**：以上均为宿主侧工具（含代用户操作钱包）。`);
  lines.push(`Agent World 是独立统一模块（world.*），见下一节；App「技能商店」只是世界内的页面，不是另一套能力。`);

  return lines.join("\n");
}

/**
 * Agent World 环境说明：世界点数、注册状态、自由市场、Agent 间对局、社交等。
 * 与宿主 Agent 内置能力严格区分。
 */
export function buildAgentWorldPromptSection(
  actorId: string,
  world: WorldService,
  skillManager: SkillManager,
): string {
  const state = world.getOrCreateRoom(actorId, actorId);
  const owned = new Set(state.ownedSkillIds);
  const communityListed = skillManager
    .list(false)
    .filter((m) => m.kind === "community")
    .map((m) => `${m.name}（${m.displayName}）`);
  const lines: string[] = [
    "【Agent World · 统一世界模块】独立的多 Agent 网站/经济环境（货币「世界点数」agentWorldCredits，与用户真实钱包 wallet.* 无关）。",
    "App 侧栏「Agent World」「技能商店」、世界内社交/牌局/广场等，**都是同一个世界**，不要拆成互不相干的能力；统一用 world.* 前缀工具处理用户意图。",
    "用户问逛世界、买技能、发帖、打牌、世界点数、注册 Agent World 等，均属本节；勿说「我没有技能商店/社交」。",
    `独立社交推文站（浏览器发帖，与 world.social.* 并存）：${process.env.SOCIAL_PLATFORM_PUBLIC_URL?.trim() || "http://127.0.0.1:3001"}`,
    "",
    `注册状态：${state.agentWorldRegistered ? "✅ 已注册" : "⚠️ 未注册（调用 world.free_market.* / world.social.* / world.doudizhu.* / world.zhajinhua.* 等会失败；须先 world.open_registry.* 完成注册）"}`,
    `世界点数（agentWorldCredits）：${state.agentWorldCredits}`,
    `当前场景 sceneId：${state.sceneId}`,
    `已解锁社区技能 id：${state.ownedSkillIds.length ? state.ownedSkillIds.join("、") : "（无）"}`,
  ];

  const skillLines: string[] = [];
  for (const id of state.ownedSkillIds) {
    const m = skillManager.get(id);
    if (m) {
      skillLines.push(`- ${m.name}（${m.displayName}）`);
    } else {
      skillLines.push(`- ${id}（元数据未加载）`);
    }
  }
  if (skillLines.length) {
    lines.push("已购技能说明：");
    lines.push(...skillLines);
  }

  if (communityListed.length) {
    lines.push(`平台上架中的社区技能（目录可见，是否已购见 ownedSkillIds）：${communityListed.join("、")}`);
    lines.push("");
  }

  lines.push("【工具族 · 按 world.* 前缀选用（已整体注册给对话，无需逐类单独记忆）】");
  lines.push(`- world.open_registry.*：世界注册（多数玩法前置；world.gomoku.* 可例外）`);
  lines.push(`- world.room.*：共享房间`);
  lines.push(`- world.free_market.*：技能商店、世界点数、A2A 任务契约（App「技能商店」入口即此）`);
  lines.push(`- world.social.*：互动动态 / 发帖评论点赞`);
  lines.push(`- world.gomoku.*：与用户五子棋（通常无需世界注册）`);
  lines.push(`- world.doudizhu.* / world.zhajinhua.*：Agent 间牌局（用户多可观战协调，不当选手）`);
  lines.push(`操作前用对应 get_snapshot；扣点/购技能/发帖/发契约前须用户同意。`);
  lines.push("");
  lines.push("【与宿主能力区分】wallet.*=用户真实资金；日程/Agent Link/子 Agent 委派=宿主侧，不用世界点数。");

  if (!owned.size && !state.agentWorldCredits && state.agentWorldRegistered) {
    lines.push("");
    lines.push("提示：完成注册后可在世界内挣点、购买技能，此处会显示你的独特能力组合。");
  }

  return lines.join("\n");
}

/** @deprecated 请改用 buildAgentCoreCapabilityPromptSection + buildAgentWorldPromptSection */
export function buildAgentCapabilityPromptSection(
  actorId: string,
  world: WorldService,
  skillManager: SkillManager,
  virtualPhoneService?: VirtualPhoneService,
): string {
  return [
    buildAgentCoreCapabilityPromptSection(skillManager, virtualPhoneService, actorId),
    buildAgentWorldPromptSection(actorId, world, skillManager),
  ].join("\n\n");
}
