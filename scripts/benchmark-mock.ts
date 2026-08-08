import { performance } from "node:perf_hooks";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { FreeContextConfig } from "../src/config.js";
import { createModel, createRequestOptions } from "../src/runtime/model.js";
import { loadPiBindings } from "../src/runtime/pi-bindings.js";
import type { PiBindings } from "../src/runtime/pi-bindings.js";
import { runPiSession } from "../src/runtime/pi-session.js";

type Scenario = "baseline" | "context";

function option(name: string): string | undefined {
  const exactIndex = process.argv.indexOf(`--${name}`);
  if (exactIndex >= 0) {
    const value = process.argv[exactIndex + 1];
    if (value === undefined) throw new Error(`--${name} requires a value`);
    return value;
  }
  return process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function integerOption(name: string, fallback: number, minimum: number): number {
  const raw = option(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!/^\d+$/u.test(raw) || !Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`--${name} must be an integer >= ${minimum}`);
  }
  return value;
}

function percentile(sorted: readonly number[], fraction: number): number {
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const lowerValue = sorted[lower];
  const upperValue = sorted[upper];
  if (lowerValue === undefined || upperValue === undefined) throw new Error("benchmark produced no samples");
  return lowerValue + (upperValue - lowerValue) * (position - lower);
}

function rounded(value: number): number {
  return Number(value.toFixed(3));
}

function assistantText(text: string, totalTokens = 15): AssistantMessage {
  const output = Math.min(5, totalTokens);
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "freecontext-benchmark",
    model: "benchmark-model",
    usage: {
      input: totalTokens - output,
      output,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      totalTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  };
}

async function main(): Promise<void> {
  const selectedScenario = option("scenario") ?? "baseline";
  if (selectedScenario !== "baseline" && selectedScenario !== "context") {
    throw new Error("--scenario must be baseline or context");
  }
  const scenario: Scenario = selectedScenario;
  const runs = integerOption("runs", 20, 1);
  const warmup = integerOption("warmup", 3, 0);
  const config: FreeContextConfig = {
    target: "benchmark",
    provider: "benchmark-provider",
    api: "anthropic",
    authMode: "auto",
    apiKey: "benchmark-key",
    baseUrl: "https://example.invalid",
    model: "benchmark-model",
    promptPath: "/dev/null",
    configFilePath: "/tmp/freecontext-benchmark.toml",
    maxTurns: 2,
    maxToolCalls: 1,
    maxOutputTokens: 256,
    requestTimeoutMs: 2_000,
    toolTimeoutMs: 2_000,
    maxToolOutputBytes: 8_192,
    maxParallelTools: 1,
    contextWindow: 8_192,
    contextCompactionEnabled: true,
    contextReserveTokens: 2_048,
    contextKeepRecentTokens: 1_024,
    effectiveToolOutputBytes: 8_192,
    temperature: 0,
    thinkingLevel: "off",
    headers: {},
    openAICompat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsUsageInStreaming: false,
      supportsStrictMode: false,
      supportsStore: false,
      maxTokensField: "max_tokens",
    },
  };
  const publicBindings = await loadPiBindings("anthropic");
  const final = assistantText("done");
  let summaryCalls = 0;
  const bindings: PiBindings = {
    ...publicBindings,
    runAgentLoop: async (prompts, context, loopConfig, emit) => {
      await emit({ type: "turn_start" });
      await emit({ type: "turn_end", message: final, toolResults: [] });
      const finalContext = { ...context, messages: [...context.messages, ...prompts, final] };
      await loopConfig.shouldStopAfterTurn?.({
        message: final,
        toolResults: [],
        context: finalContext,
        newMessages: [...prompts, final],
      });
      return [...prompts, final];
    },
    streamSimple: () => {
      summaryCalls += 1;
      const stream = createAssistantMessageEventStream();
      stream.end(assistantText("benchmark summary"));
      return stream;
    },
  };
  const initialMessages: readonly AgentMessage[] = scenario === "context"
    ? [
        { role: "user", content: `old ${"x".repeat(4000)}`, timestamp: 0 },
        assistantText("old finding", 7000),
        { role: "user", content: `recent ${"y".repeat(5000)}`, timestamp: 1 },
      ]
    : [];
  const runOnce = async () => await runPiSession({
    bindings,
    model: createModel(config),
    requestOptions: createRequestOptions(config),
    config,
    systemPrompt: "Return a concise benchmark answer.",
    promptText: "benchmark",
    tools: [],
    initialMessages,
  });

  for (let index = 0; index < warmup; index += 1) await runOnce();
  summaryCalls = 0;
  const samples: number[] = [];
  let compactions = 0;
  let compactionMs = 0;
  for (let index = 0; index < runs; index += 1) {
    const startedAt = performance.now();
    const result = await runOnce();
    samples.push(performance.now() - startedAt);
    compactions += result.metrics.compactions;
    compactionMs += result.metrics.compactionMs;
  }

  if (scenario === "baseline" && (summaryCalls !== 0 || compactions !== 0)) {
    throw new Error("baseline benchmark unexpectedly invoked context compaction");
  }
  if (scenario === "context" && (summaryCalls < runs || compactions < runs)) {
    throw new Error("forced-context benchmark did not compact every measured run");
  }
  const sorted = [...samples].sort((left, right) => left - right);
  const result: Record<string, string | number> = {
    scenario,
    runs,
    warmup,
    medianMs: rounded(percentile(sorted, 0.5)),
    p95Ms: rounded(percentile(sorted, 0.95)),
    minMs: rounded(sorted[0] ?? 0),
    maxMs: rounded(sorted.at(-1) ?? 0),
    rssBytes: process.memoryUsage().rss,
  };
  if (scenario === "context") {
    result.compactions = compactions;
    result.compactionMs = rounded(compactionMs);
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

await main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
