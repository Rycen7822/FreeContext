import { readdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { renderGatherContextText } from "../mcp/contracts.js";
import type { McpSessionDocument } from "../mcp/session.js";
import type { BenchmarkSessionDocument } from "./session-file.js";

const OUTPUT_NAME = "master-agent-context.json";
const RUNTIME_AGENT_DIR = "/logs/agent";

export interface MasterAgentContextSource {
  readonly path: string;
  readonly rawJsonl: string;
}

export interface FreeContextCallReference {
  readonly promptToFreeContext: string;
  readonly outputToMasterAgent: string | null;
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

type FreeContextSessionDocument = BenchmarkSessionDocument | McpSessionDocument;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function parseSessionDocument(text: string, filePath: string): FreeContextSessionDocument {
  const value: unknown = JSON.parse(text);
  if (isRecord(value) && value.schemaVersion === "freecontext-benchmark-session-v1") {
    return value as unknown as BenchmarkSessionDocument;
  }
  if (
    isRecord(value) &&
    value.schemaVersion === "freecontext-mcp-session-v1" &&
    value.transport === "mcp" &&
    isRecord(value.invocation) &&
    typeof value.invocation.request === "string" &&
    isRecord(value.result) &&
    typeof value.result.status === "string" &&
    (typeof value.result.sessionFile === "string" || value.result.sessionFile === null) &&
    (value.modelVisibleText === undefined || typeof value.modelVisibleText === "string")
  ) {
    return value as unknown as McpSessionDocument;
  }
  throw new Error(`Invalid FreeContext session file: ${filePath}`);
}

function outputToMaster(
  session: FreeContextSessionDocument,
  runtimeSessionFile: string,
): string {
  if (session.schemaVersion === "freecontext-mcp-session-v1") {
    const text = session.modelVisibleText ?? renderGatherContextText(session.result);
    return JSON.stringify({
      content: [{ type: "text", text }],
      structured_content: session.result,
    }, null, 2);
  }
  const output = session.invocation.cliOutput.trimEnd();
  return `${output}\n\nFreeContext full session: ${runtimeSessionFile}`;
}

function promptToFreeContext(session: FreeContextSessionDocument): string {
  return session.schemaVersion === "freecontext-mcp-session-v1"
    ? session.invocation.request
    : session.capture?.request ?? session.invocation.request;
}

function sessionStatus(session: FreeContextSessionDocument): string {
  return session.schemaVersion === "freecontext-mcp-session-v1"
    ? session.result.status
    : session.capture?.outcome.status ?? "failed_before_capture";
}

export async function exportMasterAgentContext({
  agentDir,
  taskName,
  allowUnreferencedSessions = false,
  now = () => new Date(),
}: Readonly<{
  agentDir: string;
  taskName: string;
  allowUnreferencedSessions?: boolean;
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
    if (
      session.schemaVersion === "freecontext-mcp-session-v1" &&
      session.result.sessionFile !== runtimeSessionFile
    ) {
      throw new Error(`MCP session path does not match exported file: ${filePath}`);
    }
    const referenceFoundInMasterContext = completeMasterContext.includes(runtimeSessionFile);
    if (
      !referenceFoundInMasterContext
      && session.schemaVersion === "freecontext-mcp-session-v1"
    ) {
      throw new Error(`Master-agent context does not reference ${runtimeSessionFile}`);
    }
    return Object.freeze({
      promptToFreeContext: promptToFreeContext(session),
      outputToMasterAgent: referenceFoundInMasterContext
        ? outputToMaster(session, runtimeSessionFile)
        : null,
      fullSessionFile: relativePath,
      runtimeSessionFile,
      status: sessionStatus(session),
      referenceFoundInMasterContext,
    });
  }));

  const missingReference = freeContextCalls.find((call) => !call.referenceFoundInMasterContext);
  if (missingReference && !allowUnreferencedSessions) {
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
