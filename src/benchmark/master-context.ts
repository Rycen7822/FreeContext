import { readdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  FreeContextInvocationContextSchema,
  FreeContextRequestSchema,
  FreeContextResultSchema,
  LegacyFreeContextResultSchema,
} from "../mcp/contracts.js";
import type { FreeContextRequest, FreeContextResult, LegacyFreeContextResult } from "../mcp/contracts.js";
import type { McpSessionDocument } from "../mcp/session.js";
import {
  analyzeFreeContextConsumption,
  collectParentRepositoryActions,
} from "./consumption-analysis.js";
import type { FreeContextConsumptionAudit } from "./consumption-analysis.js";
import {
  collectObservedCalls,
  collectFreeContextTransportObservations,
  collectDuplicateSemanticCalls,
  classifyMissingReturn,
  evaluateDelivery,
  isRecord,
  legacyObservation,
  sha256,
} from "./delivery-observation.js";
import type { DuplicateSemanticCall } from "./delivery-observation.js";
import type { FreeContextTransportObservation } from "./delivery-observation.js";
import type { MissingReturnCausalEvidence } from "./delivery-observation.js";
import {
  collectCompletedDirectMcpRepositoryActions,
  collectCompletedHostRepositoryActions,
} from "./host-action-observation.js";
import { buildFreeContextInvocationWindows } from "./invocation-window.js";
import type { FreeContextInvocationKind, FreeContextInvocationWindow } from "./invocation-window.js";
import { collectInvocationProvenance } from "./invocation-provenance.js";
import type { FreeContextInvocationProvenance } from "./invocation-provenance.js";

const OUTPUT_NAME = "master-agent-context.json";
const DELIVERY_AUDIT_NAME = "delivery-observations.jsonl";
const CONSUMPTION_AUDIT_NAME = "consumption-observations.jsonl";
const INVOCATION_PROVENANCE_NAME = "invocation-provenance.json";
const RUNTIME_AGENT_DIR = "/logs/agent";

export interface MasterAgentContextSource {
  readonly path: string;
  readonly rawJsonl: string;
}

export interface FreeContextCallReference {
  readonly callId: string | null;
  readonly promptToFreeContext: string;
  readonly outputToMasterAgent: string | null;
  readonly fullSessionFile: string;
  readonly runtimeSessionFile: string;
  readonly status: string;
  readonly deliveryStatus: "matched" | "mismatch" | "missing" | "ambiguous" | "legacy_observed";
  readonly callIdCorrelation: "unique" | "missing" | "ambiguous" | null;
  readonly sessionReferenceMatches: number | null;
  readonly serializedTextSha256: string | null;
  readonly observedTextSha256: string | null;
  readonly requestMatches: boolean | null;
  readonly structuredContentMatches: boolean | null;
  readonly handoffProvenanceComplete: boolean | null;
  readonly recoverableResult: Readonly<FreeContextResult> | null;
  readonly missingReturnCausalEvidence: Readonly<MissingReturnCausalEvidence> | null;
  readonly episodeIndex: number | null;
  readonly invocationKind: FreeContextInvocationKind | null;
  readonly windowStartedAfter: string | null;
  readonly windowEndedBefore: string | null;
  readonly windowObserved: boolean | null;
  readonly exactDuplicate: boolean | null;
  readonly consumptionAudit: Readonly<FreeContextConsumptionAudit> | null;
}

export interface BenchmarkMasterAgentContext {
  readonly schemaVersion: "freecontext-master-agent-context-v4";
  readonly taskName: string;
  readonly createdAt: string;
  readonly masterAgentContext: readonly MasterAgentContextSource[];
  readonly freeContextCalls: readonly FreeContextCallReference[];
  readonly freeContextTransport: readonly Readonly<FreeContextTransportObservation>[];
  readonly duplicateSemanticCalls: readonly Readonly<DuplicateSemanticCall & { readonly repetition: string | null }>[];
  readonly invocationProvenance: Readonly<FreeContextInvocationProvenance>;
}

