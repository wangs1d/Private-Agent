export type ReminderLevel = "popup" | "tts_alarm" | "phone_call";

export type ReminderStatus = 
  | "pending"
  | "active"
  | "delivered"
  | "acknowledged"
  | "escalated"
  | "completed"
  | "cancelled";

export interface ReminderConfig {
  id: string;
  title: string;
  message: string;
  priority: "low" | "medium" | "high" | "urgent";
  initialLevel: ReminderLevel;
  maxLevel?: ReminderLevel;
  scheduledAt: Date;
  expiresAt?: Date;
  metadata?: Record<string, unknown>;
}

export interface PopupReminderConfig {
  showConfirmButton?: boolean;
  confirmText?: string;
  autoCloseAfterMs?: number;
  position?: "center" | "top-right" | "top-left";
}

export interface TTSAlarmConfig {
  volumeStart?: number;
  volumeEnd?: number;
  rampUpDurationMs?: number;
  repeatIntervalMs?: number;
  voiceId?: string;
  speed?: number;
}

export interface PhoneCallConfig {
  waitForResponse?: boolean;
  maxRingDurationSec?: number;
  allowUserInput?: boolean;
  disconnectCommand?: string[];
  retryOnNoAnswer?: boolean;
  retryCount?: number;
  /** 前摇振铃持续时间（毫秒），默认 8000 */
  ringDurationMs?: number;
}

export interface ReminderEscalationRule {
  fromLevel: ReminderLevel;
  toLevel: ReminderLevel;
  triggerCondition: "timeout" | "no_response" | "user_ignored";
  timeoutMs: number;
  maxEscalations?: number;
}

export interface UserResponseHistory {
  userId: string;
  totalReminders: number;
  respondedCount: number;
  averageResponseTimeMs: number;
  preferredLevel: ReminderLevel;
  ignoredCount: number;
  lastResponseAt?: Date;
  levelStats: Record<ReminderLevel, {
    shown: number;
    responded: number;
    avgResponseTimeMs: number;
  }>;
}

export interface ReminderInstance {
  config: ReminderConfig;
  currentLevel: ReminderLevel;
  status: ReminderStatus;
  createdAt: Date;
  startedAt?: Date;
  deliveredAt?: Date;
  acknowledgedAt?: Date;
  escalationCount: number;
  escalationHistory: Array<{
    fromLevel: ReminderLevel;
    toLevel: ReminderLevel;
    triggeredAt: Date;
    reason: string;
  }>;
  popupConfig?: PopupReminderConfig;
  ttsConfig?: TTSAlarmConfig;
  phoneConfig?: PhoneCallConfig;
}
