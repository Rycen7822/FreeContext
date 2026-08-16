import type { Model, ModelCost, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { ConfigurationError } from "../errors.js";
import type { FreeContextConfig } from "../config.js";

const ZERO_COST: Readonly<ModelCost> = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

function findHeaderKey(headers: Readonly<Record<string, string>>, expected: string): string | undefined {
  const normalized = expected.toLowerCase();
  return Object.keys(headers).find((key) => key.toLowerCase() === normalized);
}

function setHeader(headers: Record<string, string>, name: string, value: string): void {
  const current = findHeaderKey(headers, name);
  if (current) headers[current] = value;
  else headers[name] = value;
}

type AnthropicModel = Model<"anthropic-messages"> & {
  readonly compat: NonNullable<Model<"anthropic-messages">["compat"]>;
};
type OpenAIModel = Model<"openai-completions"> & {
  readonly compat: NonNullable<Model<"openai-completions">["compat"]>;
};
export type FreeContextModel = AnthropicModel | OpenAIModel;

export interface FreeContextRequestOptions extends SimpleStreamOptions {
  readonly headers: Readonly<Record<string, string>>;
}

export function createModel(config: FreeContextConfig): Readonly<FreeContextModel> {
  if (config.api === "anthropic") {
    return Object.freeze({
      id: config.model,
      name: config.model,
      api: "anthropic-messages",
      provider: "freecontext-custom",
      baseUrl: config.baseUrl,
      reasoning: config.thinkingLevel !== "off",
      input: ["text"],
      cost: ZERO_COST,
      contextWindow: config.contextWindow,
      maxTokens: config.maxOutputTokens,
      compat: {
          supportsEagerToolInputStreaming: false,
          supportsLongCacheRetention: false,
          sendSessionAffinityHeaders: false,
          supportsCacheControlOnTools: false,
          supportsTemperature: true,
          forceAdaptiveThinking: false,
          allowEmptySignature: true,
          supportsStrictTools: false,
          supportsToolReferences: false,
      },
    } satisfies Model<"anthropic-messages">);
  }

  return Object.freeze({
    id: config.model,
    name: config.model,
    api: "openai-completions",
    provider: "freecontext-custom",
    baseUrl: config.baseUrl,
    reasoning: config.thinkingLevel !== "off" || config.openAICompat.thinkingFormat === "deepseek",
    input: ["text"],
    cost: ZERO_COST,
    contextWindow: config.contextWindow,
    maxTokens: config.maxOutputTokens,
    compat: {
          supportsStore: false,
          supportsDeveloperRole: config.openAICompat.supportsDeveloperRole,
          supportsReasoningEffort: config.openAICompat.supportsReasoningEffort,
          supportsUsageInStreaming: config.openAICompat.supportsUsageInStreaming,
          supportsStrictMode: config.openAICompat.supportsStrictMode,
          maxTokensField: config.openAICompat.maxTokensField,
          requiresToolResultName: false,
          requiresAssistantAfterToolResult: false,
          requiresThinkingAsText: false,
          requiresReasoningContentOnAssistantMessages: false,
          thinkingFormat: config.openAICompat.thinkingFormat,
          supportsOpenAIGrammarTools: false,
          sendSessionAffinityHeaders: false,
          supportsLongCacheRetention: false,
    },
  } satisfies Model<"openai-completions">);
}

export function createRequestOptions(config: FreeContextConfig): Readonly<FreeContextRequestOptions> {
  const headers = { ...config.headers };
  let apiKey;

  switch (config.authMode) {
    case "auto":
      apiKey = config.apiKey;
      break;
    case "bearer":
      if (!findHeaderKey(headers, "authorization")) setHeader(headers, "Authorization", `Bearer ${config.apiKey}`);
      break;
    case "x-api-key":
      if (config.api !== "anthropic") {
        throw new ConfigurationError("x-api-key authentication requires the Anthropic Messages protocol.");
      }
      if (!findHeaderKey(headers, "x-api-key")) setHeader(headers, "x-api-key", config.apiKey);
      break;
    case "both":
      apiKey = config.apiKey;
      if (!findHeaderKey(headers, "authorization")) setHeader(headers, "Authorization", `Bearer ${config.apiKey}`);
      break;
    default:
      throw new ConfigurationError(`Unsupported authentication mode: ${config.authMode}`);
  }

  const options: FreeContextRequestOptions = {
    headers: Object.freeze(headers),
    temperature: config.temperature,
    maxTokens: config.maxOutputTokens,
    timeoutMs: config.requestTimeoutMs,
    maxRetries: 0,
    cacheRetention: "none",
  };
  if (apiKey) options.apiKey = apiKey;
  if (config.thinkingLevel !== "off") options.reasoning = config.thinkingLevel;
  return Object.freeze(options);
}

export function redactProviderError(message: unknown, config: FreeContextConfig): string {
  let text = String(message || "Provider request failed.");
  const secrets = [config.apiKey];
  try {
    const endpoint = new URL(config.baseUrl);
    if (endpoint.username) secrets.push(decodeURIComponent(endpoint.username));
    if (endpoint.password) secrets.push(decodeURIComponent(endpoint.password));
    for (const value of endpoint.searchParams.values()) secrets.push(value);
  } catch {
    // Base URL validity is checked during configuration resolution.
  }
  for (const [key, value] of Object.entries(config.headers || {})) {
    if (/authorization|api[-_]?key|token|secret|credential|cookie/iu.test(key)) {
      secrets.push(value);
      const credential = String(value).match(/^(?:Bearer|Basic)\s+(.+)$/iu)?.[1];
      if (credential) secrets.push(credential);
    }
  }
  for (const secret of secrets.filter((value): value is string => Boolean(value)).sort((a, b) => b.length - a.length)) {
    text = text.split(secret).join("<redacted>");
  }
  return text.length > 4000 ? `${text.slice(0, 4000)}…` : text;
}
