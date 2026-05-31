import { useMemo } from "react";
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

const TEMPLATES: Record<AgentMood, string[]> = {
  idle: [
    "{timeGreeting}，{action}~",
    "嗯…{feeling}",
    "{action}，{suggestion}？",
    "{moodDesc}{punctuation}",
    "好{timeDesc}啊{punctuation}",
  ],
  listening: [
    "嗯嗯，{response}！",
    "{encourage}继续说~",
    "我在{action}呢{punctuation}",
    "{positive}！然后呢？",
    "说得{compliment}！",
  ],
  thinking: [
    "让我{action}…",
    "这个{difficulty}…",
    "正在{action}！",
    "嗯…{progress}{punctuation}",
    "{action}中…",
  ],
  speaking: [
    "听我说{punctuation}",
    "是这样的{punctuation}",
    "让我告诉你{punctuation}",
    "{emphasis}来了{punctuation}",
    "准备好了吗{punctuation}",
  ],
  happy: [
    "太{positive}了{emoji}！",
    "{positive}{punctuation}",
    "今天心情{moodDesc}~",
    "哈哈{punctuation}",
    "nice{emoji}！",
  ],
  alert: [
    "咦？{question}{punctuation}",
    "{notice}异常！",
    "等等，这是什么{punctuation}",
    "{notice}情况！",
    "小心{punctuation}",
  ],
};

const DYNAMIC_PARTS = {
  timeGreeting: ["早上好", "下午好", "晚上好", "嗨"],
  action: ["想想", "发呆", "等你", "休息", "观察", "听听", "准备", "整理", "琢磨", "分析"],
  feeling: ["有点无聊呢", "好安静", "有点困", "挺放松的", "在放空"],
  suggestion: ["聊点什么", "做点有趣的事", "给我个任务", "玩个游戏", "聊聊今天"],
  moodDesc: ["安静", "悠闲", "平静", "舒适", "惬意"],
  timeDesc: ["安静", "清闲", "无聊", "慢悠悠"],
  response: ["我在听", "请讲", "我听着呢", "感兴趣", "明白了"],
  encourage: ["请", "继续", "加油", "嗯", "好的"],
  positive: ["不错", "很好", "可以", "OK", "好的"],
  compliment: ["不错", "很好", "有道理", "精彩", "到位"],
  difficulty: ["有点复杂", "需要想想", "有意思", "不简单", "有挑战"],
  progress: ["有思路了", "快想到了", "正在整理", "差不多", "有想法"],
  emphasis: ["重点", "关键", "核心", "重要", "主要"],
  question: ["怎么了", "什么情况", "这是啥", "发生什么", "有情况"],
  notice: ["注意到", "发现", "检测到", "观察到", "感觉到"],
  positive2: ["棒", "赞", "好", "爽", "开心"],
  emoji: ["😊", "🎉", "✨", "💪", "👍"],
  punctuation: ["！", "～", "~", "…", "～"],
};

function getRandomElement<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function generateDynamicText(mood: AgentMood): string {
  const templates = TEMPLATES[mood];
  const template = getRandomElement(templates);

  return template.replace(/\{(\w+)\}/g, (match, key) => {
    const parts = DYNAMIC_PARTS as Record<string, string[]>;
    if (parts[key]) {
      return getRandomElement(parts[key]);
    }
    return match;
  });
}

let generationCount = 0;

interface InnerThoughtProps {
  state: AgentState;
}

export function InnerThought({ state }: InnerThoughtProps) {
  const { mood, phase, subAgentDisplayName } = state;
  const hasContent = phase || subAgentDisplayName || mood !== "idle";
  if (!hasContent) return null;

  const interaction = useMemo(() => {
    generationCount += 1;
    const seed = generationCount + Date.now();
    Math.random = () => {
      const x = Math.sin(seed) * 10000;
      return x - Math.floor(x);
    };
    const text = generateDynamicText(mood);
    Math.random = () => Math.random();
    return text;
  }, [mood]);

  return (
    <div className={`inner-thought inner-thought--${mood}`}>
      <div className="inner-thought__mood">
        <span className="inner-thought__mood-icon">{MOOD_ICON[mood]}</span>
        <span className="inner-thought__mood-label">{MOOD_LABEL[mood]}</span>
      </div>

      <div className="inner-thought__interaction">{interaction}</div>

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
