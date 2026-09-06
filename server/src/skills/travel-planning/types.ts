/**
 * 旅游规划 Skill - 核心类型
 *
 * 历史说明：本文件曾整份移植自 3D-Travel 的领域类型（Attraction/Hotel/Booking/
 * RoutePlan/UserState/ReplanEvent/PreferenceProfile 等约 600 行）。经全仓核查，
 * 除下述类型外均无任何引用，属于从未接线的投机设计，已于 2026-09 清理。
 * 后续如需「用户实时状态驱动的重规划」，请按实际接线方案重新设计，勿整段回填。
 */

// ============================================
// 坐标与地理
// ============================================

export interface Coordinates {
  latitude: number;
  longitude: number;
}

// ============================================
// Agent 推理追踪
// ============================================

/** Agent 推理追踪 */
export interface AgentTrace {
  /** 规划模式 */
  planningMode: 'agent' | 'fallback-rule';
  /** 推理步骤 */
  steps: AgentTraceStep[];
  /** 总耗时（ms） */
  totalDurationMs: number;
  /** 是否降级 */
  degraded: boolean;
  /** 降级原因 */
  degradeReason?: string;
}

export interface AgentTraceStep {
  /** 步骤序号 */
  step: number;
  /** 类型 */
  type: 'llm-reasoning' | 'tool-call' | 'tool-result';
  /** 工具名（type 为 tool-call/tool-result 时） */
  toolName?: string;
  /** 工具输入 */
  toolInput?: unknown;
  /** 工具输出 */
  toolOutput?: unknown;
  /** LLM 推理内容 */
  reasoning?: string;
  /** 耗时（ms） */
  durationMs: number;
  /** 数据来源标记 */
  dataSource?: 'real-api' | 'estimated';
}
