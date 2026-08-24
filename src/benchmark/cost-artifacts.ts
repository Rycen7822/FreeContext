import { readFile } from "node:fs/promises";
import path from "node:path";
import type { BenchmarkCostTrialReference } from "./cost-analysis.js";

export interface NativeUsage {
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens: number;
  reasoningTokens: number;
  uncachedInputTokens: number;
  visibleOutputTokens: number;
  reasoningExcludedUncachedTokens: number;
  countedTokens: number;
  reportedTotalTokens: number;
}

interface TransportMetrics {
  observations: number;
  reminderEvents: number;
  waitToolTurns: number;
  latencySamples: number;
  latencyMsTotal: number;
  latencyMsMax: number;
}

export interface LoadedCostTrial extends BenchmarkCostTrialReference {
  readonly mainInputs: readonly string[];
  readonly mainOutputs: readonly string[];
  readonly subagentDelivered: readonly string[];
  readonly mainNative: NativeUsage;
  readonly subagentNative: NativeUsage;
  readonly freeContextCalls: number;
  readonly transport: Readonly<TransportMetrics>;
}

function record(value: unknown, location: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${location} must be an object.`);
  return value as Record<string, unknown>;
}

async function jsonFile(filePath: string): Promise<Record<string, unknown>> {
  return record(JSON.parse(await readFile(filePath, "utf8")), filePath);
}

function integer(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : 0;
}

function nativeUsage(
  promptTokens: number,
  completionTokens: number,
  cachedPromptTokens: number,
  reasoningTokens: number,
  reportedTotalTokens: number,
): NativeUsage {
  const uncachedInputTokens = Math.max(0, promptTokens - cachedPromptTokens);
  const visibleOutputTokens = Math.max(0, completionTokens - reasoningTokens);
  return {
    promptTokens,
    completionTokens,
    cachedPromptTokens,
    reasoningTokens,
    uncachedInputTokens,
    visibleOutputTokens,
    reasoningExcludedUncachedTokens: uncachedInputTokens + visibleOutputTokens,
    countedTokens: Math.max(0, reportedTotalTokens - reasoningTokens),
    reportedTotalTokens,
  };
}

function requiredInteger(value: unknown, location: string): number {
  if (Number.isSafeInteger(value) && (value as number) >= 0) return value as number;
  throw new Error(`${location} must be a non-negative integer.`);
}

function requiredNonNegativeNumber(value: unknown, location: string): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  throw new Error(`${location} must be a finite non-negative number.`);
}

function emptyTransportMetrics(): TransportMetrics {
  return { observations: 0, reminderEvents: 0, waitToolTurns: 0, latencySamples: 0, latencyMsTotal: 0, latencyMsMax: 0 };
}

function text(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function mainVisibleTexts(trajectory: Record<string, unknown>): Readonly<{ inputs: string[]; outputs: string[] }> {
  const inputs: string[] = [];
  const outputs: string[] = [];
  const steps = Array.isArray(trajectory.steps) ? trajectory.steps : [];
  for (const rawStep of steps) {
    if (!rawStep || typeof rawStep !== "object" || Array.isArray(rawStep)) continue;
    const step = rawStep as Record<string, unknown>;
    if ((step.source === "system" || step.source === "user") && typeof step.message === "string" && step.message) {
      inputs.push(step.message);
    } else if (step.source === "agent") {
      if (typeof step.message === "string" && step.message) outputs.push(step.message);
      const calls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
      for (const rawCall of calls) {
        if (!rawCall || typeof rawCall !== "object" || Array.isArray(rawCall)) continue;
        const call = rawCall as Record<string, unknown>;
        if (call.arguments !== undefined && call.arguments !== "") outputs.push(text(call.arguments));
      }
      const observation = step.observation && typeof step.observation === "object" && !Array.isArray(step.observation)
        ? step.observation as Record<string, unknown>
        : {};
      const results = Array.isArray(observation.results) ? observation.results : [];
      for (const rawResult of results) {
        if (!rawResult || typeof rawResult !== "object" || Array.isArray(rawResult)) continue;
        const content = (rawResult as Record<string, unknown>).content;
        if (content !== undefined && content !== "") inputs.push(text(content));
      }
    }
  }
  return { inputs, outputs };
}

function mainNativeUsage(trajectory: Record<string, unknown>): NativeUsage {
  const metrics = trajectory.final_metrics && typeof trajectory.final_metrics === "object" && !Array.isArray(trajectory.final_metrics)
    ? trajectory.final_metrics as Record<string, unknown>
    : {};
  const extra = metrics.extra && typeof metrics.extra === "object" && !Array.isArray(metrics.extra)
    ? metrics.extra as Record<string, unknown>
    : {};
  const promptTokens = integer(metrics.total_prompt_tokens);
  const completionTokens = integer(metrics.total_completion_tokens);
  return nativeUsage(
    promptTokens,
    completionTokens,
    integer(metrics.total_cached_tokens),
    integer(extra.reasoning_output_tokens),
    promptTokens + completionTokens,
  );
}

function emptyNativeUsage(): NativeUsage {
  return nativeUsage(0, 0, 0, 0, 0);
}

function addNative(target: NativeUsage, source: Readonly<NativeUsage>): void {
  target.promptTokens += source.promptTokens;
  target.completionTokens += source.completionTokens;
  target.cachedPromptTokens += source.cachedPromptTokens;
  target.reasoningTokens += source.reasoningTokens;
  target.uncachedInputTokens += source.uncachedInputTokens;
  target.visibleOutputTokens += source.visibleOutputTokens;
  target.reasoningExcludedUncachedTokens += source.reasoningExcludedUncachedTokens;
  target.countedTokens += source.countedTokens;
  target.reportedTotalTokens += source.reportedTotalTokens;
}

function piUsage(value: unknown): NativeUsage {
  const usage = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const cachedPromptTokens = integer(usage.cacheRead);
  const promptTokens = integer(usage.input) + cachedPromptTokens + integer(usage.cacheWrite);
  const completionTokens = integer(usage.output);
  return nativeUsage(
    promptTokens,
    completionTokens,
    cachedPromptTokens,
    integer(usage.reasoning),
    integer(usage.totalTokens) || promptTokens + completionTokens,
  );
}

function safeSessionPath(agentDir: string, relativePath: string): string {
  const root = path.resolve(agentDir);
  const target = path.resolve(root, relativePath);
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`FreeContext session escapes agentDir: ${relativePath}`);
  }
  return target;
}

async function subagentMetrics(agentDir: string): Promise<Readonly<{
  calls: number;
  delivered: readonly string[];
  native: NativeUsage;
  transport: LoadedCostTrial["transport"];
}>> {
  let master: Record<string, unknown>;
  try { master = await jsonFile(path.join(agentDir, "master-agent-context.json")); }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return {
        calls: 0,
        delivered: [],
        native: emptyNativeUsage(),
        transport: emptyTransportMetrics(),
      };
    }
    throw error;
  }
  const calls = Array.isArray(master.freeContextCalls) ? master.freeContextCalls : [];
  const delivered: string[] = [];
  const native = emptyNativeUsage();
  const transport = emptyTransportMetrics();
  const transportObservations = Array.isArray(master.freeContextTransport) ? master.freeContextTransport : [];
  for (const rawObservation of transportObservations) {
    const observation = record(rawObservation, "freeContextTransport[]");
    if (observation.schemaVersion !== "freecontext-transport-observation-v1") {
      throw new Error("Unsupported FreeContext transport observation.");
    }
    transport.observations += 1;
    transport.reminderEvents += requiredInteger(observation.reminderCount, "freeContextTransport[].reminderCount");
    transport.waitToolTurns += requiredInteger(observation.sameCellWaitCount, "freeContextTransport[].sameCellWaitCount");
    if (observation.latencyMs !== null && observation.latencyMs !== undefined) {
      const latencyMs = requiredNonNegativeNumber(observation.latencyMs, "freeContextTransport[].latencyMs");
      transport.latencySamples += 1;
      transport.latencyMsTotal += latencyMs;
      transport.latencyMsMax = Math.max(transport.latencyMsMax, latencyMs);
    }
  }
  for (const rawCall of calls) {
    const call = record(rawCall, "freeContextCalls[]");
    if (typeof call.outputToMasterAgent === "string") delivered.push(call.outputToMasterAgent);
    if (typeof call.fullSessionFile !== "string") throw new Error("FreeContext call has no fullSessionFile.");
    const session = await jsonFile(safeSessionPath(agentDir, call.fullSessionFile));
    const capture = session.capture && typeof session.capture === "object" && !Array.isArray(session.capture)
      ? session.capture as Record<string, unknown>
      : null;
    const primary = capture?.primary && typeof capture.primary === "object" && !Array.isArray(capture.primary)
      ? capture.primary as Record<string, unknown>
      : null;
    const metrics = primary?.metrics && typeof primary.metrics === "object" && !Array.isArray(primary.metrics)
      ? primary.metrics as Record<string, unknown>
      : null;
    if (metrics) {
      addNative(native, piUsage(metrics.usage));
      continue;
    }
    const runtimeEvents = Array.isArray(session.runtimeEvents) ? session.runtimeEvents : [];
    for (const rawRuntimeEvent of runtimeEvents) {
      if (!rawRuntimeEvent || typeof rawRuntimeEvent !== "object" || Array.isArray(rawRuntimeEvent)) continue;
      const event = (rawRuntimeEvent as Record<string, unknown>).event;
      if (!event || typeof event !== "object" || Array.isArray(event)) continue;
      const typed = event as Record<string, unknown>;
      if (typed.type === "turn_end") {
        const message = typed.message && typeof typed.message === "object" && !Array.isArray(typed.message)
          ? typed.message as Record<string, unknown>
          : null;
        addNative(native, piUsage(message?.usage));
      } else if (typed.type === "provider_attempt_failed") {
        addNative(native, piUsage(typed.usage));
      }
    }
  }
  return { calls: calls.length, delivered, native, transport: Object.freeze(transport) };
}

export async function loadCostTrial(reference: Readonly<BenchmarkCostTrialReference>): Promise<LoadedCostTrial> {
  if (!reference.taskId.trim()) throw new Error("taskId must be non-empty.");
  const agentDir = path.resolve(reference.agentDir);
  const trajectory = await jsonFile(path.join(agentDir, "trajectory.json"));
  const visible = mainVisibleTexts(trajectory);
  const subagent = await subagentMetrics(agentDir);
  return {
    ...reference,
    agentDir,
    mainInputs: visible.inputs,
    mainOutputs: visible.outputs,
    subagentDelivered: subagent.delivered,
    mainNative: mainNativeUsage(trajectory),
    subagentNative: subagent.native,
    freeContextCalls: subagent.calls,
    transport: subagent.transport,
  };
}
