import { z } from "zod";

import type { ParsedIntent } from "../intent-router/intent-router.js";
import { ResourceType } from "../registry/models.js";

export const queryConstraintsSchema = z.object({
  max_latency_ms: z.number().int().positive(),
  read_only: z.boolean(),
  file_type: z.string().nullable(),
  auth_level: z.enum(["default", "admin", "guest"]),
});

export const parsedIntentSchema: z.ZodType<ParsedIntent> = z.lazy(() =>
  z.object({
    intent: z.string(),
    domain_candidates: z.array(z.string()),
    primary_capability: z.string(),
    confidence: z.number().min(0).max(1),
    query_constraints: queryConstraintsSchema,
    param_extract: z.record(z.unknown()),
    is_compound_task: z.boolean(),
    sub_intents: z.array(parsedIntentSchema),
  }),
);

export const feedbackReportSchema = z
  .object({
    raw_query: z.string().min(1),
    parsed_intent: parsedIntentSchema,
    resource_id: z.string().min(1),
    resource_type: z.enum([
      ResourceType.Tool,
      ResourceType.Skill,
      ResourceType.McpServer,
    ]),
    success: z.boolean(),
    error_code: z.string().nullable(),
    latency_ms: z.number().int().min(0),
    result_quality_score: z.number().min(0).max(1),
    user_feedback: z.string().nullable(),
    context_hash: z.string().min(1),
    call_timestamp: z.string().datetime(),
  })
  .strict();

export const feedbackBatchSchema = z
  .object({
    items: z.array(feedbackReportSchema).min(1).max(500),
  })
  .strict();

export type FeedbackReport = z.infer<typeof feedbackReportSchema>;
export type FeedbackBatch = z.infer<typeof feedbackBatchSchema>;
