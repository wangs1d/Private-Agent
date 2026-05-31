import { ServerEventType } from "../protocol.js";
import type {
  EmbodimentCommand,
  EmbodimentMood,
  EmbodimentPatch,
  EmbodimentSender,
} from "./agent-embodiment.js";
import type { WsConnectionRegistry } from "./ws-connection-registry.js";

type SessionAutonomyState = {
  mood: EmbodimentMood;
  processing: boolean;
  lastCommandAt: number;
  lastMoodAt: number;
  speakingTicks: number;
  registered: boolean;
};

function envAutonomyEnabled(): boolean {
  const raw = process.env.ENABLE_EMBODIMENT_AUTONOMY?.trim().toLowerCase();
  if (raw === "0" || raw === "false" || raw === "off") return false;
  return true;
}

function randBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function randomRoamStrength(base: number): number {
  return Math.min(2, Math.max(0.25, base + (Math.random() - 0.5) * 0.25));
}

/**
 * 主 Agent 具身自主意识 — 根据 mood / 处理阶段自发驱动球形身体移动（无需用户显式下令）。
 */
export class EmbodimentAutonomyService {
  private readonly sessions = new Map<string, SessionAutonomyState>();
  private readonly tickTimer: ReturnType<typeof setInterval>;
  private readonly enabled: boolean;

  constructor(private readonly wsRegistry: WsConnectionRegistry) {
    this.enabled = envAutonomyEnabled();
    this.tickTimer = setInterval(() => this.tick(), 4500);
  }

  dispose(): void {
    clearInterval(this.tickTimer);
    this.sessions.clear();
  }

  registerSession(sessionId: string): void {
    const prev = this.sessions.get(sessionId);
    this.sessions.set(sessionId, {
      mood: prev?.mood ?? "idle",
      processing: prev?.processing ?? false,
      lastCommandAt: prev?.lastCommandAt ?? 0,
      lastMoodAt: Date.now(),
      speakingTicks: 0,
      registered: true,
    });
  }

  unregisterSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  setProcessing(sessionId: string, processing: boolean, send?: EmbodimentSender): void {
    const st = this.ensureSession(sessionId);
    st.processing = processing;
    if (processing) {
      this.maybeCommand(sessionId, { action: "roam", strength: 0.75, source: "autonomy:processing_start" }, send, 0);
    }
  }

  /** 每次 embodiment.patch 发出后调用 */
  onPatch(sessionId: string, patch: EmbodimentPatch, send?: EmbodimentSender): void {
    if (!this.enabled) return;
    if (patch.source?.startsWith("tool:")) return;

    const st = this.ensureSession(sessionId);
    const prevMood = st.mood;
    const nextMood = patch.mood ?? st.mood;
    const moodChanged = nextMood !== prevMood;
    st.mood = nextMood;
    st.lastMoodAt = Date.now();

    if (nextMood === "speaking") {
      st.speakingTicks += 1;
    } else if (moodChanged) {
      st.speakingTicks = 0;
    }

    if (nextMood === "listening") {
      if (moodChanged) {
        this.maybeCommand(
          sessionId,
          { action: "move", x: 0, y: 1.6, z: 0, source: "autonomy:listening" },
          send,
          0,
        );
      }
      return;
    }

    if (nextMood === "thinking") {
      const isDelegate = patch.phase?.startsWith("delegate");
      const minGap = isDelegate ? 5000 : 7000;
      if (moodChanged) {
        this.maybeCommand(
          sessionId,
          { action: "roam", strength: randomRoamStrength(isDelegate ? 1.0 : 0.88), source: "autonomy:thinking" },
          send,
          0,
        );
      } else {
        this.maybeCommand(
          sessionId,
          { action: "roam", strength: randomRoamStrength(0.72), source: "autonomy:thinking_pulse" },
          send,
          minGap,
        );
      }
      return;
    }

    if (nextMood === "speaking") {
      if (st.speakingTicks === 1 || st.speakingTicks % 3 === 0) {
        const energy = typeof patch.energy === "number" ? patch.energy : 0.6;
        const strength = randomRoamStrength(1.05 + energy * 0.55);
        const wild = energy > 0.62 && (st.speakingTicks > 1 || energy > 0.78);
        this.maybeCommand(
          sessionId,
          {
            action: wild ? "excite" : "roam",
            strength,
            source: wild ? "autonomy:speaking_excited" : "autonomy:speaking",
          },
          send,
          st.speakingTicks === 1 ? 0 : 3200,
        );
      }
      return;
    }

    if (nextMood === "happy" && moodChanged) {
      this.maybeCommand(
        sessionId,
        { action: "excite", strength: randomRoamStrength(1.35), source: "autonomy:happy" },
        send,
        0,
      );
      st.processing = false;
      setTimeout(() => {
        const cur = this.sessions.get(sessionId);
        if (!cur || cur.mood !== "happy") return;
        cur.mood = "idle";
        cur.processing = false;
      }, 2000);
      return;
    }

    if (nextMood === "alert" && moodChanged) {
      this.maybeCommand(sessionId, { action: "stop", source: "autonomy:alert" }, send, 0);
      return;
    }

    if (nextMood === "idle" && moodChanged) {
      st.processing = false;
      this.maybeCommand(
        sessionId,
        { action: "roam", strength: randomRoamStrength(0.52), source: "autonomy:idle_enter" },
        send,
        0,
      );
    }
  }

