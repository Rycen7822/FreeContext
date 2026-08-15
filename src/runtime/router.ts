import type { CliConfigOverrides, FreeContextConfig, ResolvedRouteConfig } from "../config.js";
import { resolveConfig } from "../config.js";
import { ProviderError } from "../errors.js";
import type { FreeContextRequest } from "../mcp/contracts.js";
import { loadSystemPrompt } from "../prompt.js";
import type { RepositoryToolSet, ToolExecutables, Workspace } from "../tools/contracts.js";
import { createRepositoryTools } from "../tools/index.js";
import type { FreeContextModel, FreeContextRequestOptions } from "./model.js";
import { createModel, createRequestOptions } from "./model.js";
import type { ContextTokenCounter } from "./context-budget.js";
import type { PiBindings } from "./pi-bindings.js";
import { loadPiBindings } from "./pi-bindings.js";
import type { PiSessionEventHandler, PiSessionResult } from "./pi-session.js";
import { runPiSession } from "./pi-session.js";

export interface RouterDependencies {
  readonly routeConfig?: ResolvedRouteConfig;
  readonly bindings?: PiBindings;
  readonly repositoryTools?: RepositoryToolSet;
  readonly executables?: Readonly<ToolExecutables> | null;
  readonly systemPrompt?: string;
  readonly clock?: () => number;
  readonly timestamp?: () => number;
  readonly tokenCounter?: ContextTokenCounter;
}

export interface PrimaryRouteResult {
  readonly route: string;
  readonly config: FreeContextConfig;
  readonly bindings: PiBindings;
  readonly repositoryTools: RepositoryToolSet;
  readonly systemPrompt: string;
  readonly model: Readonly<FreeContextModel>;
  readonly requestOptions: Readonly<FreeContextRequestOptions>;
  readonly primary: Readonly<PiSessionResult>;
  readonly setupMs: number;
  readonly primarySessionMs: number;
  readonly routeAttempts: number;
  readonly fallbacks: number;
}

function canFallback(error: unknown, route: ResolvedRouteConfig, hasNext: boolean): boolean {
  return Boolean(
    hasNext &&
      error instanceof ProviderError &&
      error.safeToFallback &&
      error.category !== "other" &&
      route.fallbackOn.includes(error.category),
  );
}

export async function runPrimaryRoute({
  cli,
  workspace,
  promptText,
  finalizationRequest,
  signal,
  onEvent,
  startedAt,
  dependencies = {},
}: Readonly<{
  cli: CliConfigOverrides;
  workspace: Workspace;
  promptText: string;
  finalizationRequest: Readonly<FreeContextRequest>;
  signal?: AbortSignal;
  onEvent?: PiSessionEventHandler;
  startedAt: number;
  dependencies?: RouterDependencies;
}>): Promise<Readonly<PrimaryRouteResult>> {
  const clock = dependencies.clock ?? performance.now.bind(performance);
  const route = dependencies.routeConfig ?? (await resolveConfig({ cli }));
  let setupMs = 0;
  let primarySessionMs = 0;
  let cachedSystemPrompt = dependencies.systemPrompt;

  for (let index = 0; index < route.targets.length; index += 1) {
    const setupStartedAt = index === 0 ? startedAt : clock();
    const config = route.targets[index];
    if (!config) continue;
    const bindings = dependencies.bindings ?? (await loadPiBindings(config.api));
    const repositoryTools = dependencies.repositoryTools ?? (await createRepositoryTools({
      Type: bindings.Type,
      workspace,
      config,
      executables: dependencies.executables ?? null,
    }));
    cachedSystemPrompt ??= await loadSystemPrompt({
      promptPath: config.promptPath,
      workspace,
      toolNames: repositoryTools.names,
    });
    const model = createModel(config);
    const requestOptions = createRequestOptions(config);
    setupMs += Math.max(0, clock() - setupStartedAt);

    const primaryStartedAt = clock();
    try {
      const primary = await runPiSession({
        bindings,
        model,
        requestOptions,
        config,
        systemPrompt: cachedSystemPrompt,
        promptText,
        finalizationRequest,
        tools: repositoryTools.tools,
        ...(signal ? { signal } : {}),
        ...(onEvent ? { onEvent } : {}),
        clock,
        ...(dependencies.tokenCounter ? { tokenCounter: dependencies.tokenCounter } : {}),
        ...(dependencies.timestamp ? { timestamp: dependencies.timestamp } : {}),
      });
      primarySessionMs += Math.max(0, clock() - primaryStartedAt);
      return Object.freeze({
        route: route.route,
        config,
        bindings,
        repositoryTools,
        systemPrompt: cachedSystemPrompt,
        model,
        requestOptions,
        primary,
        setupMs,
        primarySessionMs,
        routeAttempts: index + 1,
        fallbacks: index,
      });
    } catch (error) {
      primarySessionMs += Math.max(0, clock() - primaryStartedAt);
      if (!canFallback(error, route, index + 1 < route.targets.length)) throw error;
    }
  }
  throw new ProviderError(`Route ${route.route} has no usable model target.`);
}
