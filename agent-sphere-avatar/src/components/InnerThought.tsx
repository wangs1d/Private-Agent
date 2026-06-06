import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentMood, AgentState } from "../types/agent";
import { LOCAL_GENERATOR, type DynamicSpeechContext } from "../hooks/useDynamicSpeech";

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

/**
 * 桌宠内心独白气泡
 *
 * 设计原则：完全不用固定语句。
 * - 真实对话 / 拖动反馈 / LLM 反应都通过 state.caption 传进来 — 直接显示。
 * - 没有 caption 时（无对话、无拖动）— 用 useDynamicSpeech 的本地词库 + 长闲上下文
 *   实时拼一句"短想法"，每次都不同，不存在写死的句子。
 */
export function InnerThought({ state }: InnerThoughtProps) {
  const { mood, phase, subAgentDisplayName, caption, source } = state;
  const [ambientText, setAmbientText] = useState<string | null>(null);
  const ambientSeedRef = useRef(0);
  const lastAmbientAtRef = useRef(0);
  const idleSinceRef = useRef<number>(performance.now());

  // 当有真实 caption（来自拖动 / 旋转 / LLM 实时反应）时优先显示
  const showCaption = !!caption;

  // 检测"长时间无交互" — 用作环境独白的触发
  useEffect(() => {
    if (showCaption || mood === "speaking" || mood === "listening" || mood === "thinking") {
      idleSinceRef.current = performance.now();
      return;
    }
    const tick = () => {
      const idleMs = performance.now() - idleSinceRef.current;
      // 至少 8s 才开始说"环境独白"；30s 之内不要再换
      if (idleMs > 8000 && performance.now() - lastAmbientAtRef.current > 30000) {
        ambientSeedRef.current += 1;
        const ctx: DynamicSpeechContext = {
          trigger: "long_idle",
          intensity: Math.min(0.5, idleMs / 60000),
          totalMagnitude: ambientSeedRef.current,
          silenceMs: idleMs,
          hour: new Date().getHours(),
          mood,
        };
        setAmbientText(LOCAL_GENERATOR.generate(ctx));
        lastAmbientAtRef.current = performance.now();
      }
    };
    const id = window.setInterval(tick, 1500);
    return () => window.clearInterval(id);
  }, [mood, showCaption]);

  // 如果新出现 caption，环境独白先让位
  useEffect(() => {
    if (showCaption) setAmbientText(null);
  }, [showCaption]);

  // 计算最终显示文本
  const displayText = useMemo(() => {
    if (caption) return caption;
    if (ambientText) return ambientText;
    return null;
  }, [caption, ambientText]);

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
