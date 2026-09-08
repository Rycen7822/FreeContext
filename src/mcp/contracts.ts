import { z } from "zod";

/** Captured native output; command execution remains with the caller. */
export const FreeContextCallerRequestSchema = z.object({
  intent: z.string().trim().min(1).max(16_000),
  output: z.string(),
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
  "CONTEXT_BUDGET_EXCEEDED",
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
  summaryBypassed: z.literal(true).optional(),
}).strict();

export type FreeContextResult = z.infer<typeof FreeContextResultSchema>;

export const TOOL_DESCRIPTION = [
  "Summarize captured local read/search output. Send {intent, output}; both are strings. Main selects and executes its already-authorized native command, and passes the captured result including command and exit/truncation metadata without first emitting it into Main's context.",
  "Use when evidence selection can replace substantial reading, including broad initial source reads and cross-file searches of core files. Read already-located edit functions/small windows and small dense results natively. No call count is required. Ask for observable facts, paths, actual source lines, guards, errors and original excerpts, not global absence judgments or design review. A short explicit successful terminal status can answer verification without summarizing a long success log.",
  "In one code-mode cell, await the native tool into a variable, pass JSON.stringify({command, ...result}) as output to this tool, and emit only this tool's response. If the native command is still running, collect its terminal output inside code mode before summarizing. This tool never executes commands or searches, has no tools or inherited conversation, and only extracts evidence from the supplied output.",
  "Use a long initial code-mode yield and long outer waits on the same running cell (Codex: yield_time_ms 300000; otherwise use host-supported values) until FC succeeds or actually fails, with no arbitrary wait-count limit. While pending, do not explore, edit or reread natively; intermediate yields or empty output do not justify cancellation or one-second polling. Actual provider/FC deadlines and user cancellation still apply.",
  "Returns concise ordinary text with relevant original excerpts, observed paths/symbols/line numbers, conditions, exceptions and gaps. Captured text is saved with the session for exact targeted rereads. Short output bypasses the model; the complete capture must fit the configured model context and reserve, otherwise the call fails with the capture reference for segmentation. Main retains diagnosis, design, edits, verification and targeted native reads. On summary failure use the saved capture; do not rerun the command merely to retry a summary.",
].join(" ");

export const SERVER_INSTRUCTIONS = [
  "FreeContext summarizes caller-captured output with no tools or inherited conversation. Use gather_context with intent and output inside the same code-mode cell as the native command and emit only its response.",
].join(" ");
