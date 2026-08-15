import {
  convertToLlm,
  createCompactionSummaryMessage,
  estimateContextTokens,
  estimateTokens,
  runAgentLoopContinue,
  serializeConversation,
  shouldCompact,
  uuidv7,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream, isContextOverflow, Type } from "@earendil-works/pi-ai";
import type { FreeContextConfig, ResolvedRouteConfig } from "../src/config.js";
import type { FreeContextRequest } from "../src/mcp/contracts.js";
import type { PiBindings } from "../src/runtime/pi-bindings.js";

export const FakeType = new Proxy(
  {},
  {
    get: (_target, name) => (...args: unknown[]) => ({ kind: String(name), args }),
  },
) as unknown as typeof Type;

export function baseRequest(): Readonly<FreeContextRequest> {
  return {
    taskText: "Inspect the fixture.",
    knownRefs: [],
    evidenceQuestions: [
      { id: "impl", role: "implementation", question: "Where is the implementation?", required: true },
      { id: "tests", role: "test", question: "Where is it tested?", required: false },
    ],
  };
}

export function baseConfig(overrides: Partial<FreeContextConfig> = {}): FreeContextConfig {
  return {
    target: "test",
    provider: "test-provider",
    api: "anthropic",
    authMode: "auto",
    apiKey: "sk-test-secret",
    baseUrl: "https://example.invalid",
    model: "test-model",
    promptPath: new URL("../prompts/explorer.md", import.meta.url).pathname,
    configFilePath: "/tmp/freecontext-test.toml",
    maxTurns: 5,
    maxToolCalls: 18,
    maxOutputTokens: 1024,
    requestTimeoutMs: 2000,
    providerRetryDelaysMs: [1, 2, 4],
    toolTimeoutMs: 2000,
    maxToolOutputBytes: 8192,
    maxParallelTools: 4,
    contextWindow: 32768,
    contextCompactionEnabled: true,
    contextReserveTokens: 16384,
    contextKeepRecentTokens: 8192,
    effectiveToolOutputBytes: 8192,
    temperature: 0,
    thinkingLevel: "off",
    headers: {},
    openAICompat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsUsageInStreaming: false,
      supportsStrictMode: false,
      supportsRequiredToolChoice: true,
      supportsStore: false,
      maxTokensField: "max_tokens",
    },
    ...overrides,
  };
}

export function baseRouteConfig(
  targets: readonly FreeContextConfig[] = [baseConfig()],
  overrides: Partial<ResolvedRouteConfig> = {},
): ResolvedRouteConfig {
  return {
    route: "test-route",
    configFilePath: "/tmp/freecontext-test.toml",
    fallbackOn: ["timeout", "rate_limit", "server_error"],
    targets,
    ...overrides,
  };
}

export function assistantText(text: string, overrides: Partial<AssistantMessage> = {}): AssistantMessage {
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

export function fakeBindings(
  runAgentLoop: PiBindings["runAgentLoop"],
  overrides: Partial<PiBindings> = {},
): PiBindings {
  return {
    runAgentLoop,
    runAgentLoopContinue,
    convertToLlm,
    estimateContextTokens,
    estimateTokens,
    shouldCompact,
    serializeConversation,
    createCompactionSummaryMessage,
    uuidv7,
    Type,
    streamSimple: () => {
      const stream = createAssistantMessageEventStream();
      stream.end(assistantText("summary"));
      return stream;
    },
    isContextOverflow,
    ...overrides,
  };
}
