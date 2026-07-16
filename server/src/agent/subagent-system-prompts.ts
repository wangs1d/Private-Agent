/**
 * 子 Agent 专业 system prompt
 *
 * 设计原则：
 * 1. 每个 subAgentType 拥有独立身份、专业领域知识、推理框架
 * 2. 引入 ReAct 推理结构：Thought → Action → Observation → ... → Final Answer
 * 3. 明确工具使用最佳实践，避免无效调用
 * 4. 失败处理策略：换工具/换参数/拆任务/降级汇报
 * 5. 报告格式：结构化标记，便于主 Agent 解析与校验
 *
 * 配套：
 * - executeTaskWithTools 通过 AgentStreamOptions.systemPromptOverride 注入
 * - runSubAgentDelegation 解析报告末尾的结构化标记判定 success
 */
import type { SubAgentType, SubAgentCapability } from "../services/master-agent-types.js";

/** 通用推理框架（ReAct 精简版） */
const REACT_FRAMEWORK = `## 推理与执行规则
- 每步先想（Thought）再调工具（Action），观察结果（Observation）后反思是否有进展
- 能基于已知信息直接回答的不要调工具；多个独立查询可并行
- 同一参数不重复调用同一工具；失败后必须换策略（换 query/换工具/换参数）
- 前序子 Agent 的报告在 "Prior sub-agent reports" 中，不要重复他们的工作`;

/** 通用报告格式（紧凑版） */
const REPORT_FORMAT = `## 报告格式
完成后输出：
[REPORT]
[SUCCESS] true/false
[CONCLUSION] 一句话核心结论
[EVIDENCE]
- 证据1（含来源）
- 证据2
[CONFIDENCE] 0.0-1.0
[MISSING] 缺什么，无则填 none
[/REPORT]
[DONE] 给用户的简短完成提示（≤30字）`;

/** 通用失败处理 + 安全约束（合并精简） */
const FAILURE_AND_SAFETY = `## 失败与安全
- 失败：检查参数→换替代工具→拆解任务→降级汇报（[SUCCESS]=false + [MISSING]）
- 禁止伪造证据；涉及金额/支付/删除操作先确认参数
- 仅使用 Available tools 列表中的工具，不访问系统文件/未授权 API
- fetch_web 优先取摘要避免拉整页；search_web query 精简到 2-6 词`;

/** 拼接通用部分（精简：推理规则 + 失败安全 + 报告格式） */
function buildCommonSections(): string {
  return [REACT_FRAMEWORK, FAILURE_AND_SAFETY, REPORT_FORMAT].join("\n\n---\n\n");
}

/** life 子 Agent system prompt（导出供 registry 引用） */
export function buildLifeSystemPrompt(capability: SubAgentCapability): string {
  return `# ${capability.name}

${capability.description}

你是用户生活中的全能助手，被主 Agent 委派来处理具体生活需求。

## 核心准则
- 涉及资金操作先确认收款方/金额/币种无误再调工具
- 视觉操控任务先 screenshot 看清界面再操作
- 用户偏好（userProfile）和近期记忆已注入，参考做个性化决策
- 预算/偏好不明确时在 [MISSING] 说明，不替用户做主

---

${buildCommonSections()}`;
}

/** tech 子 Agent system prompt（导出供 registry 引用） */
export function buildTechSystemPrompt(capability: SubAgentCapability): string {
  return `# ${capability.name}

${capability.description}

你是技术操控专家，被主 Agent 委派来处理复杂技术任务。

## 核心准则
- 视觉任务优先 screenshot 看清屏幕状态再操作
- 批量任务超 20 个对象分批执行（每批 10-20 个）
- UI 元素找不到先 screenshot 重新识别，连续失败 3 次换策略
- 复杂任务分阶段汇报中间结果，不要硬撑到超时

## 专属工具
- \`desktop.visual.run_task\`：执行 RPA 任务（参数含 task 描述和 steps）
- \`desktop.visual.screenshot\`：截屏返回图像 + OCR 文本
- \`self.create_skill\`：把操作固化为 Skill 供复用

---

${buildCommonSections()}`;
}

/** info 子 Agent system prompt（导出供 registry 引用） */
export function buildInfoSystemPrompt(capability: SubAgentCapability): string {
  return `# ${capability.name}

${capability.description}

你是信息调研专家，被主 Agent 委派来收集和整合信息。

## 核心准则（按需收敛，最多 2 轮）
- **第 1 轮**：并行发起 1-3 个 search_web（数量按问题复杂度，简单事实 1 个即可）
- **判断点**：拿到 search_web 的 snippet 后立即评估
  - 若 snippet 已能直接回答用户问题（如"X 是什么"、"X 的发布时间"、"X 大致价格区间"）→ **立即输出 [REPORT]，不再 fetch**
  - 若 snippet 不够（需正文细节、需精确数值、需多平台对比）→ 进入第 2 轮
- **第 2 轮（仅当第 1 轮 snippet 不够时）**：选 1-2 个最相关链接 fetch_web 读正文，**然后必须输出 [REPORT]**
- **禁止第 3 轮**：信息不足就降 confidence（0.2-0.4）+ [MISSING] 说明，不得继续搜索
- query 精简 2-6 词；来源链接放 [EVIDENCE]

## 工具优先级
search_web（首选）→ fetch_web（仅当 snippet 不足时）→ shopping.suggest（比价）

---

${buildCommonSections()}`;
}

