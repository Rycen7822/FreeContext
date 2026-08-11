import type {
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentMessage,
  AgentTool,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage, SimpleStreamOptions, Usage } from "@earendil-works/pi-ai";
import type { FreeContextConfig } from "../config.js";
import { ContextBudgetError, FreeContextError, ProviderError } from "../errors.js";
import {
  assertInitialRequestFits,
  estimateEffectiveContextTokens,
  estimateInitialRequestTokens,
  selectCompactionCut,
} from "./context-budget.js";
import type { CompactionCut, ContextTokenCounter } from "./context-budget.js";
import { compactContext } from "./context-compaction.js";
import { GigatokenCounter } from "./gigatoken-counter.js";
import type { FreeContextModel } from "./model.js";
import { redactProviderError } from "./model.js";
import { classifyProviderFailure, providerStatusCode } from "./provider-failure.js";
import type { PiBindings } from "./pi-bindings.js";

const FINALIZE_MESSAGE = Object.freeze({
  role: "user" as const,
  content:
    "The repository exploration budget is exhausted. Do not request more tools. Using only evidence already present in the transcript, return the required <final_answer> block now with at most 12 strong citations. Keep the summary concise and reserve output for gaps and the closing </final_answer> tag.",
  timestamp: 0,
});

const ZERO_USAGE: Usage = Object.freeze({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  totalTokens: 0,
  cost: Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }),
});

export type CompactionReason = "threshold" | "overflow";

export type FreeContextRuntimeEvent =
  | AgentEvent
  | {
      readonly type: "compaction_start";
      readonly reason: CompactionReason;
      readonly attempt: number;
      readonly tokensBefore: number;
    }
  | {
      readonly type: "compaction_end";
      readonly reason: CompactionReason;
      readonly attempt: number;
      readonly tokensBefore: number;
      readonly estimatedTokensAfter: number;
      readonly durationMs: number;
    }
  | {
      readonly type: "overflow_retry";
      readonly attempt: 1;
      readonly tokensBefore: number;
      readonly estimatedTokensAfter: number;
    };

export interface PiSessionEventState {
  readonly turnCount: number;
  readonly toolCallCount: number;
  readonly providerAttempts: number;
}

export type PiSessionEventHandler = (
  event: FreeContextRuntimeEvent,
  state: PiSessionEventState,
) => Promise<void> | void;

export interface PiSessionMetrics {
  readonly turns: number;
  readonly toolCalls: number;
  readonly providerAttempts: number;
  readonly finalizationInjected: boolean;
  readonly usage: Readonly<Usage>;
  readonly compactions: number;
  readonly thresholdCompactions: number;
  readonly overflowCompactions: number;
  readonly overflowRetries: number;
  readonly compactionMs: number;
  readonly tokensBeforeLastCompaction: number;
  readonly estimatedTokensAfterLastCompaction: number;
  readonly compactionUsage: Readonly<Usage>;
  readonly toolExecutionMsTotal: number;
  readonly toolExecutionMsMax: number;
  readonly sessionMs: number;
}

export interface PiSessionResult {
  readonly text: string;
  readonly messages: readonly AgentMessage[];
  readonly contextMessages: readonly AgentMessage[];
  readonly metrics: Readonly<PiSessionMetrics>;
}

export interface PiSessionOptions {
  readonly bindings: PiBindings;
  readonly model: FreeContextModel;
  readonly requestOptions: Readonly<SimpleStreamOptions>;
  readonly config: FreeContextConfig;
  readonly systemPrompt: string;
  readonly promptText: string;
  readonly tools: readonly AgentTool[];
  readonly initialMessages?: readonly AgentMessage[];
  readonly maxTurns?: number;
  readonly maxToolCalls?: number;
  readonly signal?: AbortSignal;
  readonly onEvent?: PiSessionEventHandler;
  readonly clock?: () => number;
  readonly timestamp?: () => number;
  readonly tokenCounter?: ContextTokenCounter;
}

