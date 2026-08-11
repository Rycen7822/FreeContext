import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import path from "node:path";
import { FreeContextError, OutputValidationError } from "../errors.js";
import type { ContextTokenCounter } from "../runtime/context-budget.js";
import { runExplorer } from "../runtime/run.js";
import type { ExplorerResult } from "../runtime/run.js";
import type { ExplorerCapturedError, ExplorerSessionCapture } from "../runtime/session-capture.js";
import type { McpRuntimeEvent, McpSessionReservation } from "./session.js";
import { commitMcpSession, reserveMcpSession } from "./session.js";
import {
  GatherContextInputSchema,
  GatherContextOutputSchema,
  renderGatherContextText,
  VISIBLE_RESULT_LIMITS,
  VISIBLE_TRUNCATION_GAP,
} from "./contracts.js";
import type { GatherContextInput, GatherContextOutput } from "./contracts.js";

export interface SingleFlightExecutor {
  run<T>(task: () => Promise<T>): Promise<T>;
}

export interface GatherContextHandlerDependencies {
  readonly tokenCounter: ContextTokenCounter;
  readonly sessionDirectory: string;
  readonly configFile?: string;
  readonly executor?: SingleFlightExecutor;
  readonly runExplorer?: typeof runExplorer;
  readonly reserveSession?: typeof reserveMcpSession;
  readonly commitSession?: typeof commitMcpSession;
  readonly now?: () => Date;
}

export type GatherContextHandler = (
  input: Readonly<GatherContextInput>,
  signal?: AbortSignal,
) => Promise<CallToolResult>;

const directExecutor: SingleFlightExecutor = Object.freeze({
  run: <T>(task: () => Promise<T>) => task(),
});

function truncateText(value: string, maximum: number): Readonly<{ value: string; truncated: boolean }> {
  const characters = [...value];
  if (characters.length <= maximum) return Object.freeze({ value, truncated: false });
  return Object.freeze({ value: characters.slice(0, maximum).join(""), truncated: true });
}

function capVisibleResult(result: Readonly<GatherContextOutput>): Readonly<GatherContextOutput> {
  let truncated = false;
  const summary = truncateText(result.summary, VISIBLE_RESULT_LIMITS.summaryCharacters);
  truncated ||= summary.truncated;
  const evidence = result.evidence.slice(0, VISIBLE_RESULT_LIMITS.evidence).map((item) => {
    const reason = truncateText(item.reason, VISIBLE_RESULT_LIMITS.detailCharacters);
    truncated ||= reason.truncated;
    return Object.freeze({ ...item, reason: reason.value });
  });
  truncated ||= result.evidence.length > evidence.length;

  let gaps = result.gaps.map((gap) => {
    const detail = truncateText(gap, VISIBLE_RESULT_LIMITS.detailCharacters);
    truncated ||= detail.truncated;
    return detail.value;
  });
  truncated ||= gaps.length > VISIBLE_RESULT_LIMITS.gaps;

  const errorMessage = result.error
    ? truncateText(result.error.message, VISIBLE_RESULT_LIMITS.detailCharacters)
    : null;
  truncated ||= Boolean(errorMessage?.truncated);
  if (truncated) {
    gaps = [
      ...gaps.filter((gap) => gap !== VISIBLE_TRUNCATION_GAP).slice(0, VISIBLE_RESULT_LIMITS.gaps - 1),
      VISIBLE_TRUNCATION_GAP,
    ];
  } else {
    gaps = gaps.slice(0, VISIBLE_RESULT_LIMITS.gaps);
  }

  return Object.freeze(GatherContextOutputSchema.parse({
    ...result,
    summary: summary.value,
    evidence,
    gaps: [...gaps],
    error: result.error && errorMessage
      ? { code: result.error.code, message: errorMessage.value }
      : null,
  }));
}

function terminalError(error: unknown, signal?: AbortSignal): Readonly<ExplorerCapturedError> {
  if (signal?.aborted) {
    return Object.freeze({ name: "AbortError", code: "ABORTED", message: "FreeContext request was aborted." });
  }
  if (error instanceof FreeContextError) {
    return Object.freeze({ name: error.name, code: error.code, message: error.message });
  }
  return Object.freeze({ name: "Error", code: "UNEXPECTED_ERROR", message: "Unexpected FreeContext failure." });
}

function errorOutput(
  status: "no_evidence" | "failed",
  error: Readonly<ExplorerCapturedError>,
  sessionFile: string | null,
  gaps: readonly string[] = [],
): Readonly<GatherContextOutput> {
  return capVisibleResult({
    status,
    summary: "",
    evidence: [],
    gaps: [...gaps],
    sessionFile,
    error: { code: error.code, message: error.message },
  });
}