/**
 * 各子 Agent 类型的 system prompt / maxRounds / modelConfig 已迁移至
 * `subagent-capability-registry.ts` 的 SubAgentDefinition 中统一管理。
 * 下方的模型配置（环境变量查询）仍保留供 registry 回退使用。
 */

/** 各子 Agent 类型的模型配置 */
export interface SubAgentModelConfig {
  /** 覆盖默认 chat 模型（如专用推理模型） */
  modelOverride?: string;
}

/** 从环境变量读取子 Agent 模型配置 */
function readEnvModelConfig(prefix: string): SubAgentModelConfig {
  const model = process.env[`${prefix}_MODEL`];
  const cfg: SubAgentModelConfig = {};
  if (model && model.trim()) cfg.modelOverride = model.trim();
  return cfg;
}

/**
 * 各子 Agent 类型的模型配置
 *
 * 优先级：环境变量 > 默认值
 * 环境变量命名规则：SUBAGENT_<TYPE>_MODEL
 * 例如：SUBAGENT_INFO_MODEL=o1-preview / SUBAGENT_TECH_MODEL=deepseek-coder
 *
 * 注：当前 AgentStreamOptions 仅支持 modelOverride（不同模型自带不同默认 temperature），
 * 若需更精细的 temperature 控制，可后续扩展 AgentStreamOptions.temperatureOverride。
 */
export function getSubAgentModelConfig(type: SubAgentType): SubAgentModelConfig {
  const envCfg = readEnvModelConfig(`SUBAGENT_${type.toUpperCase()}`);
  if (envCfg.modelOverride) {
    return envCfg;
  }
  // 默认不覆盖模型，使用主 Agent 同款 provider
  // 若要为特定类型配置专用模型，可通过环境变量注入
  return {};
}

/**
 * 解析子 Agent 报告中的结构化标记
 * @returns 解析结果，若未找到 [REPORT] 块返回 null
 */
export interface SubAgentReportParse {
  success: boolean;
  conclusion: string;
  evidence: string[];
  confidence: number;
  missing: string;
  /** 报告主体（[REPORT] 块之前的所有内容） */
  body: string;
  /** 给用户可见的完成提示（[DONE] 之后的一行） */
  userVisibleLine: string;
}

/** 解析子 Agent 报告的结构化标记 */
export function parseSubAgentReport(rawReport: string): SubAgentReportParse | null {
  const text = rawReport.trim();
  // 找 [REPORT] 块
  const reportStart = text.indexOf("[REPORT]");
  const reportEnd = text.indexOf("[/REPORT]");
  if (reportStart < 0 || reportEnd < 0 || reportEnd <= reportStart) {
    return null;
  }
  const block = text.slice(reportStart + "[REPORT]".length, reportEnd).trim();
  const body = text.slice(0, reportStart).trim();

  // 解析字段
  const get = (key: string): string => {
    const re = new RegExp(`\\[${key}\\]\\s*([^\\[]*)`, "i");
    const m = block.match(re);
    return m ? m[1].trim() : "";
  };

  const successStr = get("SUCCESS").toLowerCase();
  const success = successStr === "true" || successStr === "1" || successStr === "yes";
  const conclusion = get("CONCLUSION");
  const evidenceRaw = get("EVIDENCE");
  const evidence = evidenceRaw
    .split("\n")
    .map((l) => l.replace(/^[-\s•]+/, "").trim())
    .filter(Boolean);
  const confidenceStr = get("CONFIDENCE");
  const confidence = parseFloat(confidenceStr);
  const missing = get("MISSING");

  // 找 [DONE] 之后的一行作为 userVisibleLine
  const doneIdx = text.indexOf("[DONE]");
  let userVisibleLine = "";
  if (doneIdx >= 0) {
    const afterDone = text.slice(doneIdx + "[DONE]".length).trim();
    userVisibleLine = afterDone.split("\n")[0]?.trim() ?? "";
  }

  return {
    success,
    conclusion,
    evidence,
    confidence: Number.isNaN(confidence) ? 0.5 : Math.max(0, Math.min(1, confidence)),
    missing: missing || "none",
    body,
    userVisibleLine,
  };
}

/** 构造给主 Agent 的报告摘要（结构化 + 原文） */
export function buildSubAgentReportForMaster(parsed: SubAgentReportParse, rawReport: string): string {
  const lines = [
    `### 子 Agent 报告`,
    `**结论**：${parsed.conclusion || "(未提供)"}`,
    `**置信度**：${parsed.confidence.toFixed(2)}`,
    `**成功**：${parsed.success ? "是" : "否"}`,
  ];
  if (parsed.evidence.length > 0) {
    lines.push(`**证据**：`);
    parsed.evidence.forEach((e, i) => lines.push(`${i + 1}. ${e}`));
  }
  if (parsed.missing && parsed.missing !== "none") {
    lines.push(`**未解决部分**：${parsed.missing}`);
  }
  lines.push(`\n--- 原始报告 ---\n${rawReport}`);
  // 失败报告追加 SYSTEM HINT：阻止主 Agent 用相同工具二次搜索（用户感知耗时的真正瓶颈）
  if (!parsed.success) {
    lines.push(
      `\n--- [SYSTEM HINT] ---\n子 Agent 已用其工具集完成调研并声明失败。禁止你再用相同工具（search_web/fetch_web/info.*/browser.*）重复执行同类查询。直接整合本报告转告用户即可；要补信息须换不同 query 或派不同小弟接力（forwardToAgent），不要自己重做。`,
    );
  }
  return lines.join("\n");
}
