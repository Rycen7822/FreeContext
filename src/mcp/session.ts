import path from "node:path";
import {
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
