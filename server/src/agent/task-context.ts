import { requiresTaskDecomposition, shouldSkipNarrativeRecall } from "./simple-task.js";

export type TaskContextProfile = {
  complexity: "direct" | "multi_step";
  needsNarrativeRecall: boolean;
  likelyNeedsFreshFacts: boolean;
  likelyPersistsState: boolean;
  likelyCodeOrProjectWork: boolean;
};

const FRESH_FACT_RE =
  /latest|recent|today|tomorrow|yesterday|current|now|news|price|weather|schedule|score|version|release|202[0-9]|最新|最近|今天|明天|昨天|现在|当前|新闻|价格|天气|日程|赛程|版本|发布|查一下|搜索|联网|浏览/i;

const PERSISTENT_ACTION_RE =
  /remind|schedule|calendar|book|buy|send|call|delete|update|create|save|commit|push|deploy|提醒|日程|预约|购买|发送|拨打|删除|更新|创建|保存|提交|推送|部署/i;

const CODE_OR_PROJECT_RE =
  /code|repo|project|file|bug|test|build|lint|typescript|javascript|flutter|server|client|代码|项目|文件|报错|测试|构建|类型|前端|后端|优化|修复|实现/i;

export function buildTaskContextProfile(message: string): TaskContextProfile {
  const t = message.trim();
  return {
    complexity: requiresTaskDecomposition(t) ? "multi_step" : "direct",
    needsNarrativeRecall: !shouldSkipNarrativeRecall(t),
    likelyNeedsFreshFacts: FRESH_FACT_RE.test(t),
    likelyPersistsState: PERSISTENT_ACTION_RE.test(t),
    likelyCodeOrProjectWork: CODE_OR_PROJECT_RE.test(t),
  };
}

export function buildTaskContextPrompt(message: string, now: Date = new Date()): string {
  const profile = buildTaskContextProfile(message);
  const flags = [
    `complexity=${profile.complexity}`,
    `needsNarrativeRecall=${profile.needsNarrativeRecall}`,
    `likelyNeedsFreshFacts=${profile.likelyNeedsFreshFacts}`,
    `likelyPersistsState=${profile.likelyPersistsState}`,
    `likelyCodeOrProjectWork=${profile.likelyCodeOrProjectWork}`,
  ].join(", ");

  const needsDetailedPolicy =
    profile.complexity === "multi_step" ||
    profile.needsNarrativeRecall ||
    profile.likelyNeedsFreshFacts ||
    profile.likelyPersistsState ||
    profile.likelyCodeOrProjectWork;

  if (!needsDetailedPolicy) {
    return [
      `Runtime timestamp: ${now.toISOString()}. Interpret relative dates from this timestamp; use clock tools when the user asks for exact current time/date/location.`,
      `Task profile: ${flags}.`,
      "Operating policy: answer directly when the request is simple and no tool or persistent action is needed.",
    ].join("\n");
  }

  return [
    `Runtime timestamp: ${now.toISOString()}. Interpret relative dates from this timestamp; use clock tools when the user asks for exact current time/date/location.`,
    `Task profile: ${flags}.`,
    "Operating policy:",
    "- If facts may be stale, local-state-dependent, or user-specific, use the available tool before giving a confident answer.",
    "- If the task changes persistent state or performs an external action, verify required fields and report the resulting id/status when available.",
    "- If this is code/project work, inspect the relevant project context before deciding on an implementation.",
    "- Before the final answer, check whether the user's actual request is satisfied; name any blocker or uncertainty plainly.",
  ].join("\n");
}
