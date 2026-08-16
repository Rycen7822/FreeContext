import { readFile, stat } from "node:fs/promises";
import { parse } from "smol-toml";
import { ConfigurationError } from "../errors.js";
import {
  asTable,
  assertKnownKeys,
  optionalBoolean,
  optionalIntegerArray,
  optionalNumber,
  optionalString,
  parseHeaders,
  requiredString,
  stringArray,
  validateEnvironmentName,
  validateId,
} from "./toml-values.js";

const MAX_CONFIG_BYTES = 1024 * 1024;

export interface RuntimeDocument {
  readonly promptPath?: string;
  readonly maxTurns?: number;
  readonly maxToolCalls?: number;
  readonly requestTimeoutMs?: number;
  readonly providerRetryDelaysMs?: readonly number[];
  readonly toolTimeoutMs?: number;
  readonly maxToolOutputBytes?: number;
  readonly maxParallelTools?: number;
  readonly contextCompactionEnabled?: boolean;
}

export interface ProviderDocument {
  readonly api: string;
  readonly baseUrl: string;
  readonly authMode?: string;
  readonly credentialEnv: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface OpenAICompatDocument {
  readonly supportsDeveloperRole?: boolean;
  readonly supportsReasoningEffort?: boolean;
  readonly supportsUsageInStreaming?: boolean;
  readonly supportsStrictMode?: boolean;
  readonly supportsRequiredToolChoice?: boolean;
  readonly maxTokensField?: string;
  readonly thinkingFormat?: string;
}

export interface ModelDocument {
  readonly provider: string;
  readonly modelId: string;
  readonly contextWindow: number;
  readonly maxOutputTokens?: number;
  readonly contextReserveTokens?: number;
  readonly contextKeepRecentTokens?: number;
  readonly temperature?: number;
  readonly thinkingLevel?: string;
  readonly openAICompat: Readonly<OpenAICompatDocument>;
}

export interface RouteDocument {
  readonly models: readonly string[];
  readonly fallbackOn: readonly string[];
}

export interface ConfigDocument {
  readonly defaultRoute: string;
  readonly runtime: Readonly<RuntimeDocument>;
  readonly providers: Readonly<Record<string, Readonly<ProviderDocument>>>;
  readonly models: Readonly<Record<string, Readonly<ModelDocument>>>;
  readonly routes: Readonly<Record<string, Readonly<RouteDocument>>>;
}

function parseRuntime(value: unknown): Readonly<RuntimeDocument> {
  if (value === undefined) return Object.freeze({});
  const table = asTable(value, "runtime");
  assertKnownKeys(table, [
    "prompt_path",
    "max_turns",
    "max_tool_calls",
    "request_timeout_ms",
    "provider_retry_delays_ms",
    "tool_timeout_ms",
    "max_tool_output_bytes",
    "max_parallel_tools",
    "context_compaction_enabled",
  ], "runtime");
  const promptPath = optionalString(table, "prompt_path", "runtime");
  const maxTurns = optionalNumber(table, "max_turns", "runtime");
  const maxToolCalls = optionalNumber(table, "max_tool_calls", "runtime");
  const requestTimeoutMs = optionalNumber(table, "request_timeout_ms", "runtime");
  const providerRetryDelaysMs = optionalIntegerArray(table, "provider_retry_delays_ms", "runtime");
  const toolTimeoutMs = optionalNumber(table, "tool_timeout_ms", "runtime");
  const maxToolOutputBytes = optionalNumber(table, "max_tool_output_bytes", "runtime");
  const maxParallelTools = optionalNumber(table, "max_parallel_tools", "runtime");
  const contextCompactionEnabled = optionalBoolean(table, "context_compaction_enabled", "runtime");
  return Object.freeze({
    ...(promptPath !== undefined ? { promptPath } : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    ...(maxToolCalls !== undefined ? { maxToolCalls } : {}),
    ...(requestTimeoutMs !== undefined ? { requestTimeoutMs } : {}),
    ...(providerRetryDelaysMs !== undefined ? { providerRetryDelaysMs } : {}),
    ...(toolTimeoutMs !== undefined ? { toolTimeoutMs } : {}),
    ...(maxToolOutputBytes !== undefined ? { maxToolOutputBytes } : {}),
    ...(maxParallelTools !== undefined ? { maxParallelTools } : {}),
    ...(contextCompactionEnabled !== undefined ? { contextCompactionEnabled } : {}),
  });
}

function parseProviders(value: unknown): Readonly<Record<string, Readonly<ProviderDocument>>> {
  const table = asTable(value, "providers");
  const providers: Record<string, Readonly<ProviderDocument>> = {};
  for (const [rawId, rawProvider] of Object.entries(table)) {
    const id = validateId(rawId, `provider id ${JSON.stringify(rawId)}`);
    const location = `providers.${id}`;
    const provider = asTable(rawProvider, location);
    assertKnownKeys(provider, ["api", "base_url", "auth_mode", "credential_env", "headers"], location);
    const credentialEnv = requiredString(provider, "credential_env", location);
    validateEnvironmentName(credentialEnv, `${location}.credential_env`);
    const authMode = optionalString(provider, "auth_mode", location);
    providers[id] = Object.freeze({
      api: requiredString(provider, "api", location),
      baseUrl: requiredString(provider, "base_url", location),
      credentialEnv,
      headers: parseHeaders(provider.headers, `${location}.headers`),
      ...(authMode !== undefined ? { authMode } : {}),
    });
  }
  if (!Object.keys(providers).length) throw new ConfigurationError("providers must define at least one provider.");
  return Object.freeze(providers);
}

function parseOpenAICompat(value: unknown, location: string): Readonly<OpenAICompatDocument> {
  if (value === undefined) return Object.freeze({});
  const table = asTable(value, location);
  assertKnownKeys(table, [
    "supports_developer_role",
    "supports_reasoning_effort",
    "supports_usage_in_streaming",
    "supports_strict_mode",
    "supports_required_tool_choice",
    "max_tokens_field",
    "thinking_format",
  ], location);
  const supportsDeveloperRole = optionalBoolean(table, "supports_developer_role", location);
  const supportsReasoningEffort = optionalBoolean(table, "supports_reasoning_effort", location);
  const supportsUsageInStreaming = optionalBoolean(table, "supports_usage_in_streaming", location);
  const supportsStrictMode = optionalBoolean(table, "supports_strict_mode", location);
  const supportsRequiredToolChoice = optionalBoolean(table, "supports_required_tool_choice", location);
  const maxTokensField = optionalString(table, "max_tokens_field", location);
  const thinkingFormat = optionalString(table, "thinking_format", location);
  return Object.freeze({
    ...(supportsDeveloperRole !== undefined ? { supportsDeveloperRole } : {}),
    ...(supportsReasoningEffort !== undefined ? { supportsReasoningEffort } : {}),
    ...(supportsUsageInStreaming !== undefined ? { supportsUsageInStreaming } : {}),
    ...(supportsStrictMode !== undefined ? { supportsStrictMode } : {}),
    ...(supportsRequiredToolChoice !== undefined ? { supportsRequiredToolChoice } : {}),
    ...(maxTokensField !== undefined ? { maxTokensField } : {}),
    ...(thinkingFormat !== undefined ? { thinkingFormat } : {}),
  });
}

function parseModels(value: unknown): Readonly<Record<string, Readonly<ModelDocument>>> {
  const table = asTable(value, "models");
  const models: Record<string, Readonly<ModelDocument>> = {};
  for (const [rawId, rawModel] of Object.entries(table)) {
    const id = validateId(rawId, `model id ${JSON.stringify(rawId)}`);
    const location = `models.${id}`;
    const model = asTable(rawModel, location);
    assertKnownKeys(model, [
      "provider",
      "model_id",
      "context_window",
      "max_output_tokens",
      "context_reserve_tokens",
      "context_keep_recent_tokens",
      "temperature",
      "thinking_level",
      "openai_compat",
    ], location);
    const maxOutputTokens = optionalNumber(model, "max_output_tokens", location);
    const contextReserveTokens = optionalNumber(model, "context_reserve_tokens", location);
    const contextKeepRecentTokens = optionalNumber(model, "context_keep_recent_tokens", location);
    const temperature = optionalNumber(model, "temperature", location);
    const thinkingLevel = optionalString(model, "thinking_level", location);
    const contextWindow = optionalNumber(model, "context_window", location);
    if (contextWindow === undefined) throw new ConfigurationError(`${location}.context_window is required.`);
    models[id] = Object.freeze({
      provider: requiredString(model, "provider", location),
      modelId: requiredString(model, "model_id", location),
      contextWindow,
      openAICompat: parseOpenAICompat(model.openai_compat, `${location}.openai_compat`),
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      ...(contextReserveTokens !== undefined ? { contextReserveTokens } : {}),
      ...(contextKeepRecentTokens !== undefined ? { contextKeepRecentTokens } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
      ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
    });
  }
  if (!Object.keys(models).length) throw new ConfigurationError("models must define at least one model.");
  return Object.freeze(models);
}

function parseRoutes(value: unknown): Readonly<Record<string, Readonly<RouteDocument>>> {
  const table = asTable(value, "routes");
  const routes: Record<string, Readonly<RouteDocument>> = {};
  for (const [rawId, rawRoute] of Object.entries(table)) {
    const id = validateId(rawId, `route id ${JSON.stringify(rawId)}`);
    const location = `routes.${id}`;
    const route = asTable(rawRoute, location);
    assertKnownKeys(route, ["models", "fallback_on"], location);
    const models = stringArray(route, "models", location);
    if (!models.length) throw new ConfigurationError(`${location}.models must contain at least one model.`);
    routes[id] = Object.freeze({
      models: Object.freeze(models),
      fallbackOn: Object.freeze(
        stringArray(route, "fallback_on", location, ["timeout", "rate_limit", "server_error", "connection"]),
      ),
    });
  }
  if (!Object.keys(routes).length) throw new ConfigurationError("routes must define at least one route.");
  return Object.freeze(routes);
}

export async function loadTomlConfig(filePath: string): Promise<Readonly<ConfigDocument>> {
  let source: string;
  try {
    const metadata = await stat(filePath);
    if (!metadata.isFile()) throw new ConfigurationError(`Configuration path is not a file: ${filePath}`);
    if (metadata.size > MAX_CONFIG_BYTES) {
      throw new ConfigurationError(`Configuration file exceeds ${MAX_CONFIG_BYTES} bytes: ${filePath}`);
    }
    source = await readFile(filePath, "utf8");
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    throw new ConfigurationError(`Configuration file is not readable: ${filePath}`, { cause: error });
  }

  let parsed: unknown;
  try {
    parsed = parse(source);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ConfigurationError(`Invalid TOML configuration at ${filePath}: ${detail}`, { cause: error });
  }

  const root = asTable(parsed, "configuration");
  assertKnownKeys(root, ["version", "default_route", "runtime", "providers", "models", "routes"], "configuration");
  if (root.version !== 1) throw new ConfigurationError("configuration.version must be 1.");
  return Object.freeze({
    defaultRoute: validateId(requiredString(root, "default_route", "configuration"), "configuration.default_route"),
    runtime: parseRuntime(root.runtime),
    providers: parseProviders(root.providers),
    models: parseModels(root.models),
    routes: parseRoutes(root.routes),
  });
}
