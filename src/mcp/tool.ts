import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  FreeContextCallContextSchema,
  normalizeFreeContextRequest,
  serializeForModel,
} from "./contracts.js";
import type { FreeContextCallContext, FreeContextResult } from "./contracts.js";
import { errorReason, failedResult } from "./failure.js";
import {
  createDeadlineClock,
  createTerminalStore,
  SINGLE_CALL_DEADLINE_MS,
} from "./lifecycle.js";
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

export interface GatherContextHandlerDependencies extends Omit<
  SingleCallDependencies,
  "deadlineClock" | "deadlineMs" | "terminalStore"
> {
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

const directExecutor: SingleFlightExecutor = Object.freeze({
  run: <T>(task: () => Promise<T>) => task(),
});

function callResult(
  result: Readonly<FreeContextResult>,
  serializedText = serializeForModel(result),
  meta: Readonly<Record<string, unknown>> = {},
): CallToolResult {
  return {
    structuredContent: result,
    content: [{ type: "text", text: serializedText }],
    ...(result.status === "failed" ? { isError: true } : {}),
    _meta: { freecontext: meta },
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
        : new InvocationContextError(
          "invalid_call_context",
          "The MCP host did not supply a valid FreeContext call context.",
        );
      return callResult(failedResult({
        code: "INVALID_REQUEST",
        reason: contextFailure.message,
        sessionId: "unbound-invocation",
        sessionFile: null,
      }), undefined, {
        callContextBound: false,
        contextFailure: contextFailure.category,
      });
    }

    let request;
    try {
      request = normalizeFreeContextRequest(rawInput);
    } catch {
      return callResult(failedResult({
        code: "INVALID_REQUEST",
        reason: errorReason("INVALID_REQUEST"),
        sessionId: callContext.invocationId,
        sessionFile: null,
      }));
    }

    const completed = await executeSingleCall(request, callContext, externalSignal, {
      ...dependencies,
      terminalStore,
      deadlineClock,
      deadlineMs,
    });
    return callResult(completed.result, completed.serializedText, completed.meta);
  });
}
