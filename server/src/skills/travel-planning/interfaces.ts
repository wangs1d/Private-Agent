/**
 * 旅游规划 Skill - Agent 集成接口（精简自 3D-Travel interfaces/interfaces.ts）
 *
 * 仅保留 PlanningService 需要的最小类型集，剥离 express 等宿主依赖。
 */

import type { AgentTrace, Coordinates } from './types.js';

/** Agent 请求（规则引擎入口与 Agent 集成入口共用） */
export interface AgentRequest {
  input: string;
  destination?: string;
  days?: number;
  preferences?: string[];
  userId?: string;
}

/** Agent 结果 */
export interface AgentResult {
  itinerary: unknown;
  agentTrace: AgentTrace;
}

/** Planning Agent 核心接口 */
export interface IPlanningAgent {
  generateItinerary(request: AgentRequest): Promise<AgentResult>;
  findIndoorAlternatives(
    poiName: string,
    location: Coordinates,
    radius?: number,
  ): Promise<unknown[]>;
  ping(): Promise<boolean>;
}