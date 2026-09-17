import iconv from "iconv-lite";
import type { FinanceCategory } from "./finance-deep-service.js";

/**
 * 支付宝/微信账单导出文件确定性解析器（零 LLM）。
 *
 * 为什么存在：用户把「支付宝交易记录明细查询 / 支付宝交易明细清单」或
 * 「微信支付账单明细」导出的 CSV 原文粘贴/上传进来时，这些文本格式是
 * 完全固定、公开可知的——用 LLM 抽取既浪费 token 又可能编造/漏记金额。
 * 本解析器逐列确定性映射，解析不了就如实写进 warnings / skipped，绝不编造数据。
 *
 * 入账字段与 {@link FinanceTransaction}（finance-deep-service）完全一致：
 *   id / date / amount / type(income|expense) / category / merchant / description / source。
 * 注意：现有交易结构没有 externalId 字段（importTransactions 只保留上述字段），
 * 因此「交易单号幂等键」用确定性记录 id 承载：`alipay:<交易号>` / `wechat:<交易单号>`。
 * 重复导入同一份账单时，调用方按 id 与账本比对即可避免重复入账。
 *
 * 已知格式（以真实导出为准）：
 *  - 支付宝旧版（网页导出，GBK 编码）：说明头「支付宝交易记录明细查询」+ 账号 +
 *    日期范围 + 「------」分隔线，列名行以「交易号」开头；
 *    金额列为「金额（元）」（全角括号），收支列为「收/支」（收入/支出/不计收支）。
 *  - 支付宝新版（App 导出「支付宝交易明细清单」，UTF-8）：列名行含
 *    「交易时间/交易分类/交易对方/…/收/支/金额/…/交易订单号」。
 *  - 微信（「微信支付账单明细」，UTF-8）：多行说明头 + 「----列表----」分隔线，
 *    列名行：交易时间/交易类型/交易对方/商品/收/支/金额(元)/支付方式/当前状态/
 *    交易单号/商户单号/备注；金额带「¥」前缀且可能带千分位逗号。
 */

/** 账单来源。 */
export type BillStatementSource = "alipay" | "wechat";

/** 识别结果（unknown = 既不是支付宝也不是微信账单导出）。 */
export type BillStatementFormat = BillStatementSource | "unknown";

/**
 * 解析出的单笔交易（字段与 FinanceTransaction 完全一致，可直接喂给
 * FinanceDeepService.importTransactions）。
 */
export interface BillTransaction {
  /**
   * 幂等键：`alipay:<交易号|交易订单号>` / `wechat:<交易单号>`。
   * 账单缺单号时退化为 `来源:日期_金额_方向`（仍是确定性的，重复解析结果一致）。
   */
  id: string;
  /** 交易时间（保留账单原始 "YYYY-MM-DD HH:mm:ss"，Date.parse 可解析） */
  date: string;
  /** 金额（正数，元） */
  amount: number;
  /** income 收入 / expense 支出 */
  type: "income" | "expense";
  /** 账单本身无分类信息，统一落「其他」（与邮件/通知入账通道约定一致） */
  category: FinanceCategory;
  /** 商户/交易对方 */
  merchant?: string;
  /** 商品说明/备注简述 */
  description?: string;
  /** 数据来源标记：alipay / wechat */
  source: BillStatementSource;
}

/** 被跳过的行（诚实反馈：为什么这行没有入账）。 */
export interface BillSkippedRow {
  /** CSV 记录行号（1 起，含说明头行，便于用户回原文核对） */
  row: number;
  /** 跳过原因 */
  reason: string;
  /** 原始行内容摘要（截断，便于核对） */
  preview: string;
}

/** parseBillStatement 可选项。 */
export interface BillStatementParseOptions {
  /**
   * 最大解析的 CSV 记录行数（防超长粘贴拖垮内存；默认 20000）。
   * 超出部分不解析并写入 warnings（如实告知，不静默截断）。
   */
  maxRows?: number;
}