  private tick(): void {
    if (!this.enabled) return;
    const now = Date.now();
    for (const [sessionId, st] of this.sessions) {
      if (!st.registered || !this.wsRegistry.get(sessionId)) continue;

      if (st.processing) {
        if (st.mood === "thinking" && now - st.lastCommandAt > randBetween(6500, 9500)) {
          this.pushCommand(sessionId, {
            action: "roam",
            strength: randomRoamStrength(0.78),
            source: "autonomy:thinking_idle_pulse",
          });
          st.lastCommandAt = now;
        }
        continue;
      }

      if (st.mood !== "idle" && st.mood !== "happy") continue;
      const wanderGap = randBetween(11000, 22000);
      if (now - st.lastCommandAt < wanderGap) continue;
      if (now - st.lastMoodAt < 3000) continue;

      const strength = randomRoamStrength(0.48 + Math.random() * 0.22);
      if (Math.random() < 0.32) {
        this.pushCommand(sessionId, {
          action: "move",
          x: (Math.random() - 0.5) * 3.6,
          y: 1.2 + Math.random() * 1.0,
          z: (Math.random() - 0.5) * 3.6,
          source: "autonomy:consciousness_wander",
        });
      } else {
        this.pushCommand(sessionId, {
          action: "roam",
          strength,
          source: "autonomy:consciousness_wander",
        });
      }
      st.lastCommandAt = now;
      if (st.mood === "happy") st.mood = "idle";
    }
  }

  private ensureSession(sessionId: string): SessionAutonomyState {
    let st = this.sessions.get(sessionId);
    if (!st) {
      st = {
        mood: "idle",
        processing: false,
        lastCommandAt: 0,
        lastMoodAt: Date.now(),
        speakingTicks: 0,
        registered: false,
      };
      this.sessions.set(sessionId, st);
    }
    return st;
  }

  private maybeCommand(
    sessionId: string,
    command: EmbodimentCommand,
    send: EmbodimentSender | undefined,
    minGapMs: number,
  ): void {
    const st = this.ensureSession(sessionId);
    const now = Date.now();
    if (minGapMs > 0 && now - st.lastCommandAt < minGapMs) return;
    this.pushCommand(sessionId, command, send);
    st.lastCommandAt = now;
  }

  private pushCommand(
    sessionId: string,
    command: EmbodimentCommand,
    send?: EmbodimentSender,
  ): void {
    const json = JSON.stringify({
      type: ServerEventType.AgentEmbodimentCommand,
      payload: { sessionId, ...command },
    });
    if (send) {
      send(json);
      return;
    }
    this.wsRegistry.trySend(sessionId, json);
  }
}

let sharedAutonomy: EmbodimentAutonomyService | null = null;

export function initEmbodimentAutonomy(service: EmbodimentAutonomyService): void {
  sharedAutonomy = service;
}

export function getEmbodimentAutonomy(): EmbodimentAutonomyService | null {
  return sharedAutonomy;
}
