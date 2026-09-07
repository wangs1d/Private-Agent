import type { FastifyInstance } from "fastify";
import type { DuplexSocketLike, VoiceDuplexService } from "../services/voice-duplex/voice-duplex-service.js";

/**
 * 全双工语音 WS 路由：/ws/voice-duplex
 *
 * 协议见 services/voice-duplex/protocol.ts（JSON 文本帧，音频 base64 PCM）。
 * 连接建立后交给 VoiceDuplexService.attach 管理生命周期。
 */
export function registerVoiceDuplexWsRoute(app: FastifyInstance, service: VoiceDuplexService): void {
  app.get("/ws/voice-duplex", { websocket: true }, (socket) => {
    service.attach(socket as unknown as DuplexSocketLike);
  });
}
