import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ProviderFailureCategory } from "../errors.js";

const HTTP_ERROR_STATUS = /\b([45]\d\d)\b/u;
const MAX_STRUCTURED_ERROR_BYTES = 8_192;
const TOKENRHYTHM_UNAVAILABLE = "模型服务暂时不可用，请稍后重试";
const RETRYABLE_HTTP_STATUS = new Set([408, 409, 429]);
const RETRYABLE_PROVIDER_CODES = new Set([
  "INTERNAL_SERVER_ERROR",
  "OVERLOADED",
  "RATE_LIMITED",
  "REQUEST_TIMEOUT",
  "SERVER_BUSY",
  "SERVICE_BUSY",
  "TOO_MANY_REQUESTS",
  "UNAVAILABLE",
]);
const FATAL_PROVIDER_CODES = new Set([
  "AUTHENTICATION_ERROR",
  "BILLING_ERROR",
  "CONTEXT_LENGTH_EXCEEDED",
  "CREDIT_BALANCE_TOO_LOW",
  "INVALID_API_KEY",
  "INVALID_REQUEST",
  "PERMISSION_DENIED",
  "QUOTA_EXCEEDED",
]);
const RETRYABLE_PROVIDER_TYPES = new Set([
  "overloaded_error",
  "rate_limit_error",
  "server_error",
  "timeout_error",
]);
const FATAL_PROVIDER_TYPES = new Set([
  "authentication_error",
  "billing_error",
  "invalid_request_error",
  "permission_error",
  "quota_error",
]);
const TIMEOUT_CODES = new Set(["ECONNABORTED", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT"]);
const CONNECTION_CODES = new Set([
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENETDOWN",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ERR_STREAM_PREMATURE_CLOSE",
  "UND_ERR_SOCKET",
]);
const SAFE_PROVIDER_CODES = new Set([
  ...RETRYABLE_PROVIDER_CODES,
  ...FATAL_PROVIDER_CODES,
  ...TIMEOUT_CODES,
  ...CONNECTION_CODES,
]);
const SAFE_PROVIDER_TYPES = new Set([...RETRYABLE_PROVIDER_TYPES, ...FATAL_PROVIDER_TYPES]);

export type ProviderFailureSource = "http" | "provider" | "transport" | "pi" | "tokenrhythm_adapter" | "unknown";
export type ProviderFailureReason =
  | "retryable_http_status"
  | "retryable_provider_code"
  | "retryable_provider_type"
  | "retryable_transport"
  | "explicit_retryable"
  | "pi_retryable"
  | "tokenrhythm_unavailable"
  | "fatal_http_status"
  | "fatal_provider_code"
  | "fatal_provider_type"
  | "unknown";

export interface ProviderFailureSignal {
  readonly category: ProviderFailureCategory;
  readonly retryable: boolean;
  readonly source: ProviderFailureSource;
  readonly reason: ProviderFailureReason;
  readonly statusCode: number | null;
  readonly code: string | null;
  readonly type: string | null;
}

export interface ProviderFailureContext {
  readonly provider?: string;
  readonly baseUrl?: string;
  readonly piRetryable?: boolean;
}

interface ExtractedFailure {
  statusCode?: number;
  code?: string;
  type?: string;
  retryable?: boolean;
  text: string;
}

function normalizedField(value: unknown, uppercase: boolean): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > 128 || /[\r\n]/u.test(normalized)) return undefined;
  return uppercase ? normalized.toUpperCase() : normalized.toLowerCase();
}

