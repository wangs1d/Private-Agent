/**
 * FunAsrAdapter Node 端端到端测试：
 *   1. 读取 data/funasr_test_audio/case_*.wav
 *   2. 通过 FunAsrAdapter.transcribe() 调用
 *   3. 比对原文输出识别准确率
 *
 * 跑法（在 server 目录）：
 *   $env:FUNASR_BASE_URL="http://127.0.0.1:8001"
 *   npx tsx scripts/funasr_adapter_test.ts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { FunAsrAdapter } from "../src/services/voice-dialogue/adapters/funasr-asr-adapter.js";

interface Case {
  idx: number;
  text: string;
  label: string;
}

const CASES: Case[] = [
  { idx: 0, text: "你好，今天天气怎么样", label: "短句-日常问候" },
  { idx: 1, text: "我要预约明天下午三点的会议室", label: "中句-日程预约" },
  { idx: 2, text: "帮我搜索一下北京到上海的高铁票，明天早上的车次", label: "长句-复杂查询" },
  { idx: 3, text: "1加2等于3，10乘以20等于200", label: "数字识别" },
  { idx: 4, text: "I love programming in TypeScript and Python", label: "中英混合" },
];

async function main() {
  const adapter = new FunAsrAdapter();
  if (!adapter.isEnabled()) {
    console.error("[ERR] FunAsrAdapter 未启用，请设置 FUNASR_BASE_URL");
    process.exit(1);
  }
  console.log(`[Info] FunAsrAdapter 已启用，name=${adapter.name}`);
  console.log("========== Node FunAsrAdapter 测试 ==========\n");

  // 优先从 server 上级目录找音频（gen_test_audio.py 写到项目根的 data/）
  const candidates = [
    resolve(process.cwd(), "data/funasr_test_audio"),
    resolve(process.cwd(), "../data/funasr_test_audio"),
  ];
  const audioDir = candidates.find((p) => {
    try {
      return readFileSync(resolve(p, "case_0.wav")).length > 0;
    } catch {
      return false;
    }
  });
  if (!audioDir) {
    console.error(`[ERR] 找不到测试音频，已尝试：\n${candidates.join("\n")}`);
    process.exit(1);
  }
  console.log(`[Info] 音频目录：${audioDir}`);
  let passCount = 0;
  let totalCount = 0;

  for (const c of CASES) {
    const wavPath = resolve(audioDir, `case_${c.idx}.wav`);
    let buf: Buffer;
    try {
      buf = readFileSync(wavPath);
    } catch (e) {
      console.log(`[${c.label}] 跳过：文件不存在 ${wavPath}`);
      continue;
    }
    const t0 = Date.now();
    const result = await adapter.transcribe(
      { data: buf, format: "wav" },
      { language: "zh", enablePunctuation: true },
    );
    const elapsed = Date.now() - t0;
    totalCount++;

    const recognized = result.text ?? "";
    // 简单字符级准确率（去掉标点后比较）
    const normOriginal = c.text.replace(/[，。？！、；：""''（）《》【】\s]/g, "");
    const normRecognized = recognized.replace(/[，。？！、；：""''（）《》【】\s]/g, "");
    const match = normOriginal === normRecognized;
    if (match) passCount++;
    console.log(`[${c.label}]`);
    console.log(`  原文：${c.text}`);
    console.log(`  识别：${recognized}`);
    console.log(`  耗时：${elapsed}ms | confidence=${result.confidence} | ${match ? "✅ PASS" : "⚠️ DIFF"}`);
    console.log();
  }

  console.log(`========== 结果：${passCount}/${totalCount} 完全匹配 ==========`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
