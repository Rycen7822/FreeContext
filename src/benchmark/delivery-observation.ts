import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  FreeContextCallerRecoveryRequestSchema,
  FreeContextRequestSchema,
  normalizeFreeContextRequest,
  type FreeContextCallerRecoveryRequest,
  type FreeContextRequest,
  type FreeContextResult,
} from "../mcp/contracts.js";
import type { McpSessionDocument } from "../mcp/session.js";
import type { ProviderFailureSignal } from "../runtime/provider-failure.js";

export interface ObservedMcpCall {
  readonly source: "direct_mcp" | "code_await";
  readonly callId: string;
  readonly startedSeen: boolean;
  readonly arguments: unknown;
  readonly text: string | null;
  readonly structuredContent: unknown;
}

export interface DuplicateSemanticCall {
  readonly taskId: string;
  readonly callId: string;
  readonly firstCallId: string;
  readonly duplicateOrdinal: number;
}

export interface DeliveryEvaluation {
  readonly outputToMasterAgent: string | null;
  readonly deliveryStatus: "matched" | "mismatch" | "missing" | "ambiguous";
  readonly callIdCorrelation: "unique" | "missing" | "ambiguous";
  readonly sessionReferenceMatches: number;
  readonly observedTextSha256: string | null;
  readonly requestMatches: boolean | null;
  readonly structuredContentMatches: boolean | null;
  readonly masterStartedSeen: boolean;
}

export interface FreeContextTransportObservation {
  readonly schemaVersion: "freecontext-transport-observation-v1";
  readonly turnId: string | null;
  readonly outerCallId: string;
  readonly cellId: string | null;
  readonly reminderCount: number;
  readonly sameCellWaitCount: number;
  readonly waitYieldTimeMs: readonly (number | null)[];
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly latencyMs: number | null;
  readonly terminalTextSha256?: string | null;
  readonly terminalOutputSeen: boolean;
}

export type MissingReturnFailureClass = "remote_api" | "harness" | "mixed" | "indeterminate";

export interface MissingReturnCausalEvidence {
  readonly classification: MissingReturnFailureClass;
  readonly reasons: readonly string[];
  readonly masterStartedSeen: boolean;
  readonly terminalWinner: McpSessionDocument["terminalDecision"]["winner"];
  readonly terminalResultStatus: FreeContextResult["status"];
  readonly terminalSerializedTextSha256: string;
  readonly providerFailures: readonly Readonly<{
    scope: "primary" | "compaction";
    attempt: number;
    willRetry: boolean;
    failure: Readonly<ProviderFailureSignal>;
  }>[];
}

export type MissingReturnSessionEvidence = Readonly<{
  runtimeEvents: McpSessionDocument["runtimeEvents"];
  terminalError: McpSessionDocument["terminalError"];
  terminalDecision: Readonly<{ winner: McpSessionDocument["terminalDecision"]["winner"] }>;
  result: Readonly<FreeContextResult>;
  serializedTextSha256: string;
}>;

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function eventTurnId(value: Record<string, unknown>): string | null {
  const metadata = isRecord(value.internal_chat_message_metadata_passthrough)
    ? value.internal_chat_message_metadata_passthrough
    : null;
  const turnId = value.turn_id ?? value.turnId ?? metadata?.turn_id ?? metadata?.turnId;
  return typeof turnId === "string" && turnId ? turnId : null;
}

function outputText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.flatMap((item) => isRecord(item) && typeof item.text === "string" ? [item.text] : []).join("\n");
}

