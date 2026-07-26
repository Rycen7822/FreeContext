import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseArgs, HELP_TEXT } from "./cli/args.mjs";
import { runDoctor } from "./cli/doctor.mjs";
import { runExplorer } from "./runtime/run.mjs";
import { FreeContextError } from "./errors.mjs";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function readPackageVersion() {
  const packageJson = JSON.parse(await readFile(path.join(PACKAGE_ROOT, "package.json"), "utf8"));
  return packageJson.version;
}

async function readStdin(stream) {
  if (stream.isTTY) return "";
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8").trim();
}

function createEventReporter(stderr) {
  let turn = 0;
  return async (event) => {
    if (event.type === "turn_start") {
      turn += 1;
      stderr.write(`[freecontext] turn ${turn}\n`);
    } else if (event.type === "tool_execution_start") {
      stderr.write(`[freecontext] tool ${event.toolName} start\n`);
    } else if (event.type === "tool_execution_end") {
      stderr.write(`[freecontext] tool ${event.toolName} ${event.isError ? "error" : "done"}\n`);
    }
  };
}

function jsonResult(result) {
  return {
    summary: result.summary,
    evidence: result.evidence,
    gaps: result.gaps,
    metrics: result.metrics,
    runtime: result.runtime,
    answer: result.answer,
  };
}

function renderDoctor(report) {
  return report.checks
    .map((check) => `${check.ok ? "ok" : check.advisory ? "warn" : "fail"}\t${check.name}\t${check.detail}`)
    .join("\n");
}

export async function main(argv = process.argv.slice(2), io = process) {
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
    const result = await runExplorer({
      query,
      cwd: cli.cwd || process.cwd(),
      cli,
      repair: !cli.noRepair,
      signal: controller.signal,
      onEvent: cli.verbose ? createEventReporter(io.stderr) : undefined,
    });
    if (cli.format === "json") io.stdout.write(`${JSON.stringify(jsonResult(result), null, 2)}\n`);
    else io.stdout.write(`${result.answer}\n`);
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
    process.stderr.write(`freecontext: ${code}: ${error.message}\n`);
    if (process.env.FREECONTEXT_DEBUG === "1" && error.stack) process.stderr.write(`${error.stack}\n`);
    process.exitCode = exitCode;
  }
}
