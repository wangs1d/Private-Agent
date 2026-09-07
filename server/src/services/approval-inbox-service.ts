/**
 * 待确认收件箱服务（ApprovalInboxService）—— 「Agent 主动了什么 / 想花钱做什么」的统一读/解外观。
 *
 * 产品口径：
 *  - **涉及花钱的主动服务确认**需要用户点确认（approve 执行 / decline 作废）
 *  - **其他主动化消息**也进收件箱，但只是可见性（无需点击）——来自
 *    AgentActivityStore 的主动动作台账（含已执行的代办性质动作）
 *  - 习惯自动化是 Agent 自己的习惯，**不进收件箱**（habit-loop 自身按
 *    authorization 梯度运行，仅失败降权后才回到确认路径）
 *  - task 来源的 awaiting_approval 依旧**不接入**——approveTask 仅翻状态、
 *    不恢复已退出的编排主循环，接入会造成「批了不跑」的假确认
 *
 * 只聚合既有挂起态，不新建状态、不重实现动作：resolve 委托
 * hub.resolveConfirmation（内部走既有执行路径），无死锁风险。
 */
import type { PendingActionConfirmation, ProactivityHub } from "../proactivity/proactivity-hub.js";
import type { AgentActivity } from "../proactivity/activity-store.js";

export type ApprovalSource = "proactivity";

/** 收件箱条目（payload 只含可安全展示的小子集：不含工具参数等敏感内容） */
export interface ApprovalInboxItem {
  id: string;
  source: ApprovalSource;
  /** 来源内部的条目类型（proactivity 的 kind） */
  kind: string;
  title: string;
  summary: string;
  actorId: string;
  /** ISO 时间戳 */
  createdAt: string;
  /** ISO 时间戳；来源无过期概念时为 null */
  expiresAt: string | null;
  /**
   * 是否涉及花钱：true 时客户端渲染「批准执行 / 拒绝」按钮；
   * false 时仅展示（无需确认的行动计划）
   */
  spend: boolean;
  payload: Record<string, unknown>;
}

/** 主动动态条目（AgentActivityStore 台账的透出视图，只读） */
export type ApprovalActivityItem = AgentActivity;

export interface ApprovalInboxSnapshot {
  items: ApprovalInboxItem[];
  activity: ApprovalActivityItem[];
}

export interface ApprovalResolveResult {
  ok: boolean;
  detail?: string;
}

/** 便于测试注入的最小面（与 ProactivityHub 的确认两方法同形） */
export type ApprovalHubLike = Pick<ProactivityHub, "listPendingConfirmations" | "resolveConfirmation">;
/** 与 AgentActivityStore 的读取面同形 */
export type ApprovalActivityStoreLike = {
  list: (actorId?: string, limit?: number) => AgentActivity[];
};
/** 与 FeatureCatalog 的分类面同形（risk=spend 判定） */
export type ApprovalCatalogLike = {
  classify: (name: string) => { cls: { risk: string } } | null;
};

/** 兜底花钱判定：目录不可用时按工具名关键词 */
const SPEND_TOOL_RE = /(^|\.)(book|pay|order|purchase)$|booking\.travel-pay|alipay|wechat_pay|ride_hailing|meituan|restaurant\.book|home_service\.book|shopping/i;
/** 文案兜底：理由里出现金额或花钱动词（pipeline 提案级 steps 为空时的主要信号） */
const SPEND_TEXT_RE = /(¥|￥|\d+\s*元)|购买|下单|支付|付款|代付|充值|买票|订票|点外卖|购物|代订/;

export class ApprovalInboxService {
  constructor(
    private readonly deps: {
      proactivityHub?: ApprovalHubLike | null;
      activityStore?: ApprovalActivityStoreLike | null;
      featureCatalog?: ApprovalCatalogLike | null;
      /** 主动动态拉取条数上限 */
      activityLimit?: number;
      /** 分级触达路由（resolve 时同步闭合关联注意力记录） */
      reachRouter?: { resolveByConfirmId: (confirmId: string, note?: string) => unknown } | null;
    } = {},
  ) {}

