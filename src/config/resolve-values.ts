import { ConfigurationError } from "../errors.js";
import type {
  ApiProtocol,
  AuthMode,
  FallbackReason,
  OpenAIMaxTokensField,
  ThinkingLevel,
} from "./types.js";

type NumericBounds = Readonly<{ min: number; max: number; name: string }>;

export function parseInteger(value: unknown, fallback: number, { min, max, name }: NumericBounds): number {
  if (value === undefined || (typeof value === "string" && !value.trim())) return fallback;
  const normalized = typeof value === "string" ? value.trim() : value;
  const parsed = typeof normalized === "number"
    ? normalized
    : /^[-+]?\d+$/u.test(String(normalized))
      ? Number(normalized)
      : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new ConfigurationError(`${name} must be an integer in [${min}, ${max}], received: ${value}`);
  }
  return parsed;
}

export function parseIntegerArray(
  value: unknown,
  fallback: readonly number[],
  bounds: NumericBounds & Readonly<{ maxItems: number }>,
): readonly number[] {
  if (value === undefined) return Object.freeze([...fallback]);
  const entries = Array.isArray(value) ? value : String(value).trim() ? String(value).split(",") : [];
  if (entries.length > bounds.maxItems) {
    throw new ConfigurationError(`${bounds.name} must contain at most ${bounds.maxItems} values.`);
  }
  return Object.freeze(entries.map((entry) => parseInteger(entry, bounds.min, bounds)));
}

export function parseNumber(value: unknown, fallback: number, { min, max, name }: NumericBounds): number {
  if (value === undefined || (typeof value === "string" && !value.trim())) return fallback;
  const parsed = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new ConfigurationError(`${name} must be a number in [${min}, ${max}], received: ${value}`);
  }
  return parsed;
}

export function parseBoolean(value: unknown, fallback: boolean, name: string): boolean {
  if (value === undefined || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new ConfigurationError(`${name} must be true or false, received: ${value}`);
}

export function normalizeApi(value: unknown, name: string): ApiProtocol {
  const api = String(value || "").trim().toLowerCase();
  if (["anthropic", "anthropic-messages"].includes(api)) return "anthropic";
  if (["openai", "openai-completions", "chat-completions"].includes(api)) return "openai";
  throw new ConfigurationError(`${name} must be anthropic or openai, received: ${value}`);
}

export function normalizeAuthMode(value: unknown, api: ApiProtocol, name: string): AuthMode {
  const mode = String(value || "auto").trim().toLowerCase();
  const aliases = new Map<string, AuthMode>([
    ["auto", "auto"],
    ["api-key", "x-api-key"],
    ["apikey", "x-api-key"],
    ["x-api-key", "x-api-key"],
    ["bearer", "bearer"],
    ["both", "both"],
  ]);
  const normalized = aliases.get(mode);
  if (!normalized) {
    throw new ConfigurationError(`${name} must be auto, x-api-key, bearer, or both, received: ${value}`);
  }
  if (api === "openai" && normalized === "x-api-key") {
    throw new ConfigurationError(`${name}=x-api-key is only valid for the Anthropic protocol.`);
  }
  return normalized;
}

export function normalizeThinkingLevel(value: unknown, name: string): ThinkingLevel {
  const level = String(value || "off").trim().toLowerCase();
  if (["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(level)) {
    return level as ThinkingLevel;
  }
  throw new ConfigurationError(`${name} has unsupported value: ${value}`);
}

export function normalizeMaxTokensField(value: unknown, name: string): OpenAIMaxTokensField {
  const field = String(value || "max_tokens").trim();
  if (field === "max_tokens" || field === "max_completion_tokens") return field;
  throw new ConfigurationError(`${name} must be max_tokens or max_completion_tokens, received: ${value}`);
}

export function normalizeFallbackReason(value: string, name: string): FallbackReason {
  if (value === "timeout" || value === "rate_limit" || value === "server_error" || value === "connection") {
    return value;
  }
  throw new ConfigurationError(`${name} has unsupported fallback reason: ${value}`);
}

export function normalizeBaseUrl(value: string, name: string): string {
  const baseUrl = value.trim().replace(/\/+$/u, "");
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("unsupported protocol");
  } catch (error) {
    throw new ConfigurationError(`${name} is not a valid HTTP(S) URL.`, { cause: error });
  }
  return baseUrl;
}
