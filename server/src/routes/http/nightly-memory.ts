import type { FastifyInstance } from "fastify";
import { getNightlyMemoryTaskService } from "../../services/nightly-memory-task-service.js";
import { getDailyChatSyncService } from "../../services/daily-chat-sync-service.js";
import type { ChatSyncRecord } from "../../services/daily-chat-sync-service.js";

export function registerNightlyMemoryRoutes(app: FastifyInstance): void {
  app.get("/api/nightly-memory/status", async (_request, reply) => {
    const service = getNightlyMemoryTaskService();
    
    if (!service) {
      return reply.status(503).send({
        error: "Nightly memory service not initialized",
        enabled: false,
      });
    }

    return {
      enabled: true,
      isInNightMode: service.isInNightMode(),
      shouldDeferConsolidation: service.shouldDeferConsolidation(),
      timestamp: new Date().toISOString(),
    };
  });

  app.post("/api/nightly-memory/trigger", async (_request, reply) => {
    const service = getNightlyMemoryTaskService();
    
    if (!service) {
      return reply.status(503).send({
        error: "Nightly memory service not initialized",
        success: false,
      });
    }

    try {
      const result = await service.forceRunNightTasks();
      return {
        success: true,
        result,
        triggeredAt: new Date().toISOString(),
      };
    } catch (err) {
      return reply.status(500).send({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.get("/api/nightly-memory/stats", async (_request, reply) => {
    const service = getNightlyMemoryTaskService();
    
    if (!service) {
      return reply.status(503).send({
        error: "Nightly memory service not initialized",
      });
    }

    try {
      let totalMessages = 0;
      let todayMessages = 0;
      const days = new Set<string>();

      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key?.startsWith("pai_daily_chat_")) {
          try {
            const raw = localStorage.getItem(key);
            if (raw) {
              const messages = JSON.parse(raw);
              totalMessages += messages.length;
              const day = key.replace("pai_daily_chat_", "");
              days.add(day);
              
              const today = new Date().toISOString().split("T")[0];
              if (day === today) {
                todayMessages = messages.length;
              }
            }
          } catch {
            
          }
        }
      }

      return {
        totalDays: days.size,
        totalMessages,
        todayMessages,
        storedDays: Array.from(days).sort().reverse(),
        timestamp: new Date().toISOString(),
      };
    } catch (err) {
      return reply.status(500).send({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.post<{ Body: ChatSyncRecord }>("/api/chat/sync", async (request, reply) => {
    const syncService = getDailyChatSyncService();
    
    if (!syncService) {
      return reply.status(503).send({
        error: "Chat sync service not initialized",
        success: false,
      });
    }

    try {
      const record = request.body;
      
      if (!record.actorId || !record.day || !Array.isArray(record.messages)) {
        return reply.status(400).send({
          error: "Invalid sync record format",
          success: false,
        });
      }

      const result = syncService.receiveClientChatSync(record);
      
      return {
        ...result,
        serverTimestamp: new Date().toISOString(),
      };
    } catch (err) {
      return reply.status(500).send({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.get<{ Querystring: { actorId?: string } }>("/api/chat/sync/status", async (request, reply) => {
    const syncService = getDailyChatSyncService();
    
    if (!syncService) {
      return reply.status(503).send({
        error: "Chat sync service not initialized",
      });
    }

    const actorId = request.query.actorId;
    return syncService.getSyncStatus(actorId);
  });
}
