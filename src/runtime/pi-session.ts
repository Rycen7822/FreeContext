import type {
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentMessage,
  AgentTool,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage, SimpleStreamOptions, Usage } from "@earendil-works/pi-ai";
import type { FreeContextConfig } from "../config.js";
import { ContextBudgetError, ProviderError } from "../errors.js";
import { estimateEffectiveContextTokens, estimateInitialRequestTokens, selectCompactionCut } from "./context-budget.js";
import type { ContextTokenCounter } from "./context-budget.js";
import { compactContext } from "./context-compaction.js";
import { FINALIZATION_SYSTEM_PROMPT } from "./finalization.js";
import type { FreeContextModel } from "./model.js";
import { redactProviderError } from "./model.js";
import { normalizeAssistantFailure, normalizeProviderFailure } from "./provider-failure.js";
import type { ProviderFailureSignal } from "./provider-failure.js";
import { retryProviderMessage } from "./provider-retry.js";
import type { ProviderAttempt, ProviderRetryCallbacks } from "./provider-retry.js";
import type { PiBindings } from "./pi-bindings.js";
import { addUsage, EMPTY_USAGE } from "./usage.js";

export const EXPLORER_MAX_TURNS = 24;
export const EXPLORER_MAX_TOOL_CALLS = 64;
export const PI_SOFT_FINALIZATION_MS = 180_000;

export type FinalizationReason = "turn_limit" | "tool_limit" | "soft_deadline";

export type FreeContextRuntimeEvent =
  | AgentEvent
  | {
      readonly type: "compaction_start";
      readonly reason: "threshold";
      readonly attempt: number;
      readonly tokensBefore: number;
    }
  | {
      readonly type: "compaction_end";
      readonly reason: "threshold";
      readonly attempt: number;
      readonly tokensBefore: number;
      readonly estimatedTokensAfter: number;
      readonly durationMs: number;
    }
  | {
      readonly type: "provider_attempt_failed";
      readonly scope: "primary" | "compaction";
      readonly attempt: number;
      readonly willRetry: boolean;
      readonly failure: Readonly<ProviderFailureSignal>;
      readonly usage: Readonly<Usage>;
    }
  | {
      readonly type: "provider_retry_scheduled";
      readonly scope: "primary" | "compaction";
      readonly attempt: number;
      readonly maxRetries: number;
      readonly baseDelayMs: number;
      readonly delayMs: number;
      readonly category: ProviderError["category"];
      readonly failure: Readonly<ProviderFailureSignal>;
    }
  | {
      readonly type: "provider_retry_start";
      readonly scope: "primary" | "compaction";
      readonly attempt: number;
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
  readonly providerRetries: number;
  readonly finalizationReason: FinalizationReason | null;
  readonly blockedToolCalls: number;
  readonly usage: Readonly<Usage>;
  readonly compactions: number;
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
  readonly explorationTools: readonly AgentTool[];
  readonly terminalFailure: "provider" | "aborted" | null;
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
  readonly softFinalizationMs?: number;
  readonly clock?: () => number;
  readonly timestamp?: () => number;
  readonly tokenCounter?: ContextTokenCounter;
}

