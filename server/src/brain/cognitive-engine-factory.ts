// Agent Brain Center — 认知引擎工厂（可插拔大脑入口）
//
// 职责：把 CognitiveEngine 的具体实现从 bootstrap 装配代码中解耦，
// 通过环境变量 COGNITIVE_ENGINE_IMPL 配置驱动选择不同实现，
// 让"换大脑"（升级到更强 LLM / 切换到 AGI 世界模型）只需改环境变量，
// 无需改动 bootstrap 装配代码。
//
// 设计原则（与 BodyGateway / registerCognitiveEngine 一致）：
//   1. 默认实现保持与原 bootstrap 内联实现完全等价（向后兼容）
//   2. 工厂返回 CognitiveEngine 接口，调用方不感知具体实现
//   3. 新增实现只需在此文件追加 case，不改 bootstrap
//   4. 未识别的 COGNITIVE_ENGINE_IMPL 值 → 回退默认实现 + 警告日志
//
// 未来"换 AGI 大脑"路径：
//   - 新增 world-model-cognitive-engine.ts 实现 CognitiveEngine 接口
//   - 在工厂 case 中注册 "world-model"
//   - 设 COGNITIVE_ENGINE_IMPL=world-model 即可切换，bootstrap 零改动

import type { CognitiveEngine, CognitiveInput, CognitiveContext } from "./types.js";
import { createExternalChatProviderFromEnv } from "../external-model/index.js";

/**
 * 默认认知引擎实现：基于 OpenAI 兼容协议的路由决策器。
 *
 * 行为与原 create-app-services.ts 内联实现完全等价：
 *   - 单次 LLM 调用判断路由（complex / fast）
 *   - cognize 失败 → 默认 fast（主 Agent 自处理，最安全兜底）
 *   - 不产出 response（统一走 streamCompletion 让主 Agent 生成回复）
 *
 * 从 bootstrap 抽出后，bootstrap 只需调 createCognitiveEngineFromEnv() 即可。
 */
export function createDefaultCognitiveEngine(): CognitiveEngine {
  return {
    async cognize(input: CognitiveInput, ctx: CognitiveContext) {
      const userText = input.text ?? ctx.audioText ?? "";
      // ── 极简 cognize：只判断「是否需要委派子 Agent」──
      const visualBrief = ctx.visualDescription
        ? ctx.visualDescription.slice(0, 200)
        : "";
      const prompt =
        `你是路由决策器。只判断一件事：用户消息是否需要委派子 Agent 处理。\n\n` +
        `用户消息：${userText}${visualBrief ? `\n视觉：${visualBrief}` : ""}\n\n` +
        `判断规则（只选一个 mode）：\n` +
        `  complex=需要委派子 Agent 的场景（满足任一即选）：\n` +
        `    - 深度调研/比价/对比/评测/推荐（需要多步搜索整合）\n` +
        `    - 写代码/调试/部署/自动化脚本/运维\n` +
        `    - 截屏/操作电脑/桌面自动化/批量处理/RPA\n` +
        `    - 转账/消费/充值/订票下单（生活服务类）\n` +
        `    - 撰写文案/创作/策划/长文生成\n` +
        `    - 复杂多步任务需要规划\n` +
        `  fast=其他所有场景（寒暄/知识问答/查天气/查日历/查时间/简单工具调用）\n` +
        `    主 Agent 自己有工具调用能力（天气/日历/时钟/search_web 等），无需委派。\n\n` +
        `⚠️ 关键原则：宁可误判为 fast（主 Agent 自己能处理），不要漏判。\n` +
        `  只有明确属于上述 complex 场景时才委派。\n` +
        `  查天气、查时间、查日历、简单问答 → fast（主 Agent 自带工具）\n\n` +
        `只输出 JSON：{"mode": "fast", "rationale": "..."}`;
      let raw = "";
      const now = new Date().toISOString();
      try {
        const provider = createExternalChatProviderFromEnv();
        if (!provider) throw new Error("no_chat_provider");
        await provider.streamCompletion(
          `cognize:${input.actorId}:${Date.now()}`,
          { text: prompt },
          (delta) => { raw += delta; },
          undefined,
          { ephemeralTurn: true, disableThinking: true, maxThreadMessages: 0 },
        );
      } catch (e) {
        const route = { userMessage: userText, system: "system1" as const, mode: "fast" as const, rationale: `cognize_llm_failed:${String(e).slice(0, 60)}`, decidedAt: now };
        return { route, response: "", memoryWrites: [], needsToolLoop: true, rationale: route.rationale };
      }
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) {
        const route = { userMessage: userText, system: "system1" as const, mode: "fast" as const, rationale: "no_json", decidedAt: now };
        return { route, response: "", memoryWrites: [], needsToolLoop: true, rationale: "no_json" };
      }
      try {
        const parsed = JSON.parse(match[0]);
        const mode = parsed.mode === "complex" ? "complex" : "fast";
        const system = mode === "complex" ? "system2" : "system1";
        const route = {
          userMessage: userText,
          system: system as "system1" | "system2",
          mode: mode as "fast" | "complex",
          rationale: typeof parsed.rationale === "string" ? parsed.rationale : "",
          decidedAt: now,
        };
        return {
          route,
          response: "",
          memoryWrites: [],
          needsToolLoop: true,
          rationale: route.rationale,
        };
      } catch {
        const route = { userMessage: userText, system: "system1" as const, mode: "fast" as const, rationale: "parse_failed", decidedAt: now };
        return { route, response: "", memoryWrites: [], needsToolLoop: true, rationale: "parse_failed" };
      }
    },
  };
}

