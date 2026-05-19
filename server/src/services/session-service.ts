export type SessionState = {
  sessionId: string;
  deviceId: string;
  userAlias?: string;
};

export class SessionService {
  private readonly sessions = new Map<string, SessionState>();

  upsert(session: SessionState): SessionState {
    this.sessions.set(session.sessionId, session);
    return session;
  }

  get(sessionId: string): SessionState | undefined {
    return this.sessions.get(sessionId);
  }
}
