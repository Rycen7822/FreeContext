import test from "node:test";
import assert from "node:assert/strict";
import type {
  AgentContext,
  AgentLoopConfig,
  AgentLoopTurnUpdate,
  AgentMessage,
  AgentTool,
  StreamFn,
} from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, Type } from "@earendil-works/pi-ai";
import { ContextBudgetError, ProviderError } from "../src/errors.js";
import { createModel, createRequestOptions } from "../src/runtime/model.js";
import type { PiBindings } from "../src/runtime/pi-bindings.js";
import type { FreeContextRuntimeEvent, PiSessionOptions } from "../src/runtime/pi-session.js";
import { runPiSession as runPiSessionBase } from "../src/runtime/pi-session.js";
import { assistantText, baseConfig, fakeBindings } from "./helpers.js";

function bindingsWith(handler: PiBindings["runAgentLoop"]): PiBindings {
  return fakeBindings(handler);
}

const tokenCounter = {
  countBatch: async (texts: readonly string[]) => texts.map((text) => Math.ceil(text.length / 4)),
};

const runPiSession = (options: PiSessionOptions) => runPiSessionBase({ ...options, tokenCounter });

const readTool: AgentTool = {
  name: "read",
  label: "Read",
  description: "Read fixture",
  parameters: Type.Object({}),
  execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
};

const toolResult = {
  role: "toolResult" as const,
  toolCallId: "call-1",
  toolName: "read",
  content: [{ type: "text" as const, text: "result" }],
  isError: false,
  timestamp: 0,
};

test("runPiSession wires the low-level Pi loop in parallel mode", async () => {
  const config = baseConfig();
  let captured: {
    readonly prompts: AgentMessage[];
    readonly context: AgentContext;
    readonly loopConfig: AgentLoopConfig;
    readonly signal: AbortSignal | undefined;
    readonly streamSimple: StreamFn;
  } | undefined;
  const final = assistantText("done");
  const bindings = bindingsWith(async (prompts, context, loopConfig, emit, signal, streamSimple) => {
    captured = { prompts, context, loopConfig, signal, streamSimple };
    await emit({ type: "agent_start" });
    await emit({ type: "turn_start" });
    await emit({ type: "turn_end", message: final, toolResults: [] });
    return [...prompts, final];
  });
  const result = await runPiSession({
    bindings,
    model: createModel(config),
    requestOptions: createRequestOptions(config),
    config,
    systemPrompt: "system",
    promptText: "prompt",
    tools: [readTool],
  });
  assert.ok(captured);
  assert.equal(captured.loopConfig.toolExecution, "parallel");
  assert.equal(captured.context.systemPrompt, "system");
  assert.equal(captured.prompts[0]?.role, "user");
  assert.equal(result.text, "done");
  assert.equal(result.metrics.turns, 1);
  assert.equal(result.metrics.usage.totalTokens, 15);
  assert.equal(result.metrics.compactions, 0);
});

test("tool timing aggregates overlapping executions under an injected clock", async () => {
  const config = baseConfig();
  const final = assistantText("done");
  const ticks = [0, 10, 20, 50, 80, 100];
  let tickIndex = 0;
  const clock = (): number => {
    const tick = ticks[tickIndex++];
    if (tick === undefined) throw new Error("unexpected clock read");
    return tick;
  };
  const observed: FreeContextRuntimeEvent[] = [];
  const bindings = bindingsWith(async (prompts, _context, _loopConfig, emit) => {
    await emit({ type: "turn_start" });
    await emit({ type: "tool_execution_start", toolCallId: "a", toolName: "read", args: {} });
    await emit({ type: "tool_execution_start", toolCallId: "b", toolName: "read", args: {} });
    await emit({
      type: "tool_execution_end",
      toolCallId: "b",
      toolName: "read",
      result: { content: [], details: {} },
      isError: false,
    });
    await emit({
      type: "tool_execution_end",
      toolCallId: "a",
      toolName: "read",
      result: { content: [], details: {} },
      isError: false,
    });
    await emit({ type: "turn_end", message: final, toolResults: [] });
    return [...prompts, final];
  });
  const result = await runPiSession({
    bindings,
    model: createModel(config),
    requestOptions: createRequestOptions(config),
    config,
    systemPrompt: "system",
    promptText: "prompt",
    tools: [readTool],
    clock,
    onEvent: (event) => { observed.push(event); },
  });

  assert.equal(result.metrics.toolExecutionMsTotal, 100);
  assert.equal(result.metrics.toolExecutionMsMax, 70);
  assert.equal(result.metrics.sessionMs, 100);
  assert.equal(tickIndex, ticks.length);
  assert.deepEqual(
    observed.filter((event) => event.type.startsWith("tool_execution_")).map((event) => event.type),
    ["tool_execution_start", "tool_execution_start", "tool_execution_end", "tool_execution_end"],
  );
});