/**
 * 认知引擎注册表：COGNITIVE_ENGINE_IMPL 值 → 工厂函数。
 *
 * 新增实现时在此追加一行即可。默认实现已注册为 "default"。
 *
 * 未来"换 AGI 大脑"示例：
 *   COGNITIVE_ENGINE_IMPL=world-model → 注册 createWorldModelCognitiveEngine()
 *   COGNITIVE_ENGINE_IMPL=anthropic   → 注册 createAnthropicCognitiveEngine()
 */
const COGNITIVE_ENGINE_REGISTRY: Record<string, () => CognitiveEngine> = {
  default: createDefaultCognitiveEngine,
  openai: createDefaultCognitiveEngine, // 别名：OpenAI 兼容协议
};

/**
 * 注册自定义认知引擎实现（供外部项目扩展）。
 *
 * 调用时机：在 bootstrap 调 createCognitiveEngineFromEnv() 之前注册。
 * 示例：外部 AGI 项目 import { registerCognitiveEngine } from "..." 后注册自己的实现。
 */
export function registerCognitiveEngineImpl(name: string, factory: () => CognitiveEngine): void {
  COGNITIVE_ENGINE_REGISTRY[name] = factory;
}

/**
 * 根据环境变量 COGNITIVE_ENGINE_IMPL 创建认知引擎实例。
 *
 * - 未设置 / "default" / "openai" → 默认 OpenAI 兼容实现
 * - 其他已注册值 → 对应实现
 * - 未识别值 → 回退默认实现 + 警告日志（fail-safe，不让 typo 阻断启动）
 *
 * bootstrap 装配处只需：
 *   const cognitiveEngine = createCognitiveEngineFromEnv();
 *   brainCenter.registerCognitiveEngine(cognitiveEngine);
 */
export function createCognitiveEngineFromEnv(): CognitiveEngine {
  const implName = (process.env.COGNITIVE_ENGINE_IMPL ?? "default").trim().toLowerCase();
  const factory = COGNITIVE_ENGINE_REGISTRY[implName];
  if (factory) {
    if (implName !== "default" && implName !== "openai") {
      console.log(`[CognitiveEngineFactory] 使用自定义认知引擎实现: ${implName}`);
    }
    return factory();
  }
  console.warn(`[CognitiveEngineFactory] 未识别的 COGNITIVE_ENGINE_IMPL="${implName}"，回退默认实现`);
  return createDefaultCognitiveEngine();
}