function parseStructuredText(value: string): unknown {
  if (Buffer.byteLength(value, "utf8") > MAX_STRUCTURED_ERROR_BYTES || !value.trim().startsWith("{")) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function extractFailure(value: unknown): ExtractedFailure {
  const extracted: ExtractedFailure = { text: value instanceof Error ? value.message : typeof value === "string" ? value : "" };
  const seen = new Set<object>();
  const visit = (candidate: unknown, depth = 0): void => {
    if (depth > 3 || !candidate || typeof candidate !== "object" || seen.has(candidate)) return;
    seen.add(candidate);
    const record = candidate as Record<string, unknown>;
    for (const key of ["status", "statusCode"]) {
      const status = record[key];
      if (extracted.statusCode === undefined && typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) {
        extracted.statusCode = status;
      }
    }
    const code = normalizedField(record.code, true);
    if (extracted.code === undefined && code !== undefined) extracted.code = code;
    const type = normalizedField(record.type, false);
    if (extracted.type === undefined && type !== undefined) extracted.type = type;
    if (extracted.retryable === undefined && typeof record.retryable === "boolean") extracted.retryable = record.retryable;
    for (const key of ["error", "response", "cause", "data", "body"]) visit(record[key], depth + 1);
    for (const key of ["message", "errorMessage"]) {
      const text = record[key];
      if (typeof text !== "string") continue;
      if (!extracted.text) extracted.text = text;
      visit(parseStructuredText(text), depth + 1);
    }
  };
  visit(value);
  visit(parseStructuredText(extracted.text));
  if (extracted.statusCode === undefined) {
    const match = extracted.text.match(HTTP_ERROR_STATUS);
    if (match?.[1]) extracted.statusCode = Number(match[1]);
  }
  return extracted;
}

function isTokenRhythm(context: Readonly<ProviderFailureContext>): boolean {
  if (context.provider?.toLowerCase().includes("tokenrhythm")) return true;
  try { return new URL(context.baseUrl ?? "").hostname.toLowerCase() === "tokenrhythm.studio"; } catch { return false; }
}

function categoryOf(extracted: Readonly<ExtractedFailure>): ProviderFailureCategory {
  if (extracted.statusCode === 429 || extracted.code === "RATE_LIMITED" || extracted.code === "TOO_MANY_REQUESTS" ||
      extracted.type === "rate_limit_error") return "rate_limit";
  if (extracted.statusCode !== undefined && extracted.statusCode >= 500) return "server_error";
  if (extracted.code && TIMEOUT_CODES.has(extracted.code)) return "timeout";
  if (extracted.code && CONNECTION_CODES.has(extracted.code)) return "connection";
  if (extracted.code && RETRYABLE_PROVIDER_CODES.has(extracted.code)) return "server_error";
  if (extracted.type && RETRYABLE_PROVIDER_TYPES.has(extracted.type)) return "server_error";
  return "other";
}

export function normalizeProviderFailure(
  value: unknown,
  context: Readonly<ProviderFailureContext> = {},
): Readonly<ProviderFailureSignal> {
  const extracted = extractFailure(value);
  const common = {
    category: categoryOf(extracted),
    statusCode: extracted.statusCode ?? null,
    code: extracted.code && SAFE_PROVIDER_CODES.has(extracted.code) ? extracted.code : null,
    type: extracted.type && SAFE_PROVIDER_TYPES.has(extracted.type) ? extracted.type : null,
  };
  if (extracted.statusCode !== undefined && extracted.statusCode >= 400 && extracted.statusCode < 500 &&
      !RETRYABLE_HTTP_STATUS.has(extracted.statusCode)) {
    return Object.freeze({ ...common, retryable: false, source: "http", reason: "fatal_http_status" });
  }
  if (extracted.code && FATAL_PROVIDER_CODES.has(extracted.code)) {
    return Object.freeze({ ...common, retryable: false, source: "provider", reason: "fatal_provider_code" });
  }
  if (extracted.type && FATAL_PROVIDER_TYPES.has(extracted.type)) {
    return Object.freeze({ ...common, retryable: false, source: "provider", reason: "fatal_provider_type" });
  }
  if (extracted.statusCode !== undefined &&
      (RETRYABLE_HTTP_STATUS.has(extracted.statusCode) || extracted.statusCode >= 500)) {
    return Object.freeze({ ...common, retryable: true, source: "http", reason: "retryable_http_status" });
  }
  if (extracted.code && RETRYABLE_PROVIDER_CODES.has(extracted.code)) {
    return Object.freeze({ ...common, retryable: true, source: "provider", reason: "retryable_provider_code" });
  }
  if (extracted.type && RETRYABLE_PROVIDER_TYPES.has(extracted.type)) {
    return Object.freeze({ ...common, retryable: true, source: "provider", reason: "retryable_provider_type" });
  }
  if (extracted.code && (TIMEOUT_CODES.has(extracted.code) || CONNECTION_CODES.has(extracted.code))) {
    return Object.freeze({ ...common, retryable: true, source: "transport", reason: "retryable_transport" });
  }
  if (extracted.retryable === true) {
    return Object.freeze({ ...common, retryable: true, source: "provider", reason: "explicit_retryable" });
  }
  if (isTokenRhythm(context) && extracted.text.trim() === TOKENRHYTHM_UNAVAILABLE) {
    return Object.freeze({ ...common, category: "server_error", retryable: true, source: "tokenrhythm_adapter", reason: "tokenrhythm_unavailable" });
  }
  if (context.piRetryable === true) {
    return Object.freeze({ ...common, retryable: true, source: "pi", reason: "pi_retryable" });
  }
  return Object.freeze({ ...common, retryable: false, source: "unknown", reason: "unknown" });
}

export function normalizeAssistantFailure(
  message: AssistantMessage,
  context: Omit<ProviderFailureContext, "piRetryable"> = {},
): Readonly<ProviderFailureSignal> {
  return normalizeProviderFailure(message, { ...context, piRetryable: isRetryableAssistantError(message) });
}

export function providerStatusCode(value: unknown): number | undefined {
  return normalizeProviderFailure(value).statusCode ?? undefined;
}

export function classifyProviderFailure(value: unknown): ProviderFailureCategory {
  return normalizeProviderFailure(value).category;
}