function callArguments(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function canonicalRequest(value: unknown): Readonly<FreeContextRequest> | null {
  try {
    return normalizeFreeContextRequest(value);
  } catch {
    const canonical = FreeContextRequestSchema.safeParse(value);
    return canonical.success ? canonical.data : null;
  }
}

function callerArgumentsMatch(value: unknown, request: Readonly<FreeContextRequest>): boolean {
  const recoveryOnly = FreeContextCallerRecoveryRequestSchema.safeParse(value);
  if (recoveryOnly.success) return isDeepStrictEqual(recoveryOnly.data.recovery, request.recovery);
  return isDeepStrictEqual(canonicalRequest(value), request);
}

function semanticRequest(value: unknown): Readonly<FreeContextRequest> | Readonly<FreeContextCallerRecoveryRequest> | null {
  const canonical = canonicalRequest(value);
  if (canonical) return canonical;
  const recoveryOnly = FreeContextCallerRecoveryRequestSchema.safeParse(value);
  return recoveryOnly.success ? recoveryOnly.data : null;
}

function isFreeContextExec(event: Record<string, unknown>): boolean {
  if (event.name !== "exec") return false;
  const source = typeof event.input === "string" ? event.input : typeof event.arguments === "string" ? event.arguments : "";
  if (/\bawait\s+tools\.mcp__freecontext__gather_context\s*\(/u.test(source)) return true;
  for (const match of source.matchAll(
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*tools\.mcp__freecontext__gather_context\s*;?/gu,
  )) {
    const alias = match[1];
    if (alias && new RegExp(`\\bawait\\s+${alias}\\s*\\(`, "u").test(source)) return true;
  }
  return false;
}

function terminalResultText(value: unknown): string | null {
  const texts = typeof value === "string"
    ? [value]
    : Array.isArray(value)
      ? value.flatMap((item) => isRecord(item) && typeof item.text === "string" ? [item.text] : [])
      : [];
  const matches = texts.filter((text) => text.split(/\r?\n/u).some((line) =>
    /^Session: \/.+\/freecontext-sessions\/.+\.json$/u.test(line)));
  return matches.length === 1 ? matches[0] ?? null : null;
}

function completedFreeContextMcpCall(event: Record<string, unknown>): Readonly<{
  callId: string;
  arguments: unknown;
  result: unknown;
  durationMs: number | null;
}> | null {
  if (event.type !== "mcp_tool_call_end") return null;
  const invocation = isRecord(event.invocation) ? event.invocation : null;
  if (invocation?.server !== "freecontext" || invocation.tool !== "gather_context") return null;
  const callId = event.call_id ?? event.callId;
  if (typeof callId !== "string" && typeof callId !== "number") return null;
  const result = isRecord(event.result) ? event.result.Ok : null;
  const duration = isRecord(event.duration) ? event.duration : null;
  const seconds = typeof duration?.secs === "number" ? duration.secs : 0;
  const nanos = typeof duration?.nanos === "number" ? duration.nanos : 0;
  const durationMs = duration && Number.isFinite(seconds) && Number.isFinite(nanos)
    ? Math.max(0, seconds * 1_000 + nanos / 1_000_000)
    : null;
  return Object.freeze({
    callId: String(callId),
    arguments: invocation.arguments ?? null,
    result,
    durationMs,
  });
}

export function collectFreeContextTransportObservations(
  rawJsonl: string,
): readonly Readonly<FreeContextTransportObservation>[] {
  type MutableObservation = {
    turnId: string | null;
    outerCallId: string;
    cellId: string | null;
    reminderCount: number;
    waitYieldTimeMs: (number | null)[];
    startedAt: string | null;
    startedMs: number | null;
    completedAt: string | null;
    completedMs: number | null;
    terminalTextSha256: string | null;
  };
  const observations: MutableObservation[] = [];
  const outerCalls = new Map<string, MutableObservation>();
  const waitCalls = new Map<string, MutableObservation>();
  for (const line of rawJsonl.split("\n")) {
    if (!line.trim()) continue;
    let envelope: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed)) continue;
      envelope = parsed;
    } catch {
      continue;
    }
    const event = isRecord(envelope.payload) ? envelope.payload : envelope;
    const type = typeof event.type === "string" ? event.type : "";
    const callId = event.call_id ?? event.callId;
    const normalizedCallId = typeof callId === "string" || typeof callId === "number" ? String(callId) : null;
    const turnId = eventTurnId(event) ?? eventTurnId(envelope);
    const timestamp = typeof envelope.timestamp === "string" ? envelope.timestamp : null;
    const parsedTimestamp = timestamp === null ? Number.NaN : Date.parse(timestamp);
    const timestampMs = Number.isNaN(parsedTimestamp) ? null : parsedTimestamp;
    const completedMcpCall = completedFreeContextMcpCall(event);
    if (completedMcpCall !== null) {
      const terminalText = terminalResultText(
        isRecord(completedMcpCall.result) ? completedMcpCall.result.content : null,
      );
      const startedMs = timestampMs === null || completedMcpCall.durationMs === null
        ? timestampMs
        : timestampMs - completedMcpCall.durationMs;
      observations.push({
        turnId,
        outerCallId: completedMcpCall.callId,
        cellId: null,
        reminderCount: 0,
        waitYieldTimeMs: [],
        startedAt: startedMs === null ? timestamp : new Date(startedMs).toISOString(),
        startedMs,
        completedAt: timestamp,
        completedMs: timestampMs,
        terminalTextSha256: terminalText === null ? null : sha256(terminalText),
      });
      continue;
    }
    const isCall = type === "custom_tool_call" || type === "function_call";
    const isOutput = type === "custom_tool_call_output" || type === "function_call_output";

    if (isCall && event.name === "exec" && normalizedCallId !== null) {
      if (isFreeContextExec(event)) {
        const observation: MutableObservation = {
          turnId,
          outerCallId: normalizedCallId,
          cellId: null,
          reminderCount: 0,
          waitYieldTimeMs: [],
          startedAt: timestamp,
          startedMs: timestampMs,
          completedAt: null,
          completedMs: null,
          terminalTextSha256: null,
        };
        observations.push(observation);
        outerCalls.set(normalizedCallId, observation);
      }
      continue;
    }

    if (isCall && event.name === "wait" && normalizedCallId !== null) {
      const args = callArguments(event.arguments ?? event.input);
      const cellId = args?.cell_id ?? args?.cellId;
      if (typeof cellId !== "string" && typeof cellId !== "number") continue;
      const normalizedCellId = String(cellId);
      let observation: MutableObservation | undefined;
      for (let index = observations.length - 1; index >= 0; index -= 1) {
        const candidate = observations[index];
        if (candidate?.cellId === normalizedCellId &&
            (turnId === null || candidate.turnId === null || candidate.turnId === turnId)) {
          observation = candidate;
          break;
        }
      }
      if (!observation) continue;
      const yieldTimeMs = args?.yield_time_ms ?? args?.yieldTimeMs;
      if (typeof yieldTimeMs === "number" && Number.isSafeInteger(yieldTimeMs) && yieldTimeMs >= 0) {
        observation.waitYieldTimeMs.push(yieldTimeMs);
      } else {
        observation.waitYieldTimeMs.push(null);
      }
      waitCalls.set(normalizedCallId, observation);
      continue;
    }

    if (!isOutput || normalizedCallId === null) continue;
    const observation = outerCalls.get(normalizedCallId) ?? waitCalls.get(normalizedCallId);
    if (!observation) continue;
    const rendered = outputText(event.output);
    const terminalText = terminalResultText(event.output);
    if (terminalText !== null) observation.terminalTextSha256 ??= sha256(terminalText);
    if (rendered.includes("FreeContext is still running.")) observation.reminderCount += 1;
    const running = rendered.match(/Script running with cell ID (?<cellId>[^\s]+)/u)?.groups?.cellId;
    if (running) observation.cellId = running;
    if (rendered && !running && !rendered.includes("FreeContext is still running.")) {
      observation.completedAt ??= timestamp;
      observation.completedMs ??= timestampMs;
    }
  }
  const terminalHashes = new Set<string>();
  const finalized = observations.map((observation) => Object.freeze({
    schemaVersion: "freecontext-transport-observation-v1" as const,
    turnId: observation.turnId,
    outerCallId: observation.outerCallId,
    cellId: observation.cellId,
    reminderCount: observation.reminderCount,
    sameCellWaitCount: observation.waitYieldTimeMs.length,
    waitYieldTimeMs: Object.freeze([...observation.waitYieldTimeMs]),
    startedAt: observation.startedAt,
    completedAt: observation.completedAt,
    latencyMs: observation.startedMs === null || observation.completedMs === null
      ? null
      : Math.max(0, observation.completedMs - observation.startedMs),
    terminalTextSha256: observation.terminalTextSha256,
    terminalOutputSeen: observation.completedAt !== null,
  })).filter((observation) => {
    if (typeof observation.terminalTextSha256 !== "string") return true;
    if (terminalHashes.has(observation.terminalTextSha256)) return false;
    terminalHashes.add(observation.terminalTextSha256);
    return true;
  });
  return Object.freeze(finalized);
}

