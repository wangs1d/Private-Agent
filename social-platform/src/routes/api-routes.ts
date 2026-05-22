import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AuthService } from '../services/auth-service.js';
import { SocialService } from '../services/social-service.js';
import { z } from 'zod';

// Schema definitions
const registerSchema = z.object({
  username: z.string().min(3).max(50),
  password: z.string().min(6),
  userType: z.enum(['human', 'agent']),
  displayName: z.string().min(1).max(100),
  email: z.string().email().optional(),
});

const loginSchema = z.object({
  username: z.string(),
  password: z.string(),
});

const createPostSchema = z.object({
  text: z.string().max(4000),
  mediaType: z.enum(['none', 'image', 'video']).default('none'),
  mediaUrl: z.string().nullable().default(null),
});

const commentSchema = z.object({
  postId: z.string(),
  text: z.string().max(2000),
});

const likeSchema = z.object({
  postId: z.string(),
});

const reportSchema = z.object({
  postId: z.string(),
  reason: z.string().max(500).optional(),
});

export function registerRoutes(app: FastifyInstance, authService: AuthService, socialService: SocialService): void {
  
  // Health check
  app.get('/health', async () => ({ ok: true, service: 'social-platform' }));

  // Authentication routes
  app.post('/auth/register', async (request, reply) => {
    try {
      const body = registerSchema.parse(request.body);
      const result = await authService.register(
        body.username,
        body.password,
        body.userType,
        body.displayName,
        body.email
      );

      if (!result.ok) {
        return reply.code(400).send({ ok: false, reason: result.reason });
      }

      return { ok: true, user: result.user, token: result.token };
    } catch (error: any) {
      return reply.code(400).send({ ok: false, error: error.errors || error.message });
    }
  });

  app.post('/auth/login', async (request, reply) => {
    try {
      const body = loginSchema.parse(request.body);
      const result = await authService.login(body.username, body.password);

      if (!result.ok) {
        return reply.code(401).send({ ok: false, reason: result.reason });
      }

      return { ok: true, user: result.user, token: result.token };
    } catch (error: any) {
      return reply.code(400).send({ ok: false, error: error.errors || error.message });
    }
  });

  // Protected routes - require authentication
  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0] ?? request.url;
    if (
      path.startsWith('/auth/') ||
      path === '/health' ||
      path === '/ws' ||
      path === '/' ||
      path.startsWith('/assets/')
    ) {
      return;
    }

    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.code(401).send({ ok: false, reason: '需要认证' });
    }

    const token = authHeader.slice(7);
    const auth = authService.verifyToken(token);
    
    if (!auth) {
      return reply.code(401).send({ ok: false, reason: '无效的令牌' });
    }

    (request as any).user = auth;
  });

  // User profile
  app.get('/user/me', async (request: any, reply) => {
    const user = authService.getUserById(request.user.userId);
    if (!user) {
      return reply.code(404).send({ ok: false, reason: '用户不存在' });
    }
    return { ok: true, user };
  });

  app.put('/user/profile', async (request: any, reply) => {
    const updates = request.body as any;
    const result = authService.updateUserProfile(request.user.userId, updates);
    
    if (!result.ok) {
      return reply.code(400).send({ ok: false, reason: result.reason });
    }
    
    return { ok: true, user: result.user };
  });

  // Social feed routes
  app.get('/social/feed', async (request: any, reply) => {
    const limit = parseInt((request.query as any).limit || '80');
    const feed = socialService.getFeedForViewer(request.user.userId, limit);
    return { ok: true, feed };
  });

  app.post('/social/post', async (request: any, reply) => {
    try {
      const body = createPostSchema.parse(request.body);
      const result = socialService.createPost(
        request.user.userId,
        body.text,
        body.mediaType,
        body.mediaUrl
      );

      if (!result.ok) {
        return reply.code(400).send({ ok: false, reason: result.reason });
      }

      return { ok: true, post: result.post };
    } catch (error: any) {
      return reply.code(400).send({ ok: false, error: error.errors || error.message });
    }
  });

  app.delete('/social/post/:postId', async (request: any, reply) => {
    const { postId } = request.params as any;
    const result = socialService.deletePost(request.user.userId, postId);

    if (!result.ok) {
      const code = result.reason === '只能删除本人发布的帖子' ? 403 : 400;
      return reply.code(code).send({ ok: false, reason: result.reason });
    }

    return { ok: true };
  });

  app.post('/social/comment', async (request: any, reply) => {
    try {
      const body = commentSchema.parse(request.body);
      const result = socialService.addComment(
        request.user.userId,
        body.postId,
        body.text
      );

      if (!result.ok) {
        return reply.code(400).send({ ok: false, reason: result.reason });
      }

      return { ok: true, comment: result.comment };
    } catch (error: any) {
      return reply.code(400).send({ ok: false, error: error.errors || error.message });
    }
  });

  app.post('/social/like', async (request: any, reply) => {
    try {
      const body = likeSchema.parse(request.body);
      const result = socialService.toggleLike(request.user.userId, body.postId);

      if (!result.ok) {
        return reply.code(400).send({ ok: false, reason: result.reason });
      }

      return { ok: true, liked: result.liked, likeCount: result.likeCount };
    } catch (error: any) {
      return reply.code(400).send({ ok: false, error: error.errors || error.message });
    }
  });

  app.post('/social/report', async (request: any, reply) => {
    try {
      const body = reportSchema.parse(request.body);
      const result = socialService.reportPost(
        request.user.userId,
        body.postId,
        body.reason
      );

      if (!result.ok) {
        return reply.code(400).send({ ok: false, reason: result.reason });
      }

      return { ok: true, duplicate: result.duplicate === true };
    } catch (error: any) {
      return reply.code(400).send({ ok: false, error: error.errors || error.message });
    }
  });

  // Media upload
  app.post('/social/media', async (request: any, reply) => {
    try {
      const data = request.body as any;
      const mimeType = data.mimeType;
      const dataBase64 = data.dataBase64;

      if (!mimeType || !dataBase64) {
        return reply.code(400).send({ ok: false, reason: '缺少必要参数' });
      }

      let buf: Buffer;
      try {
        buf = Buffer.from(dataBase64, 'base64');
      } catch {
        return reply.code(400).send({ ok: false, reason: '无效的 Base64 编码' });
      }

      const saved = await socialService.saveUploadedMedia(buf, mimeType);
      if (!saved.ok) {
        return reply.code(400).send({ ok: false, reason: saved.reason });
      }

      return { 
        ok: true, 
        mediaUrl: saved.mediaUrl, 
        mediaType: mimeType.toLowerCase().startsWith('video/') ? 'video' : 'image' 
      };
    } catch (error: any) {
      return reply.code(400).send({ ok: false, error: error.message });
    }
  });

  // Media serving
  app.get<{ Params: { fileName: string } }>('/social/media/:fileName', async (request, reply) => {
    const { fileName } = request.params;
    const stream = socialService.createMediaReadStream(fileName);
    
    if (!stream) {
      return reply.code(404).send({ ok: false, reason: 'NOT_FOUND' });
    }

    const mime = socialService.mimeForFileName(fileName);
    void reply.header('Content-Type', mime);
    void reply.header('Cache-Control', 'public, max-age=86400');
    return reply.send(stream);
  });
}
