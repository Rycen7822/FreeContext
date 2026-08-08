import type * as AgentCore from "@earendil-works/pi-agent-core";
import type * as PiAi from "@earendil-works/pi-ai";
import { ConfigurationError } from "../errors.js";
import type { ApiProtocol } from "../config.js";

const API_LOADERS = {
  anthropic: () => import("@earendil-works/pi-ai/api/anthropic-messages"),
  openai: () => import("@earendil-works/pi-ai/api/openai-completions"),
} as const;

export interface PiBindings {
  readonly runAgentLoop: typeof AgentCore.runAgentLoop;
  readonly runAgentLoopContinue: typeof AgentCore.runAgentLoopContinue;
  readonly convertToLlm: typeof AgentCore.convertToLlm;
  readonly estimateContextTokens: typeof AgentCore.estimateContextTokens;
  readonly estimateTokens: typeof AgentCore.estimateTokens;
  readonly shouldCompact: typeof AgentCore.shouldCompact;
  readonly serializeConversation: typeof AgentCore.serializeConversation;
  readonly createCompactionSummaryMessage: typeof AgentCore.createCompactionSummaryMessage;
  readonly uuidv7: typeof AgentCore.uuidv7;
  readonly Type: typeof PiAi.Type;
  readonly streamSimple: AgentCore.StreamFn;
  readonly isContextOverflow: typeof PiAi.isContextOverflow;
}

function assertBinding(name: string, value: unknown, expected: "function" | "object"): void {
  if (typeof value !== expected || value === null) {
    throw new ConfigurationError(`Injected Pi binding is missing or invalid: ${name}`);
  }
}

function validateBindings(bindings: PiBindings): Readonly<PiBindings> {
  assertBinding("runAgentLoop", bindings.runAgentLoop, "function");
  assertBinding("runAgentLoopContinue", bindings.runAgentLoopContinue, "function");
  assertBinding("convertToLlm", bindings.convertToLlm, "function");
  assertBinding("estimateContextTokens", bindings.estimateContextTokens, "function");
  assertBinding("estimateTokens", bindings.estimateTokens, "function");
  assertBinding("shouldCompact", bindings.shouldCompact, "function");
  assertBinding("serializeConversation", bindings.serializeConversation, "function");
  assertBinding("createCompactionSummaryMessage", bindings.createCompactionSummaryMessage, "function");
  assertBinding("uuidv7", bindings.uuidv7, "function");
  assertBinding("Type", bindings.Type, typeof bindings.Type === "function" ? "function" : "object");
  assertBinding("streamSimple", bindings.streamSimple, "function");
  assertBinding("isContextOverflow", bindings.isContextOverflow, "function");
  return Object.freeze(bindings);
}

export async function loadPiBindings(
  api: ApiProtocol,
  overrides: PiBindings | null = null,
): Promise<Readonly<PiBindings>> {
  if (overrides) return validateBindings(overrides);

  const loadProvider = API_LOADERS[api];
  try {
    const [agent, ai, provider] = await Promise.all([
      import("@earendil-works/pi-agent-core"),
      import("@earendil-works/pi-ai"),
      loadProvider(),
    ]);
    const providerStreams: PiAi.ProviderStreams = provider;
    const bindings: PiBindings = {
      runAgentLoop: agent.runAgentLoop,
      runAgentLoopContinue: agent.runAgentLoopContinue,
      convertToLlm: agent.convertToLlm,
      estimateContextTokens: agent.estimateContextTokens,
      estimateTokens: agent.estimateTokens,
      shouldCompact: agent.shouldCompact,
      serializeConversation: agent.serializeConversation,
      createCompactionSummaryMessage: agent.createCompactionSummaryMessage,
      uuidv7: agent.uuidv7,
      Type: ai.Type,
      streamSimple: providerStreams.streamSimple,
      isContextOverflow: ai.isContextOverflow,
    };
    return validateBindings(bindings);
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    throw new ConfigurationError(
      "Pi runtime could not be loaded. Install dependencies with `npm install` under Node.js 22.19 or newer.",
      { cause: error },
    );
  }
}
