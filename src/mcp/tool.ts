import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  FreeContextCallContextSchema,
  FreeContextCallerRequestSchema,
} from "./contracts.js";
import type { FreeContextCallContext, FreeContextCallerRequest } from "./contracts.js";
import { errorReason, failedResult } from "./failure.js";
import { createDeadlineClock, createTerminalStore, SINGLE_CALL_DEADLINE_MS } from "./lifecycle.js";
import type { DeadlineClock, TerminalStore } from "./lifecycle.js";
import { executeSingleCall } from "./single-call.js";
import type { SingleCallDependencies } from "./single-call.js";

export interface SingleFlightExecutor {
  run<T>(task: () => Promise<T>): Promise<T>;
}

export type InvocationContextFailureCategory =
  | "missing_request_identity"
  | "invalid_request_identity"
  | "workspace_roots_unavailable"
  | "missing_workspace_root"
  | "multiple_workspace_roots"
  | "non_file_workspace_root"
  | "invalid_call_context";

export class InvocationContextError extends Error {
  readonly category: InvocationContextFailureCategory;

  constructor(category: InvocationContextFailureCategory, message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = "InvocationContextError";
    this.category = category;
  }
}

export interface GatherContextHandlerDependencies extends Omit<SingleCallDependencies, "deadlineClock" | "deadlineMs" | "terminalStore"> {
  readonly executor?: SingleFlightExecutor;
  readonly invocationContextProvider?: (
    metadata: unknown,
  ) => Promise<Readonly<FreeContextCallContext>> | Readonly<FreeContextCallContext>;
  readonly terminalStore?: TerminalStore;
  readonly deadlineClock?: DeadlineClock;
  readonly deadlineMs?: number;
}

export type GatherContextHandler = (
  input: unknown,
  invocationMetadata: unknown,
  signal?: AbortSignal,
) => Promise<CallToolResult>;

const directExecutor: SingleFlightExecutor = Object.freeze({ run: <T>(task: () => Promise<T>) => task() });

function safeRequestSchemaReason(error: unknown): string {
  if (!error || typeof error !== "object" || !Array.isArray((error as { issues?: unknown }).issues)) return "Invalid FreeContext request.";
  const issue = (error as { issues: unknown[] }).issues[0];
  if (!issue || typeof issue !== "object") return "Invalid FreeContext request.";
  const path = Array.isArray((issue as { path?: unknown }).path)
    ? (issue as { path: unknown[] }).path.map((part) => typeof part === "number" ? `[${part}]` : String(part)).join(".")
    : "request";
  return `Invalid FreeContext request at ${path || "request"}.`;
}

function appendVisibleSessionId(text: string, sessionId: string): string {
  return `${text}${text ? "\n\n" : ""}Session: ${sessionId}`;
}

function callResult(
  result: Readonly<{ status: "complete" | "partial" | "failed"; text: string; sessionId: string; sessionFile: string | null }>,
): CallToolResult {
  return {
    content: [{ type: "text", text: result.sessionFile ? appendVisibleSessionId(result.text, result.sessionId) : result.text }],
    ...(result.status === "failed" ? { isError: true } : {}),
    ...(result.sessionFile ? { _meta: { freecontext: { sessionId: result.sessionId } } } : {}),
  };
}

export function createGatherContextHandler(
  dependencies: Readonly<GatherContextHandlerDependencies>,
): GatherContextHandler {
  const executor = dependencies.executor ?? directExecutor;
  const invocationContextProvider = dependencies.invocationContextProvider
    ?? ((metadata: unknown) => FreeContextCallContextSchema.parse(metadata));
  const terminalStore = dependencies.terminalStore ?? createTerminalStore();
  const deadlineClock = dependencies.deadlineClock ?? createDeadlineClock();
  const deadlineMs = dependencies.deadlineMs ?? SINGLE_CALL_DEADLINE_MS;

  return async (rawInput, invocationMetadata, externalSignal) => executor.run(async () => {
    let callContext: Readonly<FreeContextCallContext>;
    try {
      callContext = FreeContextCallContextSchema.parse(await invocationContextProvider(invocationMetadata));
    } catch (error) {
      const contextFailure = error instanceof InvocationContextError
        ? error
        : new InvocationContextError("invalid_call_context", "The MCP host did not supply a valid FreeContext call context.");
      return callResult(failedResult({ code: "INVALID_REQUEST", reason: contextFailure.message, sessionId: "unbound-invocation", sessionFile: null }));
    }

    let callerRequest: Readonly<FreeContextCallerRequest>;
    try {
      callerRequest = FreeContextCallerRequestSchema.parse(rawInput);
    } catch (error) {
      return callResult(failedResult({ code: "INVALID_REQUEST", reason: safeRequestSchemaReason(error), sessionId: callContext.invocationId, sessionFile: null }));
    }
    const completed = await executeSingleCall(callerRequest, callContext, externalSignal, {
      ...dependencies,
      terminalStore,
      deadlineClock,
      deadlineMs,
    });
    return callResult(completed.result);
  });
}
