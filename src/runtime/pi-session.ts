import type {
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentMessage,
  AgentTool,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage, SimpleStreamOptions, Usage } from "@earendil-works/pi-ai";
import { isDeepStrictEqual } from "node:util";
import type { FreeContextConfig } from "../config.js";
import { ContextBudgetError, FreeContextError, ProviderError } from "../errors.js";
import type { FreeContextRequest, FreeContextResult } from "../mcp/contracts.js";
import type { ExplorerCandidate } from "../output/candidate.js";
import { serializeExplorerFeedback } from "../output/evidence.js";
import {
  assertInitialRequestFits,
  estimateEffectiveContextTokens,
  estimateInitialRequestTokens,
  selectCompactionCut,
} from "./context-budget.js";
import type { CompactionCut, ContextTokenCounter } from "./context-budget.js";
import { compactContext } from "./context-compaction.js";
import { GigatokenCounter } from "./gigatoken-counter.js";
import {
  buildFinalizationPacket,
  createSubmitEvidenceTool,
  createTerminalSubmissionState,
  FINALIZATION_SYSTEM_PROMPT,
  finalizationFits,
  latestCompactionSummary,
  observedReadFromToolResult,
  retainedObservedReads,
  SUBMIT_EVIDENCE_TOOL_NAME,
  submitSchemaTokenDelta,
} from "./finalization.js";
import type { ObservedRead, TerminalFailureDetail, TerminalFailureKind } from "./finalization.js";
import type { FreeContextModel } from "./model.js";
import { redactProviderError } from "./model.js";
import { normalizeAssistantFailure, normalizeProviderFailure } from "./provider-failure.js";
import type { ProviderFailureSignal } from "./provider-failure.js";
import { retryProviderMessage } from "./provider-retry.js";
import type { ProviderAttempt, ProviderRetryCallbacks } from "./provider-retry.js";
import type { PiBindings } from "./pi-bindings.js";
import { addUsage, EMPTY_USAGE } from "./usage.js";

// Safety ceiling only: coverage feedback, not this number, decides when the
// same Pi exploration session is complete.
export const EXPLORER_MAX_TURNS = 24;
export const EXPLORER_MAX_TOOL_CALLS = 64;
export const PI_SOFT_FINALIZATION_MS = 180_000;

export type CompactionReason = "threshold" | "overflow";
export type FinalizationReason =
  | "coverage"
  | "partial_candidate"
  | "protocol_retry"
  | "stagnation"
  | "turn_limit"
  | "tool_limit"
  | "provider_probe"
  | "soft_deadline";

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
  readonly submitSchemaTokens: number;
  readonly finalizationInjected: boolean;
  readonly finalizationReason: FinalizationReason | null;
  readonly softFinalizationTriggered: boolean;
  readonly terminalFailureDetails: readonly TerminalFailureDetail[];
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
  readonly candidate: Readonly<ExplorerCandidate> | null;
  readonly canonicalResult: Readonly<FreeContextResult> | null;
  readonly observedReads: readonly Readonly<ObservedRead>[];
  readonly terminalFailure: TerminalFailureKind | null;
  readonly messages: readonly AgentMessage[];
  readonly explorationTools: readonly AgentTool[];
  readonly contextSystemPrompt: string;
  readonly contextMessages: readonly AgentMessage[];
  readonly contextTools: readonly AgentTool[];
  readonly metrics: Readonly<PiSessionMetrics>;
}

export interface PiSessionOptions {
  readonly bindings: PiBindings;
  readonly model: FreeContextModel;
  readonly requestOptions: Readonly<SimpleStreamOptions>;
  readonly config: FreeContextConfig;
  readonly systemPrompt: string;
  readonly promptText: string;
  readonly finalizationRequest: Readonly<FreeContextRequest>;
  readonly tools: readonly AgentTool[];
  readonly initialMessages?: readonly AgentMessage[];
  readonly maxTurns?: number;
  readonly maxToolCalls?: number;
  readonly signal?: AbortSignal;
  readonly onEvent?: PiSessionEventHandler;
  /** @internal Test seam; production callers use PI_SOFT_FINALIZATION_MS. */
  readonly softFinalizationMs?: number;
  readonly clock?: () => number;
  readonly timestamp?: () => number;
  readonly tokenCounter?: ContextTokenCounter;
  readonly candidateEvaluator?: CanonicalCandidateEvaluator;
}

export interface PiFinalizationOptions {
  readonly bindings: PiBindings;
  readonly model: FreeContextModel;
  readonly requestOptions: Readonly<SimpleStreamOptions>;
  readonly config: FreeContextConfig;
  readonly request: Readonly<FreeContextRequest>;
  readonly observedReads: readonly Readonly<ObservedRead>[];
  readonly compactionSummary?: string | null;
  readonly signal?: AbortSignal;
  readonly onEvent?: PiSessionEventHandler;
  readonly clock?: () => number;
  readonly timestamp?: () => number;
  readonly tokenCounter?: ContextTokenCounter;
}

