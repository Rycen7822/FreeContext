import { ConfigurationError } from "../errors.js";

export type TomlTable = Record<string, unknown>;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const SENSITIVE_HEADERS = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "set-cookie",
  "x-api-key",
  "api-key",
]);

export function asTable(value: unknown, location: string): TomlTable {
  if (!value || typeof value !== "object" || Array.isArray(value) || value instanceof Date) {
    throw new ConfigurationError(`${location} must be a TOML table.`);
  }
  return value as TomlTable;
}

export function assertKnownKeys(table: TomlTable, allowed: readonly string[], location: string): void {
  const known = new Set(allowed);
  const unknown = Object.keys(table).filter((key) => !known.has(key));
  if (unknown.length) {
    throw new ConfigurationError(`${location} contains unknown key(s): ${unknown.join(", ")}`);
  }
}

export function requiredString(table: TomlTable, key: string, location: string): string {
  const value = table[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new ConfigurationError(`${location}.${key} must be a non-empty string.`);
  }
  return value.trim();
}

export function optionalString(table: TomlTable, key: string, location: string): string | undefined {
  if (table[key] === undefined) return undefined;
  return requiredString(table, key, location);
}

export function optionalNumber(table: TomlTable, key: string, location: string): number | undefined {
  const value = table[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ConfigurationError(`${location}.${key} must be a finite number.`);
  }
  return value;
}

export function optionalBoolean(table: TomlTable, key: string, location: string): boolean | undefined {
  const value = table[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new ConfigurationError(`${location}.${key} must be a boolean.`);
  return value;
}

export function stringArray(
  table: TomlTable,
  key: string,
  location: string,
  fallback: readonly string[] = [],
): string[] {
  const value = table[key];
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new ConfigurationError(`${location}.${key} must be an array of non-empty strings.`);
  }
  const normalized = value.map((item) => String(item).trim());
  if (new Set(normalized).size !== normalized.length) {
    throw new ConfigurationError(`${location}.${key} must not contain duplicates.`);
  }
  return normalized;
}

export function validateId(value: string, location: string): string {
  if (!ID_PATTERN.test(value)) {
    throw new ConfigurationError(`${location} must match ${ID_PATTERN.source}.`);
  }
  return value;
}

export function validateEnvironmentName(value: string, location: string): string {
  if (!ENV_NAME_PATTERN.test(value)) {
    throw new ConfigurationError(`${location} must be an environment-variable name.`);
  }
  return value;
}

export function parseHeaders(value: unknown, location: string): Readonly<Record<string, string>> {
  if (value === undefined) return Object.freeze({});
  const table = asTable(value, location);
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(table)) {
    const normalized = name.trim().toLowerCase();
    if (!name.trim() || typeof headerValue !== "string") {
      throw new ConfigurationError(`${location} must contain only non-empty string header values.`);
    }
    if (SENSITIVE_HEADERS.has(normalized)) {
      throw new ConfigurationError(`${location}.${name} is sensitive; configure credentials with credential_env.`);
    }
    headers[name.trim()] = headerValue;
  }
  return Object.freeze(headers);
}
