import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { AuthService } from './services/auth-service.js';
import { SocialService } from './services/social-service.js';
import { BiometricService } from './services/biometric-service.js';
import { registerRoutes } from './routes/api-routes.js';
import { registerWebSocket } from './routes/websocket-routes.js';
import { registerSocialWebUi } from './routes/web-ui.js';

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
  const biometricService = new BiometricService();

  await authService.load();
  await socialService.load();
  await biometricService.load();

  // Register routes
  registerRoutes(app, authService, socialService, biometricService);
  registerWebSocket(app, authService, socialService);
  registerSocialWebUi(app);

  // Start server
  const port = parseInt(process.env.PORT || '3001');
  const host = process.env.HOST || '0.0.0.0';

  try {
    await app.listen({ port, host });
    const displayHost = host === "0.0.0.0" ? "127.0.0.1" : host;
    console.log(`Social Platform  http://${displayHost}:${port}  （推文 Web + API）`);
    console.log(`WebSocket          ws://${displayHost}:${port}/ws`);
  } catch (err) {
    const code =
      typeof err === "object" && err !== null && "code" in err
        ? (err as NodeJS.ErrnoException).code
        : undefined;
    if (process.env.NODE_ENV !== "production" && code === "EADDRINUSE") {
      process.exit(0);
    }
    app.log.error(err);
    process.exit(1);
  }
}

start();
