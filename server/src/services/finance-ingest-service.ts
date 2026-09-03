// FinanceIngestService —— 入站信号自动记账（财务管家 P1）
//
// 链路：邮件网关将投递到 Agent 绑定邮箱的邮件 POST 到
//   POST /finance/ingest/email/inbound（与邮箱注册 inbound 同模式、同密钥头）：
//   1. 收件人反查 Agent 账号（AgentAccountService.getByEmail）→ actorId
//   2. 账单/支付类邮件关键词预过滤（非账单直接跳过，不耗 LLM）
//   3. 单次 LLM 抽取结构化交易（克制原则：一封邮件一次 LLM；未配置 LLM 时跳过）
//   4. 指纹去重（落盘 data/finance/{actorId}/ingest-seen.json，防网关重投/重启重放）
//   5. financeDeepService.importTransactions 入账（source=email_ingest）
//   6. onIngested 回调（装配层接 ProactivityHub，轻量告知「已自动记账 N 笔」）
//
// 银行短信/通知文案：无邮件网关时走对话路径——用户把短信粘给 agent，
// 由 finance.import_transactions 导入（抽取逻辑与邮件一致，由对话 LLM 完成）。
//
// 微信支付服务通知通道（实时、零 LLM、静默）：微信桥把「微信支付」会话的
// 服务通知作为入站消息汇入 MessageHub → 装配层 onInbound 回调
// handleInboundMessage() → 确定性正则解析 → 指纹去重 → 入账（source=wechat_notice）。
// 用户要求：只落库，agent 经 finance.* 工具查询，不做主动推送。
import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { FinanceDeepService } from "./finance-deep-service.js";
import type { AgentAccountService } from "./agent-account-service.js";
import { parseRecipientToEmail } from "./email-registration-service.js";
import { getAgentMailInboundSecret } from "../config/mail.js";
import { isWechatPaymentContact, parseWechatPaymentNotice } from "./wechat-payment-notice.js";

/** 账单/支付类邮件判定关键词（命中任一即进入 LLM 抽取）。 */
const BILL_KEYWORDS = [
  "支付宝", "微信支付", "微信银行", "银行", "账单", "支付", "交易", "消费",
  "扣款", "扣费", "订单", "还款", "到账", "入账", "工资", "流水", "收付款",
  "发票", "话费", "水电", "充值",
  "payment", "paid", "invoice", "receipt", "transaction", "bank", "billing",
  "order confirmed", "subscription", "renewal",
];

/** 邮件是否像账单/支付通知（from + subject + 正文粗筛）。 */
export function isBillRelatedMail(params: {
  from?: string;
  subject?: string;
  text: string;
}): boolean {
  const haystack = `${params.from ?? ""} ${params.subject ?? ""} ${params.text}`
    .toLowerCase()
    .slice(0, 4000);
  return BILL_KEYWORDS.some((kw) => haystack.includes(kw));
}

/**
 * 从 LLM 输出中解析交易数组（容错：剥 markdown 围栏、截取首个 JSON 数组）。
 * 非法条目丢弃；解析失败返回 null（区别于合法空数组）。
 */
