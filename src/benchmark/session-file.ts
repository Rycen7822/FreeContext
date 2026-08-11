import path from "node:path";
import { ConfigurationError } from "../errors.js";
import type { ExplorerCapturedError, ExplorerSessionCapture } from "../runtime/session-capture.js";
import type {
  FreeContextRuntimeEvent,
  PiSessionEventState,
} from "../runtime/pi-session.js";
import { commitSessionFile, reserveSessionFile } from "../session/store.js";

export interface CapturedRuntimeEvent {
  readonly event: FreeContextRuntimeEvent;
  readonly state: PiSessionEventState;
}

export interface BenchmarkSessionDocument {
  readonly schemaVersion: "freecontext-benchmark-session-v1";
  readonly capturedAt: string;
  readonly invocation: Readonly<{ request: string; cwd: string; cliOutput: string }>;
  readonly capture: Readonly<ExplorerSessionCapture> | null;
  readonly runtimeEvents: readonly CapturedRuntimeEvent[];
  readonly terminalError: Readonly<ExplorerCapturedError> | null;
}

function validateTarget(filePath: string): void {
  if (!filePath.trim()) throw new ConfigurationError("--benchmark-session-file requires a non-empty path.");
  if (path.extname(filePath).toLowerCase() !== ".json") {
    throw new ConfigurationError("--benchmark-session-file must end in .json.");
  }
}

export async function writeBenchmarkSessionFile({
  filePath,
  workspaceRoot,
  request,
  cwd,
  cliOutput,
  capture,
  runtimeEvents,
  terminalError,
  now = () => new Date(),
}: Readonly<{
  filePath: string;
  workspaceRoot: string;
  request: string;
  cwd: string;
  cliOutput: string;
  capture: Readonly<ExplorerSessionCapture> | null;
  runtimeEvents: readonly CapturedRuntimeEvent[];
  terminalError: Readonly<ExplorerCapturedError> | null;
  now?: () => Date;
}>): Promise<string> {
  validateTarget(filePath);
  const reservation = await reserveSessionFile({ workspaceRoot, filePath });
  const document: BenchmarkSessionDocument = {
    schemaVersion: "freecontext-benchmark-session-v1",
    capturedAt: now().toISOString(),
    invocation: Object.freeze({ request, cwd, cliOutput }),
    capture,
    runtimeEvents,
    terminalError,
  };
  return commitSessionFile(reservation, document);
}
