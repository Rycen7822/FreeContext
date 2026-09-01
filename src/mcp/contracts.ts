import { z } from "zod";

/** Public request: one question and optional hints. */
export const FreeContextCallerRequestSchema = z.object({
  question: z.string().trim().min(1).max(16_000),
  hints: z.string().trim().max(4_000).optional(),
}).strict();

export const FreeContextRequestSchema = FreeContextCallerRequestSchema;

export type FreeContextCallerRequest = z.infer<typeof FreeContextCallerRequestSchema>;
export type FreeContextRequest = z.infer<typeof FreeContextRequestSchema>;

export const FreeContextErrorCodeSchema = z.enum([
  "INVALID_REQUEST",
  "DEADLINE_EXCEEDED",
  "PROVIDER_RETRY_EXHAUSTED",
  "PROVIDER_FATAL",
  "SESSION_PERSISTENCE_FAILED",
  "INTERNAL_ERROR",
]);

export type FreeContextErrorCode = z.infer<typeof FreeContextErrorCodeSchema>;

export const FreeContextInvocationContextSchema = z.object({
  invocationId: z.string().trim().min(1),
  callId: z.string().trim().min(1),
  workspaceRoot: z.string().trim().min(1),
  workspaceRevision: z.string().trim().min(1),
  sessionId: z.string().trim().min(1),
  sessionFile: z.string().trim().min(1),
}).strict();

export const FreeContextCallContextSchema = FreeContextInvocationContextSchema.pick({
  invocationId: true,
  callId: true,
  workspaceRoot: true,
  workspaceRevision: true,
});

export type FreeContextInvocationContext = z.infer<typeof FreeContextInvocationContextSchema>;
export type FreeContextCallContext = z.infer<typeof FreeContextCallContextSchema>;

/**
 * The model answer is deliberately opaque. Formatting is a system-prompt hint,
 * never a validator or a transport protocol.
 */
export const FreeContextResultSchema = z.object({
  status: z.enum(["complete", "partial", "failed"]),
  text: z.string(),
  errorCode: FreeContextErrorCodeSchema.nullable(),
  sessionId: z.string().trim().min(1),
  sessionFile: z.string().trim().min(1).nullable(),
}).strict();

export type FreeContextResult = z.infer<typeof FreeContextResultSchema>;

export const TOOL_DESCRIPTION = [
  "Read-only repository investigator. Send {question, hints?}.",
  "At any phase, use it before expanding reading when the whole source-understanding question crosses multiple non-adjacent owners or relationships.",
  "One or two known or changed files and exact compiler/test failures stay native; known paths do not make a multi-file consistency audit local.",
  "Only facts that hints clearly describe as previously checked are settled; paths and symbols are leads that may be checked as needed.",
  "Treat returned facts as already-read navigation context, not automatically correct; open only locations to edit, verify decisive or change-critical claims as needed, or resolve uncertainty, without broadly replaying exploration.",
  "Use a differential audit only when hints describe prior reads or edits; with no prior findings, answer the question normally. Do not repeat the same question; each later call must target a genuinely new gap.",
  "The worker returns ordinary assistant text directly; wording is not schema-validated or quota-fitted.",
  "Call it alone; begin the first gather code-mode cell with `// @exec: {\"yield_time_ms\": 300000, \"max_output_tokens\": 12000}`. If it returns a cell, call the outer wait tool with its cell_id, yield_time_ms 300000, and max_tokens 12000; on failure continue natively.",
].join(" ");

export const SERVER_INSTRUCTIONS = [
  "FreeContext accepts one question and optional hints; use it at any phase before expanding a genuinely cross-module source-understanding question.",
  "It is read-only. The worker's assistant text is returned directly.",
  "Only facts clearly described in hints as previously checked are settled; returned facts are navigation context, not automatically correct. On failure continue natively and do not repeat the same question.",
  "Use a differential audit only when hints describe prior reads or edits; with no prior findings, answer normally.",
].join(" ");
