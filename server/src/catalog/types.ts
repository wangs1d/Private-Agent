/**
 * Feature Catalog —— 能力分类层类型定义。
 *
 * 设计原则（见 docs 计划）：能力的「清单」以 tool-registry / skill-manager /
 * MCP 三个既有注册表为单一事实源，catalog 只做「分类视图」——启动时汇聚、
 * 打标、校验，不注册任何能力。分类用四个维度：
 *
 *   LifeDomain  生活域（用户视角，12 个，收敛替代 agent-capabilities 的 33 散域）
 *   ActionKind  动作性质（查询/预订交易/执行/自动化/触达/管理）
 *   TriggerKind 触发方式（对话/主动/定时/事件）
 *   RiskLevel   风险等级（read/write/spend/outbound/system）——spend/outbound
 *               直接喂 AgentTaskSafety 与习惯自动执行护栏
 */

/** 生活域（12 个）。 */
export type LifeDomain =
  | "travel"   // 出行：行程/票务/预订/接站/约车/位置/天气
  | "dining"   // 餐饮：餐厅/外卖/跑腿
  | "home"     // 居家：家政/智能家居/设备
  | "finance"  // 财务：支付/钱包/记账/账单/购物下单
  | "health"   // 健康：运动/指标
  | "social"   // 社交：消息/邮件/朋友圈/外联
  | "media"    // 娱乐：音乐/视频/图像
  | "learning" // 学习：笔记/联网研究
  | "work"     // 生产力：日历/文档/代码/桌面/文件
  | "comms"    // 通讯触达：电话/短信/语音播报/通知
  | "self"     // 自身：记忆/习惯/画像/自我进化/Agent World/具身
  | "system";  // 系统基础：时钟/搜索/抓取/元工具/MCP

export const LIFE_DOMAINS: readonly LifeDomain[] = [
  "travel", "dining", "home", "finance", "health", "social",
  "media", "learning", "work", "comms", "self", "system",
];

export const LIFE_DOMAIN_LABELS: Record<LifeDomain, string> = {
  travel: "出行",
  dining: "餐饮",
  home: "居家",
  finance: "财务",
  health: "健康",
  social: "社交",
  media: "娱乐",
  learning: "学习",
  work: "生产力",
  comms: "通讯触达",
  self: "自身",
  system: "系统基础",
};

export const LIFE_DOMAIN_DESCRIPTIONS: Record<LifeDomain, string> = {
  travel: "行程规划、机票/火车/酒店预订、到站管家（接站/约车）、位置与天气",
  dining: "餐厅预订、外卖与跑腿代购",
  home: "家政/本地生活预订、智能家居控制、终端设备管理",
  finance: "支付宝/微信支付、钱包与转账、记账与账单、电商下单",
  health: "健康与运动指标记录/查询/目标",
  social: "邮件/短信/消息桥外发、社交平台发帖互动、好友关系",
  media: "音乐播放、图像生成、视频解析、图搜",
  learning: "笔记沉淀与复习、联网深度研究",
  work: "日程提醒、文件文档、代码沙盒、桌面自动化、网页浏览",
  comms: "虚拟电话、语音播报、系统通知、弹层提醒",
  self: "记忆与画像、习惯自动化、自我编程、Agent World、具身身体",
  system: "时钟、联网搜索与抓取、工具元目录、MCP 生态",
};

/** 动作性质。 */
export type ActionKind =
  | "query"       // 查询（只读）
  | "book"        // 预订/交易（下单、支付、转账）
  | "execute"     // 执行（改变外部状态：播放/控制/自动化）
  | "automate"    // 自动化（习惯/规则管理）
  | "communicate" // 触达（发消息/通知/呼叫）
  | "manage";     // 管理（配置/开关/删除）

/** 触发方式。 */
export type TriggerKind = "chat" | "proactive" | "scheduled" | "event";

/** 风险等级。 */
export type RiskLevel =
  | "read"      // 只读
  | "write"     // 写状态（可逆）
  | "spend"     // 花钱（支付/下单/转账）
  | "outbound"  // 外发第三方（短信/邮件/社交发布/代打电话）
  | "system";   // 系统层（元工具/沙箱）

/** 一个能力的完整分类。 */
export interface FeatureClass {
  domain: LifeDomain;
  action: ActionKind;
  trigger: TriggerKind;
  risk: RiskLevel;
}

/** 能力暴露形态。 */
export type FeatureSurface = "tool" | "skill" | "mcp";

/** 目录中的统一能力条目。 */
export interface UnifiedFeature {
  name: string;
  surface: FeatureSurface;
  description: string;
  cls: FeatureClass;
  /** 分类来源：rule=映射表命中 / fallback=未命中走系统兜底 */
  classifiedBy: "rule" | "fallback";
}
