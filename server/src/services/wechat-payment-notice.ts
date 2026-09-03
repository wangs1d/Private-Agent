// 微信支付服务通知解析（零 LLM、确定性规则）。
//
// 微信每笔支付/收款都会以「微信支付」服务通知（会话名固定为「微信支付」）推送，
// 消息桥将其作为普通入站消息转发进 MessageHub。本模块负责两件事：
//   1. 判断消息是否来自「微信支付」会话（联系人信号，防止把用户聊天文本误记账）
//   2. 从通知文本中确定性提取 金额/收支/商户/时间 → FinanceIngest 入账结构
//
// 解析不到有效交易（或命中退款/提现等不入账场景）时返回 null，调用方静默跳过。

/** 入账所需的最小交易结构（与 FinanceIngestService 内部标准化结构对齐）。 */
export interface WechatPaymentNoticeTransaction {
  /** ISO 风格日期（YYYY-MM-DD 或 YYYY-MM-DD HH:mm:ss） */
  date: string;
  /** 金额（正数） */
  amount: number;
  type: "income" | "expense";
  /** 商户/对方（可选） */
  merchant?: string;
  /** 商品/备注（可选） */
  description?: string;
}

/** MessageHub 入站消息中与「微信支付」联系人判定相关的字段。 */
export interface WechatPaymentContactFields {
  senderId?: string;
  senderName?: string;
  participantId?: string;
  participantName?: string;
  title?: string;
  channelId?: string;
}

/** 服务通知的会话/联系人名固定为「微信支付」。 */
export function isWechatPaymentContact(input: WechatPaymentContactFields): boolean {
  const blob = [
    input.senderId,
    input.senderName,
    input.participantId,
    input.participantName,
    input.title,
    input.channelId,
  ]
    .filter(Boolean)
    .join(" ");
  return blob.includes("微信支付");
}

/** 非交易类通知：直接跳过（退款需冲销原记录、提现/冻结是自有资金流转、明细是汇总推送）。 */
const NON_TRANSACTION = /(退款|提现|冻结|解冻|零钱明细|账单明细|收支明细|理财|零钱通)/;

/** 收入信号：收款 / 到账 / 他人转账 / 红包领取。 */
const INCOME_PATTERN = /(收款|已收钱|已收款项|收入|到账|入账|向你转账|转账给你|收到红包|红包已领取|已存入零钱)/;

/** 支出信号：商户消费 / 付款 / 扣款。 */
const EXPENSE_PATTERN = /(支付成功|已支付|付款成功|已付款|扣款|支出|消费成功|消费)/;

function extractAmount(text: string): number | null {
  const currencyMatch = text.match(/[¥￥]\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/);
  const unitMatch = text.match(/([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*元/);
  const raw = currencyMatch?.[1] ?? unitMatch?.[1];
  if (!raw) return null;
  const amount = Number(raw.replace(/,/g, ""));
  if (!Number.isFinite(amount) || amount <= 0 || amount > 10_000_000) return null;
  return amount;
}

function extractMerchant(text: string): string | undefined {
  const bracket = text.match(/【([^】]{1,60})】/);
  if (bracket?.[1]) return bracket[1].trim();
  const labeled = text.match(/商户(?:名称)?[:：]\s*([^\n，,。；;]{1,60})/);
  if (labeled?.[1]) return labeled[1].trim();
  const inline = text.match(/在\s*([^\s【】，,。；;]{2,60}?)\s*(?:成功)?(?:支付|消费|付款)/);
  if (inline?.[1]) return inline[1].trim();
  return undefined;
}

function extractDescription(text: string): string | undefined {
  const labeled = text.match(/(?:商品|备注|说明)[:：]\s*([^\n]{1,80})/);
  return labeled?.[1]?.trim() || undefined;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** 通知内绝对时间 / 「今天 12:30」类相对时间 → 归一化日期串；都没有则用消息到达时间。 */
function extractDate(text: string, fallbackNow: Date): string {
  const abs = text.match(
    /(\d{4})\s*[-/年.]\s*(\d{1,2})\s*[-/月.]\s*(\d{1,2})日?(?:[\sT]+(\d{1,2})[:：](\d{2})(?:[:：](\d{2}))?)?/,
  );
  if (abs) {
    const [, y, m, d, hh, mm, ss] = abs;
    const base = `${y}-${pad2(Number(m))}-${pad2(Number(d))}`;
    if (hh == null || mm == null) return base;
    return `${base} ${pad2(Number(hh))}:${pad2(Number(mm))}:${pad2(Number(ss ?? 0))}`;
  }
  const rel = text.match(/(?:今天|今日|昨天|昨日)\s*(\d{1,2})[:：](\d{2})/);
  if (rel) {
    const base = new Date(fallbackNow);
    if (/昨/.test(rel[0] ?? "")) base.setDate(base.getDate() - 1);
    return (
      `${base.getFullYear()}-${pad2(base.getMonth() + 1)}-${pad2(base.getDate())} ` +
      `${pad2(Number(rel[1]))}:${pad2(Number(rel[2]))}:00`
    );
  }
  const n = new Date(fallbackNow);
  return (
    `${n.getFullYear()}-${pad2(n.getMonth() + 1)}-${pad2(n.getDate())} ` +
    `${pad2(n.getHours())}:${pad2(n.getMinutes())}:${pad2(n.getSeconds())}`
  );
}

/**
 * 解析微信支付服务通知文本。
 *
 * @returns 可入账交易；无法可靠判定（无金额 / 收支语义不明 / 非交易通知）返回 null。
 */
export function parseWechatPaymentNotice(
  text: string,
  fallbackNow: Date = new Date(),
): WechatPaymentNoticeTransaction | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 2000) return null;
  if (NON_TRANSACTION.test(trimmed)) return null;

  const isIncome = INCOME_PATTERN.test(trimmed);
  const isExpense = EXPENSE_PATTERN.test(trimmed);
  // 收支语义同时命中或都不命中：宁可漏记不可错记
  if (isIncome === isExpense) return null;

  const amount = extractAmount(trimmed);
  if (amount == null) return null;

  const tx: WechatPaymentNoticeTransaction = {
    date: extractDate(trimmed, fallbackNow),
    amount,
    type: isIncome ? "income" : "expense",
  };
  const merchant = extractMerchant(trimmed);
  if (merchant) tx.merchant = merchant;
  const description = extractDescription(trimmed);
  if (description) tx.description = description;
  return tx;
}