test("hook-reported effective context remains authoritative when its length matches initial history", async () => {
  const config = baseConfig({ contextCompactionEnabled: false });
  const initialMessages: AgentMessage[] = [
    { role: "user", content: "discarded one", timestamp: 0 },
    assistantText("discarded two"),
    { role: "user", content: "discarded three", timestamp: 1 },
  ];
  const final = assistantText("done");
  const effectiveMessages: AgentMessage[] = [
    { role: "compactionSummary", summary: "effective summary", tokensBefore: 100, timestamp: 2 },
    { role: "user", content: "retained constraint", timestamp: 3 },
    final,
  ];
  const bindings = bindingsWith(async (prompts, context, loopConfig, emit) => {
    await emit({ type: "turn_start" });
    await emit({ type: "turn_end", message: final, toolResults: [] });
    await loopConfig.shouldStopAfterTurn?.({
      message: final,
      toolResults: [],
      context: { ...context, messages: effectiveMessages },
      newMessages: [...prompts, final],
    });
    return [...prompts, final];
  });
  const result = await runPiSession({
    bindings,
    model: createModel(config),
    requestOptions: createRequestOptions(config),
    config,
    systemPrompt: "system",
    promptText: "prompt",
    tools: [readTool],
    initialMessages,
  });

  assert.deepEqual(result.contextMessages, effectiveMessages);
  assert.equal(result.contextMessages.some((message) => message === initialMessages[0]), false);
});

test("budget hooks block excess calls and force a no-tool final turn", async () => {
  const config = baseConfig({ maxTurns: 3, maxToolCalls: 2 });
  let snapshot: AgentLoopTurnUpdate | undefined;
  const final = assistantText("done");
  const bindings = bindingsWith(async (prompts, context, loopConfig, emit) => {
    await emit({ type: "turn_start" });
    assert.equal(await loopConfig.beforeToolCall?.({
      assistantMessage: final,
      toolCall: { type: "toolCall", id: "1", name: "read", arguments: {} },
      args: {},
      context,
    }), undefined);
    assert.equal(await loopConfig.beforeToolCall?.({
      assistantMessage: final,
      toolCall: { type: "toolCall", id: "2", name: "read", arguments: {} },
      args: {},
      context,
    }), undefined);
    const blocked = await loopConfig.beforeToolCall?.({
      assistantMessage: final,
      toolCall: { type: "toolCall", id: "3", name: "read", arguments: {} },
      args: {},
      context,
    });
    assert.equal(blocked?.block, true);
    snapshot = await loopConfig.prepareNextTurn?.({
      message: final,
      context: { ...context, messages: [...prompts] },
      newMessages: [...prompts],
      toolResults: [toolResult],
    });
    await emit({ type: "turn_end", message: final, toolResults: [] });
    return [...prompts, final];
  });
  const result = await runPiSession({
    bindings,
    model: createModel(config),
    requestOptions: createRequestOptions(config),
    config,
    systemPrompt: "system",
    promptText: "prompt",
    tools: [readTool],
  });
  assert.ok(snapshot?.context);
  assert.deepEqual(snapshot.context.tools, []);
  const last = snapshot.context.messages.at(-1);
  assert.equal(last?.role, "user");
  assert.match(typeof last?.content === "string" ? last.content : "", /budget is exhausted/u);
  assert.match(typeof last?.content === "string" ? last.content : "", /at most 12 strong citations/u);
  assert.match(typeof last?.content === "string" ? last.content : "", /closing <\/final_answer> tag/u);
  assert.equal(result.metrics.toolCalls, 3);
  assert.equal(result.metrics.finalizationInjected, true);
});

