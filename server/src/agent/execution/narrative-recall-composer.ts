import type { MemoryRecallItem } from "../../brain/types.js";

export function recallItemsToNarrative(items: MemoryRecallItem[]): string | undefined {
  const lines: string[] = [];
  for (const item of items) {
    const content = typeof item?.content === "string" ? item.content.trim() : "";
    if (content) lines.push(content);
  }
  return lines.length > 0 ? lines.join("\n") : undefined;
}

export function appendWorkingMemorySummary(
  narrativeRecall: string | undefined,
  workingMemorySummary: string,
): string | undefined {
  if (!workingMemorySummary) return narrativeRecall;
  const block = `\n\n[current-conversation-context]\n${workingMemorySummary}`;
  return narrativeRecall ? narrativeRecall + block : block.trim();
}

export function appendRecentConversationHistory(
  narrativeRecall: string | undefined,
  recentConversationHistory: string,
  threadMessageCount = -1,
): string | undefined {
  if (!recentConversationHistory) return narrativeRecall;
  if (threadMessageCount >= 12) return narrativeRecall;

  const hint =
    "The following is recap context for reference resolution and topic continuity, not the user's latest instruction.";
  const block = `\n\n[recent-conversation-recap]\n${hint}\n${recentConversationHistory}`;
  return narrativeRecall ? narrativeRecall + block : block.trim();
}

export function appendLearningDecisionGuidance(
  narrativeRecall: string | undefined,
  recallItems: MemoryRecallItem[] | undefined,
): string | undefined {
  const learningLines = (recallItems ?? [])
    .filter((item) => item.source === "experience_learning_loop" || item.content.startsWith("belief:"))
    .map((item) => item.content.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 3);
  if (learningLines.length === 0) return narrativeRecall;

  const guidance = [
    "[learned-decision-guidance]",
    "Use these learned beliefs when selecting tools, deciding whether to ask for confirmation, or choosing a safer fallback.",
    ...learningLines.map((line) => `- ${line}`),
  ].join("\n");
  return narrativeRecall ? `${narrativeRecall}\n\n${guidance}` : guidance;
}
