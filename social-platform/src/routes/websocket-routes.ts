import type { FastifyInstance } from 'fastify';
import { SocialService } from '../services/social-service.js';

interface WebSocketClient {
  sessionId: string;
  userId: string;
  socket: any;
}

export function registerWebSocket(app: FastifyInstance, socialService: SocialService): void {
  const clients = new Map<string, WebSocketClient>();
  const userSessions = new Map<string, Set<string>>();

  app.get('/ws', { websocket: true }, (connection: any) => {
    let sessionId: string | undefined;
    let userId: string | undefined;
    const socket = connection.socket;

    socket.on('close', () => {
      if (sessionId) {
        clients.delete(sessionId);
        if (userId) {
          const sessions = userSessions.get(userId);
          if (sessions) {
            sessions.delete(sessionId);
            if (sessions.size === 0) {
              userSessions.delete(userId);
            }
          }
        }
      }
    });

    socket.on('message', (raw: Buffer) => {
      let event: { type: string; payload?: any };
      try {
        event = JSON.parse(raw.toString());
      } catch {
        socket.send(JSON.stringify({
          type: 'error',
          payload: { code: 'BAD_JSON', message: '无法解析事件 JSON' },
        }));
        return;
      }

      if (event.type === 'session.init') {
        const guestId: string = event.payload?.guestId || `guest_ws_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

        sessionId = `ws_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        userId = guestId;

        const client: WebSocketClient = { sessionId, userId: guestId, socket };
        clients.set(sessionId, client);

        if (!userSessions.has(guestId)) {
          userSessions.set(guestId, new Set());
        }
        userSessions.get(guestId)!.add(sessionId);

        socket.send(JSON.stringify({
          type: 'session.ready',
          payload: { sessionId, userId: guestId, username: 'guest', userType: 'human' },
        }));

        const feed = socialService.getFeedForViewer(guestId);
        socket.send(JSON.stringify({
          type: 'social.feed_snapshot',
          payload: feed,
        }));

        return;
      }

      if (!sessionId || !userId) {
        socket.send(JSON.stringify({
          type: 'error',
          payload: { code: 'SESSION_REQUIRED', message: '请先发送 session.init' },
        }));
        return;
      }

      if (event.type === 'social.post') {
        const { text, mediaType, mediaUrl } = event.payload || {};
        const result = socialService.createPost(userId, text || '', mediaType || 'none', mediaUrl || null);

        if (!result.ok) {
          socket.send(JSON.stringify({
            type: 'error',
            payload: { code: 'POST_FAILED', message: result.reason },
          }));
          return;
        }

        broadcastFeedUpdate();
        return;
      }

      if (event.type === 'social.comment') {
        const { postId, text } = event.payload || {};
        const result = socialService.addComment(userId, postId, text || '');

        if (!result.ok) {
          socket.send(JSON.stringify({
            type: 'error',
            payload: { code: 'COMMENT_FAILED', message: result.reason },
          }));
          return;
        }

        broadcastFeedUpdate();
        return;
      }

      if (event.type === 'social.like_toggle') {
        const { postId } = event.payload || {};
        const result = socialService.toggleLike(userId, postId);

        if (!result.ok) {
          socket.send(JSON.stringify({
            type: 'error',
            payload: { code: 'LIKE_FAILED', message: result.reason },
          }));
          return;
        }

        broadcastFeedUpdate();
        return;
      }

      if (event.type === 'social.post_delete') {
        const { postId } = event.payload || {};
        const result = socialService.deletePost(userId, postId);

        if (!result.ok) {
          socket.send(JSON.stringify({
            type: 'error',
            payload: { code: 'DELETE_FAILED', message: result.reason },
          }));
          return;
        }

        broadcastFeedUpdate();
        return;
      }

      if (event.type === 'social.report') {
        const { postId, reason } = event.payload || {};
        const result = socialService.reportPost(userId, postId, reason);

        if (!result.ok) {
          socket.send(JSON.stringify({
            type: 'error',
            payload: { code: 'REPORT_FAILED', message: result.reason },
          }));
          return;
        }

        return;
      }

      socket.send(JSON.stringify({
        type: 'error',
        payload: {
          code: 'UNSUPPORTED_EVENT',
          message: '不支持的事件类型',
        },
      }));
    });
  });

  function broadcastFeedUpdate(): void {
    for (const client of clients.values()) {
      try {
        const feed = socialService.getFeedForViewer(client.userId);
        client.socket.send(JSON.stringify({
          type: 'social.feed_snapshot',
          payload: feed,
        }));
      } catch (error) {
        console.error('[WebSocket] Failed to send to client:', error);
      }
    }
  }
}
