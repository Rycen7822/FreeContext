import type { Usage } from "@earendil-works/pi-ai";
import type { CliConfigOverrides } from "../config.js";
import { redactUrl } from "../config.js";
import { OutputValidationError } from "../errors.js";
import type { ExplorerOutputValidation, ValidatedEvidenceCitation } from "../output/evidence.js";
import { renderFinalAnswer, validateExplorerOutput } from "../output/evidence.js";
import { buildRepairPrompt, buildUserPrompt, REPAIR_SYSTEM_PROMPT } from "../prompt.js";
import type { Workspace } from "../tools/contracts.js";
import { createWorkspace } from "../tools/workspace.js";
import type { ContextTokenCounter } from "./context-budget.js";
import { GigatokenCounter } from "./gigatoken-counter.js";
import type { PiSessionEventHandler, PiSessionMetrics } from "./pi-session.js";
import { runPiSession } from "./pi-session.js";
import type { RouterDependencies } from "./router.js";
import { runPrimaryRoute } from "./router.js";
import { captureError, capturePiSession, captureValidation } from "./session-capture.js";
import type {
  ExplorerCaptureOutcome,
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
  readonly query: string;
  readonly cwd?: string;
  readonly cli?: CliConfigOverrides;
  readonly repair?: boolean;
  readonly signal?: AbortSignal;
  readonly onEvent?: PiSessionEventHandler;
  readonly onSessionCapture?: ExplorerSessionCaptureHandler;
  readonly dependencies?: ExplorerDependencies;
}

export interface ExplorerMetrics {
  readonly turns: number;
  readonly toolCalls: number;
  readonly repaired: boolean;
  readonly routeAttempts: number;
  readonly fallbacks: number;
  readonly primary: PiSessionMetrics;
  readonly repair: PiSessionMetrics | null;
  readonly usage: Readonly<Usage>;
  readonly setupMs: number;
  readonly primarySessionMs: number;
  readonly primaryValidationMs: number;
  readonly repairSessionMs: number;
  readonly repairValidationMs: number;
  readonly toolExecutionMsTotal: number;
  readonly toolExecutionMsMax: number;
  readonly totalMs: number;
}

export interface ExplorerResult {
  readonly status: "completed" | "partial";
  readonly answer: string;
  readonly summary: string;
  readonly evidence: readonly Omit<ValidatedEvidenceCitation, "totalLines">[];
  readonly gaps: readonly string[];
  readonly validationProblems: readonly string[];
  readonly metrics: Readonly<ExplorerMetrics>;
  readonly runtime: Readonly<ExplorerRuntime>;
}

const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function addUsage(left: Usage, right: Usage): Usage {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    ...(left.cacheWrite1h !== undefined || right.cacheWrite1h !== undefined
      ? { cacheWrite1h: (left.cacheWrite1h ?? 0) + (right.cacheWrite1h ?? 0) }
      : {}),
    ...(left.reasoning !== undefined || right.reasoning !== undefined
      ? { reasoning: (left.reasoning ?? 0) + (right.reasoning ?? 0) }
      : {}),
    totalTokens: left.totalTokens + right.totalTokens,
    cost: {
      input: left.cost.input + right.cost.input,
      output: left.cost.output + right.cost.output,
      cacheRead: left.cost.cacheRead + right.cost.cacheRead,
      cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
      total: left.cost.total + right.cost.total,
    },
  };
}

function sessionUsage(metrics: PiSessionMetrics): Usage {
  return addUsage(metrics.usage, metrics.compactionUsage);
}

