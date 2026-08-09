import { readdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BenchmarkSessionDocument } from "./session-file.js";

const OUTPUT_NAME = "master-agent-context.json";
const RUNTIME_AGENT_DIR = "/logs/agent";

export interface MasterAgentContextSource {
  readonly path: string;
  readonly rawJsonl: string;
}

export interface FreeContextCallReference {
  readonly promptToFreeContext: string;
  readonly outputToMasterAgent: string;
  readonly fullSessionFile: string;
  readonly runtimeSessionFile: string;
  readonly status: string;
  readonly referenceFoundInMasterContext: boolean;
}

export interface BenchmarkMasterAgentContext {
  readonly schemaVersion: "freecontext-master-agent-context-v1";
  readonly taskName: string;
  readonly createdAt: string;
  readonly masterAgentContext: readonly MasterAgentContextSource[];
  readonly freeContextCalls: readonly FreeContextCallReference[];
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

function parseSessionDocument(text: string, filePath: string): BenchmarkSessionDocument {
  const value: unknown = JSON.parse(text);
  if (
    !value ||
    typeof value !== "object" ||
    !("schemaVersion" in value) ||
    value.schemaVersion !== "freecontext-benchmark-session-v1"
  ) {
    throw new Error(`Invalid FreeContext benchmark session file: ${filePath}`);
  }
  return value as BenchmarkSessionDocument;
}

function outputToMaster(
  session: BenchmarkSessionDocument,
  runtimeSessionFile: string,
): string {
  const output = session.invocation.cliOutput.trimEnd();
  return `${output}\n\nFreeContext full session: ${runtimeSessionFile}`;
}

export async function exportMasterAgentContext({
  agentDir,
  taskName,
  now = () => new Date(),
}: Readonly<{
  agentDir: string;
  taskName: string;
  now?: () => Date;
}>): Promise<string> {
  if (!taskName.trim()) throw new Error("Benchmark task name must be non-empty.");
  const root = await realpath(agentDir);
  const masterFiles = await collectFiles(path.join(root, "sessions"), ".jsonl");
  if (masterFiles.length === 0) throw new Error(`No master-agent session JSONL found under ${root}`);

  const masterAgentContext = await Promise.all(
    masterFiles.map(async (filePath) => Object.freeze({
      path: posixRelative(root, filePath),
      rawJsonl: await readFile(filePath, "utf8"),
    })),
  );
  const completeMasterContext = masterAgentContext.map((source) => source.rawJsonl).join("\n");

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
    const referenceFoundInMasterContext = completeMasterContext.includes(runtimeSessionFile);
    return Object.freeze({
      promptToFreeContext: session.capture?.request ?? session.invocation.request,
      outputToMasterAgent: outputToMaster(session, runtimeSessionFile),
      fullSessionFile: relativePath,
      runtimeSessionFile,
      status: session.capture?.outcome.status ?? "failed_before_capture",
      referenceFoundInMasterContext,
    });
  }));

  const missingReference = freeContextCalls.find((call) => !call.referenceFoundInMasterContext);
  if (missingReference) {
    throw new Error(`Master-agent context does not reference ${missingReference.runtimeSessionFile}`);
  }

  const document: BenchmarkMasterAgentContext = {
    schemaVersion: "freecontext-master-agent-context-v1",
    taskName: taskName.trim(),
    createdAt: now().toISOString(),
    masterAgentContext: Object.freeze(masterAgentContext),
    freeContextCalls: Object.freeze(freeContextCalls),
  };
  const outputPath = path.join(root, OUTPUT_NAME);
  await writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return outputPath;
}
