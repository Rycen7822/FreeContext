import { ProviderError } from "../errors.js";
import { FreeContextResultSchema } from "./contracts.js";
import type { FreeContextErrorCode, FreeContextRequest, FreeContextResult } from "./contracts.js";

export function failedResult({
  code,
  reason,
  sessionId,
  sessionFile,
  request,
}: Readonly<{
  code: FreeContextErrorCode;
  reason: string;
  sessionId: string;
  sessionFile: string | null;
  request?: Readonly<FreeContextRequest>;
}>): Readonly<FreeContextResult> {
  return Object.freeze(FreeContextResultSchema.parse({
    status: "failed",
    summary: "",
    evidence: [],
    gaps: request?.evidenceQuestions.map((question) => ({ questionId: question.id, reason })) ?? [],
    nextAction: { kind: "exact_probe", reason },
    errorCode: code,
    sessionId,
    sessionFile,
  }));
}

export function classifyExplorerError(error: unknown, signal?: AbortSignal): FreeContextErrorCode {
  if (signal?.aborted) return "DEADLINE_EXCEEDED";
  if (error instanceof ProviderError) {
    return error.category === "other" ? "PROVIDER_FATAL" : "PROVIDER_RETRY_EXHAUSTED";
  }
  return "INTERNAL_ERROR";
}

export function errorReason(code: FreeContextErrorCode): string {
  if (code === "DEADLINE_EXCEEDED") return "FreeContext reached its total deadline before evidence was compiled.";
  if (code === "PROVIDER_RETRY_EXHAUSTED") return "The provider remained unavailable after the configured retries.";
  if (code === "PROVIDER_FATAL") return "The provider rejected the request with a non-retryable failure.";
  if (code === "SESSION_PERSISTENCE_FAILED") return "FreeContext could not persist the complete private session.";
  if (code === "INVALID_REQUEST") return "The FreeContext request did not match the canonical request contract.";
  return "FreeContext failed before it could return validated evidence.";
}
