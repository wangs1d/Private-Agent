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
 *   3. search_result 搜索卡（loop 多次调用按 url 去重合并；搜索类媒体有产出
 *      时整卡让位——照片是主形态，意图仲裁见 searchMediaHasItems）
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
import { travelPlanStore } from "../skills/travel-planning/travel-plan-store.js";

/** 一次真实工具执行的回执（来自 onExternalToolExecuted 或直跑 toolResult）。 */
export interface ExecutedToolReceipt {
  toolName: string;
  result: Record<string, unknown>;
}

/** 行程回执裁决产物：toolName/result 成对，拿不到行程时均为 undefined。 */
export interface TravelReceiptResolution {
  toolName?: "travel.plan-itinerary";
  result?: Record<string, unknown>;
}

const DEFAULT_TRAVEL_FALLBACK_WINDOW_MS = 60 * 1000;

/**
 * done 阶段行程回执裁决（单一事实源）：WS 对话路径与任务面收尾共用。
 *
 * 行程卡是确定性附卡（不依赖 LLM 转发），但「拿到行程原始数据」的链路有
 * 多条且都会漏拍：直跑回执挂在 reply.toolName，tool-loop 执行靠
 * onToolExecuted 捕获，而缓存重放 / 升级段边缘 / 旧构建 hook 断线时捕获
 * 会是空的——此前任务面收尾没有兜底，卡片就永远附不上（漏卡根因）。
 * 这里按优先级统一裁决：
 *   1. 本轮真实执行回执（直跑 toolResult 或 onToolExecuted 捕获，等价）；
 *      回执是瘦身摘要也直接放行——attachTravelItineraryCard 内部会按
 *      planId 从冷层补全量 days；
 *   2. 捕获为空 → 冷层近窗回捞兜底：只认窗口内新生成的行程，
 *      正文/目标点名目的地优先，否则取最新一份（规划轮正文可能不含
 *      目的地全名）。窗口默认 60s，任务面可放宽（执行可能排队）。
 */
export function resolveTravelReceipt(input: {
  replyToolName?: string;
  replyToolResult?: Record<string, unknown>;
  executedReceipt?: Record<string, unknown>;
  goal?: string;
  finalText?: string;
  fallbackWindowMs?: number;
  nowMs?: number;
}): TravelReceiptResolution {
  const now = input.nowMs ?? Date.now();

  // 1. 本轮真实执行回执优先
  const executed =
    input.executedReceipt ??
    (input.replyToolName === "travel.plan-itinerary"
      ? input.replyToolResult
      : undefined);
  if (executed && typeof executed === "object") {
    // 本轮确实尝试过规划：成功才附卡，失败不回捞旧行程误挂到失败轮
    if (typeof executed.ok !== "boolean" || executed.ok) {
      return { toolName: "travel.plan-itinerary", result: executed };
    }
    return {};
  }

  // 2. 冷层近窗回捞（捕获漏拍兜底）
  const window = input.fallbackWindowMs ?? DEFAULT_TRAVEL_FALLBACK_WINDOW_MS;
  const candidates = travelPlanStore
    .listSummaries(5)
    .filter((s) => now - s.createdAt < window);
  if (candidates.length === 0) return {};
  const haystack = `${input.goal ?? ""}\n${input.finalText ?? ""}`;
  const picked =
    candidates.find(
      (s) => s.destination && haystack.includes(s.destination),
    ) ?? candidates[0];
  const plan = travelPlanStore.get(picked.planId);
  if (!plan || plan.days.length === 0) return {};
  return {
    toolName: "travel.plan-itinerary",
    result: plan as unknown as Record<string, unknown>,
  };
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
  /**
   * 本轮搜索类媒体（search_images/search_images_batch/search_videos）是否有
   * 真实产出（extractMediaCards 组装出卡）。true 时 search_result 文字卡整卡
   * 让位——照片是主形态，文字列表冗余；false/缺省时搜索卡照常附（零图兜底）。
   * image.generate 生图不算搜索证据，不计入。
   */
  searchMediaHasItems?: boolean;
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
  text = attachSearchResultCardFromExecuted(text, input.searchResults ?? [], {
    yieldToSearchMedia: input.searchMediaHasItems === true,
  });
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
