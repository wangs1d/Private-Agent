/**
 * 聊天推荐项服务（「为你推荐」的服务端数据源）。
 *
 * 设计约束：
 * - 每条推荐必须绑定真实能力：capabilityId 指向能力就绪注册表
 *   （capability-readiness-service）的条目 id；未就绪（needs_config/disabled）
 *   的能力不会进推荐。capabilityId 为 null 表示依赖内置工具，永远可用。
 * - 抽样在服务端做：核心组（core，无配置依赖）保证至少 CORE_MIN 条在场，
 *   其余位置从已就绪的可配置能力里随机补足，调用间天然轮换。
 * - experimental 从就绪注册表透传，客户端渲染「实验」徽标。
 */
import { listCapabilityStatuses } from "./capability-readiness-service.js";

export interface ChatSuggestion {
  id: string;
  /** 指向能力就绪注册表条目；null = 内置工具，永远就绪 */
  capabilityId: string | null;
  /** 能力标签（胶囊上的小字标，如「日程」「打车」） */
  tag: string;
  /** 示例任务文案（点击即作为用户消息发出） */
  prompt: string;
  experimental: boolean;
}

interface SuggestionPoolEntry {
  id: string;
  capabilityId: string | null;
  tag: string;
  prompt: string;
  /** 核心组：无配置依赖，抽样时保证至少 CORE_MIN 条在场 */
  core: boolean;
}

const CORE_MIN = 3;
const SAMPLE_MAX = 5;

const SUGGESTION_POOL: SuggestionPoolEntry[] = [
  // —— 核心组：无需配置，来自内置工具 / 必就绪能力 ——
  {
    id: "weather-today",
    capabilityId: null,
    tag: "天气",
    prompt: "看看今天天气怎么样，出门要不要带伞",
    core: true,
  },
  {
    id: "schedule-create",
    capabilityId: null,
    tag: "日程",
    prompt: "帮我记个日程，周六上午十点去牙医",
    core: true,
  },
  {
    id: "web-research",
    capabilityId: "web_search",
    tag: "搜索",
    prompt: "帮我查一下这周末有什么展，挑个值得去的",
    core: true,
  },
  {
    id: "shopping-compare",
    capabilityId: null,
    tag: "购物",
    prompt: "帮我比比价，选台性价比高的空气炸锅",
    core: true,
  },
  {
    id: "memory-save",
    capabilityId: "agentic_memory",
    tag: "记忆",
    prompt: "记住我喝咖啡不加糖，以后点单都按这个来",
    core: true,
  },
  {
    id: "morning-brief",
    capabilityId: "proactive",
    tag: "主动提醒",
    prompt: "每天早上八点给我一份早报",
    core: true,
  },
  // —— 就绪才展示：配置解锁后自动进池 ——
  {
    id: "travel-ticket",
    capabilityId: "travel_booking",
    tag: "订票",
    prompt: "下周五去上海，帮我比比高铁和机票的价格",
    core: false,
  },
  {
    id: "ride-book",
    capabilityId: "ride_hailing",
    tag: "打车",
    prompt: "帮我叫辆车，四十分钟后去机场，帮我盯着行程",
    core: false,
  },
  {
    id: "luckin-order",
    capabilityId: "luckin_coffee",
    tag: "点咖啡",
    prompt: "帮我点一杯冰美式，到店自取",
    core: false,
  },
  {
    id: "errand-run",
    capabilityId: "meituan_errand",
    tag: "跑腿",
    prompt: "帮我跑腿买束花送回家",
    core: false,
  },
  {
    id: "home-control",
    capabilityId: "home_assistant",
    tag: "家居",
    prompt: "把客厅灯调暗一点，十点半自动关",
    core: false,
  },
  {
    id: "image-gen",
    capabilityId: "image_gen",
    tag: "画图",
    prompt: "帮我画一张黑白极简风格的头像",
    core: false,
  },
];

function shuffle<T>(items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = out[i] as T;
    out[i] = out[j] as T;
    out[j] = tmp;
  }
  return out;
}

/** 全量推荐（HTTP /api/chat/suggestions 的数据源，纯内存计算，无 IO） */
export function getChatSuggestions(): { suggestions: ChatSuggestion[] } {
  const readyById = new Map(
    listCapabilityStatuses()
      .capabilities.filter((c) => c.state === "ready")
      .map((c) => [c.id, c]),
  );

  const eligible = SUGGESTION_POOL.filter(
    (e) => e.capabilityId === null || readyById.has(e.capabilityId),
  );

  // 随机优先，保底修复：样本里核心组不足 CORE_MIN 时，用未入样的核心条目
  // 替换尾部的非核心条目
  const picked = shuffle(eligible).slice(0, SAMPLE_MAX);
  let coreCount = picked.filter((e) => e.core).length;
  if (coreCount < CORE_MIN) {
    const inPicked = new Set(picked);
    const replacementCores = shuffle(
      eligible.filter((e) => e.core && !inPicked.has(e)),
    );
    for (let i = picked.length - 1; i >= 0 && coreCount < CORE_MIN; i -= 1) {
      const slot = picked[i];
      if (slot && !slot.core) {
        const replacement = replacementCores.shift();
        if (!replacement) break;
        picked[i] = replacement;
        coreCount += 1;
      }
    }
  }

  return {
    suggestions: picked.map((e) => ({
      id: e.id,
      capabilityId: e.capabilityId,
      tag: e.tag,
      prompt: e.prompt,
      experimental:
        e.capabilityId !== null
          ? (readyById.get(e.capabilityId)?.experimental ?? false)
          : false,
    })),
  };
}
