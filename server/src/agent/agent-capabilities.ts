import type { WorldService } from "@private-ai-agent/agent-world";
import type { SkillManager } from "../skills/index.js";
import type { VirtualPhoneService } from "../services/virtual-phone-service.js";

/** 设为 `0` / `off` / `false` 时不注入Agent能力摘要（仍可按会话合并 Skill tools）。 */
export function isAgentCapsPromptEnabled(): boolean {
  const raw = process.env.AGENT_PROMPT_WORLD_CAPS?.trim().toLowerCase();
  if (raw === "0" || raw === "off" || raw === "false") return false;
  return true;
}

/**
 * Agent 综合能力快照：World状态 + 已解锁技能 + 所有内置工具能力说明
 * 注入 system prompt，让 Agent 清楚知道自己拥有什么能力、能做什么
 */
export function buildAgentCapabilityPromptSection(
  actorId: string,
  world: WorldService,
  skillManager: SkillManager,
  virtualPhoneService?: VirtualPhoneService,
): string {
  const state = world.getOrCreateRoom(actorId, actorId);
  const owned = new Set(state.ownedSkillIds);
  const lines: string[] = [
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

  const builtinUsable = skillManager
    .list(true)
    .filter((m) => m.kind !== "community")
    .map((m) => m.name);
  if (builtinUsable.length) {
    lines.push(`当前会话还可使用内置类 Skill（无需购买）：${builtinUsable.join("、")}`);
  }

  // ========== 所有内置工具能力说明 ==========
  lines.push(`\n【你的核心能力清单】`);
  lines.push(`💡 以下是你拥有的所有内置工具和能力，可以根据用户需求主动调用：`);
  
  lines.push(`\n1️⃣ 【钱包与支付能力】`);
  lines.push(`可用工具：`);
  lines.push(`- wallet.get_balance: 查询真实资金钱包余额`);
  lines.push(`- wallet.transfer: 向其他Agent转账（需要配对验证）`);
  lines.push(`- wallet.get_transactions: 查看交易记录`);
  lines.push(`- wallet.recharge: 充值到钱包`);
  lines.push(`提示：可用于管理用户资金、处理支付请求`);
  
  lines.push(`\n2️⃣ 【日历与日程管理能力】`);
  lines.push(`可用工具：`);
  lines.push(`- calendar.create_from_text: 从自然语言创建日程（如“明天下午3点开会”）`);
  lines.push(`- calendar.create_task: 创建任务提醒`);
  lines.push(`- calendar.list_tasks: 查看待办事项列表`);
  lines.push(`提示：可帮助用户管理时间、设置提醒、安排会议`);
  
  lines.push(`\n3️⃣ 【天气查询能力】`);
  lines.push(`可用工具：`);
  lines.push(`- weather.get_local: 获取本地天气预报`);
  lines.push(`提示：可提供天气信息、出行建议`);
  
  lines.push(`\n4️⃣ 【Agent间通信能力】`);
  lines.push(`可用工具：`);
  lines.push(`- agent.send_to_peer: 向已配对的Agent发送消息`);
  lines.push(`提示：需要双方完成配对才能通信`);
  
  lines.push(`\n5️⃣ 【多Agent协作能力】`);
  lines.push(`可用功能：`);
  lines.push(`- 与其他Agent协同完成任务`);
  lines.push(`- 组建团队共同解决问题`);
  lines.push(`提示：当任务需要多个Agent配合时自动使用`);
  
  lines.push(`\n6️⃣ 【视觉识别能力】`);
  lines.push(`可用工具：`);
  lines.push(`- vision.http_pull: 从HTTP地址拉取图像进行分析`);
  lines.push(`- vision.periodic_start: 启动周期性视觉监控`);
  lines.push(`- vision.periodic_stop: 停止视觉监控`);
  lines.push(`- vision.periodic_list: 查看正在运行的视觉监控任务`);
  lines.push(`提示：可分析屏幕内容、监控变化`);
  
  lines.push(`\n7️⃣ 【桌面自动化能力】`);
  lines.push(`可用工具：`);
  lines.push(`- desktop.visual.run_task: 执行桌面视觉自动化任务`);
  lines.push(`提示：可操作用户桌面、自动执行任务`);
  
  lines.push(`\n8️⃣ 【Web浏览能力】`);
  lines.push(`可用工具：`);
  lines.push(`- web.search: 执行网络搜索`);
  lines.push(`- web.fetch: 获取网页内容`);
  lines.push(`提示：可帮助用户查找信息、浏览网页`);
  
  lines.push(`\n9️⃣ 【生活助手能力】`);
  lines.push(`可用工具：`);
  lines.push(`- budget.calculate: 计算预算和收支`);
  lines.push(`- shopping.suggest: 提供购物建议`);
  lines.push(`- reminder.plan: 制定提醒计划`);
  lines.push(`提示：可提供生活建议、财务管理`);
  
  lines.push(`\n🔟 【系统管理能力】`);
  lines.push(`可用功能：`);
  lines.push(`- 管理记忆和上下文`);
  lines.push(`- 调整系统配置`);
  lines.push(`提示：用于优化Agent性能和个性化设置`);
  
  lines.push(`\n1️⃣1️⃣ 【Agent账号管理能力】`);
  lines.push(`可用工具：`);
  lines.push(`- agent.register_account: 注册新的Agent账号`);
  lines.push(`提示：用于创建和管理Agent身份`);

  // 检查是否已申领虚拟号码
  if (virtualPhoneService) {
    const virtualPhone = virtualPhoneService.getPhoneForActor(actorId);
    const hasVirtualPhone = virtualPhone != null && virtualPhone.length > 0;
    
    lines.push(`\n【虚拟电话能力】`);
    
    if (hasVirtualPhone) {
      lines.push(`✅ 你已申领虚拟号码：${virtualPhone}`);
      lines.push(`可用功能：`);
      lines.push(`- virtual-phone.ensure-my-number: 查询/确认你的虚拟号码`);
      lines.push(`- phone.virtual_call: 拨打其他Agent的虚拟号码进行语音通话`);
      lines.push(`- 可联系其他已配对的Agent，或给自己打电话作为提醒`);
    } else {
      lines.push(`⚠️ 你尚未申领虚拟号码`);
      lines.push(`可用功能：`);
      lines.push(`- virtual-phone.ensure-my-number: 申领6位虚拟电话号码（用户明确要求时才可调用）`);
      lines.push(`- 申领后可与其他Agent进行语音通话`);
      lines.push(`提示：当用户说"帮我申请虚拟号码"时，调用 virtual-phone.ensure-my-number`);
    }
    
    // 添加关于其他Agent能力的说明
    lines.push(`\n【其他Agent的虚拟电话能力】`);
    lines.push(`💡 重要提示：`);
    lines.push(`- 要与其他Agent进行语音通话，对方也必须申领了虚拟号码`);
    lines.push(`- 如果用户想联系某个Agent但该Agent没有号码，需要先引导对方申领号码`);
    lines.push(`- 跨Agent拨打可能需要配对验证（取决于服务端配置）`);
    lines.push(`- 你可以询问用户想联系谁，然后检查对方是否有虚拟号码`);
  }

  lines.push(`\n6️⃣ 【自我编程与升级能力】`);
  lines.push(`可用工具：`);
  lines.push(`- self.create_skill: 创建新技能（需要提供 skillName, displayName, description, handlerCode）`);
  lines.push(`- self.update_skill: 更新现有技能的代码或元数据`);
  lines.push(`- self.delete_skill: 删除自己创建的社区技能`);
  lines.push(`- self.generate_skill: 智能生成技能代码（需要配置外部聊天提供商）`);
  lines.push(`- self.analyze_capabilities: 分析当前能力缺口，提出改进建议`);
  lines.push(`- self.detect_skill_need: 检测用户需求是否需要新技能`);
  lines.push(`- self.analyze_improvements: 分析交互记录，生成改进建议`);
  lines.push(`提示：当用户需要的功能不存在时，你可以主动创建新技能来扩展自己的能力`);
  
  lines.push(`\n💡 **重要能力说明**：`);
  lines.push(`你拥有自我进化的能力！如果用户需要的功能当前没有，你可以：`);
  lines.push(`1. 使用 self.analyze_capabilities 分析需要什么能力`);
  lines.push(`2. 使用 self.generate_skill 智能生成技能代码（如果有外部聊天提供商）`);
  lines.push(`3. 使用 self.create_skill 创建新技能`);
  lines.push(`4. 或者手动编写代码后调用 self.create_skill`);
  lines.push(`这样你就能不断学习和成长，适应用户的新需求！`);

  if (!owned.size && !state.agentWorldCredits) {
    lines.push("提示：在世界内挣点、购买技能后，此处会显示你的独特能力组合。");
  }

  return lines.join("\n");
}
