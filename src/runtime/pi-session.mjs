import { ProviderError } from "../errors.mjs";
import { redactProviderError } from "./model.mjs";

const FINALIZE_MESSAGE = Object.freeze({
  role: "user",
  content:
    "The repository exploration budget is exhausted. Do not request more tools. Using only evidence already present in the transcript, return the required <final_answer> block now.",
  timestamp: 0,
});

function standardMessages(messages) {
  try {
    return messages.filter((message) => ["user", "assistant", "toolResult"].includes(message?.role));
  } catch {
    return [];
  }
}

export function extractAssistantText(message) {
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return "";
  return message.content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("")
    .trim();
}

function summarizeUsage(messages) {
  const usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    totalTokens: 0,
  };
  for (const message of messages) {
    if (message?.role !== "assistant" || !message.usage) continue;
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]) {
      usage[key] += Number(message.usage[key] || 0);
    }
    usage.reasoning += Number(message.usage.reasoning || 0);
  }
  return usage;
}

export async function runPiSession({
  bindings,
  model,
  requestOptions,
  config,
  systemPrompt,
  promptText,
  tools,
  initialMessages = [],
  maxTurns = config.maxTurns,
  maxToolCalls = config.maxToolCalls,
  signal,
  onEvent,
}) {
  let turnCount = 0;
  let toolCallCount = 0;
  let finalizationInjected = false;
  const prompt = { role: "user", content: promptText, timestamp: Date.now() };

  const emit = async (event) => {
    if (event.type === "turn_start") turnCount += 1;
    await onEvent?.(event, { turnCount, toolCallCount });
  };

  const loopConfig = {
    ...requestOptions,
    model,
    convertToLlm: standardMessages,
    toolExecution: "parallel",
    beforeToolCall: async () => {
      toolCallCount += 1;
      if (toolCallCount > maxToolCalls) {
        return {
          block: true,
          reason: `Repository exploration tool-call budget exceeded (${maxToolCalls}). Finalize from existing evidence.`,
        };
      }
      return undefined;
    },
    prepareNextTurn: async ({ context, toolResults }) => {
      const exhausted = turnCount >= maxTurns - 1 || toolCallCount >= maxToolCalls;
      if (!finalizationInjected && toolResults.length > 0 && exhausted) {
        finalizationInjected = true;
        return {
          context: {
            ...context,
            tools: [],
            messages: [
              ...context.messages,
              { ...FINALIZE_MESSAGE, timestamp: Date.now() },
            ],
          },
        };
      }
      return undefined;
    },
    shouldStopAfterTurn: async () => turnCount >= maxTurns,
  };

  let newMessages;
  try {
    newMessages = await bindings.runAgentLoop(
      [prompt],
      { systemPrompt, messages: [...initialMessages], tools: [...tools] },
      loopConfig,
      emit,
      signal,
      bindings.streamSimple,
    );
  } catch (error) {
    throw new ProviderError(redactProviderError(error?.message || error, config), { cause: error });
  }

  const assistants = newMessages.filter((message) => message?.role === "assistant");
  const lastAssistant = assistants.at(-1);
  if (!lastAssistant) throw new ProviderError("Provider returned no assistant message.");
  if (["error", "aborted"].includes(lastAssistant.stopReason)) {
    throw new ProviderError(redactProviderError(lastAssistant.errorMessage, config));
  }

  return Object.freeze({
    text: extractAssistantText(lastAssistant),
    messages: Object.freeze([...newMessages]),
    metrics: Object.freeze({
      turns: turnCount,
      toolCalls: toolCallCount,
      finalizationInjected,
      usage: Object.freeze(summarizeUsage(newMessages)),
    }),
  });
}
