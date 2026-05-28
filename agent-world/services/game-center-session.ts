/** 游戏中心会话：人类与主/子 Agent 陪玩，与 Agent World 观战场景分离。 */

export const GAME_CENTER_HUMAN_SUFFIX = "--human";

const BOT_SUFFIX_RE = /--bot-\d+$/;

export function humanSessionId(agentSessionId: string): string {
  const base = agentSessionId.trim();
  if (base.length === 0) return "human-game-player";
  if (base.endsWith(GAME_CENTER_HUMAN_SUFFIX)) return base;
  return `${base}${GAME_CENTER_HUMAN_SUFFIX}`;
}

export function botSessionId(agentSessionId: string, index: number): string {
  const n = Math.max(1, Math.floor(index));
  return `${agentSessionId.trim()}--bot-${n}`;
}

export function isHumanGameSession(sessionId: string): boolean {
  return sessionId.endsWith(GAME_CENTER_HUMAN_SUFFIX);
}

export function isBotGameSession(sessionId: string): boolean {
  return BOT_SUFFIX_RE.test(sessionId);
}

/** 游戏中心专用参与者（人类或陪玩 Bot），可不完成 Agent World 注册。 */
export function isGameCenterParticipant(sessionId: string): boolean {
  return isHumanGameSession(sessionId) || isBotGameSession(sessionId);
}

export const GAME_CENTER_DEFAULT_STAKE = 50;
export const GAME_CENTER_MIN_CREDITS = 5000;
