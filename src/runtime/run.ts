import type { Usage } from "@earendil-works/pi-ai";
import type { CliConfigOverrides, FreeContextConfig } from "../config.js";
import { redactUrl, resolveConfig } from "../config.js";
import { OutputValidationError } from "../errors.js";
import type { ValidatedEvidenceCitation } from "../output/evidence.js";
import { renderFinalAnswer, validateExplorerOutput } from "../output/evidence.js";
import { buildRepairPrompt, buildUserPrompt, loadSystemPrompt } from "../prompt.js";
import type { RepositoryToolSet, ToolExecutables, Workspace } from "../tools/contracts.js";
import { createRepositoryTools } from "../tools/index.js";
import { createWorkspace } from "../tools/workspace.js";
import type { PiBindings } from "./pi-bindings.js";
import { loadPiBindings } from "./pi-bindings.js";
import { createModel, createRequestOptions } from "./model.js";
import type { PiSessionEventHandler, PiSessionMetrics } from "./pi-session.js";
import { runPiSession } from "./pi-session.js";

export interface ExplorerDependencies {
  readonly config?: FreeContextConfig;
  readonly workspace?: Workspace;
  readonly bindings?: PiBindings;
  readonly repositoryTools?: RepositoryToolSet;
  readonly executables?: Readonly<ToolExecutables> | null;
  readonly systemPrompt?: string;
  readonly clock?: () => number;
  readonly timestamp?: () => number;
}

export interface RunExplorerOptions {
  readonly query: string;
  readonly cwd?: string;
  readonly cli?: CliConfigOverrides;
  readonly repair?: boolean;
  readonly signal?: AbortSignal;
  readonly onEvent?: PiSessionEventHandler;
  readonly dependencies?: ExplorerDependencies;
}

export interface ExplorerMetrics {
  readonly turns: number;
  readonly toolCalls: number;
  readonly repaired: boolean;
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

export interface ExplorerRuntime {
  readonly api: FreeContextConfig["api"];
  readonly authMode: FreeContextConfig["authMode"];
  readonly baseUrl: string;
  readonly model: string;
  readonly workspace: string;
  readonly promptPath: string;
  readonly tools: readonly string[];
}

export interface ExplorerResult {
  readonly answer: string;
  readonly summary: string;
  readonly evidence: readonly Omit<ValidatedEvidenceCitation, "totalLines">[];
  readonly gaps: readonly string[];
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

export async function runExplorer({
  query,
  cwd = process.cwd(),
  cli = {},
  repair = true,
  signal,
  onEvent,
  dependencies = {},
}: RunExplorerOptions): Promise<Readonly<ExplorerResult>> {
  if (typeof query !== "string" || !query.trim()) {
    throw new OutputValidationError("Repository exploration query must be a non-empty string.");
  }
  if (query.length > 100000) {
    throw new OutputValidationError("Repository exploration query exceeds 100,000 characters.");
  }

  const clock = dependencies.clock ?? performance.now.bind(performance);
  const startedAt = clock();
  const config = dependencies.config ?? (await resolveConfig({ cli }));
  const workspace = dependencies.workspace ?? (await createWorkspace(cwd));
  const bindings = await loadPiBindings(config.api, dependencies.bindings ?? null);
  const repositoryTools = dependencies.repositoryTools ?? (await createRepositoryTools({
    Type: bindings.Type,
    workspace,
    config,
    executables: dependencies.executables ?? null,
  }));
  const systemPrompt = dependencies.systemPrompt ?? (await loadSystemPrompt({
    promptPath: config.promptPath,
    workspace,
    toolNames: repositoryTools.names,
  }));
  const model = createModel(config);
  const requestOptions = createRequestOptions(config);
  const setupMs = Math.max(0, clock() - startedAt);

  const primaryStartedAt = clock();
  const primary = await runPiSession({
    bindings,
    model,
    requestOptions,
    config,
    systemPrompt,
    promptText: buildUserPrompt(query),
    tools: repositoryTools.tools,
    ...(signal ? { signal } : {}),
    ...(onEvent ? { onEvent } : {}),
    clock,
    ...(dependencies.timestamp ? { timestamp: dependencies.timestamp } : {}),
  });
  const primarySessionMs = Math.max(0, clock() - primaryStartedAt);

  const primaryValidationStartedAt = clock();
  let validation = await validateExplorerOutput(primary.text, workspace);
  const primaryValidationMs = Math.max(0, clock() - primaryValidationStartedAt);
  let repairRun: Awaited<ReturnType<typeof runPiSession>> | null = null;
  let repairSessionMs = 0;
  let repairValidationMs = 0;
  if (!validation.valid && repair) {
    const repairStartedAt = clock();
    repairRun = await runPiSession({
      bindings,
      model,
      requestOptions,
      config,
      systemPrompt,
      promptText: buildRepairPrompt(validation.problems),
      tools: [],
      initialMessages: primary.contextMessages,
      maxTurns: 1,
      maxToolCalls: 0,
      ...(signal ? { signal } : {}),
      ...(onEvent ? { onEvent } : {}),
      clock,
      ...(dependencies.timestamp ? { timestamp: dependencies.timestamp } : {}),
    });
    repairSessionMs = Math.max(0, clock() - repairStartedAt);
    const repairValidationStartedAt = clock();
    validation = await validateExplorerOutput(repairRun.text, workspace);
    repairValidationMs = Math.max(0, clock() - repairValidationStartedAt);
  }

  if (!validation.valid) {
    throw new OutputValidationError(
      `Explorer output failed validation: ${validation.problems.join("; ") || "unknown validation error"}`,
      { problems: validation.problems, rawOutput: repairRun?.text ?? primary.text },
    );
  }

  const primaryUsage = sessionUsage(primary.metrics);
  const repairUsage = repairRun ? sessionUsage(repairRun.metrics) : EMPTY_USAGE;
  const evidence = validation.evidence.map(({ totalLines: _totalLines, ...item }) => Object.freeze(item));
  return Object.freeze({
    answer: renderFinalAnswer(validation),
    summary: validation.summary,
    evidence: Object.freeze(evidence),
    gaps: Object.freeze([...validation.gaps]),
    metrics: Object.freeze({
      turns: primary.metrics.turns + (repairRun?.metrics.turns ?? 0),
      toolCalls: primary.metrics.toolCalls + (repairRun?.metrics.toolCalls ?? 0),
      repaired: Boolean(repairRun),
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
    runtime: Object.freeze({
      api: config.api,
      authMode: config.authMode,
      baseUrl: redactUrl(config.baseUrl),
      model: config.model,
      workspace: workspace.root,
      promptPath: config.promptPath,
      tools: Object.freeze([...repositoryTools.names]),
    }),
  });
}
