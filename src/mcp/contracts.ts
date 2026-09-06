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
  "At any phase, judge the new information needed for the whole source-understanding question. Delegate a concrete behavior, constraint, or missing relationship that requires substantial reading, not just a file inventory.",
  "Stay native when the answer is already in context or needs only a small direct check. Known paths, one or two files, and an exact error location do not by themselves make an investigation small. Do not call merely because a task starts.",
  "FC sees only question and hints, not your original task or conversation. Include relevant task constraints and checked facts; distinguish them from unverified paths or symbols. Do not forward the whole conversation.",
  "Use returned facts as already-read investigation context, not automatically correct. Read precise edit locations, verify decisive claims or unresolved uncertainty, and avoid replaying the full map. Narrow truncated or overlapping reads to relevant functions, branches, or local diffs; delegate remaining investigation.",
  "A test or edit can expose a narrower new question about the same feature: include that evidence and earlier findings rather than repeating a resolved question. Obvious local fixes do not require another call.",
  "Use a differential audit only when hints describe prior reads or edits; with no prior findings, answer normally.",
  "The worker returns ordinary assistant text: a conclusion with verified path:line-line, function or symbol, and relevant fact. Wording is not schema-validated or quota-fitted.",
  "Call it alone; begin the first gather code-mode cell with `// @exec: {\"yield_time_ms\": 300000, \"max_output_tokens\": 12000}`. If it returns a cell, call the outer wait tool with its cell_id, yield_time_ms 300000, and max_tokens 12000; on failure continue natively.",
].join(" ");

export const SERVER_INSTRUCTIONS = [
  "FreeContext accepts one question and optional hints; at any phase delegate a concrete investigation that needs substantial new reading, not a small direct check.",
  "It is read-only. The worker's assistant text is returned directly.",
  "The worker sees only the request: include relevant task constraints and checked findings. Use its located facts as already-read context, not automatically correct. On failure continue natively and do not repeat the unchanged question.",
  "Use a differential audit only when hints describe prior reads or edits; with no prior findings, answer normally.",
].join(" ");
