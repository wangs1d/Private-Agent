const GAME_CENTER_BASE = "";

export async function createGomokuRoom(sessionId: string): Promise<string | null> {
  try {
    const res = await fetch(`${GAME_CENTER_BASE}/game-center/gomoku/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentSessionId: sessionId }),
    });
    const data = await res.json();
    if (data.ok && data.playUrl) return data.playUrl;
    return null;
  } catch {
    return null;
  }
}

export function openGameUrl(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer");
}
