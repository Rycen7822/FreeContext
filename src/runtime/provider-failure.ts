import type { ProviderFailureCategory } from "../errors.js";

const HTTP_ERROR_STATUS = /\b([45]\d\d)\b/u;
const CONNECTION_ERROR = /\bconnection error\b|\bfetch failed\b|\bnetwork error\b|\beconn(?:refused|reset|aborted)\b|\benotfound\b|\beai_again\b|\bund_err_[a-z0-9_]+\b|socket hang up/u;

function structuredStatusCode(value: unknown, depth = 0): number | undefined {
  if (!value || typeof value !== "object" || depth > 2) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["status", "statusCode"]) {
    const candidate = record[key];
    if (
      typeof candidate === "number" &&
      Number.isInteger(candidate) &&
      candidate >= 100 &&
      candidate <= 599
    ) return candidate;
  }
  return structuredStatusCode(record.response, depth + 1) ?? structuredStatusCode(record.cause, depth + 1);
}

function errorText(value: unknown): string {
  if (value instanceof Error) return `${value.name} ${value.message}`;
  return String(value || "");
}

export function providerStatusCode(value: unknown): number | undefined {
  const structured = structuredStatusCode(value);
  if (structured !== undefined) return structured;
  const match = errorText(value).match(HTTP_ERROR_STATUS);
  return match?.[1] ? Number(match[1]) : undefined;
}

export function classifyProviderFailure(value: unknown): ProviderFailureCategory {
  const text = errorText(value).toLowerCase();
  const status = providerStatusCode(value);
  if (status === 429) return "rate_limit";
  if (status !== undefined && status >= 500 && status <= 599) return "server_error";

  if (/\b429\b|rate[ -]?limit|too many requests/u.test(text)) return "rate_limit";
  if (/\betimedout\b|\btimeout\b|timed out/u.test(text)) return "timeout";
  if (/\b5\d\d\b|internal server error|bad gateway|service unavailable|overloaded|\b(?:service|server)[_ -]?busy\b|服务繁忙/u.test(text)) {
    return "server_error";
  }
  if (CONNECTION_ERROR.test(text)) return "connection";
  return "other";
}