  /**
   * 收件箱快照：待确认条目（含 spend 标记，新在前）+ 最近主动动态（台账已按时间倒序）。
   */
  async list(actorId: string): Promise<ApprovalInboxSnapshot> {
    const items: ApprovalInboxItem[] = [];
    const hub = this.deps.proactivityHub;
    if (hub) {
      for (const entry of hub.listPendingConfirmations(actorId)) {
        items.push(
          toItemFromProactivity(entry, (name) => isSpendTool(name, this.deps.featureCatalog)),
        );
      }
    }
    items.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    const activity = this.deps.activityStore?.list(actorId, this.deps.activityLimit ?? 20) ?? [];
    return { items, activity };
  }

  /**
   * 解析一条待确认（仅 spend 条目需要调用）：委托既有执行路径。
   * @param source 目前只有 proactivity（habit/task 不接入，见文件头注释）
   * @param id proactivity 的 confirmId
   * @param decision approve 执行 / decline 作废
   */
  async resolve(
    actorId: string,
    source: ApprovalSource,
    id: string,
    decision: "approve" | "decline",
  ): Promise<ApprovalResolveResult> {
    if (source !== "proactivity") {
      return { ok: false, detail: `未知来源：${source}` };
    }
    const hub = this.deps.proactivityHub;
    if (!hub) return { ok: false, detail: "主动性确认源未装配" };
    const approved = decision === "approve";
    const result = await hub.resolveConfirmation(actorId, approved, id);
    if (!result.ok) return { ok: false, detail: result.error ?? "确认解析失败" };
    const detail = !approved
      ? "已拒绝（该行动计划已作废）"
      : result.executed
        ? "已按确认执行"
        : "已确认但未执行（安全门拦截或执行失败）";
    // 同步闭合注意力记录（ReachRouter 的升级链看到 resolve 即停）
    this.deps.reachRouter?.resolveByConfirmId(id, detail);
    return { ok: true, detail };
  }
}

/** 单个工具是否涉及花钱：优先目录 risk=spend，目录不可用时正则兜底 */
function isSpendTool(toolName: string, catalog?: ApprovalCatalogLike | null): boolean {
  const feature = catalog?.classify(toolName);
  if (feature) return feature.cls.risk === "spend";
  return SPEND_TOOL_RE.test(toolName);
}

/**
 * 整条确认是否涉及花钱（ReachRouter 路由与收件箱 spend 标记共用）：
 * 任一步骤工具命中目录 spend 风险，或理由文案带花钱信号（pipeline 提案级
 * steps 为空时的主要信号）。
 */
export function isSpendConfirmation(
  entry: { steps: Array<{ tool: string }>; rationale: string },
  catalog?: ApprovalCatalogLike | null,
): boolean {
  return (
    entry.steps.some((s) => isSpendTool(s.tool, catalog)) ||
    SPEND_TEXT_RE.test(entry.rationale)
  );
}

function toItemFromProactivity(
  entry: PendingActionConfirmation,
  isSpendToolFn: (tool: string) => boolean,
): ApprovalInboxItem {
  const tools = entry.steps.map((s) => s.tool);
  const spend =
    tools.some(isSpendToolFn) || SPEND_TEXT_RE.test(entry.rationale);
  return {
    id: entry.confirmId,
    source: "proactivity",
    kind: entry.kind,
    title: spend
      ? `需要确认：${entry.rationale.slice(0, 60)}`
      : `主动行动：${entry.rationale.slice(0, 60)}`,
    summary: entry.rationale,
    actorId: entry.actorId,
    createdAt: new Date(entry.createdAt).toISOString(),
    expiresAt: new Date(entry.expiresAt).toISOString(),
    spend,
    payload: {
      origin: entry.origin,
      stepCount: entry.steps.length,
      steps: tools,
    },
  };
}
