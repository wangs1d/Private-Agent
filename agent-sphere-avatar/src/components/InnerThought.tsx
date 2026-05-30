import type { AgentMood, AgentState } from "../types/agent";

const MOOD_LABEL: Record<AgentMood, string> = {
  idle: "待机",
  listening: "聆听中",
  thinking: "思考中",
  speaking: "表达中",
  happy: "愉悦",
  alert: "注意",
};

const MOOD_ICON: Record<AgentMood, string> = {
  idle: "◉",
  listening: "◈",
  thinking: "◇",
  speaking: "◉",
  happy: "✦",
  alert: "⚠",
};

interface InnerThoughtProps {
  state: AgentState;
}

export function InnerThought({ state }: InnerThoughtProps) {
  const { mood, caption, phase, subAgentDisplayName } = state;
  const hasContent = caption || phase || subAgentDisplayName;
  if (!hasContent && mood === "idle") return null;

  return (
    <div className={`inner-thought inner-thought--${mood}`}>
      <div className="inner-thought__mood">
        <span className="inner-thought__mood-icon">{MOOD_ICON[mood]}</span>
        <span className="inner-thought__mood-label">{MOOD_LABEL[mood]}</span>
      </div>

      {subAgentDisplayName ? (
        <div className="inner-thought__sub">
          <span className="inner-thought__sub-dot" />
          <span>{subAgentDisplayName}</span>
        </div>
      ) : null}

      {caption ? (
        <div className="inner-thought__caption">{caption}</div>
      ) : null}

      {phase && !caption ? (
        <div className="inner-thought__phase">{phase}</div>
      ) : null}
    </div>
  );
}
