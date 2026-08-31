import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  FreeContextInvocationContextSchema,
  FreeContextRequestSchema,
  FreeContextResultSchema,
  normalizeFreeContextContinuationRequest,
} from "./contracts.js";
import type {
  FreeContextInvocationContext,
  FreeContextCallerReentry,
  FreeContextRecoveryRequest,
  FreeContextRequest,
  FreeContextResult,
} from "./contracts.js";
import type {
  CapturedFreeContextRuntimeEvent,
  ExplorerCapturedError,
  ExplorerSessionCapture,
} from "../runtime/session-capture.js";
import type { PiSessionEventState } from "../runtime/pi-session.js";
import { cancelSessionFile, commitSessionFile, reserveSessionFile } from "../session/store.js";
import { defaultSessionDirectory } from "../session/store.js";
import type { SessionFileReservation } from "../session/store.js";
import type { TerminalDecision } from "./lifecycle.js";

export interface McpRuntimeEvent {
  readonly event: CapturedFreeContextRuntimeEvent;
  readonly state: PiSessionEventState;
}

export interface McpSessionReservation {
  readonly file: Readonly<SessionFileReservation>;
  readonly startedAt: string;
  readonly request: Readonly<FreeContextRequest>;
  readonly invocation: Readonly<FreeContextInvocationContext>;
}

export interface McpSessionDocument {
  readonly schemaVersion: "freecontext-mcp-session-v3";
  readonly transport: "mcp";
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly request: Readonly<FreeContextRequest>;
  readonly invocation: Readonly<FreeContextInvocationContext>;
  readonly capture: Readonly<ExplorerSessionCapture> | null;
  readonly runtimeEvents: readonly Readonly<McpRuntimeEvent>[];
  readonly result: Readonly<FreeContextResult>;
  readonly serializedTextSha256: string;
  readonly terminalDecision: Readonly<TerminalDecision>;
  readonly terminalError: Readonly<ExplorerCapturedError> | null;
}

export interface McpSessionCommit {
  readonly sessionFile: string;
  readonly sessionBytes: number;
  readonly sessionFileSha256: string;
}

export type CommittedRecoveryResolution = Readonly<{
  accepted: true;
  reason: string;
  request: Readonly<FreeContextRequest>;
}> | Readonly<{
  accepted: false;
  reason: string;
}>;

export type CommittedContinuationResolution = Readonly<{
  accepted: true;
  reason: string;
  request: Readonly<FreeContextRequest>;
}> | Readonly<{
  accepted: false;
  reason: string;
}>;

