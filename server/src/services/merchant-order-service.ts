/**
 * 商家下单服务（支付宝官方「智能体接入」模式的落地层）。
 *
 * 对应支付宝商户接入指南（https://a2a.alipay.com/merchant-guide#skill）的官方模式：
 *   商家把「下单」能力封装成 HTTP / MCP 接口，返回支付宝支付 payload（orderStr / 收银台链接）；
 *   买家侧（本项目 agent）按意图路由到商家 → 调用其下单接口 → 拿到 `alipay_` 支付短链
 *   → 引导 alipay.submit-payment 完成真实支付（官方核心原则：下单 skill 专注业务流程，支付技能负责支付）。
 *
 * 商家目录持久化在 `data/merchants.json`（可用环境变量 MERCHANT_REGISTRY_FILE 覆盖路径），
 * 每个商家声明：id/name/description/category/tags + 下单接口规格（protocol/url/模板/extractPath）。
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { existsSync } from "node:fs";
import type { AlipayBotService } from "./alipay-bot-service.js";

/** 商家下单接口规格（HTTP / MCP） */
export type MerchantOrderSpec = {
  /** 协议：http（标准 HTTP 下单接口）或 mcp（MCP Streamable HTTP） */
  protocol: "http" | "mcp";
  /** 商家下单接口 URL（HTTP 必填；MCP 为 Streamable HTTP 端点） */
  url: string;
  /** HTTP method，默认 POST */
  method?: string;
  /** 查询参数（JSON 对象字符串，支持 {param} 模板替换） */
  query?: string;
  /** 请求体模板（JSON 字符串，支持 {param} 模板替换；缺省时用 params 序列化为 body） */
  bodyTemplate?: string;
  /** 请求头列表，格式 ['key:value', ...]，支持 {param} 模板替换 */
  headers?: string[];
  /** 提取支付宝支付 payload 的 JSON 路径（默认 $.alipayMetadata.orderStr） */
  extractPath?: string;
  /** payload 类型：link / orderString / auto（默认 auto） */
  payloadType?: "link" | "orderString" | "auto";
  /** MCP JSON-RPC method（mcp 协议必填） */
  mcpMethod?: string;
  /** MCP JSON-RPC params 模板（JSON 字符串，支持 {param} 模板替换；缺省时用 params 序列化） */
  mcpParamsTemplate?: string;
};

/** 商家定义 */
export type MerchantDefinition = {
  /** 唯一标识（如 meituan、mock-demo） */
  id: string;
  name: string;
  description: string;
  /** 分类：餐饮 / 出行 / 零售 / 数字内容 ... */
  category: string;
  tags: string[];
  order: MerchantOrderSpec;
  /** 是否启用（默认 true） */
  enabled?: boolean;
};

type MerchantRegistryFile = {
  version: number;
  merchants: MerchantDefinition[];
};

export type PlaceOrderParams = Record<string, string | number | boolean>;

export type PlaceOrderResult = {
  ok: boolean;
  merchant?: MerchantDefinition;
  /** alipay_ 支付短链别名（供 alipay.submit-payment 使用） */
  alias?: string;
  extractPath?: string;
  payloadType?: string;
  stdout?: string;
  stderr?: string;
  error?: string;
};

/** 从 CLI 输出中提取 `alipay_` 别名（短链），CLI 会把真实 payload 落盘到 trade-payload-aliases.json。 */
function extractAlias(stdout: string): string | undefined {
  if (!stdout) return undefined;
  const m = /(alipay_[A-Za-z0-9]+)/.exec(stdout);
  return m ? m[1] : undefined;
}

/** 用 params 替换模板中的 {key} 占位符。 */
function substitute(template: string | undefined, params: PlaceOrderParams): string | undefined {
  if (template === undefined || template === "") return undefined;
  return template.replace(/\{([A-Za-z0-9_.-]+)\}/g, (_, key: string) => {
    const v = params[key];
    if (v === undefined || v === null) return `{${key}}`; // 未提供则保留占位符，交由商家侧判断
    return String(v);
  });
}

function substituteHeaders(headers: string[] | undefined, params: PlaceOrderParams): string[] | undefined {
  if (!headers || headers.length === 0) return undefined;
  return headers.map((h) => substitute(h, params) ?? h);
}

export class MerchantOrderService {
  private merchants: MerchantDefinition[] = [];
  private registryPath: string;
  private alipayBotService: AlipayBotService;

  constructor(registryPath: string, alipayBotService: AlipayBotService) {
    this.registryPath = registryPath;
    this.alipayBotService = alipayBotService;
  }