function callResult(
  result: Readonly<GatherContextOutput>,
  meta: Readonly<Record<string, unknown>> = {},
): CallToolResult {
  return {
    structuredContent: result,
    content: [{
      type: "text",
      text: renderGatherContextText(result),
    }],
    _meta: { freecontext: meta },
  };
}

function captureBytes(capture: Readonly<ExplorerSessionCapture> | null): number {
  return capture ? Buffer.byteLength(JSON.stringify(capture)) : 0;
}

export function createGatherContextHandler(
  dependencies: Readonly<GatherContextHandlerDependencies>,
): GatherContextHandler {
  const executor = dependencies.executor ?? directExecutor;
  const explore = dependencies.runExplorer ?? runExplorer;
  const reserve = dependencies.reserveSession ?? reserveMcpSession;
  const commit = dependencies.commitSession ?? commitMcpSession;

  return async (rawInput, signal) => executor.run(async () => {
    const parsed = GatherContextInputSchema.safeParse(rawInput);
    if (!parsed.success || !path.isAbsolute(parsed.data.workspace)) {
      const error = Object.freeze({
        name: "ConfigurationError",
        code: "INVALID_INPUT",
        message: "gather_context requires a non-empty query and an absolute workspace path.",
      });
      return callResult(errorOutput("failed", error, null));
    }
    const input = parsed.data;

    let reservation: Readonly<McpSessionReservation>;
    try {
      reservation = await reserve({
        request: input.query,
        workspace: input.workspace,
        sessionDirectory: dependencies.sessionDirectory,
        ...(dependencies.now ? { now: dependencies.now } : {}),
      });
    } catch {
      const error = Object.freeze({
        name: "SessionPersistenceError",
        code: "SESSION_PERSISTENCE_ERROR",
        message: "FreeContext could not reserve private session storage.",
      });
      return callResult(errorOutput("failed", error, null));
    }

    const runtimeEvents: McpRuntimeEvent[] = [];
    let capture: Readonly<ExplorerSessionCapture> | null = null;
    let explorerResult: Readonly<ExplorerResult> | null = null;
    let result: Readonly<GatherContextOutput>;
    let error: Readonly<ExplorerCapturedError> | null = null;
    let unexpected: unknown = null;
    let validationProblems: readonly string[] = [];

    try {
      explorerResult = await explore({
        query: input.query,
        cwd: input.workspace,
        ...(dependencies.configFile ? { cli: { configFile: dependencies.configFile } } : {}),
        ...(signal ? { signal } : {}),
        onEvent: (event, state) => {
          runtimeEvents.push(Object.freeze({ event, state: Object.freeze({ ...state }) }));
        },
        onSessionCapture: (value) => { capture = value; },
        dependencies: { tokenCounter: dependencies.tokenCounter },
      });
      result = capVisibleResult({
        status: explorerResult.status,
        summary: explorerResult.summary,
        evidence: explorerResult.evidence.map((item) => ({ ...item })),
        gaps: [...explorerResult.gaps],
        sessionFile: reservation.file.path,
        error: null,
      });
      validationProblems = explorerResult.validationProblems;
    } catch (caught) {
      error = terminalError(caught, signal);
      const noEvidence = caught instanceof OutputValidationError && !signal?.aborted;
      if (noEvidence) validationProblems = caught.problems ?? [];
      result = errorOutput(
        noEvidence ? "no_evidence" : "failed",
        error,
        reservation.file.path,
        noEvidence ? caught.problems ?? [] : [],
      );
      if (!(caught instanceof FreeContextError) && !signal?.aborted) unexpected = caught;
    }

    let committed;
    try {
      committed = await commit({
        reservation,
        capture,
        runtimeEvents,
        result,
        terminalError: error,
        ...(dependencies.now ? { now: dependencies.now } : {}),
      });
      if (committed.sessionFile !== reservation.file.path) {
        throw new Error("Session store returned a mismatched path.");
      }
    } catch {
      const persistenceError = Object.freeze({
        name: "SessionPersistenceError",
        code: "SESSION_PERSISTENCE_ERROR",
        message: "FreeContext could not commit private session storage.",
      });
      return callResult(errorOutput("failed", persistenceError, null));
    }

    if (unexpected !== null) throw unexpected;
    return callResult(result, {
      metrics: explorerResult?.metrics ?? null,
      validationProblems,
      captureBytes: captureBytes(capture),
      sessionBytes: committed.sessionBytes,
    });
  });
}
