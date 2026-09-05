/**
 * 真实 LLM 冒烟：统一抽取器对口语承诺的识别质量（P0-2 配套验证）。
 *
 * 用法（server 目录下）：
 *   node --env-file=.env --import tsx scripts/smoke-commitment-extract.ts
 *
 * 通道：默认走生产路径（OPENAI_* / OPENAI_BASE_URL）；不可达或未配置时，
 * 若设置了 SILICONFLOW_API_KEY 则自动回退到 SiliconFlow（国内可达，OpenAI
 * 兼容协议，经 injectable client 注入——生产代码零改动）。模型可用
 * SMOKE_MODEL 覆盖（缺省 deepseek-ai/DeepSeek-V4-Flash）。
 *
 * 覆盖：4 字超短句 / 显式承诺动词 / 口语无期限 / 第三方报告 / 负对照。
 * 只输出抽取 JSON，不打印任何密钥。
 */

import OpenAI from "openai";

import { extractUnified } from "../src/agentic-memory/unified-extractor.js";
import { getAgenticMemoryLlmModel, resolveOpenAiApiKey } from "../src/agentic-memory/env.js";
import type { UnifiedLlmClient } from "../src/agentic-memory/unified-extractor.js";

const CASES: Array<{ label: string; text: string; expect: "承诺" | "无" }> = [
  { label: "4字超短句", text: "明天发你", expect: "承诺" },
  { label: "显式承诺+周几", text: "我答应周五之前把报价发给客户", expect: "承诺" },
  { label: "口语无期限", text: "我回头把报告发你", expect: "承诺" },
  { label: "第三方报告", text: "老板说下周三前交付", expect: "承诺" },
  { label: "负对照", text: "今天天气不错", expect: "无" },
];

function siliconflowClient(): UnifiedLlmClient | null {
  const key = process.env.SILICONFLOW_API_KEY?.trim();
  if (!key) return null;
  return new OpenAI({
    apiKey: key,
    baseURL: process.env.SMOKE_BASE_URL?.trim() || "https://api.siliconflow.cn/v1",
    timeout: 60_000,
  }) as unknown as UnifiedLlmClient;
}

async function main(): Promise<void> {
  const key = resolveOpenAiApiKey();
  const sf = siliconflowClient();
  if (!key && !sf) {
    console.error("未解析到可用 API key（OPENAI_API_KEY / SILICONFLOW_API_KEY），无法冒烟。");
    process.exit(1);
  }
  const channel = sf ? `SiliconFlow(${process.env.SMOKE_MODEL ?? "deepseek-ai/DeepSeek-V4-Flash"})` : `生产通道(${getAgenticMemoryLlmModel()})`;
  console.log(`通道: ${channel}  生产key: ${key ? `***${key.slice(-4)}` : "无"}\n`);

  let hit = 0;
  let useProduction = Boolean(key); // 生产通道失败一次后不再逐用例重试（超时 33s 太慢）
  for (const c of CASES) {
    const t0 = Date.now();
    let u: Awaited<ReturnType<typeof extractUnified>> = null;
    let via = "production";
    if (useProduction) {
      u = await extractUnified(c.text);
      if (!u) useProduction = false;
    }
    if (!u && sf) {
      via = "siliconflow";
      u = await extractUnified(c.text, {
        client: sf,
        model: process.env.SMOKE_MODEL ?? "deepseek-ai/DeepSeek-V4-Flash",
      });
    }
    const ms = Date.now() - t0;
    const commitments = u?.commitments ?? [];
    const ok =
      (c.expect === "承诺" && commitments.length > 0) ||
      (c.expect === "无" && commitments.length === 0);
    if (ok) hit += 1;
    console.log(
      `[${ok ? "PASS" : "MISS"}] ${c.label}：「${c.text}」 (${ms}ms, via=${via}, decision=${u?.decision})`,
    );
    for (const cm of commitments) {
      console.log(
        `        → [${cm.committedBy}] ${cm.text} | deadline=${cm.deadline} | conf=${cm.confidence} | category=${cm.category ?? "-"} | evidence=${cm.evidence}`,
      );
    }
    if (commitments.length === 0) console.log(`        → （无承诺产出）`);
  }
  console.log(`\n结果：${hit}/${CASES.length} 符合预期`);
  process.exit(hit === CASES.length ? 0 : 2);
}

main().catch((err) => {
  console.error("冒烟失败:", err instanceof Error ? err.message : err);
  process.exit(1);
});