function textFromResult(result: unknown): Readonly<{ text: string | null; structuredContent: unknown }> {
  if (typeof result === "string") return { text: result, structuredContent: null };
  if (!isRecord(result)) return { text: null, structuredContent: null };
  const content = Array.isArray(result.content) ? result.content : [];
  const textBlocks = content.filter((item) => isRecord(item) && item.type === "text" && typeof item.text === "string");
  const textBlock = textBlocks.length === 1 ? textBlocks[0] : null;
  return {
    text: isRecord(textBlock) && typeof textBlock.text === "string" ? textBlock.text : null,
    structuredContent: result.structuredContent ?? result.structured_content ?? null,
  };
}

export function collectDuplicateSemanticCalls(
  calls: readonly ObservedMcpCall[],
  taskId: string,
): readonly Readonly<DuplicateSemanticCall>[] {
  const semanticCalls = calls.filter((call) => call.source === "direct_mcp");
  const firstCalls: { call: ObservedMcpCall; request: Readonly<FreeContextRequest> | Readonly<FreeContextCallerRecoveryRequest> }[] = [];
  const duplicateCounts = new Map<string, number>();
  const duplicates: DuplicateSemanticCall[] = [];
  for (const call of semanticCalls) {
    const request = semanticRequest(call.arguments);
    if (request === null) continue;
    const first = firstCalls.find((candidate) => isDeepStrictEqual(candidate.request, request));
    if (!first) {
      firstCalls.push({ call, request });
      continue;
    }
    const duplicateOrdinal = (duplicateCounts.get(first.call.callId) ?? 0) + 1;
    duplicateCounts.set(first.call.callId, duplicateOrdinal);
    duplicates.push(Object.freeze({
      taskId,
      callId: call.callId,
      firstCallId: first.call.callId,
      duplicateOrdinal,
    }));
  }
  return Object.freeze(duplicates);
}

