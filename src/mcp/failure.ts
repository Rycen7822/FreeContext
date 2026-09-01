import { ProviderError } from "../errors.js";
import type { FreeContextErrorCode, FreeContextResult } from "./contracts.js";

export function failedResult({
  code,
  reason,
  sessionId,
  sessionFile,
}: Readonly<{
  code: FreeContextErrorCode;
  reason: string;
  sessionId: string;
  sessionFile: string | null;
}>): Readonly<FreeContextResult> {
  return Object.freeze({
    status: "failed",
    text: reason,
    errorCode: code,
    sessionId,
    sessionFile,
  });
}

export function classifyExplorerError(error: unknown, signal?: AbortSignal): FreeContextErrorCode {
  if (signal?.aborted) return "DEADLINE_EXCEEDED";
  if (error instanceof ProviderError) {
    return error.category === "other" ? "PROVIDER_FATAL" : "PROVIDER_RETRY_EXHAUSTED";
  }
  return "INTERNAL_ERROR";
}

export function errorReason(code: FreeContextErrorCode): string {
  if (code === "DEADLINE_EXCEEDED") return "FreeContext reached its total deadline before returning an answer.";
  if (code === "PROVIDER_RETRY_EXHAUSTED") return "The provider remained unavailable after the configured retries.";
  if (code === "PROVIDER_FATAL") return "The provider rejected the request with a non-retryable failure.";
  if (code === "SESSION_PERSISTENCE_FAILED") return "FreeContext could not persist the complete private session.";
  if (code === "INVALID_REQUEST") return "The FreeContext request did not match the canonical request contract.";
  return "FreeContext failed before it could return an answer.";
}
