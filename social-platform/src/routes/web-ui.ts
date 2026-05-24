import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";

const publicDir = join(process.cwd(), "public");

export function registerSocialWebUi(app: FastifyInstance): void {
  const indexPath = join(publicDir, "index.html");
  const voiceRegPath = join(publicDir, "voice-registration.html");
  const faceRegPath = join(publicDir, "face-registration.html");

  // Main page
  if (existsSync(indexPath)) {
    app.get("/", async (_req, reply) => {
      void reply.type("text/html; charset=utf-8");
      return readFileSync(indexPath, "utf8");
    });
  }

  // Voice registration page
  if (existsSync(voiceRegPath)) {
    app.get("/voice-registration.html", async (_req, reply) => {
      void reply.type("text/html; charset=utf-8");
      return readFileSync(voiceRegPath, "utf8");
    });
    
    app.get("/voice-registration", async (_req, reply) => {
      void reply.type("text/html; charset=utf-8");
      return readFileSync(voiceRegPath, "utf8");
    });
  }

  // Face registration page
  if (existsSync(faceRegPath)) {
    app.get("/face-registration.html", async (_req, reply) => {
      void reply.type("text/html; charset=utf-8");
      return readFileSync(faceRegPath, "utf8");
    });
    
    app.get("/face-registration", async (_req, reply) => {
      void reply.type("text/html; charset=utf-8");
      return readFileSync(faceRegPath, "utf8");
    });
  }
}
