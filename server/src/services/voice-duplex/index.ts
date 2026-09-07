/**
 * 全双工实时语音抽象层 公共出口。
 */

export type {
  DuplexSessionState,
  DuplexSessionConfig,
  DuplexClientMessage,
  DuplexServerMessage,
} from "./protocol.js";
export { parseClientMessage } from "./protocol.js";
export { EndpointDetector, pcmToWav, type EndpointEvent } from "./endpoint-detector.js";
export { DuplexVoiceSession, type DuplexSessionDeps } from "./duplex-session.js";
export {
  VoiceDuplexService,
  type VoiceDuplexServiceDeps,
  type DuplexSocketLike,
} from "./voice-duplex-service.js";