function collectCodeAwaitTerminalOutputs(rawJsonl: string): readonly ObservedMcpCall[] {
  const trackedCalls = new Set<string>();
  const trackedCells = new Set<string>();
  const observations: ObservedMcpCall[] = [];
  for (const line of rawJsonl.split("\n")) {
    if (!line.trim()) continue;
    let envelope: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed)) continue;
      envelope = parsed;
    } catch {
      continue;
    }
    const event = isRecord(envelope.payload) ? envelope.payload : envelope;
    const type = typeof event.type === "string" ? event.type : "";
    const callId = event.call_id ?? event.callId;
    const normalizedCallId = typeof callId === "string" || typeof callId === "number" ? String(callId) : null;
    if ((type === "custom_tool_call" || type === "function_call") && normalizedCallId !== null) {
      if (isFreeContextExec(event)) trackedCalls.add(normalizedCallId);
      if (event.name === "wait") {
        const args = callArguments(event.arguments ?? event.input);
        const cellId = args?.cell_id ?? args?.cellId;
        if ((typeof cellId === "string" || typeof cellId === "number") && trackedCells.has(String(cellId))) {
          trackedCalls.add(normalizedCallId);
        }
      }
      continue;
    }
    if ((type !== "custom_tool_call_output" && type !== "function_call_output") ||
        normalizedCallId === null || !trackedCalls.has(normalizedCallId)) continue;
    const rendered = outputText(event.output);
    const runningCell = rendered.match(/Script running with cell ID (?<cellId>[^\s]+)/u)?.groups?.cellId;
    if (runningCell) trackedCells.add(runningCell);
    const text = terminalResultText(event.output);
    if (text === null) continue;
    observations.push(Object.freeze({
      source: "code_await",
      callId: normalizedCallId,
      startedSeen: true,
      arguments: null,
      text,
      structuredContent: null,
    }));
  }
  return Object.freeze(observations);
}

