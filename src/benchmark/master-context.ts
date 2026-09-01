import { readdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  FreeContextInvocationContextSchema,
  FreeContextRequestSchema,
  FreeContextResultSchema,
} from "../mcp/contracts.js";
import type { McpSessionDocument } from "../mcp/session.js";

const OUTPUT_NAME = "master-agent-context.json";
const RUNTIME_AGENT_DIR = "/logs/agent";

export interface MasterAgentContextSource {
  readonly path: string;
  readonly rawJsonl: string;
}

export interface FreeContextCallReference {
  readonly callId: string | null;
  readonly promptToFreeContext: string;
  readonly outputToMasterAgent: string | null;
  readonly fullSessionFile: string;
  readonly runtimeSessionFile: string;
  readonly status: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly latencyMs: number | null;
}

export interface FreeContextTransportObservation {
  readonly schemaVersion: "freecontext-transport-observation-v1";
  readonly callId: string | null;
  readonly sessionId: string;
  readonly reminderCount: number;
  readonly sameCellWaitCount: number;
  readonly latencyMs: number | null;
}

export interface BenchmarkMasterAgentContext {
  readonly schemaVersion: "freecontext-master-agent-context-v4";
  readonly taskName: string;
  readonly createdAt: string;
  readonly masterAgentContext: readonly MasterAgentContextSource[];
  readonly freeContextCalls: readonly FreeContextCallReference[];
  readonly freeContextTransport: readonly FreeContextTransportObservation[];
}

interface RecordValue {
  readonly [key: string]: unknown;
}

interface RawCall {
  readonly callId: string | null;
  readonly request: RecordValue;
}

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function callId(value: RecordValue): string | null {
  const candidate = value.call_id ?? value.callId ?? value.id;
  return typeof candidate === "string" || typeof candidate === "number" ? String(candidate) : null;
}

function parseArguments(value: unknown): RecordValue | null {
  if (isRecord(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function textBlocks(value: unknown, depth = 0): string[] {
  if (depth > 6 || value === null || value === undefined) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => textBlocks(item, depth + 1));
  if (!isRecord(value)) return [];
  if (value.type === "text" && typeof value.text === "string") return [value.text];
  const candidates = [value.content, value.output, value.result, value.Ok, value.ok, value.message, value.payload, value.event, value.item];
  return candidates.flatMap((candidate) => textBlocks(candidate, depth + 1));
}

function walk(value: unknown, visitor: (record: RecordValue) => void, depth = 0): void {
  if (depth > 7 || value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visitor, depth + 1);
    return;
  }
  if (!isRecord(value)) return;
  visitor(value);
  for (const child of [value.payload, value.event, value.item]) walk(child, visitor, depth + 1);
}

function collectRawCalls(rawJsonl: string): readonly RawCall[] {
  const calls: RawCall[] = [];
  const seen = new Set<string>();
  for (const line of rawJsonl.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { continue; }
    walk(parsed, (record) => {
      const invocation = isRecord(record.invocation) ? record.invocation : null;
      const name = record.name ?? record.tool ?? invocation?.tool;
      const server = record.server ?? invocation?.server;
      if (server !== undefined && server !== "freecontext") return;
      if (name !== "gather_context") return;
      const request = parseArguments(record.arguments ?? record.input ?? record.params ?? invocation?.arguments);
      if (!request) return;
      const id = callId(record);
      const key = `${id ?? "anonymous"}:${JSON.stringify(request)}`;
      if (seen.has(key)) return;
      seen.add(key);
      calls.push({ callId: id, request });
    });
  }
  return calls;
}

function outputForSession(rawJsonl: string, sessionId: string): string | null {
  const marker = `Session: ${sessionId}`;
  for (const line of rawJsonl.split(/\r?\n/u)) {
    if (!line.includes(marker)) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      const text = textBlocks(parsed).find((candidate) => candidate.includes(marker));
      if (text) return text;
    } catch {
      // The source is retained verbatim; an invalid line cannot prove delivery.
    }
  }
  return null;
}

