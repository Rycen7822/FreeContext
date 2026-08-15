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
import { parseExplorerCandidate } from "../output/evidence.js";
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
import { normalizeAssistantFailure, normalizeProviderFailure } from "./provider-failure.js";
import type { ProviderFailureSignal } from "./provider-failure.js";
import { retryProviderMessage } from "./provider-retry.js";
import type { ProviderAttempt, ProviderRetryCallbacks } from "./provider-retry.js";
import type { PiBindings } from "./pi-bindings.js";
import { addUsage, EMPTY_USAGE } from "./usage.js";

const FINALIZE_MESSAGE = Object.freeze({
  role: "user" as const,
  content:
    "The repository exploration budget is exhausted. Do not request more tools. Using only evidence already present in the transcript, return the required <final_answer> block now with at most 6 role/question/focus evidence spans. Keep the summary concise, name every unresolved question under gaps, and reserve output for the closing </final_answer> tag.",
  timestamp: 0,
});
export const EXPLORER_MAX_TURNS = 5;
export const EXPLORER_MAX_TOOL_CALLS = 18;

export type CompactionReason = "threshold" | "overflow";
export type FinalizationReason = "coverage" | "partial_candidate" | "stagnation" | "turn_limit" | "tool_limit";

export interface TurnEvidenceProgress {
  readonly turn: number;
  readonly newKeys: readonly string[];
  readonly totalKeys: number;
}

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

function createProviderRetryCallbacks(
  scope: "primary" | "compaction",
  emit: (event: Exclude<FreeContextRuntimeEvent, AgentEvent>) => Promise<void>,
  recordRetryStart: () => void,
): Readonly<ProviderRetryCallbacks> {
  return {
    onFailure: async ({ failedMessage, failure, attempt, willRetry }) => {
      await emit({ type: "provider_attempt_failed", scope, attempt, willRetry, failure, usage: failedMessage.usage });
    },
    onRetryScheduled: async ({ failure, attempt, maxRetries, baseDelayMs, delayMs }) => {
      await emit({
        type: "provider_retry_scheduled",
        scope,
        attempt,
        maxRetries,
        baseDelayMs,
        delayMs,
        category: failure.category,
        failure,
      });
    },
    onRetryStart: async ({ attempt }) => {
      recordRetryStart();
      await emit({ type: "provider_retry_start", scope, attempt });
    },
  };
}

