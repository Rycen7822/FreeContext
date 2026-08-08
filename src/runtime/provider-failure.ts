import type { ProviderFailureCategory } from "../errors.js";

function statusCode(value: unknown, depth = 0): number | undefined {
  if (!value || typeof value !== "object" || depth > 2) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["status", "statusCode"]) {
    const candidate = record[key];
    if (typeof candidate === "number" && Number.isInteger(candidate)) return candidate;
  }
  return statusCode(record.response, depth + 1) ?? statusCode(record.cause, depth + 1);
}

function errorText(value: unknown): string {
  if (value instanceof Error) return `${value.name} ${value.message}`;
  return String(value || "");
}

export function classifyProviderFailure(value: unknown): ProviderFailureCategory {
  const status = statusCode(value);
  if (status === 429) return "rate_limit";
  if (status !== undefined && status >= 500 && status <= 599) return "server_error";

  const text = errorText(value).toLowerCase();
  if (/\b429\b|rate[ -]?limit|too many requests/u.test(text)) return "rate_limit";
  if (/\betimedout\b|\btimeout\b|timed out/u.test(text)) return "timeout";
  if (/\b5\d\d\b|internal server error|bad gateway|service unavailable|overloaded/u.test(text)) {
    return "server_error";
  }
  return "other";
}