export function visibleAssistantText(message: AgentMessage | undefined): string {
  if (!message || message.role !== "assistant") return "";
  return message.content
    .filter((block): block is Extract<AssistantMessage["content"][number], { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

function lastAssistant(messages: readonly AgentMessage[]): AssistantMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant") return message;
  }
  return undefined;
}

function withoutAssistant(messages: readonly AgentMessage[], assistant: AssistantMessage): AgentMessage[] {
  const index = messages.lastIndexOf(assistant);
  return index < 0 ? [...messages] : [...messages.slice(0, index), ...messages.slice(index + 1)];
}

function providerError(value: unknown, config: Readonly<FreeContextConfig>, allowFallback = false): ProviderError {
  const failure = normalizeProviderFailure(value, { provider: config.provider, baseUrl: config.baseUrl });
  return new ProviderError(
    redactProviderError(value instanceof Error ? value.message : value, config),
    {
      cause: value,
      category: failure.category,
      ...(failure.statusCode !== null ? { statusCode: failure.statusCode } : {}),
      safeToFallback: allowFallback,
    },
  );
}

function retryCallbacks(
  emit: (event: Exclude<FreeContextRuntimeEvent, AgentEvent>) => Promise<void>,
  recordRetry: () => void,
): Readonly<ProviderRetryCallbacks> {
  return {
    onFailure: async ({ failedMessage, failure, attempt, willRetry }) => {
      await emit({ type: "provider_attempt_failed", scope: "primary", attempt, willRetry, failure, usage: failedMessage.usage });
    },
    onRetryScheduled: async ({ failure, attempt, maxRetries, baseDelayMs, delayMs }) => {
      await emit({ type: "provider_retry_scheduled", scope: "primary", attempt, maxRetries, baseDelayMs, delayMs, category: failure.category, failure });
    },
    onRetryStart: async ({ attempt }) => {
      recordRetry();
      await emit({ type: "provider_retry_start", scope: "primary", attempt });
    },
  };
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
  softFinalizationMs,
  clock = performance.now.bind(performance),
  timestamp = Date.now,
}: PiSessionOptions, counter: ContextTokenCounter | null): Promise<Readonly<PiSessionResult>> {
  const turnBudget = Math.min(maxTurns, EXPLORER_MAX_TURNS);
  const toolCallBudget = Math.min(maxToolCalls, EXPLORER_MAX_TOOL_CALLS);
  const startedAt = clock();
  const effectiveMessages = [...initialMessages];
  const allMessages: AgentMessage[] = [];
  let effectiveSystemPrompt = systemPrompt;
  let effectiveTools = [...tools];
  let turns = 0;
  let toolCalls = 0;
  let providerAttempts = 0;
  let providerRetries = 0;
  let blockedToolCalls = 0;
  let compactions = 0;
  let compactionMs = 0;
  let tokensBeforeLastCompaction = 0;
  let estimatedTokensAfterLastCompaction = 0;
  let compactionUsage = EMPTY_USAGE;
  let toolExecutionMsTotal = 0;
  let toolExecutionMsMax = 0;
  let finalizationReason: FinalizationReason | null = null;
  let softFinalizationPending = false;
  let stopTools = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let latestStreamText = "";
  const toolStarts = new Map<string, number>();
  const emitCustom = async (event: Exclude<FreeContextRuntimeEvent, AgentEvent>): Promise<void> => {
    await onEvent?.(event, { turnCount: turns, toolCallCount: toolCalls, providerAttempts });
  };
  const emit = async (event: AgentEvent): Promise<void> => {
    if (event.type === "turn_start") {
      providerAttempts += 1;
    }
    if (event.type === "tool_execution_start") toolStarts.set(event.toolCallId, clock());
    if (event.type === "tool_execution_end") {
      const started = toolStarts.get(event.toolCallId);
      if (started !== undefined) {
        const duration = Math.max(0, clock() - started);
        toolExecutionMsTotal += duration;
        toolExecutionMsMax = Math.max(toolExecutionMsMax, duration);
        toolStarts.delete(event.toolCallId);
      }
    }
    if (event.type === "turn_end") {
      turns += 1;
    }
    if (event.type === "message_start" || event.type === "message_update" || event.type === "message_end") {
      const text = visibleAssistantText(event.message);
      if (text) latestStreamText = text;
    }
    await onEvent?.(event, { turnCount: turns, toolCallCount: toolCalls, providerAttempts });
  };

  const clearTimer = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  timer = setTimeout(() => {
    timer = null;
    if (finalizationReason === null) {
      softFinalizationPending = true;
    }
  }, Math.max(0, softFinalizationMs ?? PI_SOFT_FINALIZATION_MS));
  (timer as unknown as { unref?: () => void }).unref?.();

  const compact = async (messages: readonly AgentMessage[]): Promise<readonly AgentMessage[]> => {
    if (!counter || !config.contextCompactionEnabled) return messages;
    const cut = await selectCompactionCut(messages, config.contextKeepRecentTokens, counter);
    if (!cut) return messages;
    const attempt = compactions + 1;
    await emitCustom({ type: "compaction_start", reason: "threshold", attempt, tokensBefore: cut.tokensBefore });
    const result = await compactContext({
      cut,
      bindings,
      model,
      requestOptions,
      config,
      tokenCounter: counter,
      ...(signal ? { signal } : {}),
      clock,
      timestamp,
      providerRetryCallbacks: retryCallbacks(emitCustom, () => { providerRetries += 1; }),
    });
    compactions += 1;
    compactionMs += result.durationMs;
    tokensBeforeLastCompaction = result.tokensBefore;
    estimatedTokensAfterLastCompaction = result.estimatedTokensAfter;
    compactionUsage = addUsage(compactionUsage, result.usage);
    await emitCustom({ type: "compaction_end", reason: "threshold", attempt, tokensBefore: result.tokensBefore, estimatedTokensAfter: result.estimatedTokensAfter, durationMs: result.durationMs });
    return result.contextMessages;
  };

  const prepareContext = async (): Promise<void> => {
    if (!counter || !config.contextCompactionEnabled) return;
    const snapshot = await estimateInitialRequestTokens({
      systemPrompt: effectiveSystemPrompt,
      promptText,
      messages: effectiveMessages,
      tools: effectiveTools,
      counter,
      contextWindow: model.contextWindow,
      reserveTokens: config.contextReserveTokens,
    });
    if (snapshot.totalTokens > snapshot.availableTokens) {
      const compacted = await compact(effectiveMessages);
      effectiveMessages.splice(0, effectiveMessages.length, ...compacted);
      const after = await estimateEffectiveContextTokens(effectiveMessages, counter);
      if (after > snapshot.availableTokens) throw new ContextBudgetError("Initial FreeContext request exceeds the model context window.");
    }
  };

  const finalizationMessage = (): AgentMessage => ({
    role: "user",
    content: "Soft deadline: stop using repository tools. Answer now from current findings. Keep paths, symbols, numbers, commands, and errors exact; omit filler.",
    timestamp: timestamp(),
  });
  const loopConfig: AgentLoopConfig = {
    ...requestOptions,
    model,
    convertToLlm: bindings.convertToLlm,
    toolExecution: "parallel",
    beforeToolCall: async () => {
      if (stopTools || softFinalizationPending) {
        blockedToolCalls += 1;
        return { block: true, reason: "Stop using repository tools and answer from current findings." };
      }
      if (turns >= EXPLORER_MAX_TURNS || toolCalls >= EXPLORER_MAX_TOOL_CALLS || turns >= turnBudget || toolCalls >= toolCallBudget) {
        blockedToolCalls += 1;
        finalizationReason = toolCalls >= toolCallBudget ? "tool_limit" : "turn_limit";
        stopTools = true;
        return { block: true, reason: "Exploration budget reached. Answer from current findings." };
      }
      toolCalls += 1;
      return undefined;
    },
    prepareNextTurn: async ({ context }) => {
      if (softFinalizationPending) {
        softFinalizationPending = false;
        stopTools = true;
        finalizationReason = "soft_deadline";
        effectiveSystemPrompt = `${systemPrompt}\n\n${FINALIZATION_SYSTEM_PROMPT}`;
        context.systemPrompt = effectiveSystemPrompt;
        context.messages = [...context.messages, finalizationMessage()];
        return { context };
      }
      if (config.contextCompactionEnabled && counter && !stopTools) {
        try {
          const tokens = await estimateEffectiveContextTokens(context.messages, counter);
          if (bindings.shouldCompact(tokens, model.contextWindow, {
            enabled: true,
            reserveTokens: config.contextReserveTokens,
            keepRecentTokens: config.contextKeepRecentTokens,
          })) {
            context.messages = [...(await compact(context.messages))];
          }
        } catch {
          // Context compaction is an optimization; the worker answer is more valuable.
        }
      }
      return undefined;
    },
    shouldStopAfterTurn: async ({ message, toolResults }) => {
      const text = visibleAssistantText(message);
      const calls = message.content.some((block) => block.type === "toolCall");
      if (text && (!calls || stopTools)) return true;
      if (toolResults.length === 0 && stopTools) return true;
      return turns >= EXPLORER_MAX_TURNS || toolCalls >= EXPLORER_MAX_TOOL_CALLS;
    },
  };

  await prepareContext();
  const prompt: AgentMessage = { role: "user", content: promptText, timestamp: timestamp() };
  const stream = (target: Parameters<PiBindings["streamSimple"]>[0], context: Parameters<PiBindings["streamSimple"]>[1], options: Parameters<PiBindings["streamSimple"]>[2]) => bindings.streamSimple(target, context, options);
  const context: AgentContext = { systemPrompt: effectiveSystemPrompt, messages: [...effectiveMessages], tools: [...effectiveTools] };
  let terminalFailure: PiSessionResult["terminalFailure"] = null;
  let assistant: AssistantMessage | undefined;
  let retryUsage = EMPTY_USAGE;
  const makeResult = (text: string): Readonly<PiSessionResult> => Object.freeze({
    text,
    messages: Object.freeze(allMessages),
    explorationTools: Object.freeze([...tools]),
    terminalFailure,
    metrics: Object.freeze({
      turns,
      toolCalls,
      providerAttempts,
      providerRetries,
      finalizationReason,
      blockedToolCalls,
      usage: Object.freeze(addUsage(summarizeUsage(allMessages), retryUsage)),
      compactions,
      compactionMs,
      tokensBeforeLastCompaction,
      estimatedTokensAfterLastCompaction,
      compactionUsage: Object.freeze(compactionUsage),
      toolExecutionMsTotal,
      toolExecutionMsMax,
      sessionMs: Math.max(0, clock() - startedAt),
    }),
  });

  try {
    const newMessages = await bindings.runAgentLoop([prompt], context, loopConfig, emit, signal, stream);
    allMessages.push(...newMessages);
    effectiveMessages.push(...newMessages);
    assistant = lastAssistant(newMessages);
  } catch (error) {
    terminalFailure = signal?.aborted ? "aborted" : "provider";
    clearTimer();
    if (latestStreamText) return makeResult(latestStreamText);
    throw providerError(error, config, true);
  }

  if (!assistant) {
    clearTimer();
    if (latestStreamText) return makeResult(latestStreamText);
    throw providerError("Provider returned no assistant answer.", config, true);
  }
  const latestText = (): string => {
    for (let index = allMessages.length - 1; index >= 0; index -= 1) {
      const text = visibleAssistantText(allMessages[index]);
      if (text) return text;
    }
    return "";
  };
  const assistantFailure = (message: AssistantMessage): Readonly<ProviderFailureSignal> | null => (
    message.stopReason === "error" ? normalizeAssistantFailure(message, { provider: config.provider, baseUrl: config.baseUrl }) : null
  );
  const attemptOf = (message: AssistantMessage): ProviderAttempt => ({ message, failure: assistantFailure(message) });
  const continueLoop = async (): Promise<AssistantMessage> => {
    const nextMessages = await bindings.runAgentLoopContinue(
      { systemPrompt: effectiveSystemPrompt, messages: [...effectiveMessages], tools: [...effectiveTools] },
      loopConfig,
      emit,
      signal,
      stream,
    );
    allMessages.push(...nextMessages);
    effectiveMessages.push(...nextMessages);
    const next = lastAssistant(nextMessages);
    if (!next) throw providerError("Provider continuation returned no assistant answer.", config, true);
    return next;
  };
  if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
    const priorText = latestText();
    if (!priorText) {
      const recovered = await retryProviderMessage(
        attemptOf(assistant),
        async (failed) => {
          effectiveMessages.splice(0, effectiveMessages.length, ...withoutAssistant(effectiveMessages, failed.message));
          return attemptOf(await continueLoop());
        },
        { delaysMs: config.providerRetryDelaysMs },
        signal,
        retryCallbacks(emitCustom, () => { providerRetries += 1; }),
      );
      assistant = recovered.message;
      retryUsage = recovered.message.usage;
      terminalFailure = assistant.stopReason === "error" ? "provider" : assistant.stopReason === "aborted" ? "aborted" : null;
    } else {
      terminalFailure = "provider";
    }
  }
  const text = latestText() || visibleAssistantText(assistant);
  clearTimer();
  return makeResult(text);
}

function summarizeUsage(messages: readonly AgentMessage[]): Usage {
  let usage = EMPTY_USAGE;
  for (const message of messages) if (message.role === "assistant") usage = addUsage(usage, message.usage);
  return usage;
}

async function runSession(options: PiSessionOptions): Promise<Readonly<PiSessionResult>> {
  if (options.tokenCounter) return runPiSessionWithCounter(options, options.tokenCounter);
  const tokenCounter = new (await import("./gigatoken-counter.js")).GigatokenCounter();
  try {
    return await runPiSessionWithCounter(options, tokenCounter);
  } finally {
    await tokenCounter.close();
  }
}

export async function runPiSession(options: PiSessionOptions): Promise<Readonly<PiSessionResult>> {
  return runSession(options);
}
