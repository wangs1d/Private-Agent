import type { AgentMood, AgentState } from "../types/agent";

const MOOD_LABEL: Record<AgentMood, string> = {
  idle: "待机",
  listening: "聆听中",
  thinking: "思考中",
  happy: "愉悦",
  alert: "注意",
};

const MOOD_ICON: Record<AgentMood, string> = {
  idle: "◉",
  listening: "◈",
  thinking: "◇",
  happy: "✦",
  alert: "⚠",
};

interface InnerThoughtProps {
  state: AgentState;
}

/**
 * 桌宠内心独白气泡
 *
 * 设计原则：所有文本均来自主 Agent（caption / pet.reaction.ack），
 * 不使用任何本地词库或固定语句。
 * - 对话回复、LLM 即兴反应通过 state.caption 展示
 * - 行动链路状态通过 state.phase 展示
 * - 子 Agent 信息通过 state.subAgentDisplayName 展示
 */
export function InnerThought({ state }: InnerThoughtProps) {
  const { mood, phase, subAgentDisplayName, caption, source } = state;

  const displayText = caption || null;

  const hasContent = !!displayText || !!phase || !!subAgentDisplayName || mood !== "idle";
  if (!hasContent) return null;

  return (
    <div className={`inner-thought inner-thought--${mood}`}>
      <div className="inner-thought__mood">
        <span className="inner-thought__mood-icon">{MOOD_ICON[mood]}</span>
        <span className="inner-thought__mood-label">{MOOD_LABEL[mood]}</span>
      </div>

      {displayText ? (
        <div className="inner-thought__interaction">
          {displayText}
          {source === "pet_reaction" ? (
            <span className="inner-thought__source-tag">即兴</span>
          ) : null}
        </div>
      ) : null}

      {subAgentDisplayName ? (
        <div className="inner-thought__sub">
          <span className="inner-thought__sub-dot" />
          <span>{subAgentDisplayName}</span>
        </div>
      ) : null}

      {phase ? (
        <div className="inner-thought__phase">{phase}</div>
      ) : null}
    </div>
  );
}
