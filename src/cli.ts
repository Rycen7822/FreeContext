import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseArgs, HELP_TEXT } from "./cli/args.js";
import { runDoctor } from "./cli/doctor.js";
import type { DoctorReport } from "./cli/doctor.js";
import { runExplorer } from "./runtime/run.js";
import type { ExplorerCapturedError, ExplorerResult, ExplorerSessionCapture } from "./runtime/run.js";
import type {
  FreeContextRuntimeEvent,
  PiSessionEventHandler,
  PiSessionEventState,
} from "./runtime/pi-session.js";
import type { CapturedRuntimeEvent } from "./benchmark/session-file.js";
import { FreeContextError } from "./errors.js";
import { captureError } from "./runtime/session-capture.js";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

interface CliIo {
  readonly stdin: NodeJS.ReadableStream & { readonly isTTY?: boolean };
  readonly stdout: Pick<NodeJS.WriteStream, "write">;
  readonly stderr: Pick<NodeJS.WriteStream, "write">;
}

async function readPackageVersion(): Promise<string> {
  const packageJson: unknown = JSON.parse(await readFile(path.join(PACKAGE_ROOT, "package.json"), "utf8"));
  if (!packageJson || typeof packageJson !== "object" || !("version" in packageJson) || typeof packageJson.version !== "string") {
    throw new Error("package.json has no valid version field");
  }
  return packageJson.version;
}

async function readStdin(stream: CliIo["stdin"]): Promise<string> {
  if (stream.isTTY) return "";
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8").trim();
}

function createEventReporter(stderr: CliIo["stderr"]): PiSessionEventHandler {
  let turn = 0;
  return async (event: FreeContextRuntimeEvent) => {
    if (event.type === "turn_start") {
      turn += 1;
      stderr.write(`[freecontext] turn ${turn}\n`);
    } else if (event.type === "tool_execution_start") {
      stderr.write(`[freecontext] tool ${event.toolName} start\n`);
    } else if (event.type === "tool_execution_end") {
      stderr.write(`[freecontext] tool ${event.toolName} ${event.isError ? "error" : "done"}\n`);
    } else if (event.type === "compaction_start") {
      stderr.write(`[freecontext] compaction ${event.reason} start (${event.tokensBefore} estimated tokens)\n`);
    } else if (event.type === "compaction_end") {
      stderr.write(`[freecontext] compaction ${event.reason} done (${event.estimatedTokensAfter} estimated tokens)\n`);
    } else if (event.type === "overflow_retry") {
      stderr.write("[freecontext] context overflow retry 1\n");
    }
  };
}

function jsonResult(result: ExplorerResult) {
  return {
    summary: result.summary,
    evidence: result.evidence,
    gaps: result.gaps,
    metrics: result.metrics,
    runtime: result.runtime,
    answer: result.answer,
  };
}

function renderDoctor(report: DoctorReport): string {
  return report.checks
    .map((check) => `${check.ok ? "ok" : check.advisory ? "warn" : "fail"}\t${check.name}\t${check.detail}`)
    .join("\n");
}

export async function main(argv: readonly string[] = process.argv.slice(2), io: CliIo = process): Promise<number> {
  const cli = parseArgs(argv);
  if (cli.help) {
    io.stdout.write(`${HELP_TEXT}\n`);
    return 0;
  }
  if (cli.version) {
    io.stdout.write(`${await readPackageVersion()}\n`);
    return 0;
  }

  if (cli.command === "doctor") {
    const report = await runDoctor(cli);
    if (cli.format === "json") io.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else io.stdout.write(`${renderDoctor(report)}\n`);
    return report.ok ? 0 : 1;
  }

  const query = cli.query || (await readStdin(io.stdin));
  if (!query) {
    io.stderr.write("freecontext: CONFIGURATION_ERROR: an exploration query is required\n");
    return 2;
  }

  const controller = new AbortController();
  const abort = () => controller.abort(new Error("Interrupted"));
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    const explorationCwd = cli.cwd || process.cwd();
    const runtimeEvents: CapturedRuntimeEvent[] = [];
    const reporter = cli.verbose ? createEventReporter(io.stderr) : undefined;
    const onEvent: PiSessionEventHandler | undefined = reporter || cli.benchmarkSessionFile
      ? async (event: FreeContextRuntimeEvent, state: PiSessionEventState) => {
          if (cli.benchmarkSessionFile) {
            runtimeEvents.push(Object.freeze({ event, state: Object.freeze({ ...state }) }));
          }
          await reporter?.(event, state);
        }
      : undefined;
    let sessionWritten = false;
    let sessionCapture: Readonly<ExplorerSessionCapture> | null = null;
    const persistSession = async (
      capture: Readonly<ExplorerSessionCapture> | null,
      terminalError: Readonly<ExplorerCapturedError> | null,
      cliOutput: string,
    ): Promise<void> => {
      if (!cli.benchmarkSessionFile) return;
      const { writeBenchmarkSessionFile } = await import("./benchmark/session-file.js");
      await writeBenchmarkSessionFile({
        filePath: cli.benchmarkSessionFile,
        workspaceRoot: capture?.runtime.workspace ?? explorationCwd,
        request: query,
        cwd: explorationCwd,
        cliOutput,
        capture,
        runtimeEvents,
        terminalError,
      });
      sessionWritten = true;
    };

    let result: Readonly<ExplorerResult>;
    try {
      result = await runExplorer({
        query,
        cwd: explorationCwd,
        cli,
        repair: !cli.noRepair,
        signal: controller.signal,
        ...(onEvent ? { onEvent } : {}),
        ...(cli.benchmarkSessionFile
          ? { onSessionCapture: (capture) => { sessionCapture = capture; } }
          : {}),
      });
    } catch (error) {
      if (cli.benchmarkSessionFile && !sessionWritten) {
        const terminalError = captureError(error);
        const cliOutput = `freecontext: ${terminalError.code}: ${terminalError.message}\n`;
        await persistSession(sessionCapture, terminalError, cliOutput);
      }
      throw error;
    }
    const cliOutput = cli.format === "json"
      ? `${JSON.stringify(jsonResult(result), null, 2)}\n`
      : `${result.answer}\n`;
    await persistSession(sessionCapture, null, cliOutput);
    io.stdout.write(cliOutput);
    return 0;
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}

export async function runCli() {
  try {
    const exitCode = await main();
    process.exitCode = exitCode;
  } catch (error) {
    const known = error instanceof FreeContextError;
    const code = known ? error.code : "UNEXPECTED_ERROR";
    const exitCode = known ? error.exitCode : 1;
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    process.stderr.write(`freecontext: ${code}: ${message}\n`);
    if (process.env.FREECONTEXT_DEBUG === "1" && stack) process.stderr.write(`${stack}\n`);
    process.exitCode = exitCode;
  }
}
