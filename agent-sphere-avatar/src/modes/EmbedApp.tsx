import { useCallback, useEffect, useState } from "react";
import { bindAgentBridge, dispatchEmbodimentCommand } from "../bridge/agent-bridge";
import { mapUserMessageSent } from "../bridge/ws-agent-mapper";
import { OverlayQuickMenu } from "../components/OverlayQuickMenu";
import { SphereAgentScene } from "../components/SphereAgentScene";
import type { QuickCommand } from "../constants/quick-commands";
import { isWsOffMode, postToHost, readSphereQuery, SPHERE_MSG } from "../embed-protocol";
import { useAgentState } from "../hooks/useAgentState";
import { useAgentWebSocket } from "../hooks/useAgentWebSocket";
import { useEmbedFloatPan } from "../hooks/useEmbedFloatPan";
import { useEmbedParentBridge } from "../hooks/useEmbedParentBridge";
import type { SphereTouchEvent } from "../hooks/useSphereUserDrag";
import { useOverlaySpeech } from "../hooks/useOverlaySpeech";
import "./modes.css";

/** 网页聊天侧边嵌入 — 可对话、3D 漫游、接收主 Agent 具身指令 */
export function EmbedApp() {
  const wsOff = isWsOffMode();
  const { state, apply, setFocused } = useAgentState({ mood: "idle", energy: 0.55 });
  const [menuOpen, setMenuOpen] = useState(false);
  const wsUrl = readSphereQuery("ws");
  const sessionId = readSphereQuery("sessionId");

  const stableApply = useCallback((patch: Parameters<typeof apply>[0]) => apply(patch), [apply]);

  const { connected, sendWake, sendChat } = useAgentWebSocket(stableApply, {
    wsUrl: wsUrl ?? undefined,
    sessionId: sessionId ?? undefined,
    enabled: !wsOff,
  });

  useEmbedParentBridge({ apply });
  useEmbedFloatPan(true);

  const sendToAgent = useCallback(
    (action: "wake" | "chat" | "focus", text?: string) => {
      if (wsOff) {
        postToHost({ type: SPHERE_MSG.send, action, text });
        if (action === "wake" || action === "chat") {
          apply(mapUserMessageSent());
        } else if (action === "focus") {
          apply({ mood: "listening", energy: 0.62, caption: "等待输入…" });
        }
        return true;
      }
      if (action === "wake") return sendWake();
      if (action === "chat" && text) return sendChat(text);
      return false;
    },
    [apply, sendChat, sendWake, wsOff],
  );

  const handleSpeechResult = useCallback(
    (text: string) => {
      setMenuOpen(false);
      sendToAgent("chat", text);
    },
    [sendToAgent],
  );

  const speech = useOverlaySpeech({
    onResult: handleSpeechResult,
    onError: (msg) => apply({ mood: "alert", energy: 0.75, caption: msg }),
  });

  useEffect(
    () =>
      bindAgentBridge({
        onMood: (mood) => apply({ mood }),
        onEnergy: (energy) => apply({ energy }),
        onCaption: (caption) => apply({ caption }),
      }),
    [apply],
  );

  const handleCommand = useCallback(
    (cmd: QuickCommand) => {
      switch (cmd.action) {
        case "wake":
          sendToAgent("wake");
          setMenuOpen(false);
          break;
        case "chat":
          if (cmd.text) sendToAgent("chat", cmd.text);
          setMenuOpen(false);
          break;
        case "roam":
          dispatchEmbodimentCommand({ action: "roam", strength: 1.1 });
          break;
        case "voice":
          if (!speech.supported) {
            apply({ mood: "alert", energy: 0.75, caption: "不支持语音识别" });
            break;
          }
          speech.start();
          apply({ mood: "listening", energy: 0.68, caption: "请说话…" });
          break;
        default:
          break;
      }
    },
    [apply, sendToAgent, speech],
  );

  const handleEyeClick = useCallback(() => {
    setMenuOpen(true);
  }, []);

  const handleEyeInteraction = useCallback(
    (active: boolean) => {
      if (menuOpen) return;
      setFocused(active);
    },
    [menuOpen, setFocused],
  );

  const handleUserTouch = useCallback(
    (event: SphereTouchEvent) => {
      if (event.phase === "start") {
        apply({ mood: "listening", energy: 0.62, focused: true });
        return;
      }
      if (event.phase === "end") {
        const spin = event.spinStrength ?? 0;
        if (spin > 0.45) {
          apply({ mood: "happy", energy: 0.72, caption: "哈哈，转晕我了！" });
          dispatchEmbodimentCommand({ action: "excite", strength: 0.8 + spin * 0.6 });
        } else if ((event.totalRotationDeg ?? 0) > 25) {
          apply({ mood: "alert", energy: 0.68, caption: "嗯？你在转我？" });
        }
      }
    },
    [apply],
  );

  return (
    <div className="mode-shell mode-embed">
      <SphereAgentScene
        state={state}
        mode="embed"
        physics={false}
        autonomous
        onEyeFocus={setFocused}
        onEyeClick={handleEyeClick}
        onEyeInteractionChange={handleEyeInteraction}
        onUserTouch={handleUserTouch}
      />

      <OverlayQuickMenu
        open={menuOpen || speech.listening}
        connected={wsOff || connected}
        voiceListening={speech.listening}
        voiceInterim={speech.interim}
        onSelect={handleCommand}
        onClose={() => {
          speech.stop();
          setMenuOpen(false);
        }}
      />
    </div>
  );
}
