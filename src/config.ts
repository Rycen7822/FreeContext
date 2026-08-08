import { access, readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigurationError } from "./errors.js";

export type ApiProtocol = "anthropic" | "openai";
export type AuthMode = "auto" | "x-api-key" | "bearer" | "both";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type OpenAIMaxTokensField = "max_tokens" | "max_completion_tokens";

export interface OpenAICompatConfig {
  readonly supportsDeveloperRole: boolean;
  readonly supportsReasoningEffort: boolean;
  readonly supportsUsageInStreaming: boolean;
  readonly supportsStrictMode: boolean;
  readonly supportsStore: false;
  readonly maxTokensField: OpenAIMaxTokensField;
}

export interface CliConfigOverrides {
  readonly envFile?: string;
  readonly promptPath?: string;
  readonly api?: string;
  readonly authMode?: string;
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly model?: string;
  readonly maxTurns?: string | number;
  readonly maxToolCalls?: string | number;
  readonly maxOutputTokens?: string | number;
  readonly requestTimeoutMs?: string | number;
  readonly toolTimeoutMs?: string | number;
  readonly maxToolOutputBytes?: string | number;
  readonly maxParallelTools?: string | number;
  readonly contextWindow?: string | number;
  readonly contextReserveTokens?: string | number;
  readonly contextKeepRecentTokens?: string | number;
  readonly contextCompactionEnabled?: boolean;
  readonly temperature?: string | number;
  readonly thinkingLevel?: string;
  readonly headersJson?: string;
}

export interface FreeContextConfig {
  readonly api: ApiProtocol;
  readonly authMode: AuthMode;
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly promptPath: string;
  readonly envFilePath: string;
  readonly envFileLoaded: boolean;
  readonly maxTurns: number;
  readonly maxToolCalls: number;
  readonly maxOutputTokens: number;
  readonly requestTimeoutMs: number;
  readonly toolTimeoutMs: number;
  readonly maxToolOutputBytes: number;
  readonly maxParallelTools: number;
  readonly contextWindow: number;
  readonly contextCompactionEnabled: boolean;
  readonly contextReserveTokens: number;
  readonly contextKeepRecentTokens: number;
  readonly effectiveToolOutputBytes: number;
  readonly temperature: number;
  readonly thinkingLevel: ThinkingLevel;
  readonly headers: Readonly<Record<string, string>>;
  readonly openAICompat: Readonly<OpenAICompatConfig>;
}

type Environment = Readonly<Record<string, string | undefined>>;
type NumericBounds = Readonly<{ min: number; max: number; name: string }>;

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = path.resolve(MODULE_DIR, "..");
export const DEFAULT_PROMPT_PATH = path.join(PACKAGE_ROOT, "prompts", "explorer.md");

function stripInlineComment(value: string): string {
  let quote: string | null = null;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if ((char === '"' || char === "'") && value[i - 1] !== "\\") {
      quote = quote === char ? null : quote ?? char;
      continue;
    }
    if (char === "#" && quote === null && (i === 0 || /\s/.test(value[i - 1] ?? ""))) {
      return value.slice(0, i).trimEnd();
    }
  }
  return value;
}

function unquote(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if (first === "'" && last === "'") return value.slice(1, -1);
  if (first === '"' && last === '"') {
    return value
      .slice(1, -1)
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
  return value;
}

export function parseEnv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of text.replace(/^\uFEFF/, "").split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const normalized = line.startsWith("export ") ? line.slice(7).trimStart() : line;
    const separator = normalized.indexOf("=");
    if (separator <= 0) continue;
    const key = normalized.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) continue;
    const rawValue = stripInlineComment(normalized.slice(separator + 1).trim());
    values[key] = unquote(rawValue);
  }
  return values;
}

