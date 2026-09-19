// 支付宝通知解析（零 LLM、确定性规则）——与 wechat-payment-notice.ts 同模式。
//
// 数据源：Android 手机通知监听（MessageCaptureListenerService）捕捉的支付宝 App
// 支付/收款推送（platform=alipay 进 MessageHub）。这是钱迹验证过的国内实时记账
// 主通道：支付成功即入账，零 Cookie、零风控；服务端 Cookie 拉取通道退居兜底对账。
//
// 两件事：
//   1. 判定是否支付/收款类通知（platform 信号本身 + 文本模式，排除营销/积分噪音）
//   2. 确定性提取 金额/收支/商户/时间 → 入账结构
//
// 解析不到有效交易（无金额 / 收支语义不明 / 非交易通知）返回 null，调用方静默跳过。
// 原则：宁可漏记不可错记。

export interface AlipayPaymentNoticeTransaction {
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

/** 明显非交易的推送：营销/积分/客服/安全类（还款提醒≠还款交易，也排除）。 */
const NON_TRANSACTION = /(蚂蚁森林|蚂蚁庄园|蚂蚁新村|芝麻信用|花呗额度|额度已|积分|会员|运动|出行|快递|外卖红包|领优惠|优惠券|活动|客服|验证码|登录|安全问题|还款提醒|账单已出|月度账单|年度账单)/;

/** 收入信号：收款 / 到账 / 他人转账 / 红包。 */
const INCOME_PATTERN = /(收款成功|收钱成功|到账|入账|收到[^。，]{0,8}转账|转账给你|向你转账|收到红包|已收钱)/;

/** 支出信号：付款 / 支付 / 扣款 / 消费 / 还款（成功类）。 */
const EXPENSE_PATTERN = /(付款成功|支付成功|扣款成功|扣款|付款|已支付|消费|还款成功)/;

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

/** 通知内绝对时间 / 「今天 12:30」类相对时间 → 归一化日期串；都没有则用通知到达时间。 */
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
 * 解析支付宝支付/收款通知文本（title + 正文拼接后传入）。
 *
 * @returns 可入账交易；无法可靠判定返回 null。
 */
export function parseAlipayPaymentNotice(
  text: string,
  fallbackNow: Date = new Date(),
): AlipayPaymentNoticeTransaction | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 2000) return null;
  if (NON_TRANSACTION.test(trimmed)) return null;

  const isIncome = INCOME_PATTERN.test(trimmed);
  const isExpense = EXPENSE_PATTERN.test(trimmed);
  // 收支语义同时命中或都不命中：宁可漏记不可错记
  if (isIncome === isExpense) return null;

  const amount = extractAmount(trimmed);
  if (amount == null) return null;

  const tx: AlipayPaymentNoticeTransaction = {
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
