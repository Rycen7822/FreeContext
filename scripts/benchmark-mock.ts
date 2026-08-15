import { performance } from "node:perf_hooks";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { FreeContextConfig } from "../src/config.js";
import { FreeContextResultSchema } from "../src/mcp/contracts.js";
import type { FreeContextRequest } from "../src/mcp/contracts.js";
import { createGatherContextHandler } from "../src/mcp/tool.js";
import type { ContextTokenCounter } from "../src/runtime/context-budget.js";
import { createModel, createRequestOptions } from "../src/runtime/model.js";
import { loadPiBindings } from "../src/runtime/pi-bindings.js";
import type { PiBindings } from "../src/runtime/pi-bindings.js";
import { runPiSession } from "../src/runtime/pi-session.js";

type Scenario = "baseline" | "context" | "mcp";

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

async function runMcpScenario(runs: number, warmup: number): Promise<void> {
  const tokenCounter: ContextTokenCounter = {
    countBatch: async (texts) => texts.map(() => 0),
  };
  let toolCalls = 0;
  let sessionIndex = 0;
  const handler = createGatherContextHandler({
    tokenCounter,
    sessionDirectory: "/benchmark-sessions",
    runExplorer: async (options) => {
      toolCalls += 1;
      return FreeContextResultSchema.parse({
        status: "ready",
        summary: "Mock MCP context.",
        evidence: [{
          role: "implementation",
          path: "document.md",
          startLine: 1,
          endLine: 1,
          focusLine: 1,
          questionId: "impl",
          why: "Supports the result.",
        }],
        gaps: [{ questionId: "tests", reason: "No test fixture is needed." }],
        nextAction: { kind: "read", path: "document.md", startLine: 1, endLine: 1, reason: "Read the evidence." },
        errorCode: null,
        sessionId: options.invocation.sessionId,
        sessionFile: options.invocation.sessionFile,
      });
    },
    reserveSession: async ({ request, invocationId, callId, workspaceRoot, workspaceRevision }) => {
      const sessionId = String(sessionIndex += 1);
      const sessionFile = `/benchmark-sessions/${sessionId}.json`;
      return {
        file: { path: sessionFile },
        startedAt: "2026-08-11T00:00:00.000Z",
        request,
        invocation: { invocationId, callId, workspaceRoot, workspaceRevision, sessionId, sessionFile },
      };
    },
    commitSession: async ({ reservation }) => ({
      sessionFile: reservation.file.path,
      sessionBytes: 2_048,
      sessionFileSha256: "0".repeat(64),
    }),
  });
  const request: FreeContextRequest = {
    taskText: "collect benchmark context",
    knownRefs: [],
    evidenceQuestions: [
      { id: "impl", role: "implementation", question: "Where is it implemented?", required: true },
      { id: "tests", role: "test", question: "How is it tested?", required: false },
    ],
  };
  let callIndex = 0;
  const runOnce = () => {
    callIndex += 1;
    return handler(request, {
      invocationId: `invocation-${callIndex}`,
      callId: `call-${callIndex}`,
      workspaceRoot: "/benchmark-workspace",
      workspaceRevision: "benchmark-revision",
    });
  };

  for (let index = 0; index < warmup; index += 1) await runOnce();
  toolCalls = 0;
  const samples: number[] = [];
  let visibleResultBytes = 0;
  let sessionBytes = 0;
  for (let index = 0; index < runs; index += 1) {
    const startedAt = performance.now();
    const call = await runOnce();
    samples.push(performance.now() - startedAt);
    visibleResultBytes += Buffer.byteLength(JSON.stringify({
      structuredContent: call.structuredContent,
      content: call.content,
    }));
    sessionBytes += Number((call._meta?.freecontext as { sessionBytes?: unknown })?.sessionBytes ?? 0);
  }
  if (toolCalls !== runs) throw new Error("MCP benchmark did not execute exactly one tool per run");
  const sorted = [...samples].sort((left, right) => left - right);
  process.stdout.write(`${JSON.stringify({
    scenario: "mcp",
    runs,
    warmup,
    medianMs: rounded(percentile(sorted, 0.5)),
    p95Ms: rounded(percentile(sorted, 0.95)),
    minMs: rounded(sorted[0] ?? 0),
    maxMs: rounded(sorted.at(-1) ?? 0),
    rssBytes: process.memoryUsage().rss,
    toolCalls,
    visibleResultBytes,
    sessionBytes,
  })}\n`);
}

async function main(): Promise<void> {
  const selectedScenario = option("scenario") ?? "baseline";
  if (selectedScenario !== "baseline" && selectedScenario !== "context" && selectedScenario !== "mcp") {
    throw new Error("--scenario must be baseline, context, or mcp");
  }
  const scenario: Scenario = selectedScenario;
  const runs = integerOption("runs", 20, 1);
  const warmup = integerOption("warmup", 3, 0);
  if (scenario === "mcp") {
    await runMcpScenario(runs, warmup);
    return;
  }
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
    providerRetryDelaysMs: [1, 2, 4],
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
      supportsRequiredToolChoice: true,
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
      const prepared = await loopConfig.prepareNextTurn?.({
        message: final,
        toolResults: [],
        context: finalContext,
        newMessages: [...prompts, final],
      });
      const effectiveContext = prepared?.context ?? finalContext;
      await loopConfig.shouldStopAfterTurn?.({
        message: final,
        toolResults: [],
        context: effectiveContext,
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
        { role: "user", content: `old ${"old-token ".repeat(8_000)}`, timestamp: 0 },
        assistantText("old finding", 7000),
        { role: "user", content: `recent ${"recent ".repeat(500)}`, timestamp: 1 },
      ]
    : [];
  const finalizationRequest: FreeContextRequest = {
    taskText: "collect benchmark context",
    knownRefs: [],
    evidenceQuestions: [
      { id: "impl", role: "implementation", question: "Where is it implemented?", required: true },
      { id: "tests", role: "test", question: "How is it tested?", required: false },
    ],
  };
  const runOnce = async () => await runPiSession({
    bindings,
    model: createModel(config),
    requestOptions: createRequestOptions(config),
    config,
    systemPrompt: "Return a concise benchmark answer.",
    promptText: "benchmark",
    finalizationRequest,
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