async function isReadable(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export function defaultEnvPath(env: Environment = process.env): string {
  const configHome = env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(configHome, "freecontext", ".env");
}

export async function loadEnvFile(
  explicitPath?: string,
  { env = process.env, required = false }: { readonly env?: Environment; readonly required?: boolean } = {},
): Promise<Readonly<{ path: string; values: Record<string, string>; loaded: boolean }>> {
  const selected = explicitPath || env.FREECONTEXT_ENV_FILE || defaultEnvPath(env);
  const absolute = path.resolve(selected.replace(/^~(?=$|[/\\])/u, os.homedir()));
  if (!(await isReadable(absolute))) {
    if (required || explicitPath || env.FREECONTEXT_ENV_FILE) {
      throw new ConfigurationError(`Environment file is not readable: ${absolute}`);
    }
    return { path: absolute, values: {}, loaded: false };
  }
  const values = parseEnv(await readFile(absolute, "utf8"));
  return { path: absolute, values, loaded: true };
}

function parseInteger(value: unknown, fallback: number, { min, max, name }: NumericBounds): number {
  if (value === undefined || value === "") return fallback;
  const normalized = String(value).trim();
  const parsed = /^[-+]?\d+$/u.test(normalized) ? Number(normalized) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new ConfigurationError(`${name} must be an integer in [${min}, ${max}], received: ${value}`);
  }
  return parsed;
}

function parseNumber(value: unknown, fallback: number, { min, max, name }: NumericBounds): number {
  if (value === undefined || value === "") return fallback;
  const normalized = String(value).trim();
  const parsed = normalized ? Number(normalized) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new ConfigurationError(`${name} must be a number in [${min}, ${max}], received: ${value}`);
  }
  return parsed;
}

function parseBoolean(value: unknown, fallback: boolean, name: string): boolean {
  if (value === undefined || value === "") return fallback;
  const normalized = String(value).toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new ConfigurationError(`${name} must be true or false, received: ${value}`);
}

function parseJsonObject(
  value: string | undefined,
  fallback: Readonly<Record<string, string>>,
  name: string,
): Readonly<Record<string, string>> {
  if (value === undefined || value === "") return fallback;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
      throw new Error("expected an object");
    }
    for (const [key, item] of Object.entries(parsed)) {
      if (typeof item !== "string") throw new Error(`header ${key} must be a string`);
    }
    return Object.freeze(parsed as Record<string, string>);
  } catch (error) {
    throw new ConfigurationError(`${name} must be a JSON object with string values`, { cause: error });
  }
}

function normalizeApi(value: unknown): ApiProtocol {
  const api = String(value || "anthropic").trim().toLowerCase();
  if (["anthropic", "anthropic-messages"].includes(api)) return "anthropic";
  if (["openai", "openai-completions", "chat-completions"].includes(api)) return "openai";
  throw new ConfigurationError(`FREECONTEXT_API must be anthropic or openai, received: ${value}`);
}

function normalizeAuthMode(value: unknown, api: ApiProtocol): AuthMode {
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
    throw new ConfigurationError(
      `FREECONTEXT_AUTH_MODE must be auto, x-api-key, bearer, or both, received: ${value}`,
    );
  }
  if (api === "openai" && normalized === "x-api-key") {
    throw new ConfigurationError("FREECONTEXT_AUTH_MODE=x-api-key is only valid for the Anthropic protocol.");
  }
  return normalized;
}

function normalizeThinkingLevel(value: unknown): ThinkingLevel {
  const level = String(value || "off").trim().toLowerCase();
  if (
    level !== "off" &&
    level !== "minimal" &&
    level !== "low" &&
    level !== "medium" &&
    level !== "high" &&
    level !== "xhigh" &&
    level !== "max"
  ) {
    throw new ConfigurationError(`Unsupported FREECONTEXT_THINKING_LEVEL: ${value}`);
  }
  return level;
}

function normalizeMaxTokensField(value: unknown): OpenAIMaxTokensField {
  const field = String(value || "max_tokens").trim();
  if (!["max_tokens", "max_completion_tokens"].includes(field)) {
    throw new ConfigurationError(
      `FREECONTEXT_OPENAI_MAX_TOKENS_FIELD must be max_tokens or max_completion_tokens, received: ${value}`,
    );
  }
  return field as OpenAIMaxTokensField;
}

function withoutTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}

export function redactSecret(value: string | undefined): string {
  if (!value) return "<unset>";
  return "<redacted>";
}

export function redactUrl(value: unknown): string {
  try {
    const parsed = new URL(String(value));
    if (parsed.username) parsed.username = "redacted";
    if (parsed.password) parsed.password = "redacted";
    const names = [...new Set(parsed.searchParams.keys())];
    for (const name of names) parsed.searchParams.set(name, "redacted");
    parsed.hash = "";
    return parsed.toString().replace(/\/$/u, "");
  } catch {
    return "<invalid-url>";
  }
}

