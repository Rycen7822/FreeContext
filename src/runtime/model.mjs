import { ConfigurationError } from "../errors.mjs";

const ZERO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

function findHeaderKey(headers, expected) {
  const normalized = expected.toLowerCase();
  return Object.keys(headers).find((key) => key.toLowerCase() === normalized);
}

function setHeader(headers, name, value) {
  const current = findHeaderKey(headers, name);
  if (current) headers[current] = value;
  else headers[name] = value;
}

export function createModel(config) {
  const api = config.api === "anthropic" ? "anthropic-messages" : "openai-completions";
  const compat =
    config.api === "anthropic"
      ? {
          supportsEagerToolInputStreaming: false,
          supportsLongCacheRetention: false,
          sendSessionAffinityHeaders: false,
          supportsCacheControlOnTools: false,
          supportsTemperature: true,
          forceAdaptiveThinking: false,
          allowEmptySignature: true,
          supportsStrictTools: false,
          supportsToolReferences: false,
        }
      : {
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
          thinkingFormat: "openai",
          supportsOpenAIGrammarTools: false,
          sendSessionAffinityHeaders: false,
          supportsLongCacheRetention: false,
        };

  return Object.freeze({
    id: config.model,
    name: config.model,
    api,
    provider: "freecontext-custom",
    baseUrl: config.baseUrl,
    reasoning: config.thinkingLevel !== "off",
    input: ["text"],
    cost: ZERO_COST,
    contextWindow: config.contextWindow,
    maxTokens: config.maxOutputTokens,
    compat,
  });
}

export function createRequestOptions(config) {
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

  return Object.freeze({
    apiKey,
    headers: Object.freeze(headers),
    temperature: config.temperature,
    maxTokens: config.maxOutputTokens,
    timeoutMs: config.requestTimeoutMs,
    maxRetries: 1,
    maxRetryDelayMs: 15000,
    cacheRetention: "none",
    reasoning: config.thinkingLevel === "off" ? undefined : config.thinkingLevel,
  });
}

export function redactProviderError(message, config) {
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
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) {
    text = text.split(secret).join("<redacted>");
  }
  return text.length > 4000 ? `${text.slice(0, 4000)}…` : text;
}