/** parseBillStatement 结果。 */
export interface BillParseResult {
  /** 识别出的账单来源；unknown 表示未能识别（transactions 必为空） */
  source: BillStatementFormat;
  /** 可入账交易 */
  transactions: BillTransaction[];
  /** 被跳过的行及原因 */
  skipped: BillSkippedRow[];
  /** 格式级告警（编码修复、表头缺失、截断等） */
  warnings: string[];
}

// ─── 内部：文本规范化与编码修复 ────────────────────────────────

/** 去掉 UTF-8 BOM（Windows 导出常见；留着会污染第一行表头匹配）。 */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * 尝试修复「GBK 字节被按单字节（latin1）误读」的乱码文本。
 *
 * 为什么只处理 latin1 型乱码：支付宝官网导出的 CSV 是 GBK 编码，若上游把
 * 字节按 latin1/binary 读成了字符串，每个 GBK 双字节会变成两个 ≤0xFF 的
 * 字符，可以无损还原（latin1 编回字节 → 按 GBK 解码）；若上游按 UTF-8 读、
 * 字节已被替换成 U+FFFD，信息已丢失，无法恢复（只能由调用方传原始字节，
 * 走 {@link decodeBillFileBytes}）。修复后必须能重新识别出账单格式才采用，
 * 避免把巧合字节误转。
 */
function tryGbkMojibakeRepair(text: string): string | null {
  if (!/[\u0080-\u00FF]{4,}/.test(text)) return null;
  // latin1 是 Buffer 原生支持的单字节编码：字符 ≤0xFF 时编回字节是无损的
  const bytes = Buffer.from(text, "latin1");
  const gbkText = iconv.decode(bytes, "gbk");
  if (gbkText.includes("\ufffd")) return null;
  return detectPlain(gbkText) !== "unknown" ? gbkText : null;
}

// ─── 内部：手写 CSV 解析（RFC4180 风格，不引外部库） ──────────

/**
 * 把整段 CSV 文本解析为记录数组。
 * 支持：双引号包裹字段、字段内逗号/换行、转义引号（""）、\r\n 与 \n 混合换行。
 * 末尾无换行时正确收尾；文件结尾的空行不产生记录。
 */
