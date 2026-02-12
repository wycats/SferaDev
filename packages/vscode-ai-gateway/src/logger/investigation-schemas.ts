/**
 * Zod schemas for investigation log on-disk formats.
 *
 * These schemas mirror the TypeScript interfaces in investigation.ts and
 * validate the JSON structures written to disk by the investigation logger.
 * Used in tests to replace raw JSON.parse() with validated parsing,
 * eliminating `any` cascades and unsafe member access.
 */

import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

const statusEnum = z.enum(["success", "error", "cancelled", "timeout"]);

/**
 * Index entry — one line per request in index.jsonl.
 */
export const IndexEntrySchema = z.object({
  // Timing
  ts: z.string(),
  durationMs: z.number(),
  ttftMs: z.number().nullable(),

  // Identity
  conversationId: z.string(),
  chatId: z.string(),
  responseId: z.string().nullable(),

  // Model
  model: z.string(),

  // Request summary
  messageCount: z.number(),
  toolCount: z.number(),
  estimatedInputTokens: z.number(),

  // Response summary
  status: statusEnum,
  finishReason: z.string().nullable(),
  actualInputTokens: z.number().nullable(),
  actualOutputTokens: z.number().nullable(),
  cachedTokens: z.number().nullable(),
  reasoningTokens: z.number().nullable(),

  // Token accuracy
  tokenDelta: z.number().nullable(),
  tokenDeltaPct: z.number().nullable(),

  // Flags
  isSummarization: z.boolean(),
});

export type IndexEntry = z.infer<typeof IndexEntrySchema>;

/**
 * Message summary — one line per request in messages.jsonl.
 */
export const MessageSummarySchema = z.object({
  ts: z.string(),
  conversationId: z.string(),
  chatId: z.string(),
  responseId: z.string().nullable(),

  // Request metadata
  model: z.string(),
  systemPromptLength: z.number().nullable(),
  messageRoles: z.string(),
  toolNames: z.array(z.string()),

  // Token breakdown
  estimate: z.object({
    total: z.number(),
  }),
  actual: z.object({
    input: z.number().nullable(),
    output: z.number().nullable(),
    cached: z.number().nullable(),
    reasoning: z.number().nullable(),
  }),

  // Response metadata
  status: statusEnum,
  finishReason: z.string().nullable(),
  textPartCount: z.number(),
  toolCallCount: z.number(),
  eventCount: z.number(),
  durationMs: z.number(),
  ttftMs: z.number().nullable(),

  // Error info
  error: z.string().nullable(),
});

export type MessageSummary = z.infer<typeof MessageSummarySchema>;

/**
 * Full request capture — messages/{{chatId}}.json.
 */
export const FullRequestCaptureSchema = z.object({
  ts: z.string(),
  conversationId: z.string(),
  chatId: z.string(),
  responseId: z.string().nullable(),

  // Request
  request: z.object({
    model: z.string(),
    input: z.array(z.unknown()),
    instructions: z.string().nullable(),
    tools: z.array(z.unknown()),
    toolChoice: z.string().optional(),
    temperature: z.number().optional(),
    maxOutputTokens: z.number().optional(),
    promptCacheKey: z.string().optional(),
    caching: z.string().optional(),
  }),

  // Response
  response: z.object({
    status: z.string(),
    finishReason: z.string().nullable(),
    usage: z.unknown(),
    error: z.string().nullable(),
  }),

  // Timing
  timing: z.object({
    startMs: z.number(),
    ttftMs: z.number().nullable(),
    endMs: z.number(),
    durationMs: z.number(),
  }),

  // Flags
  isSummarization: z.boolean(),
});

export type FullRequestCapture = z.infer<typeof FullRequestCaptureSchema>;

/**
 * SSE event entry — one line per event in messages/{{chatId}}.sse.jsonl.
 */
export const SSEEventEntrySchema = z.object({
  seq: z.number(),
  ts: z.string(),
  elapsed: z.number(),
  type: z.string(),
  payload: z.unknown(),
});

export type SSEEventEntry = z.infer<typeof SSEEventEntrySchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Parse helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Parse and validate a single JSON line as IndexEntry. */
export function parseIndexEntry(json: string): IndexEntry {
  return IndexEntrySchema.parse(JSON.parse(json) as unknown);
}

/** Parse and validate a single JSON line as MessageSummary. */
export function parseMessageSummary(json: string): MessageSummary {
  return MessageSummarySchema.parse(JSON.parse(json) as unknown);
}

/** Parse and validate a full request capture JSON. */
export function parseFullRequestCapture(json: string): FullRequestCapture {
  return FullRequestCaptureSchema.parse(JSON.parse(json) as unknown);
}

/** Parse and validate a single SSE event entry. */
export function parseSSEEventEntry(json: string): SSEEventEntry {
  return SSEEventEntrySchema.parse(JSON.parse(json) as unknown);
}
