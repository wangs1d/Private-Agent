import { useCallback, useEffect, useState } from "react";

import { bindAgentBridge, dispatchEmbodimentCommand } from "../bridge/agent-bridge";

import { mapUserMessageSent } from "../bridge/ws-agent-mapper";

import { OverlayQuickMenu } from "../components/OverlayQuickMenu";

import { SphereAgentScene } from "../components/SphereAgentScene";

import type { QuickCommand } from "../constants/quick-commands";

import { useAgentState } from "../hooks/useAgentState";

import { useAgentWebSocket } from "../hooks/useAgentWebSocket";

import { useEmbodimentCommandRelay } from "../hooks/useEmbodimentCommandRelay";

import { useOverlaySpeech } from "../hooks/useOverlaySpeech";

import type { EmbodimentCommandAction } from "../types/agent";

import "./modes.css";



function readQuery(key: string): string | undefined {

  return new URLSearchParams(window.location.search).get(key) ?? undefined;

}



/** 网页聊天侧边嵌入 — 可对话、3D 漫游、接收主 Agent 具身指令 */

export function EmbedApp() {

  const wsOff = readQuery("wsOff") === "1";

  const { state, apply, setFocused } = useAgentState({ mood: "idle", energy: 0.55 });

  const [menuOpen, setMenuOpen] = useState(false);

  const wsUrl = readQuery("ws");

  const sessionId = readQuery("sessionId");



  const stableApply = useCallback((patch: Parameters<typeof apply>[0]) => apply(patch), [apply]);



  const { connected, sendWake, sendChat } = useAgentWebSocket(stableApply, {

    wsUrl: wsUrl ?? undefined,

    sessionId: sessionId ?? undefined,

    enabled: !wsOff,

  });



  useEmbodimentCommandRelay(true);



  const sendToAgent = useCallback(

    (action: "wake" | "chat" | "focus", text?: string) => {

      if (wsOff) {

        window.parent?.postMessage({ type: "agent-sphere:send", action, text }, "*");

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



  useEffect(() => bindAgentBridge({

    onMood: (mood) => apply({ mood }),

    onEnergy: (energy) => apply({ energy }),

    onCaption: (caption) => apply({ caption }),

  }), [apply]);



  useEffect(() => {

    const onMessage = (ev: MessageEvent) => {

      if (!ev.data || typeof ev.data !== "object") return;

      const d = ev.data as {

        type?: string;

        mood?: string;

        caption?: string | null;

        energy?: number;

        phase?: string;

        subAgentType?: string;

        subAgentDisplayName?: string;

        source?: string;

        action?: EmbodimentCommandAction;

        x?: number;

        y?: number;

        z?: number;

        strength?: number;

      };

      if (d.type === "agent-sphere:patch") {

        apply({

          mood: d.mood as typeof state.mood | undefined,

          caption: d.caption === null ? undefined : d.caption,

          energy: d.energy,

          phase: d.phase,

          subAgentType: d.subAgentType,

          subAgentDisplayName: d.subAgentDisplayName,

          source: d.source,

        });

        return;

      }

      if (d.type === "agent-sphere:command" || d.type === "agent.embodiment.command") {

        if (

          d.action === "roam" ||

          d.action === "move" ||

          d.action === "stop" ||

          d.action === "window_roam"

        ) {

          dispatchEmbodimentCommand({

            action: d.action,

            x: d.x,

            y: d.y,

            z: d.z,

            strength: d.strength,

          });

        }

      }

    };

    window.addEventListener("message", onMessage);

    window.parent?.postMessage({ type: "agent-sphere:ready" }, "*");

    return () => window.removeEventListener("message", onMessage);

  }, [apply]);



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



  return (

    <div className="mode-shell mode-embed">

      <SphereAgentScene

        state={state}

        mode="embed"

        physics

        autonomous={false}

        onEyeFocus={setFocused}

        onEyeClick={handleEyeClick}

        onEyeInteractionChange={handleEyeInteraction}

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