interface HistoricalMcpSessionV2 {
  readonly schemaVersion: "freecontext-mcp-session-v2";
  readonly transport: "mcp";
  readonly request: Readonly<FreeContextRequest>;
  readonly invocation: Readonly<{
    taskId: string;
    callId: string;
    workspaceRoot: string;
    workspaceRevision: string;
    sessionId: string;
    sessionFile: string;
  }>;
  readonly capture: McpSessionDocument["capture"];
  readonly runtimeEvents: McpSessionDocument["runtimeEvents"];
  readonly result: Readonly<FreeContextResult>;
  readonly serializedTextSha256: string;
  readonly terminalDecision: Readonly<{
    callId: string;
    winner: McpSessionDocument["terminalDecision"]["winner"];
    decidedAt: string;
    lateResultExpected: boolean;
    lateDiagnosticFile: string | null;
  }>;
  readonly terminalError: McpSessionDocument["terminalError"];
}

interface LegacyMcpSessionV2 extends Omit<HistoricalMcpSessionV2, "result"> {
  readonly contract: "legacy";
  readonly result: Readonly<LegacyFreeContextResult>;
}

interface HistoricalMcpSession {
  readonly schemaVersion: "freecontext-mcp-session-v1";
  readonly invocation: Readonly<{ request: string }>;
  readonly result: Readonly<{ status: string; sessionFile: string | null }>;
}

interface HistoricalBenchmarkSession {
  readonly schemaVersion: "freecontext-benchmark-session-v1";
  readonly invocation: Readonly<{ request: string }>;
  readonly capture: Readonly<{ outcome?: Readonly<{ status?: string }> }> | null;
}

type AuditableMcpSession = McpSessionDocument | HistoricalMcpSessionV2;
type FreeContextSessionDocument = AuditableMcpSession | LegacyMcpSessionV2 | HistoricalMcpSession | HistoricalBenchmarkSession;

interface LoadedFreeContextSession {
  readonly filePath: string;
  readonly session: FreeContextSessionDocument;
}

interface LoadedAuditableMcpSession extends LoadedFreeContextSession {
  readonly session: AuditableMcpSession;
}

function isAuditableMcpSession(session: FreeContextSessionDocument): session is AuditableMcpSession {
  return (session.schemaVersion === "freecontext-mcp-session-v2" || session.schemaVersion === "freecontext-mcp-session-v3") &&
    (session as { readonly contract?: string }).contract !== "legacy";
}

function isLegacyMcpSession(session: FreeContextSessionDocument): session is LegacyMcpSessionV2 {
  return (session.schemaVersion === "freecontext-mcp-session-v2" || session.schemaVersion === "freecontext-mcp-session-v3") &&
    (session as { readonly contract?: string }).contract === "legacy";
}

function posixRelative(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join("/");
}

async function collectFiles(directory: string, extension: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile() && entry.name.endsWith(extension)) files.push(absolute);
    }
  };
  await visit(directory);
  return files.sort((left, right) => left.localeCompare(right));
}

function collectTaskCompleteTimestamps(
  sources: readonly Readonly<MasterAgentContextSource>[],
): readonly (string | null)[] {
  const timestamps: Array<string | null> = [];
  for (const { rawJsonl } of sources) {
    for (const line of rawJsonl.split("\n")) {
      if (!line.trim()) continue;
      try {
        const record: unknown = JSON.parse(line);
        if (!isRecord(record) || record.type !== "event_msg" || !isRecord(record.payload) ||
            record.payload.type !== "task_complete") continue;
        timestamps.push(typeof record.timestamp === "string" ? record.timestamp : null);
      } catch { /* Unrelated malformed lines cannot establish a task-complete boundary. */ }
    }
  }
  return Object.freeze(timestamps);
}

