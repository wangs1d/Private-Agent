/**
 * done 阶段确定性附卡链（单一事实源）。
 *
 * chat-user-message 在 assistant_done 前按固定顺序附加确定性卡片/媒体标记，
 * 此前该顺序内联在 handler 里，无法被测试覆盖——「单测全绿但真实轮次漏卡」
 * 的接线缺口（weather/wallet/calendar/shopping/video 只接了单工具直跑路径）
 * 正是在这里漏掉的。抽出为纯函数后，测试可用与 handler 完全相同的顺序与
 * 输入回放真实轮次（tool-loop 内执行、reply.toolName 为空）。
 *
 * 顺序即优先级（先附上的卡生效，后续 attach 各自含结构化标记 guard 让位）：
 *   1. travel_itinerary 行程卡（直跑 + loop 冷层回捞，handler 解析后传入）
 *   2. weather 天气卡（loop 多次调用合并为一张多地卡）
 *   3. search_result 搜索卡（loop 多次调用按 url 去重合并）
 *   4. 其余注册工具卡（wallet/schedule/order/比价…，按执行顺序取第一张）
 *   5. video 媒体标记（[RENDER_AS:video]，loop 捕获优先、直跑回执兜底）
 */

import {
  attachSearchResultCardFromExecuted,
  attachWeatherResultCardFromExecuted,
  tryAttachToolResultCard,
} from "./tool-card-registry.js";
import {
  attachTravelItineraryCard,
  attachVideoMediaMarker,
} from "./tool-result-processor.js";

/** 一次真实工具执行的回执（来自 onExternalToolExecuted 或直跑 toolResult）。 */
export interface ExecutedToolReceipt {
  toolName: string;
  result: Record<string, unknown>;
}

export interface DeterministicCardChainInput {
  /** processAssistantText 之后的正文（LLM 口语回复，可能已含 L2 卡块）。 */
  text: string;
  /** 行程：toolName + 已解析出完整 days 的回执（冷层回捞由 handler 完成后传入）。 */
  travelToolName?: string;
  travelResult?: Record<string, unknown>;
  /** tool-loop 聚合的天气回执（按执行顺序）。 */
  weatherResults?: ReadonlyArray<ExecutedToolReceipt>;
  /** tool-loop 聚合的搜索回执（按执行顺序）。 */
  searchResults?: ReadonlyArray<ExecutedToolReceipt>;
  /** 其余注册工具回执（wallet/calendar/shopping…，按执行顺序）。 */
  registryResults?: ReadonlyArray<ExecutedToolReceipt>;
  /** 视频抓取回执（loop 捕获在前、直跑兜底在后；取最后一条）。 */
  videoResults?: ReadonlyArray<ExecutedToolReceipt>;
}

/** 按 done 阶段真实顺序附加全部确定性卡片/媒体标记，返回最终文本。 */
export function attachDeterministicCards(input: DeterministicCardChainInput): string {
  let text = input.text;
  text = attachTravelItineraryCard(text, input.travelToolName, input.travelResult);
  text = attachWeatherResultCardFromExecuted(text, input.weatherResults ?? []);
  text = attachSearchResultCardFromExecuted(text, input.searchResults ?? []);
  for (const mt of input.registryResults ?? []) {
    const marked = tryAttachToolResultCard(text, mt.toolName, mt.result);
    if (marked) {
      text = marked;
      break;
    }
  }
  const video = input.videoResults?.[input.videoResults.length - 1];
  if (video) {
    text = attachVideoMediaMarker(text, video.toolName, video.result);
  }
  return text;
}
