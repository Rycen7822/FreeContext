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
  "At any phase, delegate one unresolved fact or relationship to replace the next substantial investigation you would otherwise do. Stay native if the small edit-context read Main needs anyway can settle it. Do not finish the investigation before delegating, request a recap of already-read code, or call routinely at task start. Keep overall diagnosis, design, edits, tests, and local fixes in Main.",
  "FC sees only question and hints: include the original operation and semantics to preserve, checked facts, and the unknown; label proposals and unverified assumptions. Ask how a concrete existing relationship works and under which conditions, such as which value reaches a consumer and which branch changes it, rather than how to build the feature.",
  "Returns ordinary assistant text resolving that uncertainty with decisive short code, a signature, or a branch, observed path:line and symbol, and adjacent conditions that affect the conclusion. Treat supported facts and conditions as already-read context; do not reread every listed file to confirm the answer. Check exact edit locations, gaps, contradictions, and new design/test premises narrowly. Source-grounded inferences must state their assumptions; design choices remain with Main. Delegate a new substantial unknown when useful during work; no failed test, new module, or call count is required.",
  "Call it alone; begin the first gather code-mode cell with `// @exec: {\"yield_time_ms\": 300000, \"max_output_tokens\": 12000}`. Await the terminal result; if it returns a cell, call the outer wait tool with its cell_id, yield_time_ms 300000, and max_tokens 12000, with no native work during the wait. On failure continue natively and do not repeat the same question.",
].join(" ");

export const SERVER_INSTRUCTIONS = [
  "FreeContext is read-only and returns ordinary assistant text. Use gather_context's description for routing and dispatch; it accepts one question and optional hints, with no parent conversation inherited.",
].join(" ");
