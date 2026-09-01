import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  FreeContextCallerRequestSchema,
  FreeContextInvocationContextSchema,
  FreeContextRequestSchema,
  FreeContextResultSchema,
} from "./contracts.js";
import type {
  FreeContextCallerRequest,
  FreeContextInvocationContext,
  FreeContextRequest,
  FreeContextResult,
} from "./contracts.js";
import type { ExplorerCapturedError, ExplorerSessionCapture } from "../runtime/session-capture.js";
import type { PiSessionEventState } from "../runtime/pi-session.js";
import { cancelSessionFile, commitSessionFile, reserveSessionFile } from "../session/store.js";
import { defaultSessionDirectory } from "../session/store.js";
import type { SessionFileReservation } from "../session/store.js";
import type { TerminalDecision } from "./lifecycle.js";

export interface McpRuntimeEvent {
  readonly event: unknown;
  readonly state: PiSessionEventState;
}

export interface McpSessionReservation {
  readonly file: Readonly<SessionFileReservation>;
  readonly startedAt: string;
  readonly request: Readonly<FreeContextRequest>;
  readonly invocation: Readonly<FreeContextInvocationContext>;
}

export interface McpSessionDocument {
  readonly schemaVersion: "freecontext-mcp-session-v4";
  readonly transport: "mcp";
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly request: Readonly<FreeContextRequest>;
  readonly invocation: Readonly<FreeContextInvocationContext>;
  readonly capture: Readonly<ExplorerSessionCapture> | null;
  readonly runtimeEvents: readonly Readonly<McpRuntimeEvent>[];
  readonly result: Readonly<FreeContextResult>;
  readonly terminalDecision: Readonly<TerminalDecision>;
  readonly terminalError: Readonly<ExplorerCapturedError> | null;
}

export interface McpSessionCommit {
  readonly sessionFile: string;
}

export type CommittedContinuationResolution = Readonly<{
  accepted: true;
  reason: string;
  request: Readonly<FreeContextRequest>;
}> | Readonly<{
  accepted: false;
  reason: string;
}>;

async function findSession(
  sessionDirectory: string,
  sessionId: string,
  workspaceRoot: string,
): Promise<McpSessionDocument | null> {
  const canonicalWorkspace = await realpath(workspaceRoot).catch(() => null);
  if (!canonicalWorkspace) return null;
  let names: string[];
  try { names = (await readdir(sessionDirectory)).filter((name) => name.endsWith(".json")); } catch { return null; }
  for (const name of names) {
    try {
      const text = await readFile(path.join(sessionDirectory, name), "utf8");
      const value: unknown = JSON.parse(text);
      if (!value || typeof value !== "object") continue;
      const document = value as McpSessionDocument;
      if (document.schemaVersion !== "freecontext-mcp-session-v4" || document.transport !== "mcp") continue;
      if (document.invocation.sessionId !== sessionId || path.resolve(document.invocation.workspaceRoot) !== canonicalWorkspace) continue;
      if (!FreeContextInvocationContextSchema.safeParse(document.invocation).success
        || !FreeContextRequestSchema.safeParse(document.request).success
        || !FreeContextResultSchema.safeParse(document.result).success) continue;
      return document;
    } catch { /* Ignore unrelated or incomplete files. */ }
  }
  return null;
}

export async function restoreCommittedContinuation({
  sessionId,
  question,
  hints,
  workspaceRoot,
  sessionDirectory = defaultSessionDirectory(),
}: Readonly<{
  sessionId: string;
  question: string;
  hints?: string;
  workspaceRoot: string;
  sessionDirectory?: string;
}>): Promise<CommittedContinuationResolution> {
  const prior = await findSession(sessionDirectory, sessionId, workspaceRoot);
  if (!prior) return Object.freeze({ accepted: false, reason: "Continuation session is not available in this workspace." });
  const priorText = prior.result.text.trim();
  const inheritedHints = priorText ? `Prior FreeContext answer:\n${priorText}` : undefined;
  const combinedHints = [hints?.trim(), inheritedHints].filter((value): value is string => Boolean(value)).join("\n\n");
  const request = FreeContextCallerRequestSchema.parse({
    question,
    ...(combinedHints ? { hints: combinedHints.slice(0, 4_000) } : {}),
  });
  return Object.freeze({ accepted: true, reason: "Continuation restored prior answer context.", request: Object.freeze(request) });
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
  const file = await reserveSessionFile({ workspaceRoot, ...(sessionDirectory ? { sessionDirectory } : {}), ...(sessionFile ? { filePath: sessionFile } : {}) });
  const sessionId = path.basename(file.path, path.extname(file.path));
  const invocation: Readonly<FreeContextInvocationContext> = Object.freeze({ invocationId, callId, workspaceRoot, workspaceRevision, sessionId, sessionFile: file.path });
  return Object.freeze({ file, startedAt: now().toISOString(), request: FreeContextRequestSchema.parse(request), invocation });
}

export async function commitMcpSession({
  reservation,
  capture,
  runtimeEvents,
  result,
  terminalDecision,
  terminalError,
  now = () => new Date(),
}: Readonly<{
  reservation: Readonly<McpSessionReservation>;
  capture: Readonly<ExplorerSessionCapture> | null;
  runtimeEvents: readonly Readonly<McpRuntimeEvent>[];
  result: Readonly<FreeContextResult>;
  terminalDecision: Readonly<TerminalDecision>;
  terminalError: Readonly<ExplorerCapturedError> | null;
  now?: () => Date;
}>): Promise<Readonly<McpSessionCommit>> {
  const document: McpSessionDocument = Object.freeze({
    schemaVersion: "freecontext-mcp-session-v4",
    transport: "mcp",
    startedAt: reservation.startedAt,
    finishedAt: now().toISOString(),
    request: reservation.request,
    invocation: reservation.invocation,
    capture,
    runtimeEvents: Object.freeze([...runtimeEvents]),
    result: FreeContextResultSchema.parse(result),
    terminalDecision,
    terminalError,
  });
  const committed = await commitSessionFile(reservation.file, document);
  return Object.freeze({ sessionFile: committed.path });
}

export async function cancelMcpSession(reservation: Readonly<McpSessionReservation>): Promise<void> {
  await cancelSessionFile(reservation.file);
}