async function runExplorerWithCounter({
  query,
  cwd = process.cwd(),
  cli = {},
  repair = true,
  signal,
  onEvent,
  onSessionCapture,
  dependencies = {},
}: RunExplorerOptions, tokenCounter: ContextTokenCounter): Promise<Readonly<ExplorerResult>> {
  if (typeof query !== "string" || !query.trim()) {
    throw new OutputValidationError("Repository exploration query must be a non-empty string.");
  }
  if (query.length > 100000) {
    throw new OutputValidationError("Repository exploration query exceeds 100,000 characters.");
  }

  const clock = dependencies.clock ?? performance.now.bind(performance);
  const startedAt = clock();
  const workspace = dependencies.workspace ?? (await createWorkspace(cwd));
  const primaryPrompt = buildUserPrompt(query);
  const runtimeDependencies = { ...dependencies, tokenCounter };
  const routed = await runPrimaryRoute({
    cli,
    workspace,
    promptText: primaryPrompt,
    ...(signal ? { signal } : {}),
    ...(onEvent ? { onEvent } : {}),
    startedAt,
    dependencies: runtimeDependencies,
  });
  const {
    config,
    bindings,
    repositoryTools,
    systemPrompt,
    model,
    requestOptions,
    primary,
    setupMs,
    primarySessionMs,
  } = routed;
  const runtime = Object.freeze({
    route: routed.route,
    target: config.target,
    provider: config.provider,
    api: config.api,
    authMode: config.authMode,
    baseUrl: redactUrl(config.baseUrl),
    model: config.model,
    workspace: workspace.root,
    promptPath: config.promptPath,
    tools: Object.freeze([...repositoryTools.names]),
  });

  const primaryValidationStartedAt = clock();
  const primaryValidation = await validateExplorerOutput(primary.text, workspace);
  let validation = primaryValidation;
  const primaryValidationMs = Math.max(0, clock() - primaryValidationStartedAt);
  let repairRun: Awaited<ReturnType<typeof runPiSession>> | null = null;
  let repairPrompt: string | null = null;
  let repairValidation: ExplorerOutputValidation | null = null;
  let repairSessionMs = 0;
  let repairValidationMs = 0;

  const publishCapture = async (outcome: ExplorerCaptureOutcome): Promise<void> => {
    if (!onSessionCapture) return;
    const repairCapture = repairPrompt === null
      ? null
      : Object.freeze({
          prompt: repairPrompt,
          session: repairRun
            ? capturePiSession(repairRun, REPAIR_SYSTEM_PROMPT, repairPrompt, [])
            : null,
          validation: repairValidation ? captureValidation(repairValidation) : null,
        });
    await onSessionCapture(Object.freeze({
      schemaVersion: "freecontext-session-v1",
      request: query,
      runtime,
      primary: capturePiSession(primary, systemPrompt, primaryPrompt, repositoryTools.tools),
      primaryValidation: captureValidation(primaryValidation),
      repair: repairCapture,
      outcome,
    }));
  };

  if (validation.status === "invalid" && repair) {
    const repairStartedAt = clock();
    repairPrompt = buildRepairPrompt(primary.text, validation.problems);
    try {
      repairRun = await runPiSession({
        bindings,
        model,
        requestOptions,
        config,
        systemPrompt: REPAIR_SYSTEM_PROMPT,
        promptText: repairPrompt,
        tools: [],
        maxTurns: 1,
        maxToolCalls: 0,
        ...(signal ? { signal } : {}),
        ...(onEvent ? { onEvent } : {}),
        clock,
        tokenCounter,
        ...(dependencies.timestamp ? { timestamp: dependencies.timestamp } : {}),
      });
    } catch (error) {
      await publishCapture(Object.freeze({
        status: "repair_error",
        error: captureError(error),
      }));
      throw error;
    }
    repairSessionMs = Math.max(0, clock() - repairStartedAt);
    const repairValidationStartedAt = clock();
    repairValidation = await validateExplorerOutput(repairRun.text, workspace);
    validation = repairValidation;
    repairValidationMs = Math.max(0, clock() - repairValidationStartedAt);
  }

  if (validation.status === "invalid") {
    const error = new OutputValidationError(
      `Explorer output failed validation: ${validation.problems.join("; ") || "unknown validation error"}`,
      { problems: validation.problems, rawOutput: repairRun?.text ?? primary.text },
    );
    await publishCapture(Object.freeze({
      status: "output_validation_error",
      error: captureError(error),
    }));
    throw error;
  }

  const primaryUsage = sessionUsage(primary.metrics);
  const repairUsage = repairRun ? sessionUsage(repairRun.metrics) : EMPTY_USAGE;
  const evidence = validation.evidence.map(({ totalLines: _totalLines, ...item }) => Object.freeze(item));
  const answer = renderFinalAnswer(validation);
  const result = Object.freeze({
    status: validation.status,
    answer,
    summary: validation.summary,
    evidence: Object.freeze(evidence),
    gaps: Object.freeze([...validation.gaps]),
    validationProblems: Object.freeze([...validation.problems]),
    metrics: Object.freeze({
      turns: primary.metrics.turns + (repairRun?.metrics.turns ?? 0),
      toolCalls: primary.metrics.toolCalls + (repairRun?.metrics.toolCalls ?? 0),
      repaired: Boolean(repairRun),
      routeAttempts: routed.routeAttempts,
      fallbacks: routed.fallbacks,
      primary: primary.metrics,
      repair: repairRun?.metrics ?? null,
      usage: Object.freeze(addUsage(primaryUsage, repairUsage)),
      setupMs,
      primarySessionMs,
      primaryValidationMs,
      repairSessionMs,
      repairValidationMs,
      toolExecutionMsTotal:
        primary.metrics.toolExecutionMsTotal + (repairRun?.metrics.toolExecutionMsTotal ?? 0),
      toolExecutionMsMax: Math.max(
        primary.metrics.toolExecutionMsMax,
        repairRun?.metrics.toolExecutionMsMax ?? 0,
      ),
      totalMs: Math.max(0, clock() - startedAt),
    }),
    runtime,
  });
  await publishCapture(validation.status === "partial"
    ? Object.freeze({ status: "partial", answer, problemCount: validation.problems.length })
    : Object.freeze({ status: "completed", answer }));
  return result;
}

export async function runExplorer(options: RunExplorerOptions): Promise<Readonly<ExplorerResult>> {
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
