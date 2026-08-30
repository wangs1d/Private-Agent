/**
 * 行程结构化数据桥（单例）
 *
 * travel.plan-itinerary 执行成功后将结构化行程（按天拆分、保留坐标/价格/地址等
 * 关键字段）写入本模块；agent-result-formatter 在产出 travel_itinerary 卡时读取并
 * 注入卡片 JSON 的 travelPlan 字段。
 *
 * 前端双面板（travel_plan_panel.dart）优先直读 travelPlan 渲染，无结构化数据时
 * 才回退到从卡片 items 文本正则解析 —— 让双面板从「文本解析」升级为「结构化直读」。
 *
 * 并发安全：内部按「目的地」键控保留最近 8 份快照。两个不同目的地的规划并发时，
 * formatter 通过 findForText 按卡片文本中的目的地名匹配对应快照，
 * 修复了旧版「只留一份、后写覆盖先写」导致的串卡问题。
 */
export interface TravelItinerarySnapshot {
  /** 产生该行程的工具名（用于匹配 travel_itinerary 卡） */
  toolName: string;
  /** 写入时间戳（毫秒） */
  ts: number;
  destination: string;
  title: string;
  startDate: string;
  endDate: string;
  days: Array<{
    date: string;
    items: Array<{
      type: string;
      name: string;
      startTime: string;
      latitude: number;
      longitude: number;
      address: string;
      priceInfo: string;
      description: string;
      tips?: string[];
      images?: string[];
      /** 本地评论（媒体库，最新优先，前端行程面板直读） */
      reviews?: unknown[];
      /** 相关视频元数据（播放页跳转，不自托管） */
      videos?: Array<Record<string, unknown>>;
    }>;
  }>;
}

const MAX_RECENT = 8;
/** 快照有效窗口（与 formatter 的旧时效检查一致）：过旧不注入，防旧行程串卡 */
const FRESH_MS = 2 * 60 * 1000;

class TravelItineraryStore {
  private last: TravelItinerarySnapshot | null = null;
  /** 最近快照，按目的地去重、新在前 */
  private recent: TravelItinerarySnapshot[] = [];

  set(snapshot: TravelItinerarySnapshot): void {
    this.last = snapshot;
    this.recent = [
      snapshot,
      ...this.recent.filter((s) => s.destination !== snapshot.destination),
    ].slice(0, MAX_RECENT);
  }

  /** 最新一份快照（兼容旧调用方） */
  get(): TravelItinerarySnapshot | null {
    return this.last;
  }

  /**
   * 按卡片文本挑选匹配快照：
   * 1. 优先取「目的地名出现在文本中且未过期」的快照（并发规划时按目的地区分）；
   * 2. 兜底返回最新快照（仍受 2 分钟时效约束）。
   */
  findForText(text: string, freshnessMs: number = FRESH_MS): TravelItinerarySnapshot | null {
    const now = Date.now();
    if (text) {
      for (const s of this.recent) {
        if (s.destination && now - s.ts < freshnessMs && text.includes(s.destination)) {
          return s;
        }
      }
    }
    return this.last && now - this.last.ts < freshnessMs ? this.last : null;
  }

  clear(): void {
    this.last = null;
    this.recent = [];
  }
}

export const travelItineraryStore = new TravelItineraryStore();