test("provider errors redact configured secrets", async () => {
  const config = baseConfig();
  const errorMessage = assistantText("", {
    stopReason: "error",
    errorMessage: `authorization failed for ${config.apiKey}`,
  });
  const bindings = bindingsWith(async (prompts, _context, _loopConfig, emit) => {
    await emit({ type: "turn_start" });
    return [...prompts, errorMessage];
  });
  await assert.rejects(
    () => runPiSession({
      bindings,
      model: createModel(config),
      requestOptions: createRequestOptions(config),
      config,
      systemPrompt: "system",
      promptText: "prompt",
      tools: [],
    }),
    (error) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.message.includes(config.apiKey), false);
      assert.match(error.message, /<redacted>/u);
      return true;
    },
  );
});

test("provider errors retain private HTTP status and statusless connection category", async () => {
  const config = baseConfig({ providerRetryMaxRetries: 0 });
  const cases = [
    {
      bindings: bindingsWith(async () => {
        throw Object.assign(new Error("service unavailable"), { status: 503 });
      }),
      category: "server_error",
      statusCode: 503,
    },
    {
      bindings: bindingsWith(async (prompts, _context, _loopConfig, emit) => {
        const failure = assistantText("", { stopReason: "error", errorMessage: "Connection error." });
        await emit({ type: "turn_start" });
        return [...prompts, failure];
      }),
      category: "connection",
      statusCode: undefined,
    },
  ] as const;

  for (const fixture of cases) {
    await assert.rejects(
      () => runPiSession({
        bindings: fixture.bindings,
        model: createModel(config),
        requestOptions: createRequestOptions(config),
        config,
        systemPrompt: "system",
        promptText: "prompt",
        tools: [],
      }),
      (error) => {
        assert.ok(error instanceof ProviderError);
        assert.equal(error.category, fixture.category);
        assert.equal(error.statusCode, fixture.statusCode);
        assert.equal(error.safeToFallback, true);
        return true;
      },
    );
  }
});

test("transient provider failures retry the assistant turn without discarding completed tool results", async () => {
  const config = baseConfig({ providerRetryMaxRetries: 3, providerRetryBaseDelayMs: 1 });
  const busy = assistantText("", {
    stopReason: "error",
    errorMessage: '{"code":"SERVICE_BUSY","message":"服务繁忙，请稍后重试"}',
  });
  const success = assistantText("recovered");
  const observed: FreeContextRuntimeEvent[] = [];
  let continuationCalls = 0;
  let toolExecutions = 0;
  let continuationContext: AgentContext | undefined;
  const bindings = fakeBindings(async (prompts, context, loopConfig, emit) => {
    await emit({ type: "turn_start" });
    toolExecutions += 1;
    await emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: {} });
    await emit({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "read",
      result: { content: [], details: {} },
      isError: false,
    });
    await emit({ type: "turn_end", message: busy, toolResults: [toolResult] });
    await loopConfig.shouldStopAfterTurn?.({
      message: busy,
      toolResults: [toolResult],
      context: { ...context, messages: [...context.messages, ...prompts, toolResult, busy] },
      newMessages: [...prompts, toolResult, busy],
    });
    return [...prompts, toolResult, busy];
  }, {
    runAgentLoopContinue: async (context, _loopConfig, emit) => {
      continuationCalls += 1;
      continuationContext = context;
      await emit({ type: "turn_start" });
      await emit({ type: "turn_end", message: success, toolResults: [] });
      return [success];
    },
  });

  const result = await runPiSession({
    bindings,
    model: createModel(config),
    requestOptions: createRequestOptions(config),
    config,
    systemPrompt: "system",
    promptText: "prompt",
    tools: [readTool],
    onEvent: (event) => { observed.push(event); },
  });

  assert.equal(result.text, "recovered");
  assert.equal(continuationCalls, 1);
  assert.equal(toolExecutions, 1);
  assert.equal(continuationContext?.messages.includes(toolResult), true);
  assert.equal(continuationContext?.messages.includes(busy), false);
  assert.equal(result.metrics.providerAttempts, 2);
  assert.equal(result.metrics.providerRetries, 1);
  assert.equal(result.metrics.turns, 1);
  assert.deepEqual(
    observed.filter((event) => event.type.startsWith("provider_retry")).map((event) => event.type),
    ["provider_retry_scheduled", "provider_retry_start"],
  );
});

