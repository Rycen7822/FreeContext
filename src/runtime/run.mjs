import { OutputValidationError } from "../errors.mjs";
import { redactUrl, resolveConfig } from "../config.mjs";
import { createWorkspace } from "../tools/workspace.mjs";
import { createRepositoryTools } from "../tools/index.mjs";
import { buildRepairPrompt, buildUserPrompt, loadSystemPrompt } from "../prompt.mjs";
import { renderFinalAnswer, validateExplorerOutput } from "../output/evidence.mjs";
import { loadPiBindings } from "./pi-bindings.mjs";
import { createModel, createRequestOptions } from "./model.mjs";
import { runPiSession } from "./pi-session.mjs";

function mergeMetrics(primary, repair) {
  return Object.freeze({
    turns: primary.turns + (repair?.turns || 0),
    toolCalls: primary.toolCalls + (repair?.toolCalls || 0),
    repaired: Boolean(repair),
    primary,
    repair: repair || null,
    usage: Object.freeze({
      input: primary.usage.input + (repair?.usage.input || 0),
      output: primary.usage.output + (repair?.usage.output || 0),
      cacheRead: primary.usage.cacheRead + (repair?.usage.cacheRead || 0),
      cacheWrite: primary.usage.cacheWrite + (repair?.usage.cacheWrite || 0),
      reasoning: primary.usage.reasoning + (repair?.usage.reasoning || 0),
      totalTokens: primary.usage.totalTokens + (repair?.usage.totalTokens || 0),
    }),
  });
}

export async function runExplorer({
  query,
  cwd = process.cwd(),
  cli = {},
  repair = true,
  signal,
  onEvent,
  dependencies = {},
} = {}) {
  if (typeof query !== "string" || !query.trim()) {
    throw new OutputValidationError("Repository exploration query must be a non-empty string.");
  }
  if (query.length > 100000) throw new OutputValidationError("Repository exploration query exceeds 100,000 characters.");

  const config = dependencies.config || (await resolveConfig({ cli }));
  const workspace = dependencies.workspace || (await createWorkspace(cwd));
  const bindings = await loadPiBindings(config.api, dependencies.bindings || null);
  const repositoryTools =
    dependencies.repositoryTools ||
    (await createRepositoryTools({
      Type: bindings.Type,
      workspace,
      config,
      executables: dependencies.executables || null,
    }));
  const systemPrompt =
    dependencies.systemPrompt ||
    (await loadSystemPrompt({
      promptPath: config.promptPath,
      workspace,
      toolNames: repositoryTools.names,
    }));
  const model = createModel(config);
  const requestOptions = createRequestOptions(config);

  const primary = await runPiSession({
    bindings,
    model,
    requestOptions,
    config,
    systemPrompt,
    promptText: buildUserPrompt(query),
    tools: repositoryTools.tools,
    signal,
    onEvent,
  });

  let validation = await validateExplorerOutput(primary.text, workspace);
  let repairRun = null;
  if (!validation.valid && repair) {
    repairRun = await runPiSession({
      bindings,
      model,
      requestOptions,
      config,
      systemPrompt,
      promptText: buildRepairPrompt(validation.problems),
      tools: [],
      initialMessages: primary.messages,
      maxTurns: 1,
      maxToolCalls: 0,
      signal,
      onEvent,
    });
    validation = await validateExplorerOutput(repairRun.text, workspace);
  }

  if (!validation.valid) {
    const error = new OutputValidationError(
      `Explorer output failed validation: ${validation.problems.join("; ") || "unknown validation error"}`,
    );
    error.problems = validation.problems;
    error.rawOutput = repairRun?.text || primary.text;
    throw error;
  }

  return Object.freeze({
    answer: renderFinalAnswer(validation),
    summary: validation.summary,
    evidence: Object.freeze(validation.evidence.map(({ totalLines: _totalLines, ...item }) => Object.freeze(item))),
    gaps: Object.freeze([...validation.gaps]),
    metrics: mergeMetrics(primary.metrics, repairRun?.metrics),
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
