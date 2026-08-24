import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { analyzeBenchmarkCosts } from "../src/benchmark/cost-analysis.js";

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

test("cost analysis batches all visible text once and separates local from provider-native domains", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "freecontext-costs-"));
  try {
    const treatment = path.join(root, "treatment");
    const control = path.join(root, "control");
    await writeJson(path.join(treatment, "trajectory.json"), {
      steps: [
        { source: "system", message: "sys" },
        { source: "user", message: "ask" },
        {
          source: "agent",
          message: "do",
          tool_calls: [
            { arguments: { call: "freecontext" } },
            { arguments: { cell_id: "cell-001", yield_time_ms: 300_000 } },
          ],
          observation: { results: [
            { content: "FreeContext is still running." },
            { content: "terminal" },
          ] },
        },
      ],
      final_metrics: {
        total_prompt_tokens: 100,
        total_cached_tokens: 30,
        total_completion_tokens: 40,
        extra: { reasoning_output_tokens: 10 },
      },
    });
    await writeJson(path.join(control, "trajectory.json"), {
      steps: [{ source: "user", message: "b" }, { source: "agent", message: "c" }],
      final_metrics: { total_prompt_tokens: 10, total_completion_tokens: 2 },
    });
    await writeJson(path.join(treatment, "master-agent-context.json"), {
      freeContextCalls: [
        { outputToMasterAgent: "answer", fullSessionFile: "freecontext-sessions/ready.json" },
        { outputToMasterAgent: null, fullSessionFile: "freecontext-sessions/failed.json" },
      ],
      freeContextTransport: [{
        schemaVersion: "freecontext-transport-observation-v1",
        reminderCount: 1,
        sameCellWaitCount: 1,
        latencyMs: 12_000.25,
      }],
    });
    await writeJson(path.join(treatment, "freecontext-sessions", "ready.json"), {
      capture: {
        schemaVersion: "freecontext-explorer-capture-v2",
        primary: { metrics: { usage: { input: 20, output: 5, cacheRead: 4, reasoning: 2, totalTokens: 25 } } },
      },
      runtimeEvents: [],
    });
    await writeJson(path.join(treatment, "freecontext-sessions", "failed.json"), {
      capture: null,
      runtimeEvents: [
        {
          event: {
            type: "turn_end",
            message: { usage: { input: 6, output: 1, cacheRead: 2, reasoning: 0, totalTokens: 9 } },
          },
        },
        {
          event: {
            type: "provider_attempt_failed",
            usage: { input: 8, output: 2, cacheRead: 1, reasoning: 0, totalTokens: 10 },
          },
        },
      ],
    });

    const batches: string[][] = [];
    const report = await analyzeBenchmarkCosts({
      schemaVersion: "freecontext-cost-input-v1",
      trials: [
        { taskId: "treatment", success: true, agentDir: treatment, pairId: "pair-1", arm: "treatment" },
        { taskId: "control", success: false, agentDir: control, pairId: "pair-1", arm: "control" },
      ],
    }, {
      countBatch: async (texts) => {
        batches.push([...texts]);
        return texts.map((value) => value.length);
      },
    });

    assert.deepEqual(batches, [[
      "sys",
      "ask",
      "FreeContext is still running.",
      "terminal",
      "do",
      '{"call":"freecontext"}',
      '{"cell_id":"cell-001","yield_time_ms":300000}',
      "answer",
      "b",
      "c",
    ]]);
    assert.deepEqual(report.population, { tasks: 2, successes: 1, freeContextCalls: 2 });
    assert.deepEqual((report.aggregate as Record<string, unknown>).mainVisible, {
      total: 114,
      perCall: 57,
      perTask: 57,
      perSuccess: 114,
    });
    assert.deepEqual((report.aggregate as Record<string, Record<string, unknown>>).subagentDeliveredVisible, {
      total: 6,
      perCall: 3,
      perTask: 3,
      perSuccess: 6,
    });
    assert.equal(report.schemaVersion, "freecontext-cost-report-v2");
    const provider = (report.aggregate as Record<string, Record<string, Record<string, Record<string, number>>>>).providerNative;
    assert.ok(provider);
    assert.equal(provider.countedWithoutReasoning?.main?.total, 142);
    assert.equal(provider.countedWithoutReasoning?.subagent?.total, 42);
    assert.equal(provider.countedWithoutReasoning?.total?.total, 184);
    assert.equal(provider.reasoningExcludedUncached?.main?.total, 112);
    assert.equal(provider.reasoningExcludedUncached?.subagent?.total, 40);
    assert.equal(provider.reasoningExcludedUncached?.total?.total, 152);
    assert.equal(provider.providerReported?.total?.total, 196);
    assert.equal(provider.reasoning?.total?.total, 12);
    const treatmentNative = (report.trials as Array<Record<string, unknown>>)[0]?.providerNative as Record<string, Record<string, number>>;
    assert.deepEqual(treatmentNative.main, {
      promptTokens: 100,
      completionTokens: 40,
      cachedPromptTokens: 30,
      reasoningTokens: 10,
      uncachedInputTokens: 70,
      visibleOutputTokens: 30,
      reasoningExcludedUncachedTokens: 100,
      countedTokens: 130,
      reportedTotalTokens: 140,
    });
    const paired = report.paired as Record<string, Record<string, unknown>>;
    assert.equal(paired.mainReasoningExcludedUncachedTokens?.completePairs, 1);
    assert.equal(paired.mainReasoningExcludedUncachedTokens?.medianTreatmentToControlRatio, 100 / 12);
    assert.equal(paired.mainReasoningExcludedUncachedTokens?.successfulMedianTreatmentToControlRatio, null);
    assert.equal((report.method as Record<string, Record<string, unknown>>).localVisibleText?.tokenizerInstances, 1);
    assert.deepEqual((report.aggregate as Record<string, unknown>).transport, {
      observations: 1,
      reminderEvents: 1,
      outerExecToolTurns: 1,
      waitToolTurns: 1,
      totalToolTurns: 2,
      latencyMs: { samples: 1, total: 12_000.25, mean: 12_000.25, max: 12_000.25 },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