export async function resolveConfig(
  {
    cli = {},
    processEnv = process.env,
    requireApiKey = true,
  }: {
    readonly cli?: CliConfigOverrides;
    readonly processEnv?: Environment;
    readonly requireApiKey?: boolean;
  } = {},
): Promise<Readonly<FreeContextConfig>> {
  const envFile = await loadEnvFile(cli.envFile, {
    env: processEnv,
    required: Boolean(cli.envFile),
  });
  const merged = { ...envFile.values, ...processEnv };

  const api = normalizeApi(cli.api || merged.FREECONTEXT_API);
  const authMode = normalizeAuthMode(cli.authMode || merged.FREECONTEXT_AUTH_MODE, api);
  const apiKey =
    cli.apiKey ||
    merged.FREECONTEXT_API_KEY ||
    (api === "anthropic" ? merged.ANTHROPIC_API_KEY : merged.OPENAI_API_KEY) ||
    "";
  if (requireApiKey && !apiKey) {
    throw new ConfigurationError(
      `No API key configured. Set FREECONTEXT_API_KEY in ${envFile.path} or the process environment.`,
    );
  }

  const defaultBaseUrl = api === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1";
  const baseUrl = withoutTrailingSlash(String(cli.baseUrl || merged.FREECONTEXT_BASE_URL || defaultBaseUrl).trim());
  try {
    const parsed = new URL(baseUrl);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("unsupported protocol");
  } catch (error) {
    throw new ConfigurationError(`Invalid FREECONTEXT_BASE_URL: ${redactUrl(baseUrl)}`, { cause: error });
  }

  const model = String(cli.model || merged.FREECONTEXT_MODEL || "").trim();
  if (!model) throw new ConfigurationError("FREECONTEXT_MODEL is required.");

  const promptPath = path.resolve(
    String(cli.promptPath || merged.FREECONTEXT_PROMPT_PATH || DEFAULT_PROMPT_PATH).replace(
      /^~(?=$|[/\\])/u,
      os.homedir(),
    ),
  );
  if (!(await isReadable(promptPath))) {
    throw new ConfigurationError(`System prompt is not readable: ${promptPath}`);
  }

  const maxTurns = parseInteger(cli.maxTurns ?? merged.FREECONTEXT_MAX_TURNS, 8, {
    min: 2,
    max: 32,
    name: "FREECONTEXT_MAX_TURNS",
  });
  const maxToolCalls = parseInteger(cli.maxToolCalls ?? merged.FREECONTEXT_MAX_TOOL_CALLS, 32, {
    min: 1,
    max: 256,
    name: "FREECONTEXT_MAX_TOOL_CALLS",
  });
  const maxOutputTokens = parseInteger(cli.maxOutputTokens ?? merged.FREECONTEXT_MAX_OUTPUT_TOKENS, 4096, {
    min: 256,
    max: 65536,
    name: "FREECONTEXT_MAX_OUTPUT_TOKENS",
  });
  const maxToolOutputBytes = parseInteger(
    cli.maxToolOutputBytes ?? merged.FREECONTEXT_MAX_TOOL_OUTPUT_BYTES,
    65536,
    { min: 4096, max: 1048576, name: "FREECONTEXT_MAX_TOOL_OUTPUT_BYTES" },
  );
  const contextWindow = parseInteger(cli.contextWindow ?? merged.FREECONTEXT_CONTEXT_WINDOW, 128000, {
    min: 8192,
    max: 4000000,
    name: "FREECONTEXT_CONTEXT_WINDOW",
  });
  const contextCompactionEnabled = parseBoolean(
    cli.contextCompactionEnabled ?? merged.FREECONTEXT_COMPACTION_ENABLED,
    true,
    "FREECONTEXT_COMPACTION_ENABLED",
  );
  const defaultReserveTokens = Math.min(Math.max(16384, maxOutputTokens), Math.floor(contextWindow / 2));
  const contextReserveTokens = parseInteger(
    cli.contextReserveTokens ?? merged.FREECONTEXT_CONTEXT_RESERVE_TOKENS,
    defaultReserveTokens,
    { min: 0, max: 4000000, name: "FREECONTEXT_CONTEXT_RESERVE_TOKENS" },
  );
  const defaultKeepRecentTokens = Math.min(20000, Math.floor((contextWindow - contextReserveTokens) / 2));
  const contextKeepRecentTokens = parseInteger(
    cli.contextKeepRecentTokens ?? merged.FREECONTEXT_CONTEXT_KEEP_RECENT_TOKENS,
    defaultKeepRecentTokens,
    { min: 0, max: 4000000, name: "FREECONTEXT_CONTEXT_KEEP_RECENT_TOKENS" },
  );
  if (
    contextCompactionEnabled &&
    (maxOutputTokens > contextReserveTokens ||
      contextReserveTokens < 1024 ||
      contextKeepRecentTokens < 1024 ||
      contextReserveTokens + contextKeepRecentTokens >= contextWindow)
  ) {
    throw new ConfigurationError(
      "Conflicting context budget: " +
        `FREECONTEXT_MAX_OUTPUT_TOKENS=${maxOutputTokens}, ` +
        `FREECONTEXT_CONTEXT_RESERVE_TOKENS=${contextReserveTokens}, ` +
        `FREECONTEXT_CONTEXT_KEEP_RECENT_TOKENS=${contextKeepRecentTokens}, ` +
        `FREECONTEXT_CONTEXT_WINDOW=${contextWindow}`,
    );
  }
  const effectiveToolOutputBytes = contextCompactionEnabled
    ? Math.min(maxToolOutputBytes, contextKeepRecentTokens * 4)
    : maxToolOutputBytes;

  const config = {
    api,
    authMode,
    apiKey,
    baseUrl,
    model,
    promptPath,
    envFilePath: envFile.path,
    envFileLoaded: envFile.loaded,
    maxTurns,
    maxToolCalls,
    maxOutputTokens,
    requestTimeoutMs: parseInteger(cli.requestTimeoutMs ?? merged.FREECONTEXT_REQUEST_TIMEOUT_MS, 180000, {
      min: 1000,
      max: 1800000,
      name: "FREECONTEXT_REQUEST_TIMEOUT_MS",
    }),
    toolTimeoutMs: parseInteger(cli.toolTimeoutMs ?? merged.FREECONTEXT_TOOL_TIMEOUT_MS, 20000, {
      min: 100,
      max: 300000,
      name: "FREECONTEXT_TOOL_TIMEOUT_MS",
    }),
    maxToolOutputBytes,
    maxParallelTools: parseInteger(
      cli.maxParallelTools ?? merged.FREECONTEXT_MAX_PARALLEL_TOOLS,
      8,
      { min: 1, max: 32, name: "FREECONTEXT_MAX_PARALLEL_TOOLS" },
    ),
    contextWindow,
    contextCompactionEnabled,
    contextReserveTokens,
    contextKeepRecentTokens,
    effectiveToolOutputBytes,
    temperature: parseNumber(cli.temperature ?? merged.FREECONTEXT_TEMPERATURE, 0, {
      min: 0,
      max: 2,
      name: "FREECONTEXT_TEMPERATURE",
    }),
    thinkingLevel: normalizeThinkingLevel(cli.thinkingLevel || merged.FREECONTEXT_THINKING_LEVEL),
    headers: parseJsonObject(cli.headersJson || merged.FREECONTEXT_HEADERS_JSON, {}, "FREECONTEXT_HEADERS_JSON"),
    openAICompat: Object.freeze({
      supportsDeveloperRole: parseBoolean(
        merged.FREECONTEXT_OPENAI_SUPPORTS_DEVELOPER_ROLE,
        false,
        "FREECONTEXT_OPENAI_SUPPORTS_DEVELOPER_ROLE",
      ),
      supportsReasoningEffort: parseBoolean(
        merged.FREECONTEXT_OPENAI_SUPPORTS_REASONING_EFFORT,
        false,
        "FREECONTEXT_OPENAI_SUPPORTS_REASONING_EFFORT",
      ),
      supportsUsageInStreaming: parseBoolean(
        merged.FREECONTEXT_OPENAI_SUPPORTS_USAGE_IN_STREAMING,
        false,
        "FREECONTEXT_OPENAI_SUPPORTS_USAGE_IN_STREAMING",
      ),
      supportsStrictMode: parseBoolean(
        merged.FREECONTEXT_OPENAI_SUPPORTS_STRICT_MODE,
        false,
        "FREECONTEXT_OPENAI_SUPPORTS_STRICT_MODE",
      ),
      supportsStore: false,
      maxTokensField: normalizeMaxTokensField(merged.FREECONTEXT_OPENAI_MAX_TOKENS_FIELD),
    }),
  } satisfies FreeContextConfig;
  return Object.freeze(config);
}
