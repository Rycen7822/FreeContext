import { ConfigurationError } from "../errors.js";
import type { ModelDocument, ProviderDocument } from "./toml.js";
import {
  normalizeApi,
  normalizeAuthMode,
  normalizeBaseUrl,
  normalizeMaxTokensField,
  normalizeThinkingLevel,
  parseInteger,
  parseNumber,
} from "./resolve-values.js";
import type { Environment, FreeContextConfig, RuntimeConfig } from "./types.js";

export function resolveTarget(
  target: string,
  model: ModelDocument,
  provider: ProviderDocument,
  shared: RuntimeConfig,
  promptPath: string,
  configFilePath: string,
  env: Environment,
  requireApiKey: boolean,
): Readonly<FreeContextConfig> {
  const api = normalizeApi(provider.api, `providers.${model.provider}.api`);
  const authMode = normalizeAuthMode(provider.authMode, api, `providers.${model.provider}.auth_mode`);
  const apiKey = env[provider.credentialEnv] || "";
  if (requireApiKey && !apiKey) {
    throw new ConfigurationError(
      `Model target ${target} requires credential environment variable ${provider.credentialEnv}.`,
    );
  }
  if (api === "anthropic" && Object.keys(model.openAICompat).length) {
    throw new ConfigurationError(`models.${target}.openai_compat is only valid for OpenAI-compatible models.`);
  }

  const contextWindow = parseInteger(model.contextWindow, 0, {
    min: 8192,
    max: 4000000,
    name: `models.${target}.context_window`,
  });
  const maxOutputTokens = parseInteger(model.maxOutputTokens, 4096, {
    min: 256,
    max: 65536,
    name: `models.${target}.max_output_tokens`,
  });
  const defaultReserve = Math.min(Math.max(16384, maxOutputTokens), Math.floor(contextWindow / 2));
  const contextReserveTokens = parseInteger(model.contextReserveTokens, defaultReserve, {
    min: 0,
    max: 4000000,
    name: `models.${target}.context_reserve_tokens`,
  });
  const defaultKeepRecent = Math.min(20000, Math.floor((contextWindow - contextReserveTokens) / 2));
  const contextKeepRecentTokens = parseInteger(model.contextKeepRecentTokens, defaultKeepRecent, {
    min: 0,
    max: 4000000,
    name: `models.${target}.context_keep_recent_tokens`,
  });
  if (
    shared.contextCompactionEnabled &&
    (maxOutputTokens > contextReserveTokens ||
      contextReserveTokens < 1024 ||
      contextKeepRecentTokens < 1024 ||
      contextReserveTokens + contextKeepRecentTokens >= contextWindow)
  ) {
    throw new ConfigurationError(`models.${target} has a conflicting context budget.`);
  }

  return Object.freeze({
    target,
    provider: model.provider,
    api,
    authMode,
    apiKey,
    baseUrl: normalizeBaseUrl(provider.baseUrl, `providers.${model.provider}.base_url`),
    model: model.modelId,
    promptPath,
    configFilePath,
    ...shared,
    maxOutputTokens,
    contextWindow,
    contextReserveTokens,
    contextKeepRecentTokens,
    effectiveToolOutputBytes: shared.contextCompactionEnabled
      ? Math.min(shared.maxToolOutputBytes, contextKeepRecentTokens * 4)
      : shared.maxToolOutputBytes,
    temperature: parseNumber(model.temperature, 0, {
      min: 0,
      max: 2,
      name: `models.${target}.temperature`,
    }),
    thinkingLevel: normalizeThinkingLevel(model.thinkingLevel, `models.${target}.thinking_level`),
    headers: provider.headers,
    openAICompat: Object.freeze({
      supportsDeveloperRole: model.openAICompat.supportsDeveloperRole ?? false,
      supportsReasoningEffort: model.openAICompat.supportsReasoningEffort ?? false,
      supportsUsageInStreaming: model.openAICompat.supportsUsageInStreaming ?? false,
      supportsStrictMode: model.openAICompat.supportsStrictMode ?? false,
      supportsRequiredToolChoice: model.openAICompat.supportsRequiredToolChoice ?? true,
      supportsStore: false,
      maxTokensField: normalizeMaxTokensField(
        model.openAICompat.maxTokensField,
        `models.${target}.openai_compat.max_tokens_field`,
      ),
    }),
  });
}
