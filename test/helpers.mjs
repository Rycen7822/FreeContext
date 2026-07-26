export const FakeType = new Proxy(
  {},
  {
    get: (_target, name) => (...args) => ({ kind: String(name), args }),
  },
);

export function baseConfig(overrides = {}) {
  return {
    api: "anthropic",
    authMode: "auto",
    apiKey: "sk-test-secret",
    baseUrl: "https://example.invalid",
    model: "test-model",
    promptPath: new URL("../prompts/explorer.md", import.meta.url).pathname,
    envFilePath: "/tmp/freecontext-test.env",
    envFileLoaded: true,
    maxTurns: 4,
    maxToolCalls: 8,
    maxOutputTokens: 1024,
    requestTimeoutMs: 2000,
    toolTimeoutMs: 2000,
    maxToolOutputBytes: 8192,
    maxParallelTools: 4,
    contextWindow: 32768,
    temperature: 0,
    thinkingLevel: "off",
    headers: {},
    openAICompat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsUsageInStreaming: false,
      supportsStrictMode: false,
      supportsStore: false,
      maxTokensField: "max_tokens",
    },
    ...overrides,
  };
}

export function assistantText(text, overrides = {}) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "freecontext-custom",
    model: "test-model",
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
    ...overrides,
  };
}