export function collectObservedCalls(rawJsonl: string): readonly ObservedMcpCall[] {
  const started = new Map<string, unknown>();
  const calls: ObservedMcpCall[] = [];
  const addCall = (call: ObservedMcpCall): void => {
    const duplicateIndex = call.text === null ? -1 : calls.findIndex((candidate) => candidate.text === call.text);
    if (duplicateIndex < 0) {
      calls.push(call);
      return;
    }
    const duplicate = calls[duplicateIndex];
    if (duplicate?.source === "code_await" && call.source === "direct_mcp") calls[duplicateIndex] = call;
  };
  const visit = (value: unknown, depth = 0): void => {
    if (!isRecord(value) || depth > 5) return;
    const completedMcpCall = completedFreeContextMcpCall(value);
    if (completedMcpCall !== null) {
      addCall(Object.freeze({
        source: "direct_mcp",
        callId: completedMcpCall.callId,
        startedSeen: true,
        arguments: completedMcpCall.arguments,
        ...textFromResult(completedMcpCall.result),
      }));
    }
    const item = isRecord(value.item) ? value.item : null;
    if (item?.type === "mcp_tool_call" && item.server === "freecontext" && item.tool === "gather_context") {
      const callId = item.id ?? item.callId ?? item.call_id;
      if (typeof callId === "string" || typeof callId === "number") {
        const normalizedCallId = String(callId);
        if (value.type === "item.started" || value.type === "item_started" || item.status === "in_progress") {
          started.set(normalizedCallId, item.arguments ?? null);
        }
        if (value.type === "item.completed" || value.type === "item_completed" || item.status === "completed") {
          const observed = textFromResult(item.result);
          addCall(Object.freeze({
            source: "direct_mcp",
            callId: normalizedCallId,
            startedSeen: started.has(normalizedCallId),
            arguments: item.arguments ?? null,
            ...observed,
          }));
          started.delete(normalizedCallId);
        }
      }
    }
    if (isRecord(value.payload)) visit(value.payload, depth + 1);
    if (isRecord(value.event)) visit(value.event, depth + 1);
  };
  for (const line of rawJsonl.split("\n")) {
    if (!line.trim()) continue;
    try { visit(JSON.parse(line)); } catch { /* Raw JSONL remains preserved; this line cannot prove delivery. */ }
  }
  for (const [callId, callArguments] of started) {
    addCall(Object.freeze({
      source: "direct_mcp",
      callId,
      startedSeen: true,
      arguments: callArguments,
      text: null,
      structuredContent: null,
    }));
  }
  for (const observation of collectCodeAwaitTerminalOutputs(rawJsonl)) {
    if (!calls.some((call) => call.source === "direct_mcp" && call.text === observation.text)) {
      addCall(observation);
    }
  }
  return Object.freeze(calls);
}