function parseCsvText(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const pushField = (): void => {
    row.push(field);
    field = "";
  };
  const pushRow = (): void => {
    pushField();
    rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          // 转义引号："" → "
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      pushField();
      i += 1;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      pushRow();
      // \r\n 算一个换行，吃掉后续的 \n，避免多出一条空记录
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (field !== "" || row.length > 0) pushRow();
  return rows;
}

// ─── 内部：表头识别与列定位 ────────────────────────────────────

/** 表头单元格标准化：去空白、全角括号转半角（支付宝「金额（元）」vs 微信「金额(元)」）。 */
function normHeaderCell(s: string): string {
  return s.replace(/\s+/g, "").replace(/（/g, "(").replace(/）/g, ")").trim();
}

/** 在一行表头里按候选名（标准化后精确匹配）找列下标，找不到返回 -1。 */
function findCol(cells: string[], candidates: string[]): number {
  const normalized = cells.map(normHeaderCell);
  for (const name of candidates) {
    const idx = normalized.indexOf(name);
    if (idx >= 0) return idx;
  }
  return -1;
}

const DIRECTION_COL = ["收/支"];
const AMOUNT_COL = ["金额(元)", "金额"];

/** 纯结构识别（不做编码修复）：说明头声明优先，表头特征行兜底。 */
function detectPlain(text: string): BillStatementFormat {
  // 1) 说明头声明（最可靠）：支付宝「支付宝交易记录明细查询 / 交易记录明细 /
  //    交易明细清单」，微信「微信支付账单明细」。
  //    声明必在文件开头，只看前 2000 字符；扫描头部即可，
  //    避免为识别一份超大粘贴而把全文跑一遍正则/CSV。
  const head0 = text.slice(0, 2000);
  if (/支付宝交易(记录)?明细(查询|清单|列表)?/.test(head0)) return "alipay";
  if (/微信支付账单明细/.test(head0)) return "wechat";
  // 2) 说明头被用户裁掉时，用列名行特征兜底（只扫前 60 行，避免大文件全量扫描；
  //    64KB 足够覆盖说明头 + 表头 + 若干数据行）
  const rows = parseCsvText(text.slice(0, 65_536));
  const head = rows.slice(0, 60);
  for (const cells of head) {
    const dir = findCol(cells, DIRECTION_COL);
    const amount = findCol(cells, AMOUNT_COL);
    if (dir < 0 || amount < 0) continue;
    // 微信特征列组合唯一：交易单号 + 商户单号 + 支付方式
    if (findCol(cells, ["交易单号"]) >= 0 && findCol(cells, ["商户单号"]) >= 0) return "wechat";
    // 支付宝特征：交易号（旧版首列）或交易订单号/交易来源地/商家订单号（新旧版）
    if (
      findCol(cells, ["交易号", "交易订单号", "交易来源地", "商家订单号"]) >= 0 &&
      findCol(cells, ["商户单号"]) < 0
    ) {
      return "alipay";
    }
  }
  return "unknown";
}

/**
 * 识别账单导出格式。
 *
 * 容忍：UTF-8 BOM、\r\n 换行、说明头被裁掉（表头特征兜底）、
 * GBK 字节被按 latin1 误读的乱码文本（自动转码后重试）。
 */
export function detectBillStatementFormat(rawText: string): BillStatementFormat {
  const text = stripBom(rawText ?? "");
  if (!text.trim()) return "unknown";
  const direct = detectPlain(text);
  if (direct !== "unknown") return direct;
  const repaired = tryGbkMojibakeRepair(text);
  if (repaired) return detectPlain(repaired);
  return "unknown";
}

/**
 * 把账单文件原始字节解码为文本（用户上传文件、非粘贴文本时用）。
 * 优先级：BOM 声明 > 严格 UTF-8 > GBK（支付宝官网导出默认 GBK）。
 * 解不出来时退回「UTF-8 + 替换字符」并保留 U+FFFD，由上层如实报错。
 */
export function decodeBillFileBytes(bytes: Buffer): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return stripBom(bytes.toString("utf8"));
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return bytes.toString("utf16le");
  }
  // strict UTF-8：解不出就说明不是 UTF-8（支付宝 GBK 导出会在这里失败）
  try {
    const strict = new TextDecoder("utf-8", { fatal: true });
    return stripBom(strict.decode(bytes));
  } catch {
    const gbkText = iconv.decode(bytes, "gbk");
    if (!gbkText.includes("\ufffd")) return gbkText;
    // GBK 也解不干净：退回 UTF-8 宽松解码，保留 U+FFFD 供上层识别报错（不编造）
    return bytes.toString("utf8");
  }
}

// ─── 内部：字段清洗 ────────────────────────────────────────────

/** 金额清洗：去掉 ¥/￥ 前缀、千分位逗号（半角/全角）与空白后取数。 */
function parseAmountText(raw: string): number {
  const cleaned = raw.replace(/[¥￥\s,，]/g, "");
  if (!cleaned) return Number.NaN;
  return Number(cleaned);
}

/**
 * 交易时间清洗：容忍 2024/03/02 写法，统一成 "YYYY-MM-DD HH:mm:ss"。
 * 解不出返回 null（调用方跳过该行，绝不猜测日期）。
 */
