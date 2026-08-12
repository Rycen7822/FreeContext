import type {
  CapturedFreeContextRuntimeEvent,
  ExplorerCapturedError,
  ExplorerSessionCapture,
} from "../runtime/session-capture.js";
import type { PiSessionEventState } from "../runtime/pi-session.js";
import {
  commitSessionFile,
  reserveSessionFile,
} from "../session/store.js";
import type { SessionFileReservation } from "../session/store.js";
import { renderGatherContextText } from "./contracts.js";
import type { GatherContextOutput } from "./contracts.js";

export interface McpRuntimeEvent {
  readonly event: CapturedFreeContextRuntimeEvent;
  readonly state: PiSessionEventState;
}

export interface McpSessionReservation {
  readonly file: Readonly<SessionFileReservation>;
  readonly startedAt: string;
  readonly request: string;
  readonly workspace: string;
}

export interface McpSessionDocument {
  readonly schemaVersion: "freecontext-mcp-session-v1";
  readonly transport: "mcp";
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly invocation: Readonly<{ request: string; workspace: string }>;
  readonly capture: Readonly<ExplorerSessionCapture> | null;
  readonly runtimeEvents: readonly Readonly<McpRuntimeEvent>[];
  readonly modelVisibleText?: string;
  readonly result: Readonly<GatherContextOutput>;
  readonly terminalError: Readonly<ExplorerCapturedError> | null;
}

export interface McpSessionCommit {
  readonly sessionFile: string;
  readonly sessionBytes: number;
}

export async function reserveMcpSession({
  request,
  workspace,
  sessionDirectory,
  now = () => new Date(),
}: Readonly<{
  request: string;
  workspace: string;
  sessionDirectory: string;
  now?: () => Date;
}>): Promise<Readonly<McpSessionReservation>> {
  const file = await reserveSessionFile({ workspaceRoot: workspace, sessionDirectory });
  return Object.freeze({ file, startedAt: now().toISOString(), request, workspace });
}

export async function commitMcpSession({
  reservation,
  capture,
  runtimeEvents,
  result,
  terminalError,
  now = () => new Date(),
}: Readonly<{
  reservation: Readonly<McpSessionReservation>;
  capture: Readonly<ExplorerSessionCapture> | null;
  runtimeEvents: readonly Readonly<McpRuntimeEvent>[];
  result: Readonly<GatherContextOutput>;
  terminalError: Readonly<ExplorerCapturedError> | null;
  now?: () => Date;
}>): Promise<Readonly<McpSessionCommit>> {
  const document: McpSessionDocument = Object.freeze({
    schemaVersion: "freecontext-mcp-session-v1",
    transport: "mcp",
    startedAt: reservation.startedAt,
    finishedAt: now().toISOString(),
    invocation: Object.freeze({ request: reservation.request, workspace: reservation.workspace }),
    capture,
    runtimeEvents: Object.freeze([...runtimeEvents]),
    modelVisibleText: renderGatherContextText(result),
    result,
    terminalError,
  });
  const committed = await commitSessionFile(reservation.file, document);
  return Object.freeze({ sessionFile: committed.path, sessionBytes: committed.bytes });
}