async function collectFiles(directory: string, extension: string): Promise<readonly string[]> {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return []; }
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(fullPath, extension));
    else if (entry.isFile() && entry.name.endsWith(extension)) files.push(fullPath);
  }
  return files.sort();
}

function relative(root: string, filePath: string): string {
  return path.relative(root, filePath).split(path.sep).join(path.posix.sep);
}

function sessionTiming(session: McpSessionDocument): { readonly latencyMs: number | null } {
  const started = Date.parse(session.startedAt);
  const finished = Date.parse(session.finishedAt);
  return { latencyMs: Number.isFinite(started) && Number.isFinite(finished) ? Math.max(0, finished - started) : null };
}

function parseSession(value: unknown): McpSessionDocument | null {
  if (!isRecord(value) || value.schemaVersion !== "freecontext-mcp-session-v4" || value.transport !== "mcp") return null;
  if (!FreeContextInvocationContextSchema.safeParse(value.invocation).success) return null;
  if (!FreeContextRequestSchema.safeParse(value.request).success) return null;
  if (!FreeContextResultSchema.safeParse(value.result).success) return null;
  if (typeof value.startedAt !== "string" || typeof value.finishedAt !== "string") return null;
  return value as unknown as McpSessionDocument;
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
  const masterAgentContext = await Promise.all(masterFiles.map(async (filePath) => Object.freeze({
    path: relative(root, filePath),
    rawJsonl: await readFile(filePath, "utf8"),
  })));
  const rawJsonl = masterAgentContext.map((source) => source.rawJsonl).join("\n");
  const rawCalls = collectRawCalls(rawJsonl);
  const freeContextFiles = await collectFiles(path.join(root, "freecontext-sessions"), ".json");
  const freeContextCalls: FreeContextCallReference[] = [];
  const freeContextTransport: FreeContextTransportObservation[] = [];

  for (const filePath of freeContextFiles) {
    let session: McpSessionDocument | null = null;
    try { session = parseSession(JSON.parse(await readFile(filePath, "utf8"))); } catch { continue; }
    if (!session) continue;
    const matchingCall = rawCalls.find((call) => call.callId === session?.invocation.callId);
    if (!matchingCall && !allowUnreferencedSessions) {
      throw new Error(`Committed FreeContext session is not referenced by a master-agent gather_context call: ${filePath}`);
    }
    const timing = sessionTiming(session);
    const output = outputForSession(rawJsonl, session.invocation.sessionId);
    const sessionPath = relative(root, filePath);
    freeContextCalls.push(Object.freeze({
      callId: session.invocation.callId || matchingCall?.callId || null,
      promptToFreeContext: JSON.stringify(session.request),
      outputToMasterAgent: output,
      fullSessionFile: sessionPath,
      runtimeSessionFile: path.posix.join(RUNTIME_AGENT_DIR, sessionPath),
      status: session.result.status,
      startedAt: session.startedAt,
      completedAt: session.finishedAt,
      latencyMs: timing.latencyMs,
    }));
    freeContextTransport.push(Object.freeze({
      schemaVersion: "freecontext-transport-observation-v1",
      callId: session.invocation.callId || matchingCall?.callId || null,
      sessionId: session.invocation.sessionId,
      reminderCount: 0,
      sameCellWaitCount: 0,
      latencyMs: timing.latencyMs,
    }));
  }

  const document: BenchmarkMasterAgentContext = {
    schemaVersion: "freecontext-master-agent-context-v4",
    taskName: taskName.trim(),
    createdAt: now().toISOString(),
    masterAgentContext: Object.freeze(masterAgentContext),
    freeContextCalls: Object.freeze(freeContextCalls),
    freeContextTransport: Object.freeze(freeContextTransport),
  };
  const outputPath = path.join(root, OUTPUT_NAME);
  await writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return outputPath;
}
