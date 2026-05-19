import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { AuthService } from './services/auth-service.js';
import { SocialService } from './services/social-service.js';
import { registerRoutes } from './routes/api-routes.js';
import { registerWebSocket } from './routes/websocket-routes.js';

async function start() {
  const app = Fastify({
    logger: true,
  });

  // Register plugins
  await app.register(cors, {
    origin: true,
    credentials: true,
  });

  await app.register(multipart);
  await app.register(websocket);

  // Initialize services
  const authService = new AuthService();
  const socialService = new SocialService();

  await authService.load();
  await socialService.load();

  // Register routes
  registerRoutes(app, authService, socialService);
  registerWebSocket(app, authService, socialService);

  // Start server
  const port = parseInt(process.env.PORT || '3001');
  const host = process.env.HOST || '0.0.0.0';

  try {
    await app.listen({ port, host });
    console.log(`Social Platform server listening on http://${host}:${port}`);
    console.log(`WebSocket available at ws://${host}:${port}/ws`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();
