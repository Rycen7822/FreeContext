import { realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { ConfigurationError, SecurityError } from "../errors.js";
import type { ExplorerCapturedError, ExplorerSessionCapture } from "../runtime/session-capture.js";
import type {
  FreeContextRuntimeEvent,
  PiSessionEventState,
} from "../runtime/pi-session.js";

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

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function resolveTarget(filePath: string, workspaceRoot: string): Promise<string> {
  if (!filePath.trim()) throw new ConfigurationError("--benchmark-session-file requires a non-empty path.");
  if (path.extname(filePath).toLowerCase() !== ".json") {
    throw new ConfigurationError("--benchmark-session-file must end in .json.");
  }
  const target = path.resolve(filePath);
  const [workspace, parent] = await Promise.all([
    realpath(workspaceRoot),
    realpath(path.dirname(target)),
  ]);
  const resolvedTarget = path.join(parent, path.basename(target));
  if (isWithin(workspace, resolvedTarget)) {
    throw new SecurityError("Benchmark session files must be stored outside the explored workspace.");
  }
  return resolvedTarget;
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
  const target = await resolveTarget(filePath, workspaceRoot);
  const document: BenchmarkSessionDocument = {
    schemaVersion: "freecontext-benchmark-session-v1",
    capturedAt: now().toISOString(),
    invocation: Object.freeze({ request, cwd, cliOutput }),
    capture,
    runtimeEvents,
    terminalError,
  };
  await writeFile(target, `${JSON.stringify(document, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return target;
}
