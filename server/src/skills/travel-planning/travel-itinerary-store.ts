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
 * 只保留最近一次结果：卡片生成紧跟在工具执行之后，时序天然匹配。
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
    }>;
  }>;
}

class TravelItineraryStore {
  private last: TravelItinerarySnapshot | null = null;

  set(snapshot: TravelItinerarySnapshot): void {
    this.last = snapshot;
  }

  get(): TravelItinerarySnapshot | null {
    return this.last;
  }

  clear(): void {
    this.last = null;
  }
}

export const travelItineraryStore = new TravelItineraryStore();