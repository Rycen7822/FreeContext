import type { TextTokenCounter } from "../runtime/gigatoken-counter.js";
import { loadCostTrial, type LoadedCostTrial } from "./cost-artifacts.js";

export type BenchmarkArm = "control" | "treatment";

export interface BenchmarkCostTrialReference {
  readonly taskId: string;
  readonly success: boolean;
  readonly agentDir: string;
  readonly pairId?: string;
  readonly arm?: BenchmarkArm;
}

export interface BenchmarkCostInput {
  readonly schemaVersion: "freecontext-cost-input-v1";
  readonly trials: readonly BenchmarkCostTrialReference[];
}

function rates(total: number, calls: number, tasks: number, successes: number): Readonly<Record<string, number | null>> {
  return Object.freeze({
    total,
    perCall: calls > 0 ? total / calls : null,
    perTask: tasks > 0 ? total / tasks : null,
    perSuccess: successes > 0 ? total / successes : null,
  });
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : ((sorted[middle - 1]! + sorted[middle]!) / 2);
}

function pairedMainMetric(trials: readonly LoadedCostTrial[]): Readonly<Record<string, unknown>> {
  const groups = new Map<string, { control?: LoadedCostTrial; treatment?: LoadedCostTrial }>();
  for (const trial of trials) {
    if (trial.pairId === undefined && trial.arm === undefined) continue;
    if (trial.pairId === undefined || trial.arm === undefined) {
      throw new Error(`Trial ${trial.taskId} must provide both pairId and arm for paired analysis.`);
    }
    const group = groups.get(trial.pairId) ?? {};
    if (group[trial.arm] !== undefined) throw new Error(`Duplicate ${trial.arm} trial for pair ${trial.pairId}.`);
    group[trial.arm] = trial;
    groups.set(trial.pairId, group);
  }
  const ratios: Array<Record<string, unknown>> = [];
  for (const [pairId, group] of groups) {
    if (!group.control || !group.treatment) continue;
    const controlTokens = group.control.mainNative.reasoningExcludedUncachedTokens;
    const treatmentTokens = group.treatment.mainNative.reasoningExcludedUncachedTokens;
    ratios.push({
      pairId,
      controlTokens,
      treatmentTokens,
      treatmentToControlRatio: controlTokens > 0 ? treatmentTokens / controlTokens : null,
      bothSucceeded: group.control.success && group.treatment.success,
    });
  }
  const validRatios = ratios.flatMap((ratio) =>
    typeof ratio.treatmentToControlRatio === "number" ? [ratio.treatmentToControlRatio] : []);
  const successfulRatios = ratios.flatMap((ratio) =>
    ratio.bothSucceeded && typeof ratio.treatmentToControlRatio === "number" ? [ratio.treatmentToControlRatio] : []);
  return Object.freeze({
    completePairs: ratios.length,
    ratios: Object.freeze(ratios.map((ratio) => Object.freeze(ratio))),
    medianTreatmentToControlRatio: median(validRatios),
    successfulMedianTreatmentToControlRatio: median(successfulRatios),
  });
}

