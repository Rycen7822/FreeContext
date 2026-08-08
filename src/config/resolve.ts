import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigurationError } from "../errors.js";
import { loadTomlConfig } from "./toml.js";
import type { ConfigDocument } from "./toml.js";
import {
  normalizeFallbackReason,
  parseBoolean,
  parseInteger,
} from "./resolve-values.js";
import { resolveTarget } from "./target.js";
import type {
  CliConfigOverrides,
  Environment,
  ResolvedRouteConfig,
  RuntimeConfig,
} from "./types.js";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = path.resolve(MODULE_DIR, "../..");
export const DEFAULT_PROMPT_PATH = path.join(PACKAGE_ROOT, "prompts", "explorer.md");

function expandHome(value: string): string {
  return value.replace(/^~(?=$|[/\\])/u, os.homedir());
}

export function defaultConfigPath(env: Environment = process.env): string {
  const configHome = env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(configHome, "freecontext", "config.toml");
}

async function assertReadable(filePath: string, label: string): Promise<void> {
  try {
    await access(filePath, fsConstants.R_OK);
  } catch (error) {
    throw new ConfigurationError(`${label} is not readable: ${filePath}`, { cause: error });
  }
}

function selectedConfigPath(cli: CliConfigOverrides, env: Environment): string {
  return path.resolve(expandHome(cli.configFile || env.FREECONTEXT_CONFIG || defaultConfigPath(env)));
}

function selectedPromptPath(
  cli: CliConfigOverrides,
  env: Environment,
  document: ConfigDocument,
  configFilePath: string,
): string {
  const external = cli.promptPath || env.FREECONTEXT_PROMPT_PATH;
  if (external) return path.resolve(expandHome(external));
  const configured = document.runtime.promptPath;
  if (!configured) return DEFAULT_PROMPT_PATH;
  const expanded = expandHome(configured);
  return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(path.dirname(configFilePath), expanded);
}

function validateReferences(document: ConfigDocument): void {
  for (const [modelId, model] of Object.entries(document.models)) {
    if (!document.providers[model.provider]) {
      throw new ConfigurationError(`models.${modelId}.provider references unknown provider: ${model.provider}`);
    }
  }
  for (const [routeId, route] of Object.entries(document.routes)) {
    for (const modelId of route.models) {
      if (!document.models[modelId]) {
        throw new ConfigurationError(`routes.${routeId}.models references unknown model: ${modelId}`);
      }
    }
    route.fallbackOn.forEach((reason) => normalizeFallbackReason(reason, `routes.${routeId}.fallback_on`));
  }
  if (!document.routes[document.defaultRoute]) {
    throw new ConfigurationError(`default_route references unknown route: ${document.defaultRoute}`);
  }
}

function chooseRoute(
  cli: CliConfigOverrides,
  env: Environment,
  document: ConfigDocument,
): Readonly<{ name: string; models: readonly string[]; fallbackOn: readonly string[] }> {
  if (cli.route && cli.target) throw new ConfigurationError("--route and --target cannot be used together.");
  const target = cli.target || (!cli.route ? env.FREECONTEXT_TARGET : undefined);
  if (target) {
    if (!document.models[target]) throw new ConfigurationError(`Unknown model target: ${target}`);
    return { name: `target:${target}`, models: [target], fallbackOn: [] };
  }
  const routeName = cli.route || env.FREECONTEXT_ROUTE || document.defaultRoute;
  const route = document.routes[routeName];
  if (!route) throw new ConfigurationError(`Unknown route: ${routeName}`);
  return { name: routeName, models: route.models, fallbackOn: route.fallbackOn };
}

function resolveRuntime(
  cli: CliConfigOverrides,
  env: Environment,
  document: ConfigDocument,
): Readonly<RuntimeConfig> {
  const runtime = document.runtime;
  return Object.freeze({
    maxTurns: parseInteger(cli.maxTurns ?? env.FREECONTEXT_MAX_TURNS ?? runtime.maxTurns, 8, {
      min: 2,
      max: 32,
      name: "max_turns",
    }),
    maxToolCalls: parseInteger(cli.maxToolCalls ?? env.FREECONTEXT_MAX_TOOL_CALLS ?? runtime.maxToolCalls, 32, {
      min: 1,
      max: 256,
      name: "max_tool_calls",
    }),
    requestTimeoutMs: parseInteger(
      cli.requestTimeoutMs ?? env.FREECONTEXT_REQUEST_TIMEOUT_MS ?? runtime.requestTimeoutMs,
      180000,
      { min: 1000, max: 1800000, name: "request_timeout_ms" },
    ),
    toolTimeoutMs: parseInteger(cli.toolTimeoutMs ?? env.FREECONTEXT_TOOL_TIMEOUT_MS ?? runtime.toolTimeoutMs, 20000, {
      min: 100,
      max: 300000,
      name: "tool_timeout_ms",
    }),
    maxToolOutputBytes: parseInteger(
      cli.maxToolOutputBytes ?? env.FREECONTEXT_MAX_TOOL_OUTPUT_BYTES ?? runtime.maxToolOutputBytes,
      65536,
      { min: 4096, max: 1048576, name: "max_tool_output_bytes" },
    ),
    maxParallelTools: parseInteger(
      cli.maxParallelTools ?? env.FREECONTEXT_MAX_PARALLEL_TOOLS ?? runtime.maxParallelTools,
      8,
      { min: 1, max: 32, name: "max_parallel_tools" },
    ),
    contextCompactionEnabled: cli.contextCompactionEnabled ?? parseBoolean(
      env.FREECONTEXT_COMPACTION_ENABLED ?? runtime.contextCompactionEnabled,
      true,
      "context_compaction_enabled",
    ),
  });
}

export async function resolveConfig(
  {
    cli = {},
    processEnv = process.env,
    requireApiKey = true,
  }: {
    readonly cli?: CliConfigOverrides;
    readonly processEnv?: Environment;
    readonly requireApiKey?: boolean;
  } = {},
): Promise<Readonly<ResolvedRouteConfig>> {
  const configFilePath = selectedConfigPath(cli, processEnv);
  const document = await loadTomlConfig(configFilePath);
  validateReferences(document);
  const selected = chooseRoute(cli, processEnv, document);
  const promptPath = selectedPromptPath(cli, processEnv, document, configFilePath);
  await assertReadable(promptPath, "System prompt");
  const runtime = resolveRuntime(cli, processEnv, document);
  const targets = selected.models.map((target) => {
    const model = document.models[target];
    if (!model) throw new ConfigurationError(`Unknown model target: ${target}`);
    const provider = document.providers[model.provider];
    if (!provider) throw new ConfigurationError(`Unknown provider for model target ${target}: ${model.provider}`);
    return resolveTarget(target, model, provider, runtime, promptPath, configFilePath, processEnv, requireApiKey);
  });
  return Object.freeze({
    route: selected.name,
    configFilePath,
    fallbackOn: Object.freeze(
      selected.fallbackOn.map((reason) => normalizeFallbackReason(reason, `routes.${selected.name}.fallback_on`)),
    ),
    targets: Object.freeze(targets),
  });
}
