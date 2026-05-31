import { useCallback, useEffect, useState } from "react";
import { SphereAgentScene } from "./components/SphereAgentScene";
import { useAgentState } from "./hooks/useAgentState";
import type { AgentMood } from "./types/agent";
import "./index.css";

const MOODS: { id: AgentMood; label: string }[] = [
  { id: "idle", label: "待机" },
  { id: "listening", label: "聆听" },
  { id: "thinking", label: "思考" },
  { id: "speaking", label: "说话" },
  { id: "happy", label: "开心" },
  { id: "alert", label: "提醒" },
];

export default function App() {
  const { state, setMood, setFocused, setCaption } = useAgentState({
    mood: "idle",
    energy: 0.6,
  });
  const [physics, setPhysics] = useState(true);

  const cycleMood = useCallback(() => {
    const idx = MOODS.findIndex((m) => m.id === state.mood);
    const next = MOODS[(idx + 1) % MOODS.length];
    setMood(next.id);
    setCaption(`状态：${next.label}`);
  }, [state.mood, setMood, setCaption]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === " ") {
        e.preventDefault();
        cycleMood();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cycleMood]);

  return (
    <div className="app">
      <header className="hud">
        <div>
          <h1>Agent Sphere</h1>
          <p>Private AI Agent 主形象 · Three.js + R3F + Cannon</p>
        </div>
        <div className="hud-actions">
          <button type="button" onClick={cycleMood}>
            切换表情
          </button>
          <button type="button" onClick={() => setPhysics((p) => !p)}>
            物理：{physics ? "开" : "关"}
          </button>
        </div>
      </header>

      <main className="stage">
        <SphereAgentScene
          state={state}
          physics={physics}
          canvasCaptureLenient
          onEyeFocus={setFocused}
          onEyeClick={cycleMood}
        />
      </main>

      <footer className="hud-footer">
        <span className="badge">{state.mood}</span>
        {state.focused && <span className="hint">眼睛区域已聚焦 — 点击切换状态</span>}
        <span className="hint muted">空格键 / 点击曲屏眼 切换 Agent 状态</span>
      </footer>
    </div>
  );
}
