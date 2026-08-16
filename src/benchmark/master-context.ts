import { readdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { FreeContextInvocationContextSchema, FreeContextRequestSchema, FreeContextResultSchema } from "../mcp/contracts.js";
import type { FreeContextRequest, FreeContextResult } from "../mcp/contracts.js";
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
import { collectCompletedHostRepositoryActions } from "./host-action-observation.js";

const OUTPUT_NAME = "master-agent-context.json";
const DELIVERY_AUDIT_NAME = "delivery-observations.jsonl";
const CONSUMPTION_AUDIT_NAME = "consumption-observations.jsonl";
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
  readonly recoverableResult: Readonly<FreeContextResult> | null;
  readonly missingReturnCausalEvidence: Readonly<MissingReturnCausalEvidence> | null;
  readonly consumptionAudit: Readonly<FreeContextConsumptionAudit> | null;
}

export interface BenchmarkMasterAgentContext {
  readonly schemaVersion: "freecontext-master-agent-context-v3";
  readonly taskName: string;
  readonly createdAt: string;
  readonly masterAgentContext: readonly MasterAgentContextSource[];
  readonly freeContextCalls: readonly FreeContextCallReference[];
  readonly freeContextTransport: readonly Readonly<FreeContextTransportObservation>[];
  readonly duplicateSemanticCalls: readonly Readonly<DuplicateSemanticCall & { readonly repetition: string | null }>[];
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
type FreeContextSessionDocument = AuditableMcpSession | HistoricalMcpSession | HistoricalBenchmarkSession;

function isAuditableMcpSession(session: FreeContextSessionDocument): session is AuditableMcpSession {
  return session.schemaVersion === "freecontext-mcp-session-v2" || session.schemaVersion === "freecontext-mcp-session-v3";
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

function parseSessionDocument(text: string, filePath: string): FreeContextSessionDocument {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value)) throw new Error(`Invalid FreeContext session file: ${filePath}`);
  if ((value.schemaVersion === "freecontext-mcp-session-v2" || value.schemaVersion === "freecontext-mcp-session-v3") && value.transport === "mcp") {
    if (!isRecord(value.invocation) || !isRecord(value.request) || !isRecord(value.result)) {
      throw new Error(`Invalid FreeContext v2 session file: ${filePath}`);
    }
    FreeContextRequestSchema.parse(value.request);
    FreeContextResultSchema.parse(value.result);
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
    return value as unknown as AuditableMcpSession;
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
  return isAuditableMcpSession(session)
    ? JSON.stringify(session.request, null, 2)
    : session.invocation.request;
}

function sessionStatus(session: FreeContextSessionDocument): string {
  if (isAuditableMcpSession(session) || session.schemaVersion === "freecontext-mcp-session-v1") {
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
    freeContextFiles = await collectFiles(freeContextDirectory, ".json");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }

  const freeContextCalls = await Promise.all(freeContextFiles.map(async (filePath) => {
    const session = parseSessionDocument(await readFile(filePath, "utf8"), filePath);
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
      const matchingTransports = freeContextTransport.filter((item) =>
        (typeof item.terminalTextSha256 === "string"
          ? item.terminalTextSha256 === session.serializedTextSha256
          : item.cellId === session.invocation.callId || item.outerCallId === session.invocation.callId) &&
          item.completedAt !== null);
      const matchingTransport = matchingTransports.length === 1 ? matchingTransports[0] : null;
      const hostObservation = explicitActions.length === 0 && matchingTransport?.completedAt &&
          session.schemaVersion === "freecontext-mcp-session-v3"
        ? collectCompletedHostRepositoryActions(completeMasterContext, {
            completedAt: matchingTransport.completedAt,
            taskId: taskName.trim(),
            callId: session.invocation.callId,
            repetition: "host-observed",
            gapQuestionIds: result.gaps.map(({ questionId }) => questionId),
          })
        : null;
      const observedActions = explicitActions.length > 0
        ? explicitActions
        : hostObservation?.complete ? hostObservation.actions : [];
      const consumptionAudit = analyzeFreeContextConsumption(
        result,
        observedActions,
        explicitActions.length > 0 ? "explicit_host_event" : "completed_codex_tool_call",
      );
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
        recoverableResult: delivery.deliveryStatus === "matched" ? null : result,
        missingReturnCausalEvidence,
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
      recoverableResult: null,
      missingReturnCausalEvidence: null,
      consumptionAudit: null,
    } satisfies FreeContextCallReference);
  }));

  const createdAt = now().toISOString();
  const document: BenchmarkMasterAgentContext = {
    schemaVersion: "freecontext-master-agent-context-v3",
    taskName: taskName.trim(),
    createdAt,
    masterAgentContext: Object.freeze(masterAgentContext),
    freeContextCalls: Object.freeze(freeContextCalls),
    freeContextTransport,
    duplicateSemanticCalls: Object.freeze(duplicateSemanticCalls),
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