function parseSessionDocument(text: string, filePath: string): FreeContextSessionDocument {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value)) throw new Error(`Invalid FreeContext session file: ${filePath}`);
  if ((value.schemaVersion === "freecontext-mcp-session-v2" || value.schemaVersion === "freecontext-mcp-session-v3") && value.transport === "mcp") {
    if (!isRecord(value.invocation) || !isRecord(value.request) || !isRecord(value.result)) {
      throw new Error(`Invalid FreeContext v2 session file: ${filePath}`);
    }
    FreeContextRequestSchema.parse(value.request);
    const currentResult = FreeContextResultSchema.safeParse(value.result);
    const legacyResult = currentResult.success ? null : LegacyFreeContextResultSchema.safeParse(value.result);
    if (!currentResult.success && !legacyResult?.success) {
      throw new Error(`Invalid current or legacy FreeContext result: ${filePath}`);
    }
    if (value.schemaVersion === "freecontext-mcp-session-v3") {
      FreeContextInvocationContextSchema.parse(value.invocation);
    } else if (
      typeof value.invocation.taskId !== "string" || typeof value.invocation.callId !== "string" ||
      typeof value.invocation.sessionFile !== "string"
    ) {
      throw new Error(`Invalid historical FreeContext v2 invocation: ${filePath}`);
    }
    if (
      typeof value.serializedTextSha256 !== "string" ||
      !isRecord(value.terminalDecision) ||
      typeof value.terminalDecision.winner !== "string"
    ) {
      throw new Error(`FreeContext MCP session has no serialized hash or terminal decision: ${filePath}`);
    }
    if (currentResult.success) return value as unknown as AuditableMcpSession;
    return Object.freeze({ ...value, contract: "legacy" as const, result: legacyResult?.data }) as unknown as LegacyMcpSessionV2;
  }
  if (
    value.schemaVersion === "freecontext-mcp-session-v1" &&
    isRecord(value.invocation) && typeof value.invocation.request === "string" &&
    isRecord(value.result) && typeof value.result.status === "string"
  ) return value as unknown as HistoricalMcpSession;
  if (
    value.schemaVersion === "freecontext-benchmark-session-v1" &&
    isRecord(value.invocation) && typeof value.invocation.request === "string"
  ) return value as unknown as HistoricalBenchmarkSession;
  throw new Error(`Invalid FreeContext session file: ${filePath}`);
}

function promptToFreeContext(session: FreeContextSessionDocument): string {
  return isAuditableMcpSession(session) || isLegacyMcpSession(session)
    ? JSON.stringify(session.request, null, 2)
    : session.invocation.request;
}

function sessionStatus(session: FreeContextSessionDocument): string {
  if (isAuditableMcpSession(session) || isLegacyMcpSession(session) || session.schemaVersion === "freecontext-mcp-session-v1") {
    return session.result.status;
  }
  return session.capture?.outcome?.status ?? "failed_before_capture";
}

