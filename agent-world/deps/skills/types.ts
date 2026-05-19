/**
 * Skill 系统核心类型定义
 */

import type { ToolContext } from "../tools/tool-registry.js";

/**
 * Skill 权限声明
 */
export type SkillPermission =
  | "wallet:read"        // 读取真实资金钱包余额（非 Agent World 点数）
  | "wallet:write"       // 修改真实资金钱包（扣款、冻结等）
  | "calendar:read"      // 读取日历事件
  | "calendar:write"     // 创建/修改日历事件
  | "contacts:read"      // 读取联系人
  | "location:read"      // 读取位置信息
  | "notifications:write" // 发送通知
  | "storage:read"       // 读取本地存储
  | "storage:write"      // 写入本地存储
  | "network:external"   // 访问外部网络
  | "filesystem:read"    // 读取文件系统
  | "filesystem:write";  // 写入文件系统

/**
 * Skill 输入参数定义
 */
export type SkillParameter = {
  name: string;              // 参数名
  type: "string" | "number" | "boolean" | "object" | "array"; // 参数类型
  required: boolean;         // 是否必填
  description?: string;      // 参数描述
  default?: unknown;         // 默认值
  enum?: unknown[];          // 枚举值
};

/**
 * Skill 元数据定义
 */
export type SkillMetadata = {
  name: string;              // Skill 唯一标识（如 "budget.calculate"）
  version: string;           // 版本号（语义化版本，如 "1.0.0"）
  displayName: string;       // 显示名称（如 "预算计算器"）
  description: string;       // 功能描述
  author?: string;           // 作者
  license?: string;          // 许可证
  tags?: string[];           // 标签分类
  icon?: string;             // 图标（emoji 或 URL）
  /** 内置或用户上传到技能商店的社区技能 */
  kind?: "builtin" | "community";

  // 输入输出定义
  parameters: SkillParameter[];  // 输入参数列表
  outputSchema?: Record<string, string>; // 输出字段说明
  
  // 权限和限制
  permissions: SkillPermission[];  // 所需权限列表
  timeoutMs?: number;        // 执行超时时间（毫秒），默认 5000
  maxRetries?: number;       // 最大重试次数，默认 0
  
  // 依赖和兼容性
  dependencies?: string[];   // 依赖的其他 Skill 名称
  minAgentVersion?: string;  // 最低 Agent 版本要求
  
  // 生命周期
  createdAt?: string;        // 创建时间
  updatedAt?: string;        // 更新时间
};

/**
 * Skill 执行上下文（扩展自 ToolContext）
 */
export type SkillExecutionContext = ToolContext & {
  permissions: Set<SkillPermission>;  // 已授权的权限
  storage?: Map<string, unknown>;     // Skill 私有存储空间
  logger: SkillLogger;                // 日志记录器
};

/**
 * Skill 日志记录器
 */
export type SkillLogger = {
  info: (message: string, data?: unknown) => void;
  warn: (message: string, data?: unknown) => void;
  error: (message: string, data?: unknown) => void;
  debug: (message: string, data?: unknown) => void;
};

/**
 * Skill 执行结果
 */
export type SkillExecutionResult = {
  ok: boolean;
  result?: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
  executionTime?: number;  // 执行耗时（毫秒）
};

/**
 * Skill 处理器函数类型
 */
export type SkillHandler = (
  input: Record<string, unknown>,
  context: SkillExecutionContext
) => Promise<Record<string, unknown>>;

/**
 * Skill 完整定义（元数据 + 处理器）
 */
export type SkillDefinition = {
  metadata: SkillMetadata;
  handler: SkillHandler;
};

/**
 * Skill 清单（用于列出所有可用 Skill）
 */
export type SkillManifest = Omit<SkillMetadata, "handler"> & {
  enabled: boolean;        // 是否启用
  trusted: boolean;        // 是否受信任
  installedAt?: string;    // 安装时间
};

/**
 * Skill 配置选项
 */
export type SkillConfig = {
  enabled?: boolean;       // 是否启用该 Skill
  permissions?: SkillPermission[]; // 覆盖默认权限
  settings?: Record<string, unknown>; // 自定义设置
};

/**
 * Skill 验证错误
 */
export type SkillValidationError = {
  field: string;
  message: string;
  code: string;
};

/**
 * Skill 加载选项
 */
export type SkillLoadOptions = {
  trustByDefault?: boolean;     // 是否默认信任新 Skill
  autoEnable?: boolean;         // 是否自动启用
  validateOnly?: boolean;       // 仅验证不加载
};
