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
  "At any phase, delegate one unresolved code-fact or relationship question when resolving it would replace substantial additional repository reading beyond context already seen, after accounting for the small exact edit-context read Main must make anyway. Keep that local read, along with architecture decisions and the overall diagnosis or fix, in Main. If a local read will likely settle the question, stay native; if an unfamiliar specific cross-boundary relationship still needs that substantial additional reading, it can be delegated immediately. Do not trace everything first just to decide or call merely because a task starts.",
  "FC sees only question and hints, not your original task or conversation. Include the relevant requirements, checked facts, and specific error when useful; distinguish unverified leads. Do not forward the whole conversation or a long checklist to audit.",
  "Use supported located findings as read context. Main opens exact edit locations and checks missing or contradictory facts, or the new assumption it adds when applying a fact to a design or test, using already-seen evidence first; do not re-walk source merely because FC provided it. Narrow verification to the relevant function, branch, or local diff.",
  "Native work can reveal an unresolved relationship; if resolving an unfamiliar cross-boundary relationship needs substantial additional reading beyond the small edit-context read Main must make, that question can be delegated with checked facts and any relevant change or failure. A failed test or new module is not required. Do not request a full re-audit, repeat a resolved question, or call for an obvious local fix.",
  "The worker returns ordinary assistant text after tracing the implementation or relationship that decides the requested behavior, with a decisive factual conclusion and exact observed path:line-line plus function or symbol. When needed to establish it, the worker adds a short useful excerpt and the relevant condition or scope. If the question mixes fact and design, it returns factual constraints and leaves choices to Main; it adds no unsolicited design menu. Wording is not schema-validated or quota-fitted.",
  "Call it alone; begin the first gather code-mode cell with `// @exec: {\"yield_time_ms\": 300000, \"max_output_tokens\": 12000}`. If it returns a cell, call the outer wait tool with its cell_id, yield_time_ms 300000, and max_tokens 12000; on failure continue natively.",
].join(" ");

export const SERVER_INSTRUCTIONS = [
  "FreeContext accepts one question and optional hints; delegate one unresolved code-fact or relationship investigation whose answer would replace substantial further reading beyond context already seen, after accounting for the small edit-context read Main is about to need, not a whole-feature design or correctness audit.",
  "It is read-only. The worker's assistant text is returned directly.",
  "The worker sees only the request: include relevant task constraints and checked findings. Use its located facts as read context; check missing, contradictory, or newly introduced design/test assumptions from already-seen evidence before narrow verification. On failure continue natively and do not repeat the unchanged question.",
  "Keep exact edit-context reads, design decisions, edits, and tests in the main agent. During native work, a specific unfamiliar cross-boundary relationship can justify another investigation; small direct fixes remain native.",
].join(" ");