test("a short session never calls the summary transport", async () => {
  const config = baseConfig();
  let summaryCalls = 0;
  const summaryTransport: StreamFn = () => {
    summaryCalls += 1;
    const stream = createAssistantMessageEventStream();
    stream.end(assistantText("summary"));
    return stream;
  };
  const final = assistantText("done");
  const bindings = fakeBindings(async (prompts, _context, _loopConfig, emit) => {
    await emit({ type: "turn_start" });
    await emit({ type: "turn_end", message: final, toolResults: [] });
    return [...prompts, final];
  }, { streamSimple: summaryTransport });
  const result = await runPiSession({
    bindings,
    model: createModel(config),
    requestOptions: createRequestOptions(config),
    config,
    systemPrompt: "system",
    promptText: "prompt",
    tools: [],
  });
  assert.equal(summaryCalls, 0);
  assert.equal(result.metrics.compactions, 0);
});

test("prepareNextTurn compacts older history and preserves two recent tool cycles", async () => {
  const config = baseConfig({
    contextWindow: 1200,
    contextReserveTokens: 400,
    contextKeepRecentTokens: 180,
    maxOutputTokens: 200,
  });
  let summaryCalls = 0;
  const summaryTransport: StreamFn = () => {
    summaryCalls += 1;
    const stream = createAssistantMessageEventStream();
    stream.end(assistantText("request constraints and verified paths retained"));
    return stream;
  };
  const firstAssistant = assistantText("", {
    content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/a.ts" } }],
    stopReason: "toolUse",
    usage: {
      input: 900,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      totalTokens: 920,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });
  const firstResult = {
    ...toolResult,
    content: [{ type: "text" as const, text: `first evidence ${"a".repeat(400)}` }],
  };
  const secondAssistant = assistantText("", {
    content: [{ type: "toolCall", id: "call-2", name: "read", arguments: { path: "src/b.ts" } }],
    stopReason: "toolUse",
  });
  const secondResult = {
    ...toolResult,
    toolCallId: "call-2",
    content: [{ type: "text" as const, text: "second evidence" }],
  };
  const final = assistantText("done");
  let retainedContext: AgentContext | undefined;
  const events: FreeContextRuntimeEvent[] = [];
  const bindings = fakeBindings(async (prompts, context, loopConfig, emit) => {
    const firstContext = {
      ...context,
      messages: [
        ...prompts,
        {
          role: "user" as const,
          content: `older request ${Array.from({ length: 1000 }, (_, index) => `word${index}`).join(" ")}`,
          timestamp: 1,
        },
        firstAssistant,
        firstResult,
        { role: "user" as const, content: "keep first cycle", timestamp: 2 },
      ],
    };
    await emit({ type: "turn_start" });
    await emit({ type: "turn_end", message: firstAssistant, toolResults: [firstResult] });
    const firstUpdate = await loopConfig.prepareNextTurn?.({
      message: firstAssistant,
      toolResults: [firstResult],
      context: firstContext,
      newMessages: [...firstContext.messages],
    });
    const compacted = firstUpdate?.context ?? firstContext;
    const secondContext = {
      ...compacted,
      messages: [...compacted.messages, secondAssistant, secondResult, { role: "user" as const, content: "latest", timestamp: 3 }],
    };
    await emit({ type: "turn_start" });
    await emit({ type: "turn_end", message: secondAssistant, toolResults: [secondResult] });
    const secondUpdate = await loopConfig.prepareNextTurn?.({
      message: secondAssistant,
      toolResults: [secondResult],
      context: secondContext,
      newMessages: [...secondContext.messages],
    });
    retainedContext = secondUpdate?.context ?? secondContext;
    await emit({ type: "turn_start" });
    await emit({ type: "turn_end", message: final, toolResults: [] });
    return [...prompts, final];
  }, { streamSimple: summaryTransport });
  const result = await runPiSession({
    bindings,
    model: createModel(config),
    requestOptions: createRequestOptions(config),
    config,
    systemPrompt: "system",
    promptText: "prompt",
    tools: [readTool],
    onEvent: (event) => { events.push(event); },
  });

  assert.ok(retainedContext);
  assert.equal(summaryCalls, 1);
  assert.equal(retainedContext.messages[0]?.role, "compactionSummary");
  assert.ok(retainedContext.messages.includes(firstAssistant));
  assert.ok(retainedContext.messages.includes(firstResult));
  assert.ok(retainedContext.messages.includes(secondAssistant));
  assert.ok(retainedContext.messages.includes(secondResult));
  assert.equal(result.metrics.compactions, 1);
  assert.equal(result.metrics.thresholdCompactions, 1);
  assert.equal(result.metrics.overflowCompactions, 0);
  assert.ok(events.some((event) => event.type === "compaction_start"));
  assert.ok(events.some((event) => event.type === "compaction_end"));
});

function overflowMessage(text = "request exceeds the context window") {
  return assistantText("", { stopReason: "error", errorMessage: text });
}

function compressibleHistory(): AgentMessage[] {
  return [
    { role: "user", content: `old evidence ${"x".repeat(800)}`, timestamp: 0 },
    assistantText("old finding", {
      usage: {
        input: 900,
        output: 20,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
        totalTokens: 920,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    }),
    { role: "user", content: "recent constraint", timestamp: 1 },
  ];
}

test("a recognized overflow compacts once and continues with the same budgets and signal", async () => {
  const config = baseConfig({ maxToolCalls: 1, contextKeepRecentTokens: 10 });
  const overflow = overflowMessage();
  const success = assistantText("recovered");
  const controller = new AbortController();
  let initialConfig: AgentLoopConfig | undefined;
  let continuedConfig: AgentLoopConfig | undefined;
  let initialSignal: AbortSignal | undefined;
  let continuedSignal: AbortSignal | undefined;
  let continuationCalls = 0;
  let continuationContext: AgentContext | undefined;
  const events: FreeContextRuntimeEvent[] = [];

  const bindings = fakeBindings(
    async (prompts, context, loopConfig, emit, signal) => {
      initialConfig = loopConfig;
      initialSignal = signal;
      const allowed = await loopConfig.beforeToolCall?.({
        assistantMessage: success,
        toolCall: { type: "toolCall", id: "before-overflow", name: "read", arguments: {} },
        args: {},
        context,
      });
      assert.equal(allowed, undefined);
      await emit({ type: "turn_start" });
      await emit({ type: "turn_end", message: overflow, toolResults: [] });
      await loopConfig.shouldStopAfterTurn?.({
        message: overflow,
        toolResults: [],
        context: { ...context, messages: [...context.messages, ...prompts, { ...overflow }] },
        newMessages: [...prompts, overflow],
      });
      return [...prompts, overflow];
    },
    {
      runAgentLoopContinue: async (context, loopConfig, emit, signal) => {
        continuationCalls += 1;
        continuationContext = context;
        continuedConfig = loopConfig;
        continuedSignal = signal;
        const blocked = await loopConfig.beforeToolCall?.({
          assistantMessage: success,
          toolCall: { type: "toolCall", id: "after-overflow", name: "read", arguments: {} },
          args: {},
          context,
        });
        assert.equal(blocked?.block, true);
        await emit({ type: "turn_start" });
        await emit({ type: "turn_end", message: success, toolResults: [] });
        return [success];
      },
    },
  );
  const result = await runPiSession({
    bindings,
    model: createModel(config),
    requestOptions: createRequestOptions(config),
    config,
    systemPrompt: "system",
    promptText: "prompt",
    tools: [readTool],
    initialMessages: compressibleHistory(),
    signal: controller.signal,
    onEvent: (event) => { events.push(event); },
  });

  assert.equal(result.text, "recovered");
  assert.equal(continuationCalls, 1);
  assert.equal(continuedConfig, initialConfig);
  assert.equal(initialSignal, controller.signal);
  assert.equal(continuedSignal, controller.signal);
  assert.equal(continuationContext?.systemPrompt, "system");
  assert.deepEqual(continuationContext?.tools, [readTool]);
  assert.equal(continuationContext?.messages.some((message) => message === overflow), false);
  assert.equal(
    continuationContext?.messages.some(
      (message) => message.role === "assistant" && bindings.isContextOverflow(message, config.contextWindow),
    ),
    false,
  );
  assert.equal(continuationContext?.messages[0]?.role, "compactionSummary");
  assert.equal(result.metrics.providerAttempts, 2);
  assert.equal(result.metrics.turns, 1);
  assert.equal(result.metrics.toolCalls, 2);
  assert.equal(result.metrics.overflowCompactions, 1);
  assert.equal(result.metrics.overflowRetries, 1);
  assert.ok(events.some((event) => event.type === "overflow_retry"));
});

test("a second overflow fails after exactly one continuation", async () => {
  const config = baseConfig({ contextKeepRecentTokens: 10 });
  let continuationCalls = 0;
  const first = overflowMessage("prompt exceeds the context window");
  const second = overflowMessage("request exceeds model's maximum context length");
  const bindings = fakeBindings(async (prompts, _context, _loopConfig, emit) => {
    await emit({ type: "turn_start" });
    await emit({ type: "turn_end", message: first, toolResults: [] });
    return [...prompts, first];
  }, {
    runAgentLoopContinue: async (_context, _loopConfig, emit) => {
      continuationCalls += 1;
      await emit({ type: "turn_start" });
      await emit({ type: "turn_end", message: second, toolResults: [] });
      return [second];
    },
  });
  await assert.rejects(
    () => runPiSession({
      bindings,
      model: createModel(config),
      requestOptions: createRequestOptions(config),
      config,
      systemPrompt: "system",
      promptText: "prompt",
      tools: [],
      initialMessages: compressibleHistory(),
    }),
    ProviderError,
  );
  assert.equal(continuationCalls, 1);
});

for (const [name, error, config] of [
  ["disabled compaction", overflowMessage(), baseConfig({ contextCompactionEnabled: false })],
  ["a generic provider error", assistantText("", { stopReason: "error", errorMessage: "authentication failed" }), baseConfig()],
  ["an aborted provider response", assistantText("", { stopReason: "aborted", errorMessage: "aborted" }), baseConfig()],
] as const) {
  test(`${name} never enters overflow continuation`, async () => {
    let continuationCalls = 0;
    const bindings = fakeBindings(async (prompts, _context, _loopConfig, emit) => {
      await emit({ type: "turn_start" });
      await emit({ type: "turn_end", message: error, toolResults: [] });
      return [...prompts, error];
    }, {
      runAgentLoopContinue: async () => {
        continuationCalls += 1;
        return [];
      },
    });
    await assert.rejects(
      () => runPiSession({
        bindings,
        model: createModel(config),
        requestOptions: createRequestOptions(config),
        config,
        systemPrompt: "system",
        promptText: "prompt",
        tools: [],
        initialMessages: compressibleHistory(),
      }),
      ProviderError,
    );
    assert.equal(continuationCalls, 0);
  });
}

test("overflow without a compressible span fails before continuation", async () => {
  const config = baseConfig({ contextKeepRecentTokens: 10 });
  let continuationCalls = 0;
  const overflow = overflowMessage();
  const bindings = fakeBindings(async (prompts, _context, _loopConfig, emit) => {
    await emit({ type: "turn_start" });
    await emit({ type: "turn_end", message: overflow, toolResults: [] });
    return [...prompts, overflow];
  }, {
    runAgentLoopContinue: async () => {
      continuationCalls += 1;
      return [];
    },
  });
  await assert.rejects(
    () => runPiSession({
      bindings,
      model: createModel(config),
      requestOptions: createRequestOptions(config),
      config,
      systemPrompt: "system",
      promptText: "prompt",
      tools: [],
    }),
    ContextBudgetError,
  );
  assert.equal(continuationCalls, 0);
});