function normalizeBillDate(raw: string): string | null {
  const cleaned = raw.trim().replace(/\//g, "-");
  if (!cleaned || !Number.isFinite(Date.parse(cleaned))) return null;
  return cleaned;
}

/** 微信用「/」、部分导出用「-」表示空字段，统一清洗掉。 */
function cleanTextField(raw: string): string {
  const trimmed = raw.trim();
  return trimmed === "/" || trimmed === "-" ? "" : trimmed;
}

/** 方向列 → income/expense；中性交易（不计收支、"/"、空）返回 null。 */
function parseDirection(raw: string): "income" | "expense" | null {
  const v = raw.trim();
  if (v.includes("收入")) return "income";
  if (v.includes("支出")) return "expense";
  return null;
}

/** 单行跳过记录（含预览截断）。 */
function makeSkipped(row: number, cells: string[], reason: string): BillSkippedRow {
  const preview = cells.join(",").slice(0, 80);
  return { row, reason, preview };
}

// ─── 交易状态过滤规则（两种账单共用同一优先级，关键词不同） ────
//
// 优先级（先命中先决策）：
//   1. 含「退款」→ 跳过。为什么：已全额退款=原交易资金已整体退回，入账会虚增
//      支出；部分退款（已退款/退款成功）的净支出无法从账单行确定性推算。
//      微信账单若把退款单独作为「收入」明细行给出（状态不含「退款」字样），
//      该行会按收入正常入账，因此退款不会凭空消失。
//   2. 未完成/未达成（等待付款、处理中、关闭、失败、超时等）→ 跳过：
//      钱没有真实变动，入账就是编造数据。
//   3. 明确成功（交易成功/还款成功/支付成功/已收入/已支出/已存入零钱等）→ 入账。
//   4. 都不匹配 → 跳过并记原因「未知交易状态」（诚实失败：不认识的状态
//      宁可不入账并把原文交给用户，也不猜）。

/** 支付宝交易状态 → 入账判定。返回 null 表示可入账，否则为跳过原因。 */
function alipayStatusSkipReason(status: string): string | null {
  if (status.includes("退款")) return `退款状态「${status}」：资金已退回/净额不确定，不入账`;
  if (/等待|处理中/.test(status)) return `交易未完成「${status}」：资金未实际变动，不入账`;
  if (/关闭|失败|撤销|超时/.test(status)) return `交易未达成「${status}」，不入账`;
  if (status.includes("成功")) return null;
  return `未知交易状态「${status}」，保守起见不入账`;
}

/** 微信当前状态 → 入账判定。返回 null 表示可入账，否则为跳过原因。 */
function wechatStatusSkipReason(status: string): string | null {
  if (status.includes("退款")) return `退款状态「${status}」：资金已退回/净额不确定，不入账`;
  if (/等待|待付款|处理中|关闭|已撤销|已失效|失败|超时/.test(status)) {
    return `交易未完成「${status}」：资金未实际变动，不入账`;
  }
  if (
    /已收入|已支出|已存入零钱|已入零钱|已收钱|已到账|支付成功|付款成功|收款成功|转账成功|充值成功|提现成功|交易成功/.test(
      status,
    )
  ) {
    return null;
  }
  return `未知交易状态「${status}」，保守起见不入账`;
}

// ─── 主解析入口 ────────────────────────────────────────────────

const DEFAULT_MAX_ROWS = 20_000;

/** 每种账单定位到的列下标（内部结构）。 */
interface ColumnMap {
  time: number;
  direction: number;
  amount: number;
  status: number;
  counterparty: number;
  product: number;
  ref: number;
  typeCol: number;
}

/** 按账单类型把列名行映射成列下标；关键列缺失返回 null（并写 warning）。 */
function mapColumns(
  source: BillStatementSource,
  cells: string[],
  warnings: string[],
): ColumnMap | null {
  const cols: ColumnMap =
    source === "alipay"
      ? {
          // 旧版「交易创建时间」/ 新版「交易时间」；付款时间兜底
          time: findCol(cells, ["交易创建时间", "交易时间", "付款时间"]),
          direction: findCol(cells, DIRECTION_COL),
          amount: findCol(cells, AMOUNT_COL),
          status: findCol(cells, ["交易状态"]),
          counterparty: findCol(cells, ["交易对方"]),
          product: findCol(cells, ["商品名称", "商品说明", "商品"]),
          ref: findCol(cells, ["交易号", "交易订单号"]),
          typeCol: findCol(cells, ["类型", "交易分类"]),
        }
      : {
          time: findCol(cells, ["交易时间"]),
          direction: findCol(cells, DIRECTION_COL),
          amount: findCol(cells, AMOUNT_COL),
          status: findCol(cells, ["当前状态"]),
          counterparty: findCol(cells, ["交易对方"]),
          product: findCol(cells, ["商品"]),
          ref: findCol(cells, ["交易单号"]),
          typeCol: findCol(cells, ["交易类型"]),
        };
  const missing: string[] = [];
  if (cols.time < 0) missing.push("交易时间");
  if (cols.direction < 0) missing.push("收/支");
  if (cols.amount < 0) missing.push("金额");
  if (cols.status < 0) missing.push("交易状态");
  if (missing.length > 0) {
    warnings.push(`已识别为${source === "alipay" ? "支付宝" : "微信"}账单，但列名行缺少关键列：${missing.join("、")}，未解析出交易`);
    return null;
  }
  return cols;
}

/** 确定性幂等 id：平台单号优先，缺单号退化为 日期_金额_方向（仍可重复解析复现）。 */
function buildTxId(
  source: BillStatementSource,
  ref: string,
  date: string,
  amount: number,
  type: "income" | "expense",
): string {
  if (ref) return `${source}:${ref}`;
  return `${source}:${date}_${amount.toFixed(2)}_${type}`;
}

/**
 * 解析支付宝/微信账单导出 CSV 文本。
 *
 * @returns `{ source, transactions, skipped, warnings }`；
 *          source 为 unknown 时 transactions 必为空（不猜格式，如实告警）。
 */
export function parseBillStatement(
  rawText: string,
  opts: BillStatementParseOptions = {},
): BillParseResult {
  const warnings: string[] = [];
  const empty = (source: BillStatementFormat): BillParseResult => ({
    source,
    transactions: [],
    skipped: [],
    warnings,
  });

  if (!rawText || !rawText.trim()) {
    warnings.push("账单文本为空，未解析出任何交易");
    return empty("unknown");
  }

  const maxRows = Math.max(1, Math.floor(opts.maxRows ?? DEFAULT_MAX_ROWS));

  // 去 BOM + GBK 乱码自动修复（修复逻辑见 tryGbkMojibakeRepair）
  let text = stripBom(rawText);
  const repaired = tryGbkMojibakeRepair(text);
  if (repaired) {
    text = repaired;
    warnings.push("账单文本疑似 GBK 编码被按单字节误读，已自动转码后解析");
  }

  const source = detectPlain(text);
  if (source === "unknown") {
    warnings.push(
      "无法识别为支付宝/微信账单导出（未找到「支付宝交易记录明细」或「微信支付账单明细」表头），未做任何入账",
    );
    return empty("unknown");
  }

  const rows = parseCsvText(text);

  // 定位列名行：支付宝旧版首列是「交易号」，微信首列是「交易时间」；
  // 统一规则 = 第一行同时具备 收/支 + 金额 + 状态/单号 特征的行
  let headerIdx = -1;
  let cols: ColumnMap | null = null;
  for (let i = 0; i < Math.min(rows.length, 60); i += 1) {
    const cells = rows[i];
    if (cells.every((c) => c.trim() === "")) continue;
    const dirOk = findCol(cells, DIRECTION_COL) >= 0;
    const amountOk = findCol(cells, AMOUNT_COL) >= 0;
    const statusOk = findCol(cells, [source === "alipay" ? "交易状态" : "当前状态"]) >= 0;
    if (dirOk && amountOk && statusOk) {
      cols = mapColumns(source, cells, warnings);
      if (cols) headerIdx = i;
      break;
    }
  }
  if (headerIdx < 0 || !cols) {
    if (warnings.every((w) => !w.includes("缺少关键列"))) {
      warnings.push(`已识别为${source === "alipay" ? "支付宝" : "微信"}账单，但未找到列名行（表头），未解析出交易`);
    }
    return empty(source);
  }

  const transactions: BillTransaction[] = [];
  const skipped: BillSkippedRow[] = [];
  const seenIds = new Set<string>();
  let truncated = false;

  for (let i = headerIdx + 1; i < rows.length; i += 1) {
    // 行号按 CSV 记录计（1 起，含说明头），方便用户回原文核对
    const rowNo = i + 1;
    const cells = rows[i];
    if (transactions.length + skipped.length >= maxRows) {
      truncated = true;
      break;
    }
    // 空行（含全空列）直接忽略，不算 skipped
    if (cells.every((c) => c.trim() === "")) continue;

    const cell = (idx: number): string => (idx >= 0 ? (cells[idx] ?? "").trim() : "");

    // 1) 收/支方向：不计收支/中性交易（如零钱充值、提现、余额互转）不入账——
    //    资金在自己账户间转移，记成收支会虚增流水
    const direction = parseDirection(cell(cols.direction));
    if (!direction) {
      skipped.push(
        makeSkipped(rowNo, cells, `不计收支/中性交易「${cell(cols.direction) || "空"}」：资金在自有账户间转移，不计入收支`),
      );
      continue;
    }

    // 2) 金额
    const amount = parseAmountText(cell(cols.amount));
    if (!Number.isFinite(amount) || amount <= 0) {
      skipped.push(makeSkipped(rowNo, cells, `金额无法解析「${cell(cols.amount)}」`));
      continue;
    }

    // 3) 交易时间（解析不了就跳过，绝不猜日期）
    const date = normalizeBillDate(cell(cols.time));
    if (!date) {
      skipped.push(makeSkipped(rowNo, cells, `交易时间无法解析「${cell(cols.time)}」`));
      continue;
    }

    // 4) 交易状态过滤（规则见上方注释块）
    const status = cell(cols.status);
    const skipReason =
      source === "alipay" ? alipayStatusSkipReason(status) : wechatStatusSkipReason(status);
    if (skipReason) {
      skipped.push(makeSkipped(rowNo, cells, skipReason));
      continue;
    }

    // 5) 商户 / 描述（微信用「/」表示空字段）
    const merchant = cleanTextField(cell(cols.counterparty));
    const product = cleanTextField(cell(cols.product));
    const typeText = cleanTextField(cell(cols.typeCol));
    const description = product || typeText || "";

    // 6) 幂等 id：平台交易单号；同文件内重复单号只保留首条（其余跳过，
    //    避免同一份账单里复制粘贴的重复行重复入账）
    const id = buildTxId(source, cell(cols.ref), date, amount, direction);
    if (seenIds.has(id)) {
      skipped.push(makeSkipped(rowNo, cells, `交易单号重复「${id}」，本文件内已出现过，跳过避免重复入账`));
      continue;
    }
    seenIds.add(id);

    const tx: BillTransaction = {
      id,
      date,
      amount,
      type: direction,
      category: "其他",
      source,
      ...(merchant ? { merchant } : {}),
      ...(description ? { description } : {}),
    };
    transactions.push(tx);
  }

  if (truncated) {
    warnings.push(
      `账单超过最大解析行数（${maxRows}），超出部分未解析；已解析 ${transactions.length} 笔、跳过 ${skipped.length} 行`,
    );
  }
  if (transactions.length === 0) {
    warnings.push(
      `未解析出可入账交易（跳过 ${skipped.length} 行，原因见 skipped）`,
    );
  }
  return { source, transactions, skipped, warnings };
}
