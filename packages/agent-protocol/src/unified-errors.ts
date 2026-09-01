export const UnifiedErrorCode = {
  ValidationError: "VALIDATION_ERROR",
  SessionRequired: "SESSION_REQUIRED",
  Forbidden: "FORBIDDEN",
  BadRequest: "BAD_REQUEST",
  IdempotencyConflict: "IDEMPOTENCY_CONFLICT",
} as const;

export type UnifiedErrorCodeValue = (typeof UnifiedErrorCode)[keyof typeof UnifiedErrorCode];