interface PiSessionExecutionOptions extends PiSessionOptions {
  readonly isolatedFinalization?: Readonly<{
    readonly observedReads: readonly Readonly<ObservedRead>[];
    readonly compactionSummary: string | null;
  }>;
}

export type CanonicalCandidateEvaluator = (
  candidate: Readonly<ExplorerCandidate>,
  observedReads: readonly Readonly<ObservedRead>[],
) => Promise<Readonly<FreeContextResult>>;

export function visibleAssistantText(message: AgentMessage | undefined): string {
  if (!message || message.role !== "assistant") return "";
  return message.content
    .filter((block): block is Extract<AssistantMessage["content"][number], { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

type RepositorySearchCall = Readonly<{
  name: string;
  arguments: unknown;
}>;

const REPOSITORY_SEARCH_TOOLS = new Set(["glob", "rg"]);

function repositorySearchBatch(
  calls: readonly Readonly<{ name: string; arguments: unknown }>[],
): readonly RepositorySearchCall[] | null {
  if (calls.length === 0 || calls.some((call) => !REPOSITORY_SEARCH_TOOLS.has(call.name))) return null;
  return calls.map((call) => ({ name: call.name, arguments: call.arguments }));
}

function sameRepositorySearchBatch(
  left: readonly RepositorySearchCall[] | null,
  right: readonly RepositorySearchCall[] | null,
): boolean {
  return left !== null && right !== null && isDeepStrictEqual(left, right);
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
    if (toolName === "rg" && value.noMatches === true) return null;
    if (toolName === "glob" && value.count === 0) return null;
    if (toolName === "read" || toolName === "bat") {
      const start = Number(value.startLine ?? 1);
      const end = Number(value.actualEndLine ?? value.endLine ?? start);
      return `${toolName}:${target}:${start}-${end}`;
    }
    const pattern = typeof value.pattern === "string" ? value.pattern.replace(/\s+/gu, " ").trim() : "";
    return `${toolName}:${target}:${pattern}`;
  }
  const header = fallbackText.split(/\r?\n/u, 1)[0]?.trim().toLowerCase();
  if (toolName === "rg" && fallbackText.includes("<no matches>")) return null;
  if (toolName === "glob" && fallbackText.includes("<no files matched>")) return null;
  return header ? `${toolName}:${header}` : null;
}

function observedReadKey(read: Readonly<ObservedRead>): string {
  return `${read.tool}\0${read.path}\0${read.startLine}\0${read.endLine}\0${read.content}`;
}

interface CoverageSnapshot {
  readonly evidenceRefs: readonly string[];
  readonly gapIds: readonly string[];
  readonly gapKeys: readonly string[];
  readonly candidateKey: string;
  readonly observedReadCount: number;
  readonly deficitFingerprint: string;
}

interface CoverageProgress {
  readonly newEvidenceRefs: readonly string[];
  readonly resolvedGapIds: readonly string[];
  readonly remainingGapIds: readonly string[];
  readonly candidateChanged: boolean;
  readonly observationsChanged: boolean;
  readonly deficitFingerprint: string;
}

function evidenceReferenceKey(item: ExplorerCandidate["evidence"][number]): string {
  return [item.questionId, item.targetId ?? "", item.role, item.path, item.startLine, item.endLine, item.focusLine].join("\0");
}

function gapKey(gap: ExplorerCandidate["gaps"][number]): string {
  return `${gap.questionId}\0${gap.targetId ?? ""}\0${gap.reason}`;
}

function coverageSnapshot(
  candidate: Readonly<ExplorerCandidate>,
  result: Readonly<FreeContextResult>,
  observedReadCount: number,
): CoverageSnapshot {
  const evidenceRefs = [...new Set(result.evidence.map(evidenceReferenceKey))].sort();
  const gapKeys = [...new Set(result.gaps.map(gapKey))].sort();
  const gapIds = [...new Set(result.gaps.map((gap) => gap.questionId))].sort();
  const candidateEvidenceRefs = [...new Set(candidate.evidence.map(evidenceReferenceKey))].sort();
  const candidateGapKeys = [...new Set(candidate.gaps.map(gapKey))].sort();
  return {
    evidenceRefs,
    gapIds,
    gapKeys,
    candidateKey: [candidateEvidenceRefs.join("\n"), candidateGapKeys.join("\n")].join("\n--\n"),
    observedReadCount,
    deficitFingerprint: `${result.status}|${gapKeys.join("\n")}`,
  };
}

function coverageProgress(
  previous: CoverageSnapshot | null,
  current: CoverageSnapshot,
): CoverageProgress {
  const previousEvidence = new Set(previous?.evidenceRefs ?? []);
  const previousGapIds = new Set(previous?.gapIds ?? []);
  const currentGapIds = new Set(current.gapIds);
  return {
    newEvidenceRefs: current.evidenceRefs.filter((ref) => !previousEvidence.has(ref)),
    resolvedGapIds: [...previousGapIds].filter((id) => !currentGapIds.has(id)).sort(),
    remainingGapIds: [...currentGapIds].sort(),
    candidateChanged: previous !== null && previous.candidateKey !== current.candidateKey,
    observationsChanged: previous !== null && previous.observedReadCount !== current.observedReadCount,
    deficitFingerprint: current.deficitFingerprint,
  };
}

function hasCoverageProgress(progress: CoverageProgress | null): boolean {
  return Boolean(progress && (
    progress.newEvidenceRefs.length > 0
    || progress.resolvedGapIds.length > 0
    || progress.candidateChanged
  ));
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

function isCerebrasEndpoint(provider: string, baseUrl: string): boolean {
  if (provider.toLowerCase().includes("cerebras")) return true;
  try {
    return new URL(baseUrl).hostname.toLowerCase().includes("cerebras");
  } catch {
    return false;
  }
}

function isProviderContextOverflow(
  message: AssistantMessage,
  bindings: Readonly<PiBindings>,
  config: Readonly<FreeContextConfig>,
  contextWindow: number,
): boolean {
  const bareBadRequest = message.stopReason === "error"
    && /^400\s*(?:status code)?\s*\(no body\)\s*$/iu.test(message.errorMessage ?? "");
  if (bareBadRequest && !isCerebrasEndpoint(config.provider, config.baseUrl)) return false;
  return bindings.isContextOverflow(message, contextWindow);
}

async function runPiSessionWithCounter({
  bindings,
  model,
  requestOptions,
  config,
  systemPrompt,
  promptText,
  finalizationRequest,
  tools,
  initialMessages = [],
  maxTurns = config.maxTurns,
  maxToolCalls = config.maxToolCalls,
  signal,
  onEvent,
  softFinalizationMs,
  clock = performance.now.bind(performance),
  timestamp = Date.now,
  isolatedFinalization,
  candidateEvaluator,
}: PiSessionExecutionOptions, tokenCounter: ContextTokenCounter | null): Promise<Readonly<PiSessionResult>> {
  const turnBudget = Math.min(maxTurns, EXPLORER_MAX_TURNS);
  const toolCallBudget = Math.min(maxToolCalls, EXPLORER_MAX_TOOL_CALLS);
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
  const initialFinalizationReads = isolatedFinalization
    ? Object.freeze(isolatedFinalization.observedReads.map((read) => Object.freeze({ ...read })))
    : null;
  const isolatedPacket = initialFinalizationReads
    ? buildFinalizationPacket(finalizationRequest, initialFinalizationReads, isolatedFinalization?.compactionSummary ?? null)
    : null;
  const activeSystemPrompt = isolatedPacket === null ? systemPrompt : FINALIZATION_SYSTEM_PROMPT;
  const activePromptText = isolatedPacket ?? promptText;
  let finalizationInjected = isolatedPacket !== null;
  let finalizationReason: FinalizationReason | null = isolatedPacket === null ? null : "provider_probe";
  let finalizerCorrectionUsed = false;
  let finalizationSteeringQueued = false;
  let softFinalizationTimer: ReturnType<typeof setTimeout> | null = null;
  let softFinalizationTriggered = false;
  let softFinalizationPending = false;
  let blockedToolCalls = 0;
  let overflowRecovered = false;
  let finalizerStarted = false;
  let effectiveSystemPrompt = activeSystemPrompt;
  let effectiveMessages = [...initialMessages];
  const observedReads: ObservedRead[] = [...(initialFinalizationReads ?? [])];
  let finalizationReads: readonly ObservedRead[] | null = initialFinalizationReads;
  const observedReadKeys = new Set(observedReads.map(observedReadKey));
  const submission = createTerminalSubmissionState();
  const submitTool = createSubmitEvidenceTool({
    Type: bindings.Type,
    request: finalizationRequest,
    observedReads: () => finalizationReads ?? observedReads,
    state: submission,
    isFinalizing: () => finalizerStarted,
  });
  const explorationTools = isolatedPacket === null ? [...tools, submitTool] : [];
  let effectiveTools = isolatedPacket === null ? [...explorationTools] : [submitTool];
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
  const currentObservedReadKeys = new Set<string>();
  const evidenceProgress: TurnEvidenceProgress[] = [];
  let latestCandidate: Readonly<ExplorerCandidate> | null = null;
  let canonicalResult: Readonly<FreeContextResult> | null = null;
  let evaluatedCandidate: Readonly<ExplorerCandidate> | null = null;
  const submitSchemaTokens = tokenCounter ? await submitSchemaTokenDelta({
    systemPrompt: activeSystemPrompt,
    promptText: activePromptText,
    repositoryTools: isolatedPacket === null ? tools : [],
    submitTool,
    counter: tokenCounter,
  }) : 0;
  let currentProgressRecorded = false;
  let lastSubmissionEvaluation: Readonly<FreeContextResult> | null | undefined;
  let lastCoverageSnapshot: CoverageSnapshot | null = null;
  let currentCoverageProgress: CoverageProgress | null = null;
  let lastDeficitAction: string | null = null;
  let noProgressStreak = 0;
  let previousSemanticProgress = false;
  let previousReadActivity = false;
  let softBudgetExtension = false;
  let recoveryTurnPending = false;
  let continuationFeedback: "no_tool" | "duplicate_search" | null = null;
  let duplicateSearchFeedbackUsed = false;
  let previousSearchBatch: readonly RepositorySearchCall[] | null = null;
  let previousSearchBatchHadProgress = false;
  let currentSearchBatch: readonly RepositorySearchCall[] | null = null;
  let currentSearchBatchBlocked = false;
  let currentSearchBlockCounted = false;

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
    currentProgressRecorded = true;
  };
  const recordLiveness = (action: string, progress?: CoverageProgress): boolean => {
    const hasProgress = hasCoverageProgress(progress ?? null)
      || currentObservedReadKeys.size > 0;
    if (hasProgress) {
      noProgressStreak = 0;
      lastDeficitAction = null;
      return false;
    }
    const fingerprint = `${progress?.deficitFingerprint ?? "no-candidate"}|${action}`;
    noProgressStreak = lastDeficitAction === fingerprint ? noProgressStreak + 1 : 1;
    lastDeficitAction = fingerprint;
    return noProgressStreak >= 2;
  };
  const clearSoftFinalizationTimer = (): void => {
    if (softFinalizationTimer === null) return;
    clearTimeout(softFinalizationTimer);
    softFinalizationTimer = null;
  };
  const requestFinalization = (reason: FinalizationReason): void => {
    if (finalizationReason !== null) return;
    finalizationReason = reason;
    clearSoftFinalizationTimer();
  };
  const armSoftFinalizationTimer = (): void => {
    if (isolatedPacket !== null || finalizationReason !== null || finalizationInjected) return;
    const timeoutMs = Math.max(0, softFinalizationMs ?? PI_SOFT_FINALIZATION_MS);
    softFinalizationTimer = setTimeout(() => {
      softFinalizationTimer = null;
      if (finalizationReason !== null || finalizationInjected || finalizerStarted || submission.failureKind) return;
      softFinalizationTriggered = true;
      softFinalizationPending = true;
    }, timeoutMs);
    const timer = softFinalizationTimer as unknown as { unref?: () => void };
    timer.unref?.();
  };
  let activeLoopContext: AgentContext | null = null;
  const prepareFinalizationContext = async (context: AgentContext): Promise<AgentContext | null> => {
    if (finalizationInjected || finalizationReason === null || submission.failureKind || submission.candidate) {
      return null;
    }
    finalizationReads = retainedObservedReads(context.messages, observedReads);
    const packet = buildFinalizationPacket(
      finalizationRequest,
      finalizationReads,
      latestCompactionSummary(context.messages),
    );
    if (!await finalizationFits({
      packet,
      tool: submitTool,
      counter: counter(),
      contextWindow: model.contextWindow,
      reserveTokens: config.contextReserveTokens,
    })) {
      submission.reject("context_budget");
      return null;
    }
    finalizationInjected = true;
    return {
      systemPrompt: FINALIZATION_SYSTEM_PROMPT,
      tools: [submitTool],
      messages: [{ role: "user", content: packet, timestamp: timestamp() }],
    };
  };
  const injectFinalization = async (context: AgentContext): Promise<boolean> => {
    const prepared = await prepareFinalizationContext(context);
    if (!prepared) return finalizationInjected;
    context.systemPrompt = prepared.systemPrompt;
    context.tools = prepared.tools ?? [submitTool];
    context.messages = [...prepared.messages];
    effectiveSystemPrompt = prepared.systemPrompt;
    effectiveMessages = [...prepared.messages];
    effectiveTools = [...(prepared.tools ?? [])];
    return true;
  };
  type SoftFinalizationOutcome = "not_pending" | "injected" | "failed";
  const consumeSoftFinalization = async (context: AgentContext): Promise<SoftFinalizationOutcome> => {
    if (!softFinalizationPending || finalizationReason !== null || submission.failureKind) return "not_pending";
    softFinalizationPending = false;
    requestFinalization("soft_deadline");
    return await injectFinalization(context) ? "injected" : "failed";
  };
  const consumeSoftFinalizationBeforeRetry = async (assistant: AssistantMessage): Promise<SoftFinalizationOutcome> => {
    if (assistant.stopReason !== "error"
      || !softFinalizationPending
      || observedReads.length === 0
      || signal?.aborted
      || finalizationInjected
      || submission.failureKind) {
      return "not_pending";
    }
    const context: AgentContext = {
      systemPrompt: effectiveSystemPrompt,
      messages: [...effectiveMessages],
      tools: [...effectiveTools],
    };
    const outcome = await consumeSoftFinalization(context);
    if (outcome === "injected") {
      activeLoopContext = context;
      effectiveSystemPrompt = context.systemPrompt;
      effectiveMessages = [...context.messages];
      effectiveTools = [...(context.tools ?? [])];
    }
    return outcome;
  };
  const finalizationSteeringMessage = (): AgentMessage => ({
    role: "user",
    content: "Finalization phase: call submit_evidence now using the verified observations; do not call any other tool.",
    timestamp: timestamp(),
  });
  const requestSoftBudgetFinalization = (): void => {
    if (noProgressStreak >= 2) requestFinalization("stagnation");
    else requestFinalization(toolCallCount >= toolCallBudget ? "tool_limit" : "turn_limit");
  };
  const currentTurnHasBudgetProgress = (): boolean => (
    currentObservedReadKeys.size > 0 || hasCoverageProgress(currentCoverageProgress)
  );
  const mayExplorePastBudget = (): boolean => (
    softBudgetExtension || currentTurnHasBudgetProgress() || noProgressStreak === 1
  );

  const evaluateSubmission = async (): Promise<Readonly<FreeContextResult> | null> => {
    const candidate = submission.candidate;
    if (!candidate) {
      lastSubmissionEvaluation = null;
      return null;
    }
    latestCandidate = candidate;
    if (!candidateEvaluator) {
      lastSubmissionEvaluation = null;
      return null;
    }
    if (evaluatedCandidate === candidate) {
      lastSubmissionEvaluation = canonicalResult;
      return canonicalResult;
    }
    const result = await candidateEvaluator(candidate, Object.freeze([...observedReads]));
    evaluatedCandidate = candidate;
    canonicalResult = result;
    lastSubmissionEvaluation = result;
    const currentSnapshot = coverageSnapshot(candidate, result, observedReads.length);
    const progress = coverageProgress(lastCoverageSnapshot, currentSnapshot);
    lastCoverageSnapshot = currentSnapshot;
    currentCoverageProgress = progress;
    recordLiveness("submit", progress);
    if (!finalizerStarted && result.status !== "ready" && result.status !== "failed") {
      submission.clear();
    }
    return result;
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
    const failure = message.stopReason === "error" && !isProviderContextOverflow(message, bindings, config, model.contextWindow)
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
      if (finalizationInjected) finalizerStarted = true;
      lastSubmissionEvaluation = undefined;
      currentTurnKeys.clear();
      currentObservedReadKeys.clear();
      currentProgressRecorded = false;
      currentCoverageProgress = null;
      currentSearchBatch = null;
      currentSearchBatchBlocked = false;
      currentSearchBlockCounted = false;
      softBudgetExtension = previousSemanticProgress || previousReadActivity || recoveryTurnPending;
      recoveryTurnPending = false;
      previousSemanticProgress = false;
      previousReadActivity = false;
    }
    if (event.type === "turn_end") {
      const overflow = event.message.role === "assistant"
        && isProviderContextOverflow(event.message, bindings, config, model.contextWindow);
      const transientFailure = event.message.role === "assistant" && Boolean(assistantFailure(event.message)?.retryable);
      if (!overflow && !transientFailure) {
        for (const result of event.toolResults) {
          if (result.isError) continue;
          const text = result.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
          addEvidenceKey(normalizedEvidenceKey(result.toolName, null, text));
        }
        if (!finalizerStarted) recordEvidenceProgress();
        previousSemanticProgress = hasCoverageProgress(currentCoverageProgress);
        previousReadActivity = currentObservedReadKeys.size > 0;
        if (previousSemanticProgress || previousReadActivity) duplicateSearchFeedbackUsed = false;
        if (currentSearchBatch && !currentSearchBatchBlocked) {
          previousSearchBatch = currentSearchBatch;
          previousSearchBatchHadProgress = currentTurnKeys.size > 0
            || previousSemanticProgress
            || previousReadActivity;
        } else if (!currentSearchBatchBlocked) {
          previousSearchBatch = null;
          previousSearchBatchHadProgress = false;
        }
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
        const observed = observedReadFromToolResult(event.toolName, event.result, event.isError);
        if (observed) {
          const key = observedReadKey(observed);
          if (!observedReadKeys.has(key)) {
            observedReadKeys.add(key);
            observedReads.push(observed);
            currentObservedReadKeys.add(key);
          }
        }
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
      systemPrompt: activeSystemPrompt,
      promptText: activePromptText,
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

  const prompt: AgentMessage = { role: "user", content: activePromptText, timestamp: timestamp() };
  const streamWithTerminalChoice: PiBindings["streamSimple"] = (target, context, options) => {
    const terminalOnly = finalizerStarted && context.tools?.length === 1 && context.tools[0]?.name === SUBMIT_EVIDENCE_TOOL_NAME;
    const effectiveOptions = terminalOnly
      ? ({
          ...options,
          toolChoice: config.openAICompat.supportsRequiredToolChoice ? "required" : "auto",
        } as SimpleStreamOptions)
      : options;
    return bindings.streamSimple(target, context, effectiveOptions);
  };
  const takeContinuationFeedback = (steeringOnly: boolean): AgentMessage[] => {
    if (continuationFeedback === null || finalizationReason !== null || submission.failureKind) return [];
    if (steeringOnly && continuationFeedback !== "duplicate_search") return [];
    const feedback = continuationFeedback;
    continuationFeedback = null;
    return [{
      role: "user",
      content: feedback === "duplicate_search"
        ? "Liveness recovery: the repeated repository-search batch was blocked before execution because it produced no new candidate or evidence. Read one already discovered candidate path, or call submit_evidence alone with the current evidence and explicit gaps."
        : "Continuation check: the previous turn produced no repository tool call or evidence submission. Continue this same exploration session and make the next bounded evidence-producing action for the current questions before submitting.",
      timestamp: timestamp(),
    }];
  };
  const loopConfig: AgentLoopConfig = {
    ...requestOptions,
    model,
    convertToLlm: bindings.convertToLlm,
    toolExecution: "parallel",
    beforeToolCall: async ({ assistantMessage, toolCall }) => {
      const calls = assistantMessage.content.filter((block) => block.type === "toolCall");
      const submitCount = calls.filter((call) => call.name === SUBMIT_EVIDENCE_TOOL_NAME).length;
      const protocolFailure = submitCount > 0 && calls.some((call) => call.name !== SUBMIT_EVIDENCE_TOOL_NAME)
        ? "mixed_batch"
        : submitCount > 1
          ? "duplicate_submit"
          : null;
      if (protocolFailure) {
        if (finalizerStarted) submission.reject(protocolFailure);
        else {
          requestFinalization("protocol_retry");
        }
        return { block: true, reason: "Terminal evidence submission must be the only tool call in its batch." };
      }
      if (toolCall.name === SUBMIT_EVIDENCE_TOOL_NAME) return undefined;
      if (finalizerStarted) {
        submission.reject("unexpected_tool");
        return { block: true, reason: "Only submit_evidence is allowed during finalization." };
      }
      const atEmergencyCeiling = turnCount >= EXPLORER_MAX_TURNS
        || toolCallCount >= EXPLORER_MAX_TOOL_CALLS;
      if (atEmergencyCeiling) {
        blockedToolCalls += 1;
        requestFinalization(toolCallCount >= EXPLORER_MAX_TOOL_CALLS ? "tool_limit" : "turn_limit");
        return {
          block: true,
          reason: `Repository exploration emergency ceiling reached (${EXPLORER_MAX_TURNS} turns/${EXPLORER_MAX_TOOL_CALLS} tool calls). Finalize from existing evidence.`,
        };
      }
      currentSearchBatch ??= repositorySearchBatch(calls);
      if (!previousSearchBatchHadProgress && sameRepositorySearchBatch(previousSearchBatch, currentSearchBatch)) {
        currentSearchBatchBlocked = true;
        if (!currentSearchBlockCounted) {
          blockedToolCalls += 1;
          currentSearchBlockCounted = true;
        }
        return {
          block: true,
          reason: "This repository-search batch exactly repeats the preceding no-progress batch. Read a discovered candidate or submit current evidence and gaps.",
        };
      }
      const atBudget = turnCount >= turnBudget || toolCallCount >= toolCallBudget;
      if (atBudget && !mayExplorePastBudget()) {
        blockedToolCalls += 1;
        requestSoftBudgetFinalization();
        return {
          block: true,
          reason: `Repository exploration budget reached (${turnBudget} turns/${toolCallBudget} tool calls) without new read or coverage progress. Finalize from existing evidence.`,
        };
      }
      toolCallCount += 1;
      return undefined;
    },
    afterToolCall: async ({ toolCall, isError }) => {
      if (toolCall.name !== SUBMIT_EVIDENCE_TOOL_NAME || isError) return undefined;
      const evaluation = await evaluateSubmission();
      if (!evaluation) return undefined;
      if (evaluation.status === "ready") requestFinalization("coverage");
      else if (evaluation.status === "failed") requestFinalization("protocol_retry");
      const terminal = finalizerStarted
        || evaluation.status === "ready"
        || evaluation.status === "failed";
      return {
        content: [{ type: "text" as const, text: serializeExplorerFeedback(evaluation) }],
        terminate: terminal,
      };
    },
    prepareNextTurn: async ({ context, message, toolResults }) => {
      loopReportedContext = true;
      let nextContext: AgentContext = context;
      if (finalizerStarted) {
        effectiveSystemPrompt = context.systemPrompt;
        effectiveMessages = [...context.messages];
        effectiveTools = [...(context.tools ?? [])];
        return undefined;
      }
      const calls = message.content.filter((block) => block.type === "toolCall");
      for (const result of toolResults) {
        if (result.isError) continue;
        const text = result.content
          .flatMap((block) => block.type === "text" ? [block.text] : [])
          .join("\n");
        addEvidenceKey(normalizedEvidenceKey(result.toolName, null, text));
      }
      recordEvidenceProgress();
      const hasSubmission = calls.some((call) => call.name === SUBMIT_EVIDENCE_TOOL_NAME);
      const submissionToolError = hasSubmission && toolResults.some((result) =>
        result.toolName === SUBMIT_EVIDENCE_TOOL_NAME && result.isError === true);
      const evaluation = hasSubmission
        ? (lastSubmissionEvaluation === undefined ? await evaluateSubmission() : lastSubmissionEvaluation)
        : null;
      if (hasSubmission && evaluation?.status === "ready") requestFinalization("coverage");
      else if (hasSubmission && evaluation?.status === "failed") requestFinalization("protocol_retry");
      else if (hasSubmission && evaluation === null && !submission.candidate && !submissionToolError) requestFinalization("protocol_retry");
      if (calls.length === 0 && finalizationReason === null && !submission.failureKind) {
        if (recordLiveness("no-tool")) requestFinalization("stagnation");
        else continuationFeedback = "no_tool";
      } else if (calls.length > 0 && !hasSubmission && finalizationReason === null && !submission.failureKind) {
        const stagnant = recordLiveness("explore");
        if (currentSearchBatchBlocked) {
          if (!duplicateSearchFeedbackUsed) {
            duplicateSearchFeedbackUsed = true;
            recoveryTurnPending = true;
            continuationFeedback = "duplicate_search";
          } else if (stagnant) {
            requestFinalization("stagnation");
          }
        }
      }
      const completedTurns = Math.max(turnCount, evidenceProgress.length);
      if (submission.candidate) {
        if (finalizerStarted) requestFinalization("partial_candidate");
        effectiveSystemPrompt = context.systemPrompt;
        effectiveMessages = [...context.messages];
        effectiveTools = [...(context.tools ?? [])];
        return undefined;
      }
      const softBudgetRecovery = finalizationReason === null && noProgressStreak === 1;
      const progressAtBudget = currentTurnHasBudgetProgress();
      const feedbackContinuation = continuationFeedback !== null && finalizationReason === null;
      if (completedTurns >= EXPLORER_MAX_TURNS || toolCallCount >= EXPLORER_MAX_TOOL_CALLS) {
        requestFinalization(toolCallCount >= EXPLORER_MAX_TOOL_CALLS ? "tool_limit" : "turn_limit");
      } else if (!softBudgetRecovery
        && !feedbackContinuation
        && !progressAtBudget
        && (toolCallCount >= toolCallBudget || completedTurns >= turnBudget)) {
        requestSoftBudgetFinalization();
      }
      if (config.contextCompactionEnabled && !finalizerStarted) {
        const tokens = await estimateEffectiveContextTokens(nextContext.messages, counter());
        if (bindings.shouldCompact(tokens, model.contextWindow, compactionSettings)) {
          nextContext = {
            ...nextContext,
            messages: [...(await runCompaction(nextContext.messages, "threshold"))],
          };
        }
      }
      if (softFinalizationPending && finalizationReason === null && !submission.failureKind) {
        softFinalizationPending = false;
        requestFinalization("soft_deadline");
      }
      if (!submission.candidate && !finalizationInjected && finalizationReason !== null) {
        const prepared = await prepareFinalizationContext(nextContext);
        if (prepared) nextContext = prepared;
      }
      activeLoopContext = nextContext;
      effectiveMessages = [...nextContext.messages];
      effectiveSystemPrompt = nextContext.systemPrompt;
      effectiveTools = [...(nextContext.tools ?? [])];
      return nextContext === context ? undefined : { context: nextContext };
    },
    getSteeringMessages: async () => {
      if (activeLoopContext !== null) {
        await consumeSoftFinalization(activeLoopContext);
      }
      if (isolatedPacket === null && finalizationInjected && !finalizerStarted && !submission.failureKind) {
        if (finalizationSteeringQueued) return [];
        const steering = finalizationSteeringMessage();
        finalizationSteeringQueued = true;
        effectiveMessages = [...effectiveMessages, steering];
        return [steering];
      }
      return takeContinuationFeedback(true);
    },
    getFollowUpMessages: async () => takeContinuationFeedback(false),
    shouldStopAfterTurn: async ({ context, message, toolResults }) => {
      loopReportedContext = true;
      effectiveSystemPrompt = context.systemPrompt;
      effectiveMessages = [...context.messages];
      effectiveTools = [...(context.tools ?? [])];
      if (submission.candidate) {
        const evaluation = lastSubmissionEvaluation === undefined
          ? await evaluateSubmission()
          : lastSubmissionEvaluation;
        if (evaluation?.status === "ready") requestFinalization("coverage");
        else if (evaluation?.status === "failed") requestFinalization("protocol_retry");
        else if (finalizerStarted) requestFinalization("partial_candidate");
        if (submission.candidate) return true;
      }
      if (submission.failureKind) return true;
      const softFinalization = await consumeSoftFinalization(context);
      if (softFinalization === "injected") return false;
      if (softFinalization === "failed") return true;
      if (finalizerStarted) {
        const calls = message.content.filter((block) => block.type === "toolCall");
        const submitCount = calls.filter((call) => call.name === SUBMIT_EVIDENCE_TOOL_NAME).length;
        const invalidSubmit = submitCount === 1 && toolResults.some((result) =>
          result.toolName === SUBMIT_EVIDENCE_TOOL_NAME && result.isError === true);
        if (invalidSubmit && !finalizerCorrectionUsed) {
          finalizerCorrectionUsed = true;
          return false;
        }
        if (calls.some((call) => call.name !== SUBMIT_EVIDENCE_TOOL_NAME)) submission.reject("unexpected_tool");
        else if (submitCount > 1) submission.reject("duplicate_submit");
        else if (submitCount === 1) submission.reject("invalid_arguments");
        else submission.reject("missing_submit");
        return true;
      }
      if (finalizationReason !== null && !finalizationInjected && !submission.failureKind) return false;
      if (finalizationInjected && !finalizerStarted) return false;
      if (continuationFeedback !== null && finalizationReason === null) return false;
      if (softFinalizationPending && !submission.failureKind) return false;
      if (turnCount >= EXPLORER_MAX_TURNS || toolCallCount >= EXPLORER_MAX_TOOL_CALLS) return true;
      return (turnCount >= turnBudget || toolCallCount >= toolCallBudget) && !mayExplorePastBudget();
    },
  };

  const runInitialLoop = async (): Promise<AgentMessage[]> =>
    await bindings.runAgentLoop(
      [prompt],
      { systemPrompt: effectiveSystemPrompt, messages: [...effectiveMessages], tools: [...effectiveTools] },
      loopConfig,
      emit,
      signal,
      streamWithTerminalChoice,
    );

  armSoftFinalizationTimer();
  let newMessages: AgentMessage[];
  try {
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
        { systemPrompt: effectiveSystemPrompt, messages: [...effectiveMessages], tools: [...effectiveTools] },
        loopConfig,
        emit,
        signal,
        streamWithTerminalChoice,
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
  const retryPreparation = await consumeSoftFinalizationBeforeRetry(assistant);
  if (retryPreparation === "injected") {
    assistant = await continueLoop();
  } else if (retryPreparation !== "failed") {
    assistant = await recoverTransientFailure(assistant);
    if (finalizationInjected && !finalizerStarted && !submission.failureKind) {
      assistant = await continueLoop();
    }
  }
  let overflow = isProviderContextOverflow(assistant, bindings, config, model.contextWindow);
  if (overflow && observedReads.length > 0 && !finalizerStarted && !submission.failureKind) {
    const context: AgentContext = {
      systemPrompt: effectiveSystemPrompt,
      messages: [...effectiveMessages],
      tools: [...effectiveTools],
    };
    if ((await consumeSoftFinalization(context)) === "injected") {
      activeLoopContext = context;
      effectiveSystemPrompt = context.systemPrompt;
      effectiveMessages = [...context.messages];
      effectiveTools = [...(context.tools ?? [])];
      assistant = await continueLoop();
      overflow = isProviderContextOverflow(assistant, bindings, config, model.contextWindow);
    }
  }
  if (overflow && finalizerStarted) {
    submission.reject("context_budget");
  } else if (overflow && !submission.failureKind && config.contextCompactionEnabled && !overflowRecovered) {
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

  if (isProviderContextOverflow(assistant, bindings, config, model.contextWindow) && !submission.failureKind) {
    throw providerError(assistant.errorMessage || "Provider context overflow persisted after recovery.");
  }
  if ((assistant.stopReason === "error" || assistant.stopReason === "aborted") && !submission.failureKind) {
    throw providerError(assistant.errorMessage, assistant.stopReason === "error");
  }
  if (!submission.candidate && !submission.failureKind) submission.reject("missing_submit");

  return Object.freeze({
    text: visibleAssistantText(assistant),
    candidate: submission.candidate ?? latestCandidate,
    canonicalResult,
    observedReads: Object.freeze(observedReads.map((read) => Object.freeze(read))),
    terminalFailure: submission.failureKind,
    messages: Object.freeze(allNewMessages),
    explorationTools: Object.freeze([...explorationTools]),
    contextSystemPrompt: effectiveSystemPrompt,
    contextMessages: Object.freeze([...effectiveMessages]),
    contextTools: Object.freeze([...effectiveTools]),
    metrics: Object.freeze({
      turns: turnCount,
      toolCalls: toolCallCount,
      providerAttempts,
      providerRetries,
      submitSchemaTokens,
      finalizationInjected,
      finalizationReason,
      softFinalizationTriggered,
      terminalFailureDetails: submission.failureDetails,
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
  } finally {
    clearSoftFinalizationTimer();
  }
}

async function runSession(options: PiSessionExecutionOptions): Promise<Readonly<PiSessionResult>> {
  if (options.tokenCounter) return runPiSessionWithCounter(options, options.tokenCounter);

  const tokenCounter = new GigatokenCounter();
  try {
    return await runPiSessionWithCounter(options, tokenCounter);
  } finally {
    await tokenCounter.close();
  }
}

export async function runPiSession(options: PiSessionOptions): Promise<Readonly<PiSessionResult>> {
  return runSession(options);
}

export async function runIsolatedFinalizer(options: PiFinalizationOptions): Promise<Readonly<PiSessionResult>> {
  return runSession({
    bindings: options.bindings,
    model: options.model,
    requestOptions: options.requestOptions,
    config: options.config,
    systemPrompt: FINALIZATION_SYSTEM_PROMPT,
    promptText: "",
    finalizationRequest: options.request,
    tools: [],
    maxTurns: 1,
    maxToolCalls: 0,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.timestamp ? { timestamp: options.timestamp } : {}),
    ...(options.tokenCounter ? { tokenCounter: options.tokenCounter } : {}),
    isolatedFinalization: {
      observedReads: options.observedReads,
      compactionSummary: options.compactionSummary ?? null,
    },
  });
}