export async function exportMasterAgentContext({
  agentDir,
  taskName,
  allowUnreferencedSessions = false,
  now = () => new Date(),
}: Readonly<{
  agentDir: string;
  taskName: string;
  allowUnreferencedSessions?: boolean;
  now?: () => Date;
}>): Promise<string> {
  if (!taskName.trim()) throw new Error("Benchmark task name must be non-empty.");
  const root = await realpath(agentDir);
  const masterFiles = await collectFiles(path.join(root, "sessions"), ".jsonl");
  if (masterFiles.length === 0) throw new Error(`No master-agent session JSONL found under ${root}`);
  const masterAgentContext = await Promise.all(masterFiles.map(async (filePath) => Object.freeze({
    path: posixRelative(root, filePath),
    rawJsonl: await readFile(filePath, "utf8"),
  })));
  const completeMasterContext = masterAgentContext.map((source) => source.rawJsonl).join("\n");
  const taskCompleteTimestamps = collectTaskCompleteTimestamps(masterAgentContext);
  const observedCalls = collectObservedCalls(completeMasterContext);
  const freeContextTransport = collectFreeContextTransportObservations(completeMasterContext);
  const firstObservedCallActions = observedCalls[0]
    ? collectParentRepositoryActions(completeMasterContext, observedCalls[0].callId)
    : [];
  const duplicateSemanticCalls = collectDuplicateSemanticCalls(
    observedCalls,
    firstObservedCallActions[0]?.taskId ?? taskName.trim(),
  ).map((attempt) => Object.freeze({
    ...attempt,
    repetition: firstObservedCallActions[0]?.repetition ?? null,
  }));

  const freeContextDirectory = path.join(root, "freecontext-sessions");
  let freeContextFiles: string[] = [];
  try {
    freeContextFiles = (await collectFiles(freeContextDirectory, ".json"))
      .filter((filePath) => !filePath.endsWith(".late.json"));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }

  const loadedSessions: readonly Readonly<LoadedFreeContextSession>[] = await Promise.all(
    freeContextFiles.map(async (filePath) => Object.freeze({
      filePath,
      session: parseSessionDocument(await readFile(filePath, "utf8"), filePath),
    })),
  );
  const auditableSessions = loadedSessions.filter(
    (entry): entry is Readonly<LoadedAuditableMcpSession> => isAuditableMcpSession(entry.session),
  );
  const auditableTerminalHashes = new Set(auditableSessions.map(({ session }) => session.serializedTextSha256));
  const sessionTransports = freeContextTransport.filter(({ terminalTextSha256 }) =>
    typeof terminalTextSha256 === "string" && auditableTerminalHashes.has(terminalTextSha256));
  const invocationWindows = buildFreeContextInvocationWindows(
    auditableSessions.map(({ session }) => ({
      callId: session.invocation.callId,
      request: session.request,
      result: session.result,
      serializedTextSha256: session.serializedTextSha256,
    })),
    sessionTransports,
    taskCompleteTimestamps,
  );
  const windowContextByFile = new Map<string, Readonly<{
    window: Readonly<FreeContextInvocationWindow>;
    nextWindow: Readonly<FreeContextInvocationWindow> | undefined;
  }>>();
  for (const [position, window] of invocationWindows.entries()) {
    const entry = auditableSessions[window.inputIndex];
    if (!entry) throw new Error(`FreeContext window has no source session at index ${window.inputIndex}.`);
    windowContextByFile.set(entry.filePath, Object.freeze({ window, nextWindow: invocationWindows[position + 1] }));
  }
  const orderedSessions = [
    ...invocationWindows.map((window) => auditableSessions[window.inputIndex]).filter(
      (entry): entry is Readonly<LoadedAuditableMcpSession> => entry !== undefined,
    ),
    ...loadedSessions.filter(({ session }) => !isAuditableMcpSession(session)),
  ];
  const invocationProvenance = collectInvocationProvenance({
    calls: observedCalls,
    sessions: auditableSessions.map(({ session }) => ({
      callId: session.invocation.callId,
      request: FreeContextRequestSchema.parse(session.request),
      result: FreeContextResultSchema.parse(session.result),
      capture: session.capture,
    })),
    windows: invocationWindows,
  });

  const freeContextCalls = orderedSessions.map(({ filePath, session }) => {
    const relativePath = posixRelative(root, filePath);
    const runtimeSessionFile = path.posix.join(RUNTIME_AGENT_DIR, relativePath);
    if (isAuditableMcpSession(session)) {
      const result = FreeContextResultSchema.parse(session.result) as Readonly<FreeContextResult>;
      const request = FreeContextRequestSchema.parse(session.request) as Readonly<FreeContextRequest>;
      if (result.sessionFile !== runtimeSessionFile || session.invocation.sessionFile !== runtimeSessionFile) {
        throw new Error(`MCP session path does not match exported file: ${filePath}`);
      }
      const delivery = evaluateDelivery(
        observedCalls,
        session.invocation.callId,
        request,
        result,
        session.serializedTextSha256,
      );
      const explicitActions = collectParentRepositoryActions(completeMasterContext, session.invocation.callId);
      const windowContext = windowContextByFile.get(filePath);
      if (!windowContext) throw new Error(`FreeContext session has no invocation window: ${filePath}`);
      const { window, nextWindow } = windowContext;
      const nextRequest = nextWindow
        ? FreeContextRequestSchema.parse(auditableSessions[nextWindow.inputIndex]?.session.request)
        : null;
      const hostObservation = explicitActions.length === 0 && window.windowObserved && window.windowStartedAfter
        ? collectCompletedHostRepositoryActions(completeMasterContext, {
            completedAt: window.windowStartedAfter,
            endedBefore: window.windowEndedBefore,
            taskId: taskName.trim(),
            callId: session.invocation.callId,
            repetition: "host-observed",
            gapQuestionIds: result.gaps.map(({ questionId }) => questionId),
          })
        : null;
      const directMcpObservation = explicitActions.length === 0 && window.windowObserved
        ? collectCompletedDirectMcpRepositoryActions(completeMasterContext, {
            sessionFile: result.sessionFile,
            taskId: taskName.trim(),
            callId: session.invocation.callId,
            repetition: "host-observed",
            gapQuestionIds: result.gaps.map(({ questionId }) => questionId),
          })
        : null;
      const fallbackObservation = hostObservation?.complete === true ? hostObservation : directMcpObservation;
      const windowObserved = window.windowObserved &&
        (explicitActions.length > 0 || fallbackObservation?.complete === true);
      const observedActions = !windowObserved ? [] : explicitActions.length > 0
        ? explicitActions
        : fallbackObservation?.actions ?? [];
      const actionIdentity = explicitActions[0];
      const consumptionAudit = analyzeFreeContextConsumption(
        result,
        observedActions,
        {
          observationSource: explicitActions.length > 0 ? "explicit_host_event" : "completed_codex_tool_call",
          taskId: actionIdentity?.taskId ?? taskName.trim(),
          callId: session.invocation.callId,
          repetition: actionIdentity?.repetition ?? "host-observed",
          episodeIndex: window.episodeIndex,
          invocationKind: window.invocationKind,
          windowStartedAfter: window.windowStartedAfter,
          windowEndedBefore: window.windowEndedBefore,
          windowObserved,
          exactDuplicate: window.exactDuplicate,
          windowFailureReasons: windowObserved
            ? window.failureReasons
            : [...window.failureReasons, window.windowObserved
                ? "host_action_observation"
                : "task_complete_boundary"],
          followedByReentrant: nextWindow?.invocationKind === "reentrant",
          followedByRecovery: nextWindow?.invocationKind === "recovery",
          recoveryProbePath: nextRequest?.recovery?.probe.path ?? null,
          hasFollowupInvocation: nextWindow !== undefined,
          reentryOrigin: nextRequest?.reentry?.blockingGap.origin.kind ?? null,
        },
      );
      const handoffProvenanceComplete = consumptionAudit.inlineEvidenceProvenanceComplete &&
        delivery.deliveryStatus === "matched" && delivery.sessionReferenceMatches === 1 &&
        delivery.observedTextSha256 === session.serializedTextSha256 &&
        delivery.requestMatches !== false && delivery.structuredContentMatches !== false;
      const missingReturnCausalEvidence = classifyMissingReturn(delivery, session);
      return Object.freeze({
        callId: session.invocation.callId,
        promptToFreeContext: JSON.stringify(request, null, 2),
        outputToMasterAgent: delivery.outputToMasterAgent,
        fullSessionFile: relativePath,
        runtimeSessionFile,
        status: result.status,
        deliveryStatus: delivery.deliveryStatus,
        callIdCorrelation: delivery.callIdCorrelation,
        sessionReferenceMatches: delivery.sessionReferenceMatches,
        serializedTextSha256: session.serializedTextSha256,
        observedTextSha256: delivery.observedTextSha256,
        requestMatches: delivery.requestMatches,
        structuredContentMatches: delivery.structuredContentMatches,
        handoffProvenanceComplete,
        recoverableResult: delivery.deliveryStatus === "matched" ? null : result,
        missingReturnCausalEvidence,
        episodeIndex: window.episodeIndex,
        invocationKind: window.invocationKind,
        windowStartedAfter: window.windowStartedAfter,
        windowEndedBefore: window.windowEndedBefore,
        windowObserved,
        exactDuplicate: window.exactDuplicate,
        consumptionAudit,
      } satisfies FreeContextCallReference);
    }

    const observation = legacyObservation(completeMasterContext, runtimeSessionFile);
    return Object.freeze({
      callId: null,
      promptToFreeContext: promptToFreeContext(session),
      outputToMasterAgent: observation,
      fullSessionFile: relativePath,
      runtimeSessionFile,
      status: sessionStatus(session),
      deliveryStatus: observation ? "legacy_observed" : "missing",
      callIdCorrelation: null,
      sessionReferenceMatches: null,
      serializedTextSha256: null,
      observedTextSha256: observation ? sha256(observation) : null,
      requestMatches: null,
      structuredContentMatches: null,
      handoffProvenanceComplete: null,
      recoverableResult: null,
      missingReturnCausalEvidence: null,
      episodeIndex: null,
      invocationKind: null,
      windowStartedAfter: null,
      windowEndedBefore: null,
      windowObserved: null,
      exactDuplicate: null,
      consumptionAudit: null,
    } satisfies FreeContextCallReference);
  });

  const createdAt = now().toISOString();
  const document: BenchmarkMasterAgentContext = {
    schemaVersion: "freecontext-master-agent-context-v4",
    taskName: taskName.trim(),
    createdAt,
    masterAgentContext: Object.freeze(masterAgentContext),
    freeContextCalls: Object.freeze(freeContextCalls),
    freeContextTransport,
    duplicateSemanticCalls: Object.freeze(duplicateSemanticCalls),
    invocationProvenance,
  };
  const outputPath = path.join(root, OUTPUT_NAME);
  await writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  const auditPath = path.join(root, DELIVERY_AUDIT_NAME);
  await writeFile(
    auditPath,
    freeContextCalls.map((call) => JSON.stringify({
      schemaVersion: "delivery-observation-v1",
      taskName: taskName.trim(),
      recordedAt: createdAt,
      ...call,
    })).join("\n") + (freeContextCalls.length > 0 ? "\n" : ""),
    { encoding: "utf8", flag: "ax", mode: 0o600 },
  );
  await writeFile(
    path.join(root, INVOCATION_PROVENANCE_NAME),
    `${JSON.stringify(invocationProvenance, null, 2)}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
  const consumptionRecords = [
    ...freeContextCalls.flatMap((call) => call.consumptionAudit ? [{
      ...call.consumptionAudit,
      taskName: taskName.trim(),
      recordedAt: createdAt,
    }] : []),
    ...duplicateSemanticCalls.map((attempt) => ({
      schemaVersion: "freecontext-duplicate-semantic-call-v1",
      taskName: taskName.trim(),
      recordedAt: createdAt,
      ...attempt,
    })),
    ...freeContextTransport.map((observation) => ({
      ...observation,
      taskName: taskName.trim(),
      recordedAt: createdAt,
    })),
  ];
  await writeFile(
    path.join(root, CONSUMPTION_AUDIT_NAME),
    consumptionRecords.map((record) => JSON.stringify(record)).join("\n") +
      (consumptionRecords.length > 0 ? "\n" : ""),
    { encoding: "utf8", flag: "ax", mode: 0o600 },
  );

  const missing = freeContextCalls.find((call) => call.deliveryStatus === "missing");
  if (missing && (missing.callId !== null || !allowUnreferencedSessions)) {
    throw new Error(`Master-agent context has no actual observation for ${missing.runtimeSessionFile}`);
  }
  const mismatch = freeContextCalls.find((call) => call.deliveryStatus === "mismatch");
  if (mismatch) throw new Error(`Master-agent observation does not match ${mismatch.runtimeSessionFile}`);
  const ambiguous = freeContextCalls.find((call) => call.deliveryStatus === "ambiguous");
  if (ambiguous) throw new Error(`Master-agent observation is ambiguous for ${ambiguous.runtimeSessionFile}`);
  return outputPath;
}
