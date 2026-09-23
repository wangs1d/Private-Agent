import type { ChatCompletionTool } from "openai/resources/chat/completions";

import type { SensorKernel } from "../proactivity/sensors/kernel.js";
import type { ToolRegistry } from "./tool-registry.js";

/**
 * perception.overview —— 持续感知的回溯查询出口（2026-09-19 P0-1 遥测留存）。
 *
 * 背景：SensorKernel 的信号环形日志（signals.jsonl + 内存 recentLog）此前只有
 * 诊断面板消费；「我刚才在干嘛/最近电脑上发生了什么」这类问题模型答不了——
 * 感知在跑、数据在落盘，但没有一条通到对话面的路。本工具补上这最后一跳：
 * 结构化快照（健康 + 最近信号），零 LLM 直答数据源。
 *
 * 隐私边界：只回传感层的 delta 摘要与分类（file/clipboard/screen 传感器本身
 * 就不落内容原文），不做全文检索。
 */

export const PERCEPTION_OVERVIEW_TOOL_DEFINITION: ChatCompletionTool = {
  type: "function",
  function: {
    name: "perception.overview",
    description:
      "查询持续感知的最近信号与传感器健康：用户最近在电脑上做什么（前台应用切换）、" +
      "复制了什么（剪贴板摘要）、落了什么文件。回答「我刚才在干嘛/你看到什么了」" +
      "时调用。只读，零副作用。",
    parameters: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          description: "返回最近多少条信号（缺省 15，上限 50）",
        },
        stream: {
          type: "string",
          description: "可选按信号流过滤：screen / file / clipboard / presence / schedule …",
        },
      },
    },
  },
};

export type PerceptionOverviewDeps = {
  kernel: SensorKernel;
  /** 最近屏幕专注分类（screen-sensor.latest()；缺省不展示） */
  screenFocus?: () => string | null;
};

export function registerPerceptionOverviewTool(
  registry: ToolRegistry,
  deps: PerceptionOverviewDeps,
): void {
  registry.register("perception.overview", async (input) => {
    const limitRaw = Number(input.limit);
    const limit = Math.min(50, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 15));
    const streamFilter = typeof input.stream === "string" ? input.stream.trim() : "";
    const all = deps.kernel.recentLog(120);
    const filtered = streamFilter
      ? all.filter((s) => s.stream === streamFilter)
      : all;
    const signals = filtered.slice(-limit).map((s) => ({
      at: new Date(s.at).toISOString(),
      stream: s.stream,
      salience: s.salience,
      ...(s.delta ? { delta: s.delta } : {}),
    }));
    const health = deps.kernel.health();
    return {
      ok: true,
      screenFocus: deps.screenFocus?.() ?? undefined,
      sensorCount: health.length,
      healthyCount: health.filter((h) => !h.tripped).length,
      trippedSensors: health.filter((h) => h.tripped).map((h) => h.sensorId),
      signals,
      summary:
        signals.length > 0
          ? `最近 ${signals.length} 条感知信号：${signals
              .slice(-5)
              .map((s) => s.delta ?? s.stream)
              .join("；")}`
          : "最近没有产出感知信号（传感器可能未启动或无变化）",
    };
  });
}