async function committedSessions(
  sessionDirectory: string,
): Promise<Array<{ document: McpSessionDocument; committedAt: number }>> {
  let names: string[];
  try {
    names = (await readdir(sessionDirectory)).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const sessions: Array<{ document: McpSessionDocument; committedAt: number }> = [];
  for (const name of names) {
    try {
      const sessionPath = path.join(sessionDirectory, name);
      const [text, fileStat] = await Promise.all([readFile(sessionPath, "utf8"), stat(sessionPath)]);
      const value: unknown = JSON.parse(text);
      if (!value || typeof value !== "object" || (value as { schemaVersion?: unknown }).schemaVersion !== "freecontext-mcp-session-v3") continue;
      const document = value as McpSessionDocument;
      if (document.transport !== "mcp" || !document.invocation || !document.request || !document.result ||
          typeof document.finishedAt !== "string" || Number.isNaN(Date.parse(document.finishedAt)) ||
          !FreeContextInvocationContextSchema.safeParse(document.invocation).success ||
          !FreeContextRequestSchema.safeParse(document.request).success ||
          !FreeContextResultSchema.safeParse(document.result).success) continue;
      sessions.push({ document, committedAt: fileStat.mtimeMs });
    } catch { /* Unrelated or historical session files cannot establish current continuation eligibility. */ }
  }
  return sessions;
}

function sortWorkspaceSessions(
  sessions: readonly { document: McpSessionDocument; committedAt: number }[],
  canonicalWorkspace: string,
): Array<{ document: McpSessionDocument; committedAt: number }> {
  return sessions.filter(({ document }) => path.resolve(document.invocation.workspaceRoot) === canonicalWorkspace)
    .sort((left, right) => left.committedAt - right.committedAt ||
      Date.parse(left.document.finishedAt) - Date.parse(right.document.finishedAt) ||
      left.document.invocation.sessionId.localeCompare(right.document.invocation.sessionId));
}

export async function restoreCommittedRecovery({
  recovery,
  workspaceRoot,
  sessionDirectory = defaultSessionDirectory(),
}: Readonly<{
  recovery: Readonly<FreeContextRecoveryRequest>;
  workspaceRoot: string;
  sessionDirectory?: string;
}>): Promise<CommittedRecoveryResolution> {
  let names: string[];
  try {
    names = (await readdir(sessionDirectory)).filter((name) => name.endsWith(".json"));
  } catch {
    return Object.freeze({ accepted: false, reason: "Recovery prior session is not available." });
  }
  const canonicalWorkspace = await realpath(workspaceRoot).catch(() => null);
  if (!canonicalWorkspace) return Object.freeze({ accepted: false, reason: "Recovery workspace is not available." });
  const sessions: Array<{ document: McpSessionDocument; committedAt: number }> = [];
  for (const name of names) {
    try {
      const sessionPath = path.join(sessionDirectory, name);
      const [text, fileStat] = await Promise.all([readFile(sessionPath, "utf8"), stat(sessionPath)]);
      const value: unknown = JSON.parse(text);
      if (!value || typeof value !== "object" || (value as { schemaVersion?: unknown }).schemaVersion !== "freecontext-mcp-session-v3") continue;
      const document = value as McpSessionDocument;
      if (document.transport !== "mcp" || !document.invocation || !document.request || !document.result ||
          typeof document.finishedAt !== "string" || Number.isNaN(Date.parse(document.finishedAt)) ||
          !FreeContextInvocationContextSchema.safeParse(document.invocation).success ||
          !FreeContextRequestSchema.safeParse(document.request).success ||
          !FreeContextResultSchema.safeParse(document.result).success) continue;
      sessions.push({ document, committedAt: fileStat.mtimeMs });
    } catch { /* Unrelated or historical session files cannot establish current recovery eligibility. */ }
  }
  const sameWorkspace = sessions.filter(({ document }) => path.resolve(document.invocation.workspaceRoot) === canonicalWorkspace)
    .sort((left, right) => left.committedAt - right.committedAt ||
      Date.parse(left.document.finishedAt) - Date.parse(right.document.finishedAt) ||
      left.document.invocation.sessionId.localeCompare(right.document.invocation.sessionId));
  const priorEntry = sameWorkspace.find(({ document }) => document.invocation.sessionId === recovery.priorSessionId);
  const prior = priorEntry?.document;
  if (!prior) return Object.freeze({ accepted: false, reason: "Recovery prior session is not a committed session in this workspace." });
  if (sameWorkspace.some(({ document }) => document.request.recovery?.priorSessionId === recovery.priorSessionId)) {
    return Object.freeze({ accepted: false, reason: "Recovery prior session has already been consumed." });
  }
  if (sameWorkspace.at(-1) !== priorEntry) {
    return Object.freeze({ accepted: false, reason: "Recovery prior session is not the immediately eligible session." });
  }
  if (prior.result.status !== "not_found" || prior.result.handoff !== null && prior.result.handoff !== undefined) {
    return Object.freeze({ accepted: false, reason: "Recovery prior session must be not_found without a handoff." });
  }
  if (prior.request.recovery) {
    return Object.freeze({ accepted: false, reason: "Recovery cannot chain from a recovery session." });
  }
  const request = FreeContextRequestSchema.parse({
    taskText: prior.request.taskText,
    workUnit: prior.request.workUnit,
    knownRefs: prior.request.knownRefs,
    evidenceQuestions: prior.request.evidenceQuestions,
    recovery,
  });
  return Object.freeze({
    accepted: true,
    reason: "Recovery restored the immediately eligible committed not_found request facts.",
    request: Object.freeze(request),
  });
}

export async function restoreCommittedContinuation({
  reentry,
  workspaceRoot,
  sessionDirectory = defaultSessionDirectory(),
}: Readonly<{
  reentry: Readonly<FreeContextCallerReentry>;
  workspaceRoot: string;
  sessionDirectory?: string;
}>): Promise<CommittedContinuationResolution> {
  const canonicalWorkspace = await realpath(workspaceRoot).catch(() => null);
  if (!canonicalWorkspace) return Object.freeze({ accepted: false, reason: "Continuation workspace is not available." });
  const sameWorkspace = sortWorkspaceSessions(await committedSessions(sessionDirectory), canonicalWorkspace);
  const priorEntry = sameWorkspace.find(({ document }) => document.invocation.sessionId === reentry.priorSessionId);
  const prior = priorEntry?.document;
  if (!prior) return Object.freeze({ accepted: false, reason: "Continuation prior session is not a committed session in this workspace." });
  if (sameWorkspace.some(({ document }) => document.request.reentry?.priorSessionId === reentry.priorSessionId)) {
    return Object.freeze({ accepted: false, reason: "Continuation prior session has already been consumed." });
  }
  if (sameWorkspace.at(-1) !== priorEntry) {
    return Object.freeze({ accepted: false, reason: "Continuation prior session is not the immediately eligible session." });
  }
  if (prior.result.status !== "ready" && prior.result.status !== "partial" || !prior.result.handoff) {
    return Object.freeze({ accepted: false, reason: "Continuation prior session must have a committed ready or partial handoff." });
  }
  try {
    const request = normalizeFreeContextContinuationRequest(reentry, prior.request, prior.result.handoff);
    return Object.freeze({
      accepted: true,
      reason: "Continuation restored the immediately eligible committed handoff and request facts.",
      request: Object.freeze(request),
    });
  } catch {
    return Object.freeze({ accepted: false, reason: "Continuation child question or origin is invalid." });
  }
}

export async function reserveMcpSession({
  request,
  invocationId,
  callId,
  workspaceRoot,
  workspaceRevision,
  sessionDirectory,
  sessionFile,
  now = () => new Date(),
}: Readonly<{
  request: Readonly<FreeContextRequest>;
  invocationId: string;
  callId: string;
  workspaceRoot: string;
  workspaceRevision: string;
  sessionDirectory?: string;
  sessionFile?: string;
  now?: () => Date;
}>): Promise<Readonly<McpSessionReservation>> {
  const file = await reserveSessionFile({
    workspaceRoot,
    ...(sessionDirectory ? { sessionDirectory } : {}),
    ...(sessionFile ? { filePath: sessionFile } : {}),
  });
  const sessionId = path.basename(file.path, path.extname(file.path));
  const invocation: Readonly<FreeContextInvocationContext> = Object.freeze({
    invocationId,
    callId,
    workspaceRoot,
    workspaceRevision,
    sessionId,
    sessionFile: file.path,
  });
  return Object.freeze({ file, startedAt: now().toISOString(), request, invocation });
}

export async function commitMcpSession({
  reservation,
  capture,
  runtimeEvents,
  result,
  serializedText,
  terminalDecision,
  terminalError,
  now = () => new Date(),
}: Readonly<{
  reservation: Readonly<McpSessionReservation>;
  capture: Readonly<ExplorerSessionCapture> | null;
  runtimeEvents: readonly Readonly<McpRuntimeEvent>[];
  result: Readonly<FreeContextResult>;
  serializedText: string;
  terminalDecision: Readonly<TerminalDecision>;
  terminalError: Readonly<ExplorerCapturedError> | null;
  now?: () => Date;
}>): Promise<Readonly<McpSessionCommit>> {
  const document: McpSessionDocument = Object.freeze({
    schemaVersion: "freecontext-mcp-session-v3",
    transport: "mcp",
    startedAt: reservation.startedAt,
    finishedAt: now().toISOString(),
    request: reservation.request,
    invocation: reservation.invocation,
    capture,
    runtimeEvents: Object.freeze([...runtimeEvents]),
    result,
    serializedTextSha256: createHash("sha256").update(serializedText).digest("hex"),
    terminalDecision,
    terminalError,
  });
  const committed = await commitSessionFile(reservation.file, document);
  return Object.freeze({
    sessionFile: committed.path,
    sessionBytes: committed.bytes,
    sessionFileSha256: committed.sha256,
  });
}

export async function cancelMcpSession(reservation: Readonly<McpSessionReservation>): Promise<void> {
  await cancelSessionFile(reservation.file);
}
