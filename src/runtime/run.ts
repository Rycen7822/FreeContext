import type { CliConfigOverrides } from "../config.js";
import { redactUrl } from "../config.js";
import { FreeContextInvocationContextSchema } from "../mcp/contracts.js";
import type {
  FreeContextInvocationContext,
  FreeContextRequest,
  FreeContextResult,
} from "../mcp/contracts.js";
import { compileFreeContextResult } from "../output/text-result.js";
import { buildUserPrompt } from "../prompt.js";
import type { Workspace } from "../tools/contracts.js";
import { createWorkspace } from "../tools/workspace.js";
import type { ContextTokenCounter } from "./context-budget.js";
import { GigatokenCounter } from "./gigatoken-counter.js";
import type { PiSessionEventHandler } from "./pi-session.js";
import type { RouterDependencies } from "./router.js";
import { runPrimaryRoute } from "./router.js";
import { capturePiSession } from "./session-capture.js";
import type {
  ExplorerRuntime,
  ExplorerSessionCaptureHandler,
} from "./session-capture.js";

export type {
  ExplorerCapturedError,
  ExplorerSessionCapture,
  ExplorerSessionCaptureHandler,
} from "./session-capture.js";

export interface ExplorerDependencies extends RouterDependencies {
  readonly workspace?: Workspace;
}

export interface RunExplorerOptions {
  readonly request: Readonly<FreeContextRequest>;
  readonly invocation: Readonly<FreeContextInvocationContext>;
  readonly cli?: CliConfigOverrides;
  readonly signal?: AbortSignal;
  readonly onEvent?: PiSessionEventHandler;
  readonly onSessionCapture?: ExplorerSessionCaptureHandler;
  readonly dependencies?: ExplorerDependencies;
}

async function runExplorerWithCounter(
  {
    request: rawRequest,
    invocation: rawInvocation,
    cli = {},
    signal,
    onEvent,
    onSessionCapture,
    dependencies = {},
  }: RunExplorerOptions,
  tokenCounter: ContextTokenCounter,
): Promise<Readonly<FreeContextResult>> {
  const request = rawRequest;
  const invocation = FreeContextInvocationContextSchema.parse(rawInvocation);
  const clock = dependencies.clock ?? performance.now.bind(performance);
  const startedAt = clock();
  const workspace = dependencies.workspace ?? (await createWorkspace(invocation.workspaceRoot));
  if (workspace.root !== invocation.workspaceRoot) {
    throw new Error("Invocation workspaceRoot must be the resolved workspace root.");
  }
  const primaryPrompt = buildUserPrompt(request);
  const routed = await runPrimaryRoute({
    cli,
    workspace,
    promptText: primaryPrompt,
    ...(signal ? { signal } : {}),
    ...(onEvent ? { onEvent } : {}),
    startedAt,
    dependencies: { ...dependencies, tokenCounter },
  });
  const runtime: Readonly<ExplorerRuntime> = Object.freeze({
    route: routed.route,
    target: routed.config.target,
    provider: routed.config.provider,
    api: routed.config.api,
    authMode: routed.config.authMode,
    baseUrl: redactUrl(routed.config.baseUrl),
    model: routed.config.model,
    workspace: workspace.root,
    promptPath: routed.config.promptPath,
    tools: Object.freeze([...routed.repositoryTools.names]),
  });

  const terminal = routed.primary.terminalFailure === "aborted"
    ? { errorCode: "DEADLINE_EXCEEDED" as const, reason: "FreeContext worker ended after the deadline." }
    : routed.primary.terminalFailure === "provider"
      ? { errorCode: "PROVIDER_RETRY_EXHAUSTED" as const, reason: "The provider remained unavailable after the configured retries." }
      : { errorCode: null };
  const result = await compileFreeContextResult(request, invocation, routed.primary.text, terminal);
  if (onSessionCapture) {
    await onSessionCapture(Object.freeze({
      schemaVersion: "freecontext-explorer-capture-v4",
      request,
      invocation,
      runtime,
      primary: capturePiSession(
        routed.primary,
        routed.systemPrompt,
        primaryPrompt,
      ),
      metrics: Object.freeze({
        routeAttempts: routed.routeAttempts,
        fallbacks: routed.fallbacks,
        setupMs: routed.setupMs,
        primarySessionMs: routed.primarySessionMs,
        totalMs: Math.max(0, clock() - startedAt),
      }),
    }));
  }
  return result;
}

export async function runExplorer(options: RunExplorerOptions): Promise<Readonly<FreeContextResult>> {
  if (options.dependencies?.tokenCounter) {
    return runExplorerWithCounter(options, options.dependencies.tokenCounter);
  }
  const tokenCounter = new GigatokenCounter();
  try {
    return await runExplorerWithCounter(options, tokenCounter);
  } finally {
    await tokenCounter.close();
  }
}