function addUsage(left: Usage, right: Usage): Usage {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    ...(left.cacheWrite1h !== undefined || right.cacheWrite1h !== undefined
      ? { cacheWrite1h: (left.cacheWrite1h ?? 0) + (right.cacheWrite1h ?? 0) }
      : {}),
    ...(left.reasoning !== undefined || right.reasoning !== undefined
      ? { reasoning: (left.reasoning ?? 0) + (right.reasoning ?? 0) }
      : {}),
    totalTokens: left.totalTokens + right.totalTokens,
    cost: {
      input: left.cost.input + right.cost.input,
      output: left.cost.output + right.cost.output,
      cacheRead: left.cost.cacheRead + right.cost.cacheRead,
      cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
      total: left.cost.total + right.cost.total,
    },
  };
}

export function extractAssistantText(message: AgentMessage | undefined): string {
  if (!message || message.role !== "assistant") return "";
  return message.content
    .filter((block): block is Extract<AssistantMessage["content"][number], { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

function summarizeUsage(messages: readonly AgentMessage[]): Usage {
  let usage = ZERO_USAGE;
  for (const message of messages) {
    if (message.role === "assistant") usage = addUsage(usage, message.usage);
  }
  return usage;
}

function lastAssistant(messages: readonly AgentMessage[]): AssistantMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant") return message;
  }
  return undefined;
}

async function runPiSessionWithCounter({
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
  clock = performance.now.bind(performance),
  timestamp = Date.now,
}: PiSessionOptions, tokenCounter: ContextTokenCounter | null): Promise<Readonly<PiSessionResult>> {
  const sessionStartedAt = clock();
  const counter = (): ContextTokenCounter => {
    if (!tokenCounter) throw new ContextBudgetError("Context compaction requires the Gigatoken counter.");
    return tokenCounter;
  };
  const compactionSettings = {
    enabled: config.contextCompactionEnabled,
    reserveTokens: config.contextReserveTokens,
    keepRecentTokens: config.contextKeepRecentTokens,
  };

  let turnCount = 0;
  let toolCallCount = 0;
  let providerAttempts = 0;
  let finalizationInjected = false;
  let overflowRecovered = false;
  let effectiveMessages = [...initialMessages];
  let effectiveTools = [...tools];
  let loopReportedContext = false;
  let compactions = 0;
  let thresholdCompactions = 0;
  let overflowCompactions = 0;
  let overflowRetries = 0;
  let compactionMs = 0;
  let tokensBeforeLastCompaction = 0;
  let estimatedTokensAfterLastCompaction = 0;
  let compactionUsage = ZERO_USAGE;
  let toolExecutionMsTotal = 0;
  let toolExecutionMsMax = 0;
  const toolStarts = new Map<string, number>();

  const providerError = (value: unknown, allowFallback = false): ProviderError => {
    const statusCode = providerStatusCode(value);
    return new ProviderError(
      redactProviderError(value instanceof Error ? value.message : value, config),
      {
        cause: value,
        category: classifyProviderFailure(value),
        ...(statusCode !== undefined ? { statusCode } : {}),
        safeToFallback: allowFallback && toolCallCount === 0 && !signal?.aborted,
      },
    );
  };

  const eventState = (): PiSessionEventState => ({ turnCount, toolCallCount, providerAttempts });
  const emitCustom = async (event: Exclude<FreeContextRuntimeEvent, AgentEvent>): Promise<void> => {
    await onEvent?.(event, eventState());
  };
  const emit = async (event: AgentEvent): Promise<void> => {
    if (event.type === "turn_start") providerAttempts += 1;
    if (event.type === "turn_end") {
      const overflow = event.message.role === "assistant" && bindings.isContextOverflow(event.message, model.contextWindow);
      if (!overflow) turnCount += 1;
    } else if (event.type === "tool_execution_start") {
      toolStarts.set(event.toolCallId, clock());
    } else if (event.type === "tool_execution_end") {
      const startedAt = toolStarts.get(event.toolCallId);
      if (startedAt !== undefined) {
        const duration = Math.max(0, clock() - startedAt);
        toolExecutionMsTotal += duration;
        toolExecutionMsMax = Math.max(toolExecutionMsMax, duration);
        toolStarts.delete(event.toolCallId);
      }
    }
    await onEvent?.(event, eventState());
  };

  const runCompaction = async (
    messages: readonly AgentMessage[],
    reason: CompactionReason,
    preparedCut: CompactionCut | null = null,
  ): Promise<readonly AgentMessage[]> => {
    const cut = preparedCut ?? await selectCompactionCut(messages, config.contextKeepRecentTokens, counter());
    if (!cut) {
      throw new ContextBudgetError(`Context ${reason} recovery has no valid compressible message span.`);
    }
    const attempt = compactions + 1;
    await emitCustom({ type: "compaction_start", reason, attempt, tokensBefore: cut.tokensBefore });
    const result = await compactContext({
      cut,
      bindings,
      model,
      requestOptions,
      config,
      tokenCounter: counter(),
      ...(signal ? { signal } : {}),
      clock,
      timestamp,
    });
    compactions += 1;
    if (reason === "threshold") thresholdCompactions += 1;
    else overflowCompactions += 1;
    compactionMs += result.durationMs;
    tokensBeforeLastCompaction = result.tokensBefore;
    estimatedTokensAfterLastCompaction = result.estimatedTokensAfter;
    compactionUsage = addUsage(compactionUsage, result.usage);
    await emitCustom({
      type: "compaction_end",
      reason,
      attempt,
      tokensBefore: result.tokensBefore,
      estimatedTokensAfter: result.estimatedTokensAfter,
      durationMs: result.durationMs,
    });
    return result.contextMessages;
  };

  const admission = (): ReturnType<typeof estimateInitialRequestTokens> =>
    estimateInitialRequestTokens({
      systemPrompt,
      promptText,
      messages: effectiveMessages,
      tools: effectiveTools,
      counter: counter(),
      contextWindow: model.contextWindow,
      reserveTokens: config.contextReserveTokens,
    });

  if (config.contextCompactionEnabled) {
    let snapshot = await admission();
    const initialCut = snapshot.totalTokens > snapshot.availableTokens
      ? await selectCompactionCut(effectiveMessages, config.contextKeepRecentTokens, counter())
      : null;
    assertInitialRequestFits(snapshot, initialCut);
    if (snapshot.totalTokens > snapshot.availableTokens) {
      effectiveMessages = [...(await runCompaction(effectiveMessages, "threshold", initialCut))];
      snapshot = await admission();
      if (snapshot.totalTokens > snapshot.availableTokens) {
        throw new ContextBudgetError(
          `Compacted initial request still requires approximately ${snapshot.totalTokens} tokens; ` +
            `${snapshot.availableTokens} are available.`,
        );
      }
    }
  }

  const prompt: AgentMessage = { role: "user", content: promptText, timestamp: timestamp() };
  const loopConfig: AgentLoopConfig = {
    ...requestOptions,
    model,
    convertToLlm: bindings.convertToLlm,
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
      loopReportedContext = true;
      let nextContext: AgentContext = context;
      const exhausted = turnCount >= maxTurns - 1 || toolCallCount >= maxToolCalls;
      if (!finalizationInjected && toolResults.length > 0 && exhausted) {
        finalizationInjected = true;
        nextContext = {
          ...context,
          tools: [],
          messages: [...context.messages, { ...FINALIZE_MESSAGE, timestamp: timestamp() }],
        };
      }
      if (config.contextCompactionEnabled) {
        const tokens = await estimateEffectiveContextTokens(nextContext.messages, counter());
        if (bindings.shouldCompact(tokens, model.contextWindow, compactionSettings)) {
          nextContext = {
            ...nextContext,
            messages: [...(await runCompaction(nextContext.messages, "threshold"))],
          };
        }
      }
      effectiveMessages = [...nextContext.messages];
      effectiveTools = [...(nextContext.tools ?? [])];
      return nextContext === context ? undefined : { context: nextContext };
    },
    shouldStopAfterTurn: async ({ context }) => {
      loopReportedContext = true;
      effectiveMessages = [...context.messages];
      effectiveTools = [...(context.tools ?? [])];
      return turnCount >= maxTurns;
    },
  };

  const runInitialLoop = async (): Promise<AgentMessage[]> =>
    await bindings.runAgentLoop(
      [prompt],
      { systemPrompt, messages: [...effectiveMessages], tools: [...effectiveTools] },
      loopConfig,
      emit,
      signal,
      bindings.streamSimple,
    );

  let newMessages: AgentMessage[];
  try {
    newMessages = await runInitialLoop();
  } catch (error) {
    if (error instanceof FreeContextError) throw error;
    throw providerError(error, true);
  }
  const allNewMessages = [...newMessages];
  if (!loopReportedContext) {
    effectiveMessages = [...effectiveMessages, ...newMessages];
  }

  let assistant = lastAssistant(newMessages);
  if (!assistant) throw providerError("Provider returned no assistant message.", true);
  const overflow = bindings.isContextOverflow(assistant, model.contextWindow);
  if (overflow && config.contextCompactionEnabled && !overflowRecovered) {
    overflowRecovered = true;
    const overflowAssistant = assistant;
    const identityIndex = effectiveMessages.lastIndexOf(overflowAssistant);
    const overflowIndex = identityIndex >= 0
      ? identityIndex
      : effectiveMessages.findLastIndex(
          (message) =>
            message.role === "assistant" &&
            message.timestamp === overflowAssistant.timestamp &&
            message.provider === overflowAssistant.provider &&
            message.model === overflowAssistant.model &&
            message.errorMessage === overflowAssistant.errorMessage &&
            bindings.isContextOverflow(message, model.contextWindow),
        );
    const withoutOverflow = overflowIndex >= 0
      ? [...effectiveMessages.slice(0, overflowIndex), ...effectiveMessages.slice(overflowIndex + 1)]
      : [...effectiveMessages];
    effectiveMessages = [...(await runCompaction(withoutOverflow, "overflow"))];
    overflowRetries = 1;
    await emitCustom({
      type: "overflow_retry",
      attempt: 1,
      tokensBefore: tokensBeforeLastCompaction,
      estimatedTokensAfter: estimatedTokensAfterLastCompaction,
    });
    try {
      loopReportedContext = false;
      const continued = await bindings.runAgentLoopContinue(
        { systemPrompt, messages: [...effectiveMessages], tools: [...effectiveTools] },
        loopConfig,
        emit,
        signal,
        bindings.streamSimple,
      );
      allNewMessages.push(...continued);
      if (!loopReportedContext) {
        effectiveMessages.push(...continued);
      }
      assistant = lastAssistant(continued);
    } catch (error) {
      if (error instanceof FreeContextError) throw error;
      throw providerError(error);
    }
    if (!assistant) throw providerError("Provider continuation returned no assistant message.");
  }

  if (bindings.isContextOverflow(assistant, model.contextWindow)) {
    throw providerError(assistant.errorMessage || "Provider context overflow persisted after recovery.");
  }
  if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
    throw providerError(assistant.errorMessage, assistant.stopReason === "error");
  }

  return Object.freeze({
    text: extractAssistantText(assistant),
    messages: Object.freeze(allNewMessages),
    contextMessages: Object.freeze([...effectiveMessages]),
    metrics: Object.freeze({
      turns: turnCount,
      toolCalls: toolCallCount,
      providerAttempts,
      finalizationInjected,
      usage: Object.freeze(summarizeUsage(allNewMessages)),
      compactions,
      thresholdCompactions,
      overflowCompactions,
      overflowRetries,
      compactionMs,
      tokensBeforeLastCompaction,
      estimatedTokensAfterLastCompaction,
      compactionUsage: Object.freeze(compactionUsage),
      toolExecutionMsTotal,
      toolExecutionMsMax,
      sessionMs: Math.max(0, clock() - sessionStartedAt),
    }),
  });
}

export async function runPiSession(options: PiSessionOptions): Promise<Readonly<PiSessionResult>> {
  if (options.tokenCounter) return runPiSessionWithCounter(options, options.tokenCounter);
  if (!options.config.contextCompactionEnabled) return runPiSessionWithCounter(options, null);

  const tokenCounter = new GigatokenCounter();
  try {
    return await runPiSessionWithCounter(options, tokenCounter);
  } finally {
    await tokenCounter.close();
  }
}