export function evaluateDelivery(
  calls: readonly ObservedMcpCall[],
  callId: string,
  request: Readonly<FreeContextRequest>,
  result: Readonly<FreeContextResult>,
  serializedTextSha256: string,
): Readonly<DeliveryEvaluation> {
  const callMatches = calls.filter((call) => call.callId === callId);
  const sessionLine = result.sessionFile ? `Session: ${result.sessionFile}` : null;
  const sessionMatches = sessionLine === null ? [] : calls.filter((call) =>
    call.text?.split(/\r?\n/u).includes(sessionLine) ?? false);
  const callIdCorrelation = callMatches.length === 0 ? "missing" : callMatches.length === 1 ? "unique" : "ambiguous";
  const observation = sessionMatches.length === 1
    ? sessionMatches[0]
    : callMatches.length === 1
      ? callMatches[0]
      : undefined;
  const observedTextSha256 = observation?.text === null || observation?.text === undefined
    ? null
    : sha256(observation.text);
  const directObservation = observation?.source === "direct_mcp";
  const requestMatches = directObservation
    ? callerArgumentsMatch(observation.arguments, request)
    : null;
  const structuredContentMatches = directObservation ? isDeepStrictEqual(observation.structuredContent, result) : null;
  const sourceMatches = observation?.source === "code_await" ||
    (directObservation && requestMatches && structuredContentMatches);
  const deliveryStatus = sessionMatches.length > 1 || (sessionMatches.length === 0 && callMatches.length > 1)
    ? "ambiguous"
    : observation?.text === null || observation?.text === undefined
      ? "missing"
      : sessionMatches.length === 1 && observation.startedSeen && sourceMatches &&
          observedTextSha256 === serializedTextSha256
        ? "matched"
        : "mismatch";
  return Object.freeze({
    outputToMasterAgent: observation?.text ?? null,
    deliveryStatus,
    callIdCorrelation,
    sessionReferenceMatches: sessionMatches.length,
    observedTextSha256,
    requestMatches,
    structuredContentMatches,
    masterStartedSeen: observation?.startedSeen ?? callMatches.some((call) => call.startedSeen),
  });
}

export function classifyMissingReturn(
  delivery: Readonly<DeliveryEvaluation>,
  session: MissingReturnSessionEvidence,
): Readonly<MissingReturnCausalEvidence> | null {
  if (delivery.deliveryStatus !== "missing") return null;
  const providerFailures = session.runtimeEvents.flatMap(({ event }) =>
    event.type === "provider_attempt_failed"
      ? [Object.freeze({
          scope: event.scope,
          attempt: event.attempt,
          willRetry: event.willRetry,
          failure: event.failure,
        })]
      : []);
  const terminalProviderError = session.terminalError?.code === "PROVIDER_ERROR";
  const exhaustedProviderFailure = providerFailures.some((failure) => !failure.willRetry);
  const deadlineAfterProviderFailure = session.terminalDecision.winner === "deadline" && providerFailures.length > 0;
  const remoteCausal = terminalProviderError || exhaustedProviderFailure || deadlineAfterProviderFailure;
  const classification: MissingReturnFailureClass = remoteCausal ? "mixed" : "harness";
  const reasons = [
    ...(delivery.masterStartedSeen ? ["master_call_started_without_completion"] : ["master_call_completion_not_observed"]),
    "terminal_result_persisted",
    ...(terminalProviderError ? ["terminal_provider_error"] : []),
    ...(exhaustedProviderFailure ? ["provider_retry_exhausted_or_fatal"] : []),
    ...(deadlineAfterProviderFailure ? ["deadline_after_provider_failure"] : []),
  ];
  return Object.freeze({
    classification,
    reasons: Object.freeze(reasons),
    masterStartedSeen: delivery.masterStartedSeen,
    terminalWinner: session.terminalDecision.winner,
    terminalResultStatus: session.result.status,
    terminalSerializedTextSha256: session.serializedTextSha256,
    providerFailures: Object.freeze(providerFailures),
  });
}

export function legacyObservation(rawJsonl: string, runtimeSessionFile: string): string | null {
  for (const line of rawJsonl.split("\n")) {
    if (!line.includes(runtimeSessionFile)) continue;
    try {
      const event: unknown = JSON.parse(line);
      if (isRecord(event) && typeof event.payload === "string") return event.payload;
      if (isRecord(event) && isRecord(event.item)) {
        const observed = textFromResult(event.item.result);
        if (observed.text?.includes(runtimeSessionFile)) return observed.text;
      }
    } catch {
      continue;
    }
  }
  return null;
}