  /** 从磁盘加载商家目录；文件缺失时初始化空目录并落盘。 */
  async load(): Promise<void> {
    try {
      if (!existsSync(this.registryPath)) {
        await mkdir(dirname(this.registryPath), { recursive: true });
        await this.persist({ version: 1, merchants: [] });
        this.merchants = [];
        return;
      }
      const raw = await readFile(this.registryPath, "utf8");
      const file = JSON.parse(raw) as MerchantRegistryFile;
      this.merchants = Array.isArray(file.merchants) ? file.merchants : [];
    } catch (err) {
      // 目录损坏时不阻断启动，重置为空目录
      this.merchants = [];
    }
  }

  private async persist(file: MerchantRegistryFile): Promise<void> {
    await writeFile(this.registryPath, JSON.stringify(file, null, 2), "utf8");
  }

  /** 列出启用中的商家。 */
  listMerchants(): MerchantDefinition[] {
    return this.merchants.filter((m) => m.enabled !== false);
  }

  getMerchant(id: string): MerchantDefinition | undefined {
    return this.merchants.find((m) => m.id === id && m.enabled !== false);
  }

  /**
   * 按意图路由商家：对商家的 name/category/tags（权重高）与 description（权重低）
   * 做中文友好的子串命中打分。命中数相同取先注册者；无命中返回 undefined。
   */
  routeMerchant(intent: string): MerchantDefinition | undefined {
    const q = intent.trim().toLowerCase();
    if (!q) return undefined;

    /** 按非字母数字切分，提取有信息量的词（中文单字也算，因"奶茶""咖啡"多为两字词）。 */
    const splitWords = (s: string): string[] =>
      s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2);

    let best: MerchantDefinition | undefined;
    let bestScore = 0;
    for (const m of this.listMerchants()) {
      let score = 0;
      // 高权重：name / category / tags 中的词出现在意图里
      const high = new Set([...splitWords(m.name), m.category.toLowerCase(), ...m.tags.map((t) => t.toLowerCase())]);
      for (const kw of high) {
        if (kw.length >= 2 && q.includes(kw)) score += 2;
      }
      // 低权重：description 中的词出现在意图里
      for (const w of splitWords(m.description)) {
        if (q.includes(w)) score += 1;
      }
      // 商家名整名命中加权
      if (m.name.toLowerCase() && q.includes(m.name.toLowerCase())) score += 5;
      if (score > bestScore) {
        bestScore = score;
        best = m;
      }
    }
    return bestScore > 0 ? best : undefined;
  }

  /**
   * 在指定商家下单：模板替换后调用支付宝 proxy-trade-request，
   * 提取 `alipay_` 支付短链别名返回（供 alipay.submit-payment 使用）。
   *
   * @param actorId 当前用户标识（钱包按用户隔离）
   * @param sessionId 业务会话 ID
   * @param merchantId 商家 id
   * @param params 下单参数（替换到 url/query/body/headers/mcpParams 模板）
   */
  async placeOrder(
    actorId: string,
    sessionId: string,
    merchantId: string,
    params: PlaceOrderParams = {},
  ): Promise<PlaceOrderResult> {
    const merchant = this.getMerchant(merchantId);
    if (!merchant) {
      const ids = this.listMerchants().map((m) => m.id).join(", ");
      return { ok: false, error: `商家不存在或未启用：${merchantId}${ids ? `。可用商家：${ids}` : ""}` };
    }
    const spec = merchant.order;
    const wallet = this.alipayBotService.forUser(actorId);

    try {
      let body: string | undefined;
      let paramsArg: string | undefined;
      if (spec.protocol === "mcp") {
        paramsArg = substitute(spec.mcpParamsTemplate, params) ?? (Object.keys(params).length ? JSON.stringify(params) : undefined);
      } else {
        body = substitute(spec.bodyTemplate, params) ?? (Object.keys(params).length ? JSON.stringify(params) : undefined);
      }
      const result = await wallet.proxyTradeRequest({
        protocol: spec.protocol,
        url: substitute(spec.url, params) ?? spec.url,
        sessionId,
        extractPath: spec.extractPath,
        payloadType: spec.payloadType,
        method: spec.method,
        query: substitute(spec.query, params),
        body,
        headers: substituteHeaders(spec.headers, params),
        mcpMethod: spec.mcpMethod,
        params: paramsArg,
        timeoutMs: 15_000,
      });
      if (!result.ok) {
        return {
          ok: false,
          merchant,
          stdout: result.stdout,
          stderr: result.stderr,
          error: result.error ?? result.stderr ?? "下单请求失败",
        };
      }
      const alias = extractAlias(result.stdout);
      if (!alias) {
        return {
          ok: false,
          merchant,
          stdout: result.stdout,
          stderr: result.stderr,
          error: "下单成功但未能从输出中提取 alipay_ 支付短链，请检查商家返回的 payload 格式",
        };
      }
      return {
        ok: true,
        merchant,
        alias,
        extractPath: spec.extractPath ?? "$.alipayMetadata.orderStr",
        payloadType: spec.payloadType ?? "auto",
        stdout: result.stdout,
      };
    } catch (err) {
      return { ok: false, merchant, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