export async function analyzeBenchmarkCosts(
  input: Readonly<BenchmarkCostInput>,
  tokenizer: Pick<TextTokenCounter, "countBatch">,
): Promise<Readonly<Record<string, unknown>>> {
  if (input.schemaVersion !== "freecontext-cost-input-v1") throw new Error("Unsupported cost input schemaVersion.");
  const loaded = await Promise.all(input.trials.map(loadCostTrial));
  const texts: string[] = [];
  const slices = loaded.map((trial) => {
    const mainInputStart = texts.length;
    texts.push(...trial.mainInputs);
    const mainOutputStart = texts.length;
    texts.push(...trial.mainOutputs);
    const deliveredStart = texts.length;
    texts.push(...trial.subagentDelivered);
    return {
      mainInputStart,
      mainInputEnd: mainOutputStart,
      mainOutputStart,
      mainOutputEnd: deliveredStart,
      deliveredStart,
      deliveredEnd: texts.length,
    };
  });
  const counts = await tokenizer.countBatch(texts);
  if (counts.length !== texts.length) throw new Error("Gigatoken count length mismatch.");
  const prefixSums = [0];
  for (const count of counts) prefixSums.push((prefixSums.at(-1) ?? 0) + count);
  const sumSlice = (start: number, end: number): number => (prefixSums[end] ?? 0) - (prefixSums[start] ?? 0);
  const trials = loaded.map((trial, index) => {
    const slice = slices[index]!;
    const mainInputTokens = sumSlice(slice.mainInputStart, slice.mainInputEnd);
    const mainOutputTokens = sumSlice(slice.mainOutputStart, slice.mainOutputEnd);
    return Object.freeze({
      taskId: trial.taskId,
      success: trial.success,
      agentDir: trial.agentDir,
      ...(trial.pairId === undefined ? {} : { pairId: trial.pairId }),
      ...(trial.arm === undefined ? {} : { arm: trial.arm }),
      freeContextCalls: trial.freeContextCalls,
      mainVisible: { inputTokens: mainInputTokens, outputTokens: mainOutputTokens, totalTokens: mainInputTokens + mainOutputTokens },
      subagentDeliveredVisible: { totalTokens: sumSlice(slice.deliveredStart, slice.deliveredEnd) },
      transport: trial.transport,
      providerNative: {
        main: trial.mainNative,
        subagent: trial.subagentNative,
        total: {
          countedTokens: trial.mainNative.countedTokens + trial.subagentNative.countedTokens,
          reportedTotalTokens: trial.mainNative.reportedTotalTokens + trial.subagentNative.reportedTotalTokens,
          reasoningTokens: trial.mainNative.reasoningTokens + trial.subagentNative.reasoningTokens,
        },
      },
    });
  });
  const taskCount = trials.length;
  const successCount = trials.filter((trial) => trial.success).length;
  const callCount = trials.reduce((sum, trial) => sum + trial.freeContextCalls, 0);
  const mainVisibleTotal = trials.reduce((sum, trial) => sum + trial.mainVisible.totalTokens, 0);
  const subagentDeliveredTotal = trials.reduce((sum, trial) => sum + trial.subagentDeliveredVisible.totalTokens, 0);
  const nativeTotals = (owner: "main" | "subagent", field: "countedTokens" | "reportedTotalTokens" | "reasoningTokens"): number =>
    trials.reduce((sum, trial) => sum + trial.providerNative[owner][field], 0);
  const mainCounted = nativeTotals("main", "countedTokens");
  const subagentCounted = nativeTotals("subagent", "countedTokens");
  const mainReported = nativeTotals("main", "reportedTotalTokens");
  const subagentReported = nativeTotals("subagent", "reportedTotalTokens");
  const mainReasoning = nativeTotals("main", "reasoningTokens");
  const subagentReasoning = nativeTotals("subagent", "reasoningTokens");
  const mainReasoningExcludedUncached = trials.reduce(
    (sum, trial) => sum + trial.providerNative.main.reasoningExcludedUncachedTokens,
    0,
  );
  const subagentReasoningExcludedUncached = trials.reduce(
    (sum, trial) => sum + trial.providerNative.subagent.reasoningExcludedUncachedTokens,
    0,
  );
  const transport = trials.reduce((total, trial) => ({
    observations: total.observations + trial.transport.observations,
    reminderEvents: total.reminderEvents + trial.transport.reminderEvents,
    waitToolTurns: total.waitToolTurns + trial.transport.waitToolTurns,
    latencySamples: total.latencySamples + trial.transport.latencySamples,
    latencyMsTotal: total.latencyMsTotal + trial.transport.latencyMsTotal,
    latencyMsMax: Math.max(total.latencyMsMax, trial.transport.latencyMsMax),
  }), { observations: 0, reminderEvents: 0, waitToolTurns: 0, latencySamples: 0, latencyMsTotal: 0, latencyMsMax: 0 });
  return Object.freeze({
    schemaVersion: "freecontext-cost-report-v2",
    method: {
      localVisibleText: { implementation: "Python gigatoken", encoding: "o200k_base from tiktoken", batchMethod: "encode_batch", tokenizerInstances: 1, transportEvents: "included from trajectory tool arguments and observations" },
      providerNative: {
        source: "reported usage; not mixed with local Gigatoken counts",
        comparisonTotal: "provider reported total minus reasoning tokens",
        rawTotal: "preserved separately for billing and diagnostics",
      },
    },
    population: { tasks: taskCount, successes: successCount, freeContextCalls: callCount },
    aggregate: {
      mainVisible: rates(mainVisibleTotal, callCount, taskCount, successCount),
      subagentDeliveredVisible: rates(subagentDeliveredTotal, callCount, taskCount, successCount),
      transport: {
        observations: transport.observations,
        reminderEvents: transport.reminderEvents,
        outerExecToolTurns: transport.observations,
        waitToolTurns: transport.waitToolTurns,
        totalToolTurns: transport.observations + transport.waitToolTurns,
        latencyMs: {
          samples: transport.latencySamples,
          total: transport.latencyMsTotal,
          mean: transport.latencySamples > 0 ? transport.latencyMsTotal / transport.latencySamples : null,
          max: transport.latencySamples > 0 ? transport.latencyMsMax : null,
        },
      },
      providerNative: {
        reasoningExcludedUncached: {
          main: rates(mainReasoningExcludedUncached, callCount, taskCount, successCount),
          subagent: rates(subagentReasoningExcludedUncached, callCount, taskCount, successCount),
          total: rates(mainReasoningExcludedUncached + subagentReasoningExcludedUncached, callCount, taskCount, successCount),
        },
        countedWithoutReasoning: {
          main: rates(mainCounted, callCount, taskCount, successCount),
          subagent: rates(subagentCounted, callCount, taskCount, successCount),
          total: rates(mainCounted + subagentCounted, callCount, taskCount, successCount),
        },
        providerReported: {
          main: rates(mainReported, callCount, taskCount, successCount),
          subagent: rates(subagentReported, callCount, taskCount, successCount),
          total: rates(mainReported + subagentReported, callCount, taskCount, successCount),
        },
        reasoning: {
          main: rates(mainReasoning, callCount, taskCount, successCount),
          subagent: rates(subagentReasoning, callCount, taskCount, successCount),
          total: rates(mainReasoning + subagentReasoning, callCount, taskCount, successCount),
        },
      },
    },
    paired: {
      mainReasoningExcludedUncachedTokens: pairedMainMetric(loaded),
    },
    trials: Object.freeze(trials),
  });
}
