import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseArgs, HELP_TEXT } from "./cli/args.js";
import { runDoctor } from "./cli/doctor.js";
import type { DoctorReport } from "./cli/doctor.js";
import { FreeContextCallerFullRequestSchema, FreeContextResultSchema, serializeForModel } from "./mcp/contracts.js";
import type { FreeContextCallerRequest } from "./mcp/contracts.js";
import { createGatherContextHandler } from "./mcp/tool.js";
import { GigatokenCounter } from "./runtime/gigatoken-counter.js";
import { runExplorer } from "./runtime/run.js";
import type { FreeContextRuntimeEvent, PiSessionEventHandler } from "./runtime/pi-session.js";
import { resolveWorkspaceRevision } from "./runtime/workspace-revision.js";
import { defaultSessionDirectory } from "./session/store.js";
import { createWorkspace } from "./tools/workspace.js";
import { FreeContextError } from "./errors.js";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export interface CliIo {
  readonly stdin: NodeJS.ReadableStream & { readonly isTTY?: boolean };
  readonly stdout: Pick<NodeJS.WriteStream, "write">;
  readonly stderr: Pick<NodeJS.WriteStream, "write">;
}

export interface CliDependencies {
  readonly runExplorer?: typeof runExplorer;
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
    } else if (event.type === "provider_retry_scheduled") {
      stderr.write(`[freecontext] provider ${event.category} retry ${event.attempt}/${event.maxRetries} in ${event.delayMs} ms (base ${event.baseDelayMs} ms)\n`);
    } else if (event.type === "provider_retry_start") {
      stderr.write(`[freecontext] provider retry ${event.attempt} start\n`);
    }
  };
}

function canonicalCliRequest(taskText: string): Readonly<FreeContextCallerRequest> {
  return FreeContextCallerFullRequestSchema.parse({
    taskText,
    workUnit: { outcome: "answer", goal: "Identify the decisive implementation, consumer, verification, and public contract evidence." },
    knownRefs: [],
    evidenceQuestions: [
      { role: "implementation", question: "Where is the primary implementation owner?", required: true, target: { subject: { kind: "topic", topic: "primary implementation owner" } } },
      { role: "caller", question: "Where is the relevant caller or consumer seam?", required: false, target: { subject: { kind: "topic", topic: "relevant caller or consumer seam" } } },
      { role: "test", question: "Where is the relevant verification seam?", required: false, target: { subject: { kind: "topic", topic: "relevant verification seam" } } },
      { role: "contract", question: "Where is the relevant public contract owner?", required: false, target: { subject: { kind: "topic", topic: "relevant public contract owner" } } },
    ],
  });
}

function renderDoctor(report: DoctorReport): string {
  return report.checks
    .map((check) => `${check.ok ? "ok" : check.advisory ? "warn" : "fail"}\t${check.name}\t${check.detail}`)
    .join("\n");
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  io: CliIo = process,
  dependencies: CliDependencies = {},
): Promise<number> {
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
    io.stdout.write(cli.format === "json" ? `${JSON.stringify(report, null, 2)}\n` : `${renderDoctor(report)}\n`);
    return report.ok ? 0 : 1;
  }

  const taskText = cli.query || (await readStdin(io.stdin));
  if (!taskText) {
    io.stderr.write("freecontext: CONFIGURATION_ERROR: an exploration query is required\n");
    return 2;
  }

  const controller = new AbortController();
  const abort = () => controller.abort(new Error("Interrupted"));
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  const tokenCounter = new GigatokenCounter();
  try {
    const workspace = await createWorkspace(cli.cwd || process.cwd());
    const reporter = cli.verbose ? createEventReporter(io.stderr) : undefined;
    const explorer = dependencies.runExplorer ?? runExplorer;
    const handler = createGatherContextHandler({
      tokenCounter,
      ...(cli.benchmarkSessionFile
        ? { sessionFile: path.resolve(cli.benchmarkSessionFile) }
        : { sessionDirectory: defaultSessionDirectory() }),
      ...(cli.configFile ? { configFile: cli.configFile } : {}),
      runExplorer: async (options) => explorer({
        ...options,
        cli,
        ...(reporter ? {
          onEvent: async (event, state) => {
            await options.onEvent?.(event, state);
            await reporter(event, state);
          },
        } : {}),
      }),
    });
    const call = await handler(
      canonicalCliRequest(taskText),
      {
        invocationId: `manual-invocation-${randomUUID()}`,
        callId: `manual-call-${randomUUID()}`,
        workspaceRoot: workspace.root,
        workspaceRevision: await resolveWorkspaceRevision(workspace.root),
      },
      controller.signal,
    );
    const result = FreeContextResultSchema.parse(call.structuredContent);
    io.stdout.write(cli.format === "json"
      ? `${JSON.stringify(result, null, 2)}\n`
      : `${serializeForModel(result)}\n`);
    return result.status === "failed" ? 1 : 0;
  } finally {
    await tokenCounter.close();
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}

export async function executeCli(
  argv: readonly string[],
  io: CliIo,
  dependencies: CliDependencies = {},
): Promise<number> {
  try {
    return await main(argv, io, dependencies);
  } catch (error) {
    const known = error instanceof FreeContextError;
    const code = known ? error.code : "UNEXPECTED_ERROR";
    const exitCode = known ? error.exitCode : 1;
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    io.stderr.write(`freecontext: ${code}: ${message}\n`);
    if (process.env.FREECONTEXT_DEBUG === "1" && stack) io.stderr.write(`${stack}\n`);
    return exitCode;
  }
}

export async function runCli() {
  process.exitCode = await executeCli(process.argv.slice(2), process);
}