export function parseLlmTransactions(text: string): Array<{
  date: string;
  amount: number;
  type: "income" | "expense";
  merchant?: string;
  description?: string;
} | null> | null {
  if (!text) return null;
  const cleaned = text.replace(/```(?:json)?/g, "").trim();
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start < 0 || end <= start) return null;
  try {
    const arr = JSON.parse(cleaned.slice(start, end + 1));
    if (!Array.isArray(arr)) return null;
    return arr.map((item) => {
      if (!item || typeof item !== "object") return null;
      const r = item as Record<string, unknown>;
      const amount = Number(r.amount);
      const date = typeof r.date === "string" ? r.date : "";
      if (!date || !Number.isFinite(Date.parse(date)) || !Number.isFinite(amount) || amount <= 0) {
        return null;
      }
      return {
        date,
        amount: Math.abs(amount),
        type: r.type === "income" ? ("income" as const) : ("expense" as const),
        ...(typeof r.merchant === "string" && r.merchant ? { merchant: r.merchant } : {}),
        ...(typeof r.description === "string" && r.description
          ? { description: r.description }
          : {}),
      };
    });
  } catch {
    return null;
  }
}

/** 剥 HTML 标签 + 压缩空白（邮件正文多为 html）。 */
function stripHtml(s: string): string {
  return s.replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ");
}

/** 入站账单邮件抽取结果（service 内部标准化交易）。 */
interface IngestedTransaction {
  date: string;
  amount: number;
  type: "income" | "expense";
  merchant?: string;
  description?: string;
}

export interface FinanceIngestDeps {
  financeDeepService: FinanceDeepService;
  agentAccountService: AgentAccountService;
  /** 单次 LLM 抽取函数（externalChat.streamCompletion 薄包装；未注入时邮件跳过不入账） */
  llmComplete?: (prompt: string) => Promise<string>;
  /** 入账完成回调（装配层接 ProactivityHub，轻量告知） */
  onIngested?: (actorId: string, message: string) => void;
  /** 测试注入时钟 */
  now?: () => Date;
}

export class FinanceIngestService {
  private readonly deps: FinanceIngestDeps;
  /** 已入账指纹：actorId → 指纹环形数组（落盘，防网关重投） */
  private readonly seenByActor = new Map<string, string[]>();
  private readonly SEEN_LIMIT = 1000;
  /** 账单邮箱绑定：actorId → 邮箱（懒加载 + 写穿；独立于账号验证邮箱） */
  private mailboxMap: Map<string, string> | null = null;

  constructor(deps: FinanceIngestDeps) {
    this.deps = deps;
  }

  /** 装配层后置接线：externalChat 就绪后注入 LLM 抽取函数（构造早于模型服务的场景）。 */
  setLlmComplete(cb: (prompt: string) => Promise<string>): void {
    this.deps.llmComplete = cb;
  }

  /** 装配层后置接线：ProactivityHub 就绪后注入入账告知回调。 */
  setOnIngested(cb: (actorId: string, message: string) => void): void {
    this.deps.onIngested = cb;
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  // ─── 账单邮箱绑定（傻瓜式接入：一句"绑定账单邮箱 xxx"即完成） ────

  private mailboxFile(): string {
    return join(this.deps.financeDeepService.getDataRoot(), "ingest-mailboxes.json");
  }

  private async loadMailboxMap(): Promise<Map<string, string>> {
    if (this.mailboxMap) return this.mailboxMap;
    const map = new Map<string, string>();
    try {
      const raw = await readFile(this.mailboxFile(), "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        for (const [actorId, email] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof email === "string" && email) map.set(actorId, email);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("ENOENT")) {
        console.error("[FinanceIngest] loadMailboxMap failed:", error);
      }
    }
    this.mailboxMap = map;
    return map;
  }

  private async saveMailboxMap(map: Map<string, string>): Promise<void> {
    this.mailboxMap = map;
    try {
      await mkdir(this.deps.financeDeepService.getDataRoot(), { recursive: true });
      await writeFile(
        this.mailboxFile(),
        JSON.stringify(Object.fromEntries(map), null, 2),
        "utf8",
      );
    } catch (error) {
      console.error("[FinanceIngest] saveMailboxMap failed:", error);
    }
  }

  /** 绑定/换绑账单邮箱（同邮箱可被换绑到新 actor；老 actor 的绑定被顶掉）。 */
  async bindMailbox(actorId: string, email: string): Promise<{ ok: boolean; message: string }> {
    const normalized = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
      return { ok: false, message: "邮箱格式不正确" };
    }
    const map = await this.loadMailboxMap();
    for (const [existingActor, existingEmail] of map) {
      if (existingEmail === normalized && existingActor !== actorId) {
        map.delete(existingActor);
      }
    }
    map.set(actorId, normalized);
    await this.saveMailboxMap(map);
    return { ok: true, message: `已绑定账单邮箱 ${normalized}` };
  }

  async unbindMailbox(actorId: string): Promise<{ ok: boolean; message: string }> {
    const map = await this.loadMailboxMap();
    const email = map.get(actorId);
    if (!email) return { ok: false, message: "尚未绑定账单邮箱" };
    map.delete(actorId);
    await this.saveMailboxMap(map);
    return { ok: true, message: `已解绑账单邮箱 ${email}` };
  }

  async getMailbox(actorId: string): Promise<string | undefined> {
    return (await this.loadMailboxMap()).get(actorId);
  }

  /** 入站收件人解析：账单邮箱绑定优先，账号验证邮箱兜底。 */
  private async resolveActorByRecipient(addr: string): Promise<string | null> {
    const map = await this.loadMailboxMap();
    for (const [actorId, email] of map) {
      if (email === addr) return actorId;
    }
    return this.deps.agentAccountService.getByEmail(addr)?.userId ?? null;
  }

  // ─── 接入引导（傻瓜式三步走，输出 steps 形态文本，前端自动渲染步骤卡） ───

  /** 绑定/通道状态快照（HTTP setup 端点与引导 skill 共用）。 */
  async getSetupStatus(actorId: string): Promise<{
    billMailbox?: string;
    accountEmail?: string;
    llmEnabled: boolean;
    secretConfigured: boolean;
    webhookPath: string;
    ready: boolean;
  }> {
    const billMailbox = await this.getMailbox(actorId);
    const accountEmail = this.deps.agentAccountService.getByActorId(actorId)?.email;
    const secretConfigured = Boolean(getAgentMailInboundSecret());
    return {
      ...(billMailbox ? { billMailbox } : {}),
      ...(accountEmail ? { accountEmail } : {}),
      llmEnabled: Boolean(this.deps.llmComplete),
      secretConfigured,
      webhookPath: "/finance/ingest/email/inbound",
      // 就绪判定不含网关密钥（服务端配置，用户侧无法操作）；
      // 邮箱 + LLM 齐备即可走「自动转发 + 粘贴账单」完整链路。
      ready: Boolean((billMailbox ?? accountEmail) && this.deps.llmComplete),
    };
  }

  /**
   * 生成个性化接入引导（steps 形态文本；已就绪时返回使用说明而非配置步骤）。
   */
  async buildSetupGuide(actorId: string): Promise<{ ready: boolean; guide: string }> {
    const status = await this.getSetupStatus(actorId);
    const mailbox = status.billMailbox ?? status.accountEmail;
    if (status.ready && mailbox) {
      return {
        ready: true,
        guide:
          `自动记账已就绪，接收账单的邮箱是 ${mailbox}。\n` +
          `第1步. 在你常用邮箱里设置"自动转发"，把支付宝/微信支付/银行的账单邮件转发到 ${mailbox}（QQ邮箱：设置→收发信设置→自动转发；163：设置→POP3/SMTP→自动转发）。\n` +
          `第2步. 不想配转发的话，直接把账单邮件/银行短信原文粘贴给我，效果一样。\n` +
          `第3步. 记账结果我会主动告诉你；说"盘点订阅"可以看看自动续费清单。`,
      };
    }
    if (!status.llmEnabled) {
      return {
        ready: false,
        guide: "自动记账通道未就绪：服务端未配置 LLM，无法从账单邮件抽取交易。请先配置模型服务。",
      };
    }
    const missing: string[] = [];
    if (!mailbox) missing.push("绑定一个接收账单的邮箱");
    return {
      ready: false,
      guide:
        `开启自动记账还差 ${missing.length} 步：\n` +
        `第1步. ${missing.join("；")}。${mailbox ? "" : `直接回复「绑定账单邮箱 你的邮箱」即可，我来绑定。`}\n` +
        `第2步. 邮箱就绪后，在你的邮箱设置「自动转发」，把支付宝/银行账单邮件转发过来；不想配转发也可以直接把账单文本粘贴给我。\n` +
        `第3步. 转发/粘贴一封历史账单邮件给我做测试，我记账后会主动汇报。`,
    };
  }

  /**
   * 手动文本入账（粘贴账单邮件/银行短信原文；引导第 2/3 步的"傻瓜式"验证通道）。
   * 复用与邮件入站相同的 LLM 抽取 + 去重 + 入账链路，无需绑定邮箱。
   */
  async ingestText(
    actorId: string,
    text: string,
  ): Promise<{ ok: boolean; ingested: number; message: string }> {
    const trimmed = text.trim();
    if (!trimmed) return { ok: false, ingested: 0, message: "缺少账单文本" };
    if (!this.deps.llmComplete) {
      return { ok: false, ingested: 0, message: "LLM 未配置，无法抽取账单" };
    }
    const today = this.now().toISOString().slice(0, 10);
    const prompt =
      `你是记账助手。从下面的账单/短信文本里抽取真实的资金变动，返回 JSON 数组，` +
      `每个元素形如 {"date":"YYYY-MM-DD","amount":123.45,"type":"expense"|"income","merchant":"商户","description":"简述"}。\n` +
      `没有交易返回 []。只返回 JSON，不要解释。今天是 ${today}。\n---文本---\n${trimmed.slice(0, 6000)}`;
    let llmText: string;
    try {
      llmText = (await this.deps.llmComplete(prompt)) ?? "";
    } catch (err) {
      console.log(`[FinanceIngest] 手动抽取失败（忽略）: ${err}`);
      return { ok: false, ingested: 0, message: "账单抽取失败" };
    }
    const parsed = parseLlmTransactions(llmText);
    const transactions = (parsed ?? []).filter((t): t is IngestedTransaction => t !== null);
    if (transactions.length === 0) {
      return { ok: false, ingested: 0, message: "未能从文本中解析出交易" };
    }
    const seen = await this.loadSeen(actorId);
    const fresh = transactions.filter((t) => {
      const fp = `${t.date}|${t.amount}|${t.type}|${t.merchant ?? t.description ?? ""}`;
      if (seen.includes(fp)) return false;
      seen.push(fp);
      return true;
    });
    if (fresh.length === 0) {
      await this.saveSeen(actorId, seen);
      return { ok: false, ingested: 0, message: "这些交易都已入账过（去重跳过）" };
    }
    if (seen.length > this.SEEN_LIMIT) seen.splice(0, seen.length - this.SEEN_LIMIT);
    await this.saveSeen(actorId, seen);
    const imported = await this.deps.financeDeepService.importTransactions(
      actorId,
      fresh.map((t) => ({
        id: `ingest-${Date.now()}-${randomUUID().slice(0, 8)}`,
        date: t.date,
        amount: t.amount,
        type: t.type,
        category: "其他" as const,
        ...(t.merchant ? { merchant: t.merchant } : {}),
        ...(t.description ? { description: t.description } : {}),
        source: "text_ingest",
      })),
    );
    console.log(`[FinanceIngest] 手动入账 actor=${actorId} ${imported} 笔`);
    return { ok: true, ingested: imported, message: `已入账 ${imported} 笔交易` };
  }

  // ─── 微信支付服务通知通道（实时、零 LLM、静默入账） ──────────

  /**
   * MessageHub 入站消息统一回调：命中「微信支付」联系人 → 确定性解析 → 静默入账。
   *
   * 异常全部吞掉（不阻断消息落库主链路，与 MessageWatchTrigger 同契约）；
   * 只落库不做主动推送——查询走 agent 的 finance.* 工具。
   */
  async handleInboundMessage(input: {
    platform: string;
    actorId: string;
    text: string;
    senderId?: string;
    senderName?: string;
    participantId?: string;
    participantName?: string;
    title?: string;
    channelId?: string;
  }): Promise<void> {
    try {
      if (!input.actorId || !input.text) return;
      // 「微信支付」联系人信号是唯一入口：普通聊天里提到"微信支付了xx"不会误记账
      if (!isWechatPaymentContact(input)) return;
      await this.ingestWechatNotice(input.actorId, input.text);
    } catch {
      /* 入账失败静默，不影响消息主链路 */
    }
  }

  /**
   * 解析单条微信支付通知并入账（零 LLM）。
   * 指纹与邮件/文本通道共用同一份 seen 集：同一笔交易不会因多通道重复入账。
   */
  async ingestWechatNotice(
    actorId: string,
    text: string,
  ): Promise<{ ok: boolean; ingested: number; message: string }> {
    const parsed = parseWechatPaymentNotice(text, this.now());
    if (!parsed) {
      return { ok: false, ingested: 0, message: "非可识别的支付通知" };
    }

    const seen = await this.loadSeen(actorId);
    const fp = `${parsed.date}|${parsed.amount}|${parsed.type}|${parsed.merchant ?? parsed.description ?? ""}`;
    if (seen.includes(fp)) {
      return { ok: false, ingested: 0, message: "该笔交易已入账（去重跳过）" };
    }
    seen.push(fp);
    if (seen.length > this.SEEN_LIMIT) seen.splice(0, seen.length - this.SEEN_LIMIT);
    await this.saveSeen(actorId, seen);

    const imported = await this.deps.financeDeepService.importTransactions(actorId, [
      {
        id: `ingest-wx-${Date.now()}-${randomUUID().slice(0, 8)}`,
        date: parsed.date,
        amount: parsed.amount,
        type: parsed.type,
        category: "其他" as const, // 落账时由 finance-deep 按 merchant/description 自动分类
        ...(parsed.merchant ? { merchant: parsed.merchant } : {}),
        ...(parsed.description ? { description: parsed.description } : {}),
        source: "wechat_notice",
      },
    ]);
    if (imported > 0) {
      console.log(
        `[FinanceIngest] 微信支付通知入账 actor=${actorId} ` +
          `¥${parsed.amount.toFixed(2)} ${parsed.type === "income" ? "收入" : "支出"} ${parsed.merchant ?? ""}`,
      );
    }
    return { ok: true, ingested: imported, message: "已自动入账" };
  }

  /**
   * 入站账单邮件处理入口（HTTP 路由层调用）。
   *
   * @returns matched 收件人是否命中账号；ingested 实际入账条数
   */
  async applyInboundEmail(params: {
    to: string;
    from?: string;
    subject?: string;
    text?: string;
    html?: string;
    /** 跳过关键词预过滤（网关侧已确认是账单转发时用） */
    force?: boolean;
  }): Promise<{
    matched: boolean;
    ingested: number;
    skipped?: "not_bill" | "no_llm" | "no_transaction";
    message: string;
  }> {
    const addr = parseRecipientToEmail(params.to);
    const actorId = await this.resolveActorByRecipient(addr);
    if (!actorId) {
      return { matched: false, ingested: 0, message: "收件邮箱未绑定任何 Agent 账号" };
    }
    const bodyText = [params.text ?? "", stripHtml(params.html ?? "")]
      .join("\n")
      .slice(0, 8000);
    const fullText = `${params.subject ?? ""}\n${bodyText}`.trim();
    if (!fullText) {
      return { matched: true, ingested: 0, skipped: "no_transaction", message: "邮件内容为空" };
    }
    if (!params.force && !isBillRelatedMail({ from: params.from, subject: params.subject, text: fullText })) {
      return { matched: true, ingested: 0, skipped: "not_bill", message: "非账单/支付类邮件，已跳过" };
    }
    if (!this.deps.llmComplete) {
      return {
        matched: true,
        ingested: 0,
        skipped: "no_llm",
        message: "LLM 未配置，无法抽取账单（可在对话中直接粘贴账单文本导入）",
      };
    }

    const today = this.now().toISOString().slice(0, 10);
    const prompt =
      `你是记账助手。从下面的邮件里抽取真实的资金变动（支出/收入），` +
      `只抽取确定发生的交易（忽略营销/账单提醒/模拟盘/广告），返回 JSON 数组，` +
      `每个元素形如 {"date":"YYYY-MM-DD","amount":123.45,"type":"expense"|"income","merchant":"商户","description":"简述"}。\n` +
      `没有交易返回 []。只返回 JSON，不要解释。今天是 ${today}（相对日期据此换算）。\n` +
      `---邮件---\n主题：${params.subject ?? ""}\n${bodyText}`;
    let llmText: string;
    try {
      llmText = (await this.deps.llmComplete(prompt)) ?? "";
    } catch (err) {
      console.log(`[FinanceIngest] LLM 抽取失败（忽略）: ${err}`);
      return { matched: true, ingested: 0, skipped: "no_transaction", message: "账单抽取失败" };
    }
    const parsed = parseLlmTransactions(llmText);
    if (!parsed) {
      return { matched: true, ingested: 0, skipped: "no_transaction", message: "未能从邮件解析出交易" };
    }
    const transactions = parsed.filter((t): t is IngestedTransaction => t !== null);
    if (transactions.length === 0) {
      return { matched: true, ingested: 0, skipped: "no_transaction", message: "邮件中无真实交易" };
    }

    // 去重（同 actor + 日期 + 金额 + 类型 + 商户/描述 不重复入账）
    const seen = await this.loadSeen(actorId);
    const fresh = transactions.filter((t) => {
      const fp = `${t.date}|${t.amount}|${t.type}|${t.merchant ?? t.description ?? ""}`;
      if (seen.includes(fp)) return false;
      seen.push(fp);
      return true;
    });
    if (fresh.length === 0) {
      await this.saveSeen(actorId, seen);
      return { matched: true, ingested: 0, skipped: "no_transaction", message: "交易均已入账过（去重跳过）" };
    }
    if (seen.length > this.SEEN_LIMIT) seen.splice(0, seen.length - this.SEEN_LIMIT);
    await this.saveSeen(actorId, seen);

    const imported = await this.deps.financeDeepService.importTransactions(
      actorId,
      fresh.map((t) => ({
        id: `ingest-${Date.now()}-${randomUUID().slice(0, 8)}`,
        date: t.date,
        amount: t.amount,
        type: t.type,
        category: "其他" as const, // 落账时由 finance-deep 按 description 自动分类
        ...(t.merchant ? { merchant: t.merchant } : {}),
        ...(t.description ? { description: t.description } : {}),
        source: "email_ingest",
      })),
    );

    if (imported > 0) {
      const preview = fresh
        .slice(0, 3)
        .map((t) => `${t.merchant ?? t.description ?? "交易"} ¥${t.amount.toFixed(2)}`)
        .join("、");
      const message =
        imported <= 3
          ? `账单邮件已自动记账 ${imported} 笔：${preview}。`
          : `账单邮件已自动记账 ${imported} 笔（含 ${preview} 等）。`;
      this.deps.onIngested?.(actorId, message);
      console.log(`[FinanceIngest] 邮件入账 actor=${actorId} ${imported} 笔`);
    }
    return { matched: true, ingested: imported, message: `已入账 ${imported} 笔交易` };
  }

  // ─── 去重指纹持久化（懒加载 + 写穿） ────────────────────────

  private seenFile(actorId: string): string {
    return join(this.deps.financeDeepService.getDataRoot(), actorId, "ingest-seen.json");
  }

  private async loadSeen(actorId: string): Promise<string[]> {
    const cached = this.seenByActor.get(actorId);
    if (cached) return cached;
    let seen: string[] = [];
    try {
      const raw = await readFile(this.seenFile(actorId), "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) seen = parsed.map(String);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("ENOENT")) {
        console.error(`[FinanceIngest] loadSeen ${actorId} failed:`, error);
      }
    }
    this.seenByActor.set(actorId, seen);
    return seen;
  }

  private async saveSeen(actorId: string, seen: string[]): Promise<void> {
    this.seenByActor.set(actorId, seen);
    try {
      const dir = join(this.deps.financeDeepService.getDataRoot(), actorId);
      await mkdir(dir, { recursive: true });
      await writeFile(this.seenFile(actorId), JSON.stringify(seen, null, 2), "utf8");
    } catch (error) {
      console.error(`[FinanceIngest] saveSeen ${actorId} failed:`, error);
    }
  }
}