export interface PiSessionMetrics {
  readonly turns: number;
  readonly toolCalls: number;
  readonly providerAttempts: number;
  readonly providerRetries: number;
  readonly finalizationInjected: boolean;
  readonly finalizationReason: FinalizationReason | null;
  readonly blockedToolCalls: number;
  readonly evidenceProgress: readonly Readonly<TurnEvidenceProgress>[];
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

export function extractAssistantText(message: AgentMessage | undefined): string {
  if (!message || message.role !== "assistant") return "";
  return message.content
    .filter((block): block is Extract<AssistantMessage["content"][number], { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

function normalizedEvidenceKey(
  toolName: string,
  details: unknown,
  fallbackText = "",
): string | null {
  if (toolName !== "read" && toolName !== "rg" && toolName !== "glob" && toolName !== "bat") return null;
  if (details && typeof details === "object") {
    const value = details as Record<string, unknown>;
    const target = typeof value.path === "string" ? value.path.replace(/\\/gu, "/").toLowerCase() : ".";
    if (toolName === "read" || toolName === "bat") {
      const start = Number(value.startLine ?? 1);
      const end = Number(value.actualEndLine ?? value.endLine ?? start);
      return `${toolName}:${target}:${start}-${end}`;
    }
    const pattern = typeof value.pattern === "string" ? value.pattern.replace(/\s+/gu, " ").trim() : "";
    return `${toolName}:${target}:${pattern}`;
  }
  const header = fallbackText.split(/\r?\n/u, 1)[0]?.trim().toLowerCase();
  return header ? `${toolName}:${header}` : null;
}

function requiredEvidence(promptText: string): ReadonlyMap<string, string> {
  const required = new Map<string, string>();
  for (const match of promptText.matchAll(/- \[([^\]]+)\]\[([^\]]+)\]\[required\]/gu)) {
    const role = match[1];
    const questionId = match[2];
    if (role && questionId) required.set(questionId, role);
  }
  return required;
}

function candidateCompletion(
  text: string,
  required: ReadonlyMap<string, string>,
): "coverage" | "partial_candidate" | null {
  const candidate = parseExplorerCandidate(text);
  if (candidate.block === null || candidate.problems.length > 0) return null;
  const coverage = new Map(candidate.evidence.map((item) => [item.questionId, item.role]));
  return [...required].every(([questionId, role]) => coverage.get(questionId) === role)
    ? "coverage"
    : "partial_candidate";
}

function summarizeUsage(messages: readonly AgentMessage[]): Usage {
  let usage = EMPTY_USAGE;
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

function withoutAssistant(
  messages: readonly AgentMessage[],
  assistant: AssistantMessage,
): AgentMessage[] {
  const identityIndex = messages.lastIndexOf(assistant);
  const index = identityIndex >= 0
    ? identityIndex
    : messages.findLastIndex(
        (message) =>
          message.role === "assistant" &&
          message.timestamp === assistant.timestamp &&
          message.provider === assistant.provider &&
          message.model === assistant.model &&
          message.errorMessage === assistant.errorMessage,
      );
  return index >= 0 ? [...messages.slice(0, index), ...messages.slice(index + 1)] : [...messages];
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
  const turnLimit = Math.min(maxTurns, EXPLORER_MAX_TURNS);
  const toolCallLimit = Math.min(maxToolCalls, EXPLORER_MAX_TOOL_CALLS);
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
  let providerRetries = 0;
  let finalizationInjected = false;
  let finalizationReason: FinalizationReason | null = null;
  let blockedToolCalls = 0;
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
  let compactionUsage = EMPTY_USAGE;
  let toolExecutionMsTotal = 0;
  let toolExecutionMsMax = 0;
  const toolStarts = new Map<string, number>();
  const allEvidenceKeys = new Set<string>();
  const currentTurnKeys = new Set<string>();
  const evidenceProgress: TurnEvidenceProgress[] = [];
  const requiredQuestions = requiredEvidence(promptText);
  let currentProgressRecorded = false;
  let stagnantTurns = 0;

  const addEvidenceKey = (key: string | null): void => {
    if (!key || allEvidenceKeys.has(key)) return;
    allEvidenceKeys.add(key);
    currentTurnKeys.add(key);
  };
  const recordEvidenceProgress = (): void => {
    if (currentProgressRecorded) return;
    const newKeys = Object.freeze([...currentTurnKeys].sort());
    evidenceProgress.push(Object.freeze({
      turn: Math.max(1, turnCount + 1),
      newKeys,
      totalKeys: allEvidenceKeys.size,
    }));
    stagnantTurns = newKeys.length === 0 ? stagnantTurns + 1 : 0;
    currentProgressRecorded = true;
  };
  const requestFinalization = (reason: FinalizationReason): void => {
    finalizationReason ??= reason;
  };

  const providerError = (value: unknown, allowFallback = false): ProviderError => {
    const failure = normalizeProviderFailure(value, { provider: config.provider, baseUrl: config.baseUrl });
    return new ProviderError(
      redactProviderError(value instanceof Error ? value.message : value, config),
      {
        cause: value,
        category: failure.category,
        ...(failure.statusCode !== null ? { statusCode: failure.statusCode } : {}),
        safeToFallback: allowFallback && toolCallCount === 0 && !signal?.aborted,
      },
    );
  };
  const assistantFailures = new WeakMap<AssistantMessage, Readonly<ProviderFailureSignal> | null>();
  const assistantFailure = (message: AssistantMessage): Readonly<ProviderFailureSignal> | null => {
    if (assistantFailures.has(message)) return assistantFailures.get(message) ?? null;
    const failure = message.stopReason === "error" && !bindings.isContextOverflow(message, model.contextWindow)
      ? normalizeAssistantFailure(message, { provider: config.provider, baseUrl: config.baseUrl })
      : null;
    assistantFailures.set(message, failure);
    return failure;
  };
  const attemptOf = (message: AssistantMessage): ProviderAttempt => ({ message, failure: assistantFailure(message) });

  const eventState = (): PiSessionEventState => ({ turnCount, toolCallCount, providerAttempts });
  const emitCustom = async (event: Exclude<FreeContextRuntimeEvent, AgentEvent>): Promise<void> => {
    await onEvent?.(event, eventState());
  };
  const emit = async (event: AgentEvent): Promise<void> => {
    if (event.type === "turn_start") {
      providerAttempts += 1;
      currentTurnKeys.clear();
      currentProgressRecorded = false;
    }
    if (event.type === "turn_end") {
      const overflow = event.message.role === "assistant" && bindings.isContextOverflow(event.message, model.contextWindow);
      const transientFailure = event.message.role === "assistant" && Boolean(assistantFailure(event.message)?.retryable);
      if (!overflow && !transientFailure) {
        recordEvidenceProgress();
        turnCount += 1;
      }
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
      if (!event.isError) {
        addEvidenceKey(normalizedEvidenceKey(event.toolName, event.result.details));
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
    providerAttempts += 1;
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
      providerRetryCallbacks: createProviderRetryCallbacks("compaction", emitCustom, () => {
        providerAttempts += 1;
        providerRetries += 1;
      }),
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
      if (toolCallCount >= toolCallLimit) {
        blockedToolCalls += 1;
        requestFinalization("tool_limit");
        return {
          block: true,
          reason: `Repository exploration tool-call budget reached (${toolCallLimit}). Finalize from existing evidence.`,
        };
      }
      toolCallCount += 1;
      return undefined;
    },
    prepareNextTurn: async ({ context, toolResults }) => {
      loopReportedContext = true;
      let nextContext: AgentContext = context;
      for (const result of toolResults) {
        const text = result.content
          .flatMap((block) => block.type === "text" ? [block.text] : [])
          .join("\n");
        addEvidenceKey(normalizedEvidenceKey(result.toolName, null, text));
      }
      recordEvidenceProgress();
      const completedTurns = Math.max(turnCount, evidenceProgress.length);
      if (toolCallCount >= toolCallLimit) requestFinalization("tool_limit");
      else if (completedTurns >= turnLimit - 1) requestFinalization("turn_limit");
      else if (stagnantTurns >= 2) requestFinalization("stagnation");
      if (!finalizationInjected && finalizationReason !== null) {
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
    shouldStopAfterTurn: async ({ context, message }) => {
      loopReportedContext = true;
      effectiveMessages = [...context.messages];
      effectiveTools = [...(context.tools ?? [])];
      const completion = candidateCompletion(extractAssistantText(message), requiredQuestions);
      if (completion) {
        requestFinalization(completion);
        return true;
      }
      return turnCount >= turnLimit;
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

  const continueLoop = async (): Promise<AssistantMessage> => {
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
      if (!loopReportedContext) effectiveMessages.push(...continued);
      const next = lastAssistant(continued);
      if (!next) throw providerError("Provider continuation returned no assistant message.", true);
      return next;
    } catch (error) {
      if (error instanceof FreeContextError) throw error;
      throw providerError(error, true);
    }
  };

  const recoverTransientFailure = async (initial: AssistantMessage): Promise<AssistantMessage> => {
    const recovered = await retryProviderMessage(
      attemptOf(initial),
      async (failed) => {
        effectiveMessages = withoutAssistant(effectiveMessages, failed.message);
        return attemptOf(await continueLoop());
      },
      { delaysMs: config.providerRetryDelaysMs },
      signal,
      createProviderRetryCallbacks("primary", emitCustom, () => {
        providerRetries += 1;
      }),
    );
    return recovered.message;
  };

  let assistant = lastAssistant(newMessages);
  if (!assistant) throw providerError("Provider returned no assistant message.", true);
  assistant = await recoverTransientFailure(assistant);
  const overflow = bindings.isContextOverflow(assistant, model.contextWindow);
  if (overflow && config.contextCompactionEnabled && !overflowRecovered) {
    overflowRecovered = true;
    effectiveMessages = [...(await runCompaction(withoutAssistant(effectiveMessages, assistant), "overflow"))];
    overflowRetries = 1;
    await emitCustom({
      type: "overflow_retry",
      attempt: 1,
      tokensBefore: tokensBeforeLastCompaction,
      estimatedTokensAfter: estimatedTokensAfterLastCompaction,
    });
    assistant = await recoverTransientFailure(await continueLoop());
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
      providerRetries,
      finalizationInjected,
      finalizationReason,
      blockedToolCalls,
      evidenceProgress: Object.freeze(evidenceProgress.map((progress) => Object.freeze({
        ...progress,
        newKeys: Object.freeze([...progress.newKeys]),
      }))),
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
