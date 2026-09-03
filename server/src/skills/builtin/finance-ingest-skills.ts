import { resolveActorId } from "../../agent/actor-id.js";
import type { FinanceIngestService } from "../../services/finance-ingest-service.js";
import type { SkillDefinition } from "../types.js";

type Deps = {
  financeIngestService: FinanceIngestService;
};

/**
 * 内置 Skill：财务管家快捷接入（傻瓜式绑定引导）。
 *
 * 这组 skill 是客户端技能面板上的"快捷指示"入口，把自动记账的接入
 * 压成三步：① 绑定账单邮箱（一句话）→ ② 邮箱配自动转发 / 或直接粘贴
 * 账单 → ③ 转发一封历史账单测试。每步都有对应 skill，agent 引导时
 * 逐步调用；引导文本按"第1步/第2步"形态输出，前端自动渲染步骤卡。
 *
 * 与 chat 工具的边界：finance.* chat 工具管"记账之后"（查询/预算/订阅），
 * 本组 skill 管"接进来之前"（绑定/引导/测试/粘贴入账）。
 */
export function createFinanceIngestBuiltinSkills(deps: Deps): SkillDefinition[] {
  const { financeIngestService } = deps;

  /** 1. 开启自动记账（引导主入口） */
  const ingest_guide: SkillDefinition = {
    metadata: {
      name: "finance.ingest-guide",
      version: "1.0.0",
      displayName: "开启自动记账",
      description:
        "开启/查看自动记账的接入引导。检查当前用户的账单邮箱绑定状态，返回个性化的三步接入指引" +
        "（绑定邮箱 → 邮箱配自动转发 → 转发历史账单测试）。用户说「开启自动记账」「我想自动记账」" +
        "「怎么绑定账单邮箱」「接入财务管家」时调用。把返回的 guide 原样转述给用户（已是步骤卡形态，" +
        "不要改写成段落），并根据 ready 字段决定话术：ready=true 引导用户转发一封账单测试；" +
        "ready=false 先带用户完成缺失步骤。",
      kind: "builtin",
      tags: ["finance", "记账", "自动记账", "绑定", "引导", "邮箱"],
      icon: "📮",
      parameters: [],
      outputSchema: {
        ready: "是否已就绪（绑定邮箱 + LLM + 网关密钥齐备）",
        guide: "个性化接入指引（第1步/第2步/第3步 形态文本）",
      },
      permissions: ["storage:read"],
      timeoutMs: 15_000,
    },
    handler: async (_input, context) => {
      const actorId = resolveActorId(context);
      const { ready, guide } = await financeIngestService.buildSetupGuide(actorId);
      return {
        ok: true,
        actorId,
        ready,
        guide,
        summary: guide,
      };
    },
  };

  /** 2. 绑定账单邮箱 */
  const bind_ingest_email: SkillDefinition = {
    metadata: {
      name: "finance.bind-ingest-email",
      version: "1.0.0",
      displayName: "绑定账单邮箱",
      description:
        "绑定/换绑接收账单邮件的邮箱（支付宝/微信支付/银行账单邮件将转发到该地址自动记账）。" +
        "用户说「绑定账单邮箱 xxx@xx.com」「换一个邮箱接收账单」时调用；用户没给邮箱时先询问。" +
        "绑定成功后提示下一步：在该邮箱或你的常用邮箱里设置自动转发，或直接转发一封历史账单邮件测试。" +
        "同一邮箱同一时间只绑定一个用户，重复绑定会顶掉旧绑定。",
      kind: "builtin",
      tags: ["finance", "记账", "绑定", "邮箱"],
      icon: "🔗",
      parameters: [
        {
          name: "email",
          type: "string",
          required: true,
          description: "要绑定的账单邮箱地址",
        },
      ],
      outputSchema: {
        ok: "是否绑定成功",
        message: "结果说明",
      },
      permissions: ["storage:write"],
      timeoutMs: 15_000,
    },
    handler: async (input, context) => {
      const actorId = resolveActorId(context);
      const email = typeof input.email === "string" ? input.email.trim() : "";
      if (!email) {
        return { ok: false, error: "缺少 email（要绑定的账单邮箱）" };
      }
      const result = await financeIngestService.bindMailbox(actorId, email);
      if (!result.ok) {
        return { ok: false, error: result.message };
      }
      const { guide } = await financeIngestService.buildSetupGuide(actorId);
      return {
        ok: true,
        actorId,
        message: result.message,
        summary: `${result.message}。下一步：${guide}`,
      };
    },
  };

  /** 3. 粘贴账单入账（测试/无网关兜底） */
  const ingest_text: SkillDefinition = {
    metadata: {
      name: "finance.ingest-text",
      version: "1.0.0",
      displayName: "粘贴账单立即记账",
      description:
        "用户直接粘贴账单邮件原文/银行短信/支付宝账单文本，抽取其中的真实资金变动并入账本。" +
        "用户说「帮我把这条短信记账」「这段账单帮我记一下」或按引导粘贴了账单文本时调用，" +
        "text 传用户粘贴的原文。也用于绑定后的「测试一步」：用户转发/粘贴一封账单后确认链路已通。" +
        "返回入账条数与明细摘要；返回 0 笔时告诉用户没有识别到交易，请粘贴含金额和日期的原文。",
      kind: "builtin",
      tags: ["finance", "记账", "短信", "账单", "粘贴"],
      icon: "🧾",
      parameters: [
        {
          name: "text",
          type: "string",
          required: true,
          description: "用户粘贴的账单/短信原文",
        },
      ],
      outputSchema: {
        ok: "是否成功入账",
        ingested: "入账条数",
        message: "结果说明",
      },
      permissions: ["storage:write"],
      timeoutMs: 60_000,
    },
    handler: async (input, context) => {
      const actorId = resolveActorId(context);
      const text = typeof input.text === "string" ? input.text : "";
      if (!text.trim()) {
        return { ok: false, error: "缺少 text（账单/短信原文）" };
      }
      const result = await financeIngestService.ingestText(actorId, text);
      return {
        ok: result.ok,
        actorId,
        ingested: result.ingested,
        message: result.message,
        summary: result.message,
      };
    },
  };

  /** 4. 查看接入状态 */
  const ingest_status: SkillDefinition = {
    metadata: {
      name: "finance.ingest-status",
      version: "1.0.0",
      displayName: "查看自动记账接入状态",
      description:
        "查询当前用户自动记账通道的配置状态：绑定的账单邮箱、账号邮箱、LLM 与网关密钥是否就绪。" +
        "用户问「自动记账开了吗」「账单邮箱绑的哪个」「记账通道状态」时调用，也是排查" +
        "「转发了邮件但没记账」类问题的第一步。",
      kind: "builtin",
      tags: ["finance", "记账", "状态", "诊断"],
      icon: "📡",
      parameters: [],
      outputSchema: {
        billMailbox: "绑定的账单邮箱（未绑定为空）",
        accountEmail: "账号验证邮箱（未绑定为空）",
        llmEnabled: "LLM 是否可用",
        secretConfigured: "邮件网关密钥是否配置",
        ready: "通道是否整体就绪",
      },
      permissions: ["storage:read"],
      timeoutMs: 15_000,
    },
    handler: async (_input, context) => {
      const actorId = resolveActorId(context);
      const status = await financeIngestService.getSetupStatus(actorId);
      const parts: string[] = [];
      parts.push(status.billMailbox ? `账单邮箱 ${status.billMailbox}` : "账单邮箱未绑定");
      if (!status.billMailbox && status.accountEmail) parts.push(`账号邮箱 ${status.accountEmail} 可直接收账单`);
      parts.push(status.llmEnabled ? "LLM 就绪" : "LLM 未配置");
      parts.push(status.secretConfigured ? "网关密钥已配置" : "网关密钥未配置");
      return {
        ok: true,
        actorId,
        ...status,
        summary: parts.join("，") + (status.ready ? "。通道已就绪。" : "。调 finance.ingest-guide 获取接入指引。"),
      };
    },
  };

  return [ingest_guide, bind_ingest_email, ingest_text, ingest_status];
}

/** 批量注册到 SkillManager（装配层调用，与 alipay-payment-skills 同模式）。 */
export function registerFinanceIngestBuiltinSkills(
  register: (skill: SkillDefinition) => void,
  deps: Deps,
): void {
  for (const s of createFinanceIngestBuiltinSkills(deps)) {
    register(s);
  }
}
