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
import { runAgentLoop } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, Type } from "@earendil-works/pi-ai";
import { ContextBudgetError, ProviderError } from "../src/errors.js";
import type { FreeContextEvidence, FreeContextResult } from "../src/mcp/contracts.js";
import { createModel, createRequestOptions } from "../src/runtime/model.js";
import type { PiBindings } from "../src/runtime/pi-bindings.js";
import type { FreeContextRuntimeEvent, PiSessionOptions } from "../src/runtime/pi-session.js";
import type { ExplorerCandidate } from "../src/output/candidate.js";
import { runIsolatedFinalizer, runPiSession as runPiSessionBase } from "../src/runtime/pi-session.js";
import { assistantText, baseConfig, baseRequest, fakeBindings } from "./helpers.js";

function bindingsWith(handler: PiBindings["runAgentLoop"]): PiBindings {
  return fakeBindings(handler);
}

const tokenCounter = {
  countBatch: async (texts: readonly string[]) => texts.map((text) => Math.ceil(text.length / 4)),
};

type TestPiSessionOptions = Omit<PiSessionOptions, "finalizationRequest" | "tokenCounter"> &
  Partial<Pick<PiSessionOptions, "finalizationRequest">>;

function evaluateFixture(candidate: Readonly<ExplorerCandidate>): Readonly<FreeContextResult> {
  const first = candidate.evidence[0];
  const evidence: FreeContextEvidence[] = candidate.evidence.map((item, index) => ({
    ...item,
    id: `e${index + 1}`,
    role: item.role as FreeContextEvidence["role"],
  }));
  if (!first) {
    return {
      status: "not_found",
      summary: candidate.summary,
      evidence: [],
      gaps: [...candidate.gaps],
      nextAction: {
        kind: "exact_probe",
        reason: "Continue the fixture exploration.",
        recovery: {
          requestKind: "not_found_recovery",
          priorSessionId: "test-session",
          workUnit: baseRequest().workUnit,
          requiredProbe: "exact_probe",
        },
      },
      errorCode: null,
      sessionId: "test-session",
      sessionFile: null,
    };
  }
  return {
    status: candidate.gaps.length === 0 ? "ready" : "partial",
    summary: candidate.summary,
    evidence,
    gaps: [...candidate.gaps],
    handoff: {
      id: "handoff:test-session",
      workUnit: baseRequest().workUnit,
      evidenceIds: evidence.flatMap((item) => item.id ? [item.id] : []),
      outcome: { kind: baseRequest().workUnit.outcome, instruction: "Use the fixture Evidence." },
      blockingGaps: candidate.gaps.map((gap, index) => ({
        id: `gap:fixture-${index + 1}`,
        targetId: gap.targetId ?? `fixture-${index + 1}`,
        kind: "source_unknown" as const,
        scope: { kind: "topic" as const, topic: gap.reason },
        requiredFact: gap.reason,
      })),
    },
    nextAction: {
      kind: "consume_evidence",
      reason: "Continue the fixture exploration.",
    },
    errorCode: null,
    sessionId: "test-session",
    sessionFile: "/tmp/test-session.json",
  };
}

const runPiSession = (options: TestPiSessionOptions) => runPiSessionBase({
  ...options,
  candidateEvaluator: options.candidateEvaluator ?? (async (candidate) => evaluateFixture(candidate)),
  finalizationRequest: options.finalizationRequest ?? baseRequest(),
  tokenCounter,
});

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

const observedReadResult = {
  content: [{ type: "text" as const, text: "[read src/index.ts:1-3]\n1 export const entry = true;" }],
  details: {
    tool: "read" as const,
    path: "src/index.ts",
    startLine: 1,
    requestedEndLine: 3,
    actualEndLine: 3,
    text: "1 export const entry = true;",
    empty: false,
    truncated: false,
  },
};

function submissionMessage(includeRequiredTests = false) {
  return assistantText("", {
    content: [{
      type: "toolCall" as const,
      id: "submit-1",
      name: "submit_evidence",
      arguments: {
        summary: "Implementation found.",
        evidence: [{
          question_id: "impl",
          path: "src/index.ts",
          start_line: 1,
          end_line: 3,
          focus_line: 2,
          why: "Defines the entry point.",
        }],
        gaps: includeRequiredTests ? [{ question_id: "tests", reason: "No test evidence was found." }] : [],
      },
    }],
  });
}

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
  const config = baseConfig({ maxTurns: 5, maxToolCalls: 18 });
  let snapshot: AgentLoopTurnUpdate | undefined;
  const final = assistantText("done");
  const bindings = bindingsWith(async (prompts, context, loopConfig, emit) => {
    await emit({ type: "turn_start" });
    for (let call = 1; call <= 18; call += 1) {
      assert.equal(await loopConfig.beforeToolCall?.({
        assistantMessage: final,
        toolCall: { type: "toolCall", id: String(call), name: "read", arguments: {} },
        args: {},
        context,
      }), undefined);
    }
    const blocked = await loopConfig.beforeToolCall?.({
      assistantMessage: final,
      toolCall: { type: "toolCall", id: "19", name: "read", arguments: {} },
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
  assert.deepEqual(snapshot.context.tools?.map((tool) => tool.name), ["submit_evidence"]);
  assert.equal(snapshot.context.systemPrompt.includes("untrusted data"), true);
  const last = snapshot.context.messages.at(-1);
  assert.equal(last?.role, "user");
  const packet = JSON.parse(typeof last?.content === "string" ? last.content : "{}") as Record<string, unknown>;
  assert.equal(packet.task, baseRequest().taskText);
  assert.deepEqual(packet.repositoryObservations, []);
  assert.equal(result.metrics.toolCalls, 18);
  assert.equal(result.metrics.blockedToolCalls, 1);
  assert.equal(result.metrics.finalizationInjected, true);
  assert.equal(result.metrics.finalizationReason, "tool_limit");
});

test("a sole valid typed submission ends exploration before the turn limit", async () => {
  const config = baseConfig();
  const submittedMessage = submissionMessage();
  const submittedCall = submittedMessage.content[0];
  if (submittedCall?.type !== "toolCall") throw new Error("missing submit call");
  const final = {
    ...submittedMessage,
    content: [
      { type: "thinking" as const, thinking: "private analysis is ignored" },
      { type: "text" as const, text: "visible text is audit-only" },
      submittedCall,
    ],
  };
  let shouldStop = false;
  const bindings = bindingsWith(async (prompts, context, loopConfig, emit) => {
    await emit({ type: "turn_start" });
    await emit({ type: "tool_execution_end", toolCallId: "read-1", toolName: "read", result: observedReadResult, isError: false });
    const submit = context.tools?.find((tool) => tool.name === "submit_evidence");
    assert.ok(submit);
    const call = final.content.find((block) => block.type === "toolCall");
    if (!call) throw new Error("missing submit call");
    assert.equal(await loopConfig.beforeToolCall?.({ assistantMessage: final, toolCall: call, args: call.arguments, context }), undefined);
    const submitted = await submit.execute(call.id, call.arguments);
    await emit({ type: "tool_execution_end", toolCallId: call.id, toolName: call.name, result: submitted, isError: false });
    await emit({ type: "turn_end", message: final, toolResults: [] });
    shouldStop = await loopConfig.shouldStopAfterTurn?.({
      message: final,
      toolResults: [],
      context: { ...context, messages: [...prompts, final] },
      newMessages: [...prompts, final],
    }) ?? false;
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

  assert.equal(shouldStop, true);
  assert.equal(result.metrics.turns, 1);
  assert.equal(result.metrics.finalizationReason, "coverage");
  assert.deepEqual(result.metrics.terminalFailureDetails, []);
  assert.equal(result.terminalFailure, null);
  assert.equal(result.candidate?.summary, "Implementation found.");
});

test("runIsolatedFinalizer starts with the production finalizer and no exploration turn", async () => {
  const config = baseConfig();
  const final = submissionMessage();
  let initialCalls = 0;
  let continuationCalls = 0;
  const bindings = fakeBindings(async (prompts, context, loopConfig, emit) => {
    initialCalls += 1;
    assert.deepEqual(context.tools?.map((tool) => tool.name), ["submit_evidence"]);
    assert.equal(context.systemPrompt.includes("untrusted data"), true);
    assert.deepEqual(context.messages, []);
    const prompt = prompts[0];
    assert.equal(prompt?.role, "user");
    const packet = JSON.parse(prompt?.role === "user" && typeof prompt.content === "string" ? prompt.content : "{}") as {
      readonly repositoryObservations?: readonly unknown[];
    };
    assert.equal(packet.repositoryObservations?.length, 1);

    await emit({ type: "turn_start" });
    const submit = context.tools?.[0];
    const call = final.content[0];
    assert.ok(submit && call?.type === "toolCall");
    assert.equal(await loopConfig.beforeToolCall?.({ assistantMessage: final, toolCall: call, args: call.arguments, context }), undefined);
    const submitted = await submit.execute(call.id, call.arguments);
    await emit({ type: "tool_execution_end", toolCallId: call.id, toolName: call.name, result: submitted, isError: false });
    await emit({ type: "turn_end", message: final, toolResults: [] });
    return [...prompts, final];
  }, {
    runAgentLoopContinue: async () => {
      continuationCalls += 1;
      return [];
    },
  });

  const result = await runIsolatedFinalizer({
    bindings,
    model: createModel(config),
    requestOptions: createRequestOptions(config),
    config,
    request: baseRequest(),
    observedReads: [{
      tool: "read",
      path: "src/index.ts",
      startLine: 1,
      endLine: 3,
      content: "1 export const entry = true;",
    }],
    tokenCounter,
  });

  assert.equal(initialCalls, 1);
  assert.equal(continuationCalls, 0);
  assert.equal(result.candidate?.summary, "Implementation found.");
  assert.equal(result.terminalFailure, null);
  assert.deepEqual(result.explorationTools, []);
  assert.deepEqual(result.contextTools.map((tool) => tool.name), ["submit_evidence"]);
  assert.equal(result.metrics.turns, 1);
  assert.equal(result.metrics.toolCalls, 0);
  assert.equal(result.metrics.providerAttempts, 1);
  assert.equal(result.metrics.finalizationInjected, true);
  assert.equal(result.metrics.finalizationReason, "provider_probe");
});

test("runIsolatedFinalizer rejects an oversized packet before a provider request", async () => {
  const config = baseConfig({ contextWindow: 2_000, contextReserveTokens: 1_000 });
  let providerCalls = 0;
  const bindings = bindingsWith(async () => {
    providerCalls += 1;
    return [];
  });
  await assert.rejects(runIsolatedFinalizer({
    bindings,
    model: createModel(config),
    requestOptions: createRequestOptions(config),
    config,
    request: baseRequest(),
    observedReads: [{
      tool: "read",
      path: "large.ts",
      startLine: 1,
      endLine: 1,
      content: "x".repeat(8_000),
    }],
    tokenCounter,
  }), ContextBudgetError);
  assert.equal(providerCalls, 0);
});

test("a partial submission feeds canonical gaps back into the same Pi session", async () => {
  const config = baseConfig();
  const responses = [
    assistantText("", {
      stopReason: "toolUse",
      content: [{ type: "toolCall" as const, id: "read-1", name: "read", arguments: {} }],
    }),
    submissionMessage(true),
    submissionMessage(false),
  ];
  let responseIndex = 0;
  const observedReadTool: AgentTool = {
    ...readTool,
    execute: async () => observedReadResult,
  };
  const bindings = fakeBindings(runAgentLoop, {
    streamSimple: () => {
      const stream = createAssistantMessageEventStream();
      stream.end(responses[responseIndex++] ?? assistantText("unexpected response"));
      return stream;
    },
  });
  const result = await runPiSession({
    bindings,
    model: createModel(config),
    requestOptions: createRequestOptions(config),
    config,
    systemPrompt: "system",
    promptText: "prompt",
    tools: [observedReadTool],
  });

  assert.equal(responseIndex, 3);
  assert.match(JSON.stringify(result.messages), /Status: partial/u);
  assert.match(JSON.stringify(result.messages), /\[tests\]/u);
  assert.match(JSON.stringify(result.messages), /same Pi exploration session/u);
  assert.match(JSON.stringify(result.messages), /Do not call gather_context/u);
  assert.equal(result.metrics.turns, 3);
  assert.equal(result.metrics.finalizationReason, "coverage");
  assert.equal(result.canonicalResult?.status, "ready");
});

test("mixed and duplicate submit batches are blocked before repository effects", async () => {
  const submitCall = submissionMessage().content[0];
  if (submitCall?.type !== "toolCall") throw new Error("missing submit fixture");
  for (const [expected, names] of [
    ["mixed_batch", ["read", "submit_evidence"]],
    ["duplicate_submit", ["submit_evidence", "submit_evidence"]],
  ] as const) {
    const message = assistantText("", {
      content: names.map((name, index) => ({
        type: "toolCall" as const,
        id: `${name}-${index}`,
        name,
        arguments: name === "submit_evidence" ? submitCall.arguments : {},
      })),
    });
    const blocked: boolean[] = [];
    const bindings = bindingsWith(async (prompts, context, loopConfig, emit) => {
      await emit({ type: "turn_start" });
      for (const call of message.content) {
        if (call.type !== "toolCall") continue;
        const decision = await loopConfig.beforeToolCall?.({ assistantMessage: message, toolCall: call, args: call.arguments, context });
        blocked.push(decision?.block === true);
      }
      await emit({ type: "turn_end", message, toolResults: [] });
      const update = await loopConfig.prepareNextTurn?.({
        message,
        toolResults: [],
        context: { ...context, messages: [...prompts, message] },
        newMessages: [...prompts, message],
      });
      await loopConfig.shouldStopAfterTurn?.({
        message,
        toolResults: [],
        context: update?.context ?? context,
        newMessages: [...prompts, message],
      });
      return [...prompts, message];
    });
    const result = await runPiSession({
      bindings,
      model: createModel(baseConfig()),
      requestOptions: createRequestOptions(baseConfig()),
      config: baseConfig(),
      systemPrompt: "system",
      promptText: "prompt",
      tools: [readTool],
    });
    assert.deepEqual(blocked, [true, true], expected);
    assert.equal(result.metrics.toolCalls, 0, expected);
    assert.equal(result.metrics.finalizationReason, "protocol_retry", expected);
  }
});

test("an over-budget isolated packet fails before starting a finalizer request", async () => {
  const config = baseConfig({ maxTurns: 3, contextWindow: 5_000, contextReserveTokens: 1_000 });
  const response = assistantText("explored");
  const bindings = bindingsWith(async (prompts, context, loopConfig, emit) => {
    let activeContext: AgentContext = { ...context, messages: [...prompts] };
    for (let turn = 1; turn <= 2; turn += 1) {
      await emit({ type: "turn_start" });
      const completed = { ...activeContext, messages: [...activeContext.messages, response] };
      await emit({ type: "turn_end", message: response, toolResults: [] });
      const update = await loopConfig.prepareNextTurn?.({ message: response, toolResults: [], context: completed, newMessages: [response] });
      activeContext = update?.context ?? completed;
      await loopConfig.shouldStopAfterTurn?.({ message: response, toolResults: [], context: activeContext, newMessages: [response] });
    }
    return [...prompts, response];
  });
  const result = await runPiSession({
    bindings,
    model: createModel(config),
    requestOptions: createRequestOptions(config),
    config,
    systemPrompt: "system",
    promptText: "prompt",
    finalizationRequest: { ...baseRequest(), taskText: "x".repeat(16_000) },
    tools: [],
  });
  assert.equal(result.terminalFailure, "context_budget");
  assert.equal(result.metrics.providerAttempts, 2);
  assert.equal(result.metrics.finalizationInjected, false);
});

test("successive observed reads extend the soft budget while progress continues", async () => {
  const config = baseConfig();
  const rgTool: AgentTool = { ...readTool, name: "rg", label: "Search" };
  const batTool: AgentTool = { ...readTool, name: "bat", label: "Bat" };
  let thirdTurnTools: readonly string[] | undefined;
  const bindings = bindingsWith(async (prompts, context, loopConfig, emit) => {
    let activeContext: AgentContext = { ...context, messages: [...prompts] };
    for (let turn = 1; turn <= 7; turn += 1) {
      if (turn === 3) thirdTurnTools = activeContext.tools?.map((tool) => tool.name);
      const exploratory = assistantText("", {
        content: turn <= 6
          ? [{ type: "toolCall", id: `call-${turn}`, name: "read", arguments: { path: `src/file-${turn}.ts` } }]
          : [],
        stopReason: turn <= 6 ? "toolUse" : "stop",
      });
      await emit({ type: "turn_start" });
      const result = {
        ...toolResult,
        toolCallId: `call-${turn}`,
        content: [{ type: "text" as const, text: `src/file-${turn}.ts:1-2` }],
      };
      let blocked = false;
      if (turn <= 6) {
        const call = exploratory.content.find((block) => block.type === "toolCall");
        if (!call || call.type !== "toolCall") throw new Error("missing read call");
        blocked = (await loopConfig.beforeToolCall?.({
          assistantMessage: exploratory,
          toolCall: call,
          args: call.arguments,
          context: activeContext,
        }))?.block === true;
      }
      if (turn <= 6 && !blocked) {
        await emit({
          type: "tool_execution_end",
          toolCallId: `call-${turn}`,
          toolName: "read",
          result: {
            content: result.content,
            details: { tool: "read", path: `src/file-${turn}.ts`, startLine: 1, actualEndLine: 2, truncated: false },
          },
          isError: false,
        });
      }
      const completedContext = { ...activeContext, messages: [...activeContext.messages, exploratory, ...(turn <= 6 && !blocked ? [result] : [])] };
      await emit({ type: "turn_end", message: exploratory, toolResults: turn <= 6 && !blocked ? [result] : [] });
      const update = await loopConfig.prepareNextTurn?.({
        message: exploratory,
        context: completedContext,
        newMessages: turn <= 6 && !blocked ? [exploratory, result] : [exploratory],
        toolResults: turn <= 6 && !blocked ? [result] : [],
      });
      activeContext = update?.context ?? completedContext;
    }
    return [...prompts, assistantText("exploration complete")];
  });
  const result = await runPiSession({
    bindings,
    model: createModel(config),
    requestOptions: createRequestOptions(config),
    config,
    systemPrompt: "system",
    promptText: "Evidence questions:\n- [implementation][impl][required] Where is it implemented?\n- [test][tests][required] Where is it tested?",
    tools: [readTool, rgTool, batTool],
  });

  assert.deepEqual(thirdTurnTools, ["read", "rg", "bat", "submit_evidence"]);
  assert.equal(result.metrics.turns, 7);
  assert.equal(result.metrics.toolCalls, 6);
  assert.equal(result.metrics.finalizationInjected, false);
  assert.equal(result.metrics.finalizationReason, null);
  assert.equal(result.metrics.blockedToolCalls, 0);
  assert.equal(result.metrics.providerAttempts, result.metrics.turns);
  assert.equal(result.terminalFailure, "missing_submit");
});

test("canonical evidence progress extends beyond the soft budget", async () => {
  const config = baseConfig({ maxTurns: 1 });
  const responses = [
    assistantText("", {
      stopReason: "toolUse",
      content: [{ type: "toolCall" as const, id: "read-1", name: "read", arguments: {} }],
    }),
    submissionMessage(true),
    submissionMessage(true),
    submissionMessage(false),
  ];
  let responseIndex = 0;
  const observedReadTool: AgentTool = { ...readTool, execute: async () => observedReadResult };
  const bindings = fakeBindings(runAgentLoop, {
    streamSimple: () => {
      const stream = createAssistantMessageEventStream();
      stream.end(responses[responseIndex++] ?? assistantText("unexpected response"));
      return stream;
    },
  });
  const result = await runPiSession({
    bindings,
    model: createModel(config),
    requestOptions: createRequestOptions(config),
    config,
    systemPrompt: "system",
    promptText: "prompt",
    tools: [observedReadTool],
  });

  assert.equal(responseIndex, 4);
  assert.ok(result.metrics.turns > config.maxTurns + 2);
  assert.equal(result.metrics.finalizationReason, "coverage");
  assert.equal(result.canonicalResult?.status, "ready");
});

test("ordinary search output requires repeated no progress before soft-budget finalization", async () => {
  const config = baseConfig({ maxTurns: 1 });
  const rgTool: AgentTool = { ...readTool, name: "rg", label: "Search" };
  const allowed: boolean[] = [];
  let firstTools: readonly string[] | undefined;
  let secondTools: readonly string[] | undefined;
  const bindings = bindingsWith(async (prompts, context, loopConfig, emit) => {
    let activeContext: AgentContext = { ...context, messages: [...prompts] };
    for (let turn = 1; turn <= 2; turn += 1) {
      const id = `search-${turn}`;
      const exploratory = assistantText("", {
        content: [{ type: "toolCall", id, name: "rg", arguments: { pattern: `entry-${turn}` } }],
        stopReason: "toolUse",
      });
      const searchResult = { ...toolResult, toolCallId: id, toolName: "rg", content: [{ type: "text" as const, text: `src/index-${turn}.ts` }] };
      const call = exploratory.content[0];
      if (!call || call.type !== "toolCall") throw new Error("missing search call");
      await emit({ type: "turn_start" });
      allowed.push((await loopConfig.beforeToolCall?.({ assistantMessage: exploratory, toolCall: call, args: call.arguments, context: activeContext }))?.block !== true);
      await emit({ type: "tool_execution_end", toolCallId: id, toolName: "rg", result: { content: searchResult.content }, isError: false });
      const completedContext = { ...activeContext, messages: [...activeContext.messages, exploratory, searchResult] };
      await emit({ type: "turn_end", message: exploratory, toolResults: [searchResult] });
      const update = await loopConfig.prepareNextTurn?.({ message: exploratory, context: completedContext, newMessages: [exploratory, searchResult], toolResults: [searchResult] });
      activeContext = update?.context ?? completedContext;
      if (turn === 1) firstTools = activeContext.tools?.map((tool) => tool.name);
      else secondTools = activeContext.tools?.map((tool) => tool.name);
    }
    return [...activeContext.messages, assistantText("done")];
  });
  const result = await runPiSession({
    bindings,
    model: createModel(config),
    requestOptions: createRequestOptions(config),
    config,
    systemPrompt: "system",
    promptText: "prompt",
    tools: [rgTool],
  });

  assert.deepEqual(allowed, [true, true]);
  assert.deepEqual(firstTools, ["rg", "submit_evidence"]);
  assert.deepEqual(secondTools, ["submit_evidence"]);
  assert.equal(result.metrics.toolCalls, 2);
  assert.equal(result.metrics.finalizationInjected, true);
  assert.equal(result.metrics.finalizationReason, "stagnation");
});

test("knownRef-first blocks root search until an observed read exists", async () => {
  const config = baseConfig({ maxTurns: 3 });
  let decisions: Array<boolean | undefined> = [];
  const bindings = bindingsWith(async (_prompts, context, loopConfig, emit) => {
    type TestCall = { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };
    const rootCall: TestCall = { type: "toolCall", id: "root", name: "rg", arguments: { pattern: "entry" } };
    const rootGlobCall: TestCall = { type: "toolCall", id: "root-glob", name: "glob", arguments: { pattern: "**/*" } };
    const exactCall: TestCall = { type: "toolCall", id: "exact", name: "rg", arguments: { pattern: "entry", path: "src/index.ts" } };
    const deepParentCall: TestCall = { type: "toolCall", id: "deep-parent", name: "rg", arguments: { pattern: "entry", path: "src" } };
    const deepBoundedParentCall: TestCall = { type: "toolCall", id: "deep-bounded-parent", name: "rg", arguments: { pattern: "entry", path: "src/deep", literal: true, glob: ["*.ts"], max_results: 20 } };
    const deepGlobCall: TestCall = { type: "toolCall", id: "deep-glob", name: "glob", arguments: { pattern: ["**/*"], path: "src/deep" } };
    const deepBoundedGlobCall: TestCall = { type: "toolCall", id: "deep-bounded-glob", name: "glob", arguments: { pattern: ["*.ts"], path: "src/deep", max_results: 20 } };
    const readCall: TestCall = { type: "toolCall", id: "read", name: "read", arguments: { path: "src/index.ts" } };
    const rootAfterRead: TestCall = { type: "toolCall", id: "root-after", name: "rg", arguments: { pattern: "entry" } };
    const message = (call: TestCall) => assistantText("", { content: [call as never], stopReason: "toolUse" });
    decisions.push((await loopConfig.beforeToolCall?.({ assistantMessage: message(rootCall), toolCall: rootCall, args: rootCall.arguments, context }))?.block);
    decisions.push((await loopConfig.beforeToolCall?.({ assistantMessage: message(rootGlobCall), toolCall: rootGlobCall, args: rootGlobCall.arguments, context }))?.block);
    decisions.push((await loopConfig.beforeToolCall?.({ assistantMessage: message(exactCall), toolCall: exactCall, args: exactCall.arguments, context }))?.block);
    decisions.push((await loopConfig.beforeToolCall?.({ assistantMessage: message(deepParentCall), toolCall: deepParentCall, args: deepParentCall.arguments, context }))?.block);
    decisions.push((await loopConfig.beforeToolCall?.({ assistantMessage: message(deepBoundedParentCall), toolCall: deepBoundedParentCall, args: deepBoundedParentCall.arguments, context }))?.block);
    decisions.push((await loopConfig.beforeToolCall?.({ assistantMessage: message(deepGlobCall), toolCall: deepGlobCall, args: deepGlobCall.arguments, context }))?.block);
    decisions.push((await loopConfig.beforeToolCall?.({ assistantMessage: message(deepBoundedGlobCall), toolCall: deepBoundedGlobCall, args: deepBoundedGlobCall.arguments, context }))?.block);
    decisions.push((await loopConfig.beforeToolCall?.({ assistantMessage: message(readCall), toolCall: readCall, args: readCall.arguments, context }))?.block);
    await emit({ type: "tool_execution_end", toolCallId: "read", toolName: "read", result: observedReadResult, isError: false });
    decisions.push((await loopConfig.beforeToolCall?.({ assistantMessage: message(rootAfterRead), toolCall: rootAfterRead, args: rootAfterRead.arguments, context }))?.block);
    return [assistantText("done")];
  });
  await runPiSession({
    bindings,
    model: createModel(config),
    requestOptions: createRequestOptions(config),
    config,
    systemPrompt: "system",
    promptText: "prompt",
    tools: [readTool],
    finalizationRequest: {
      ...baseRequest(),
      knownRefs: [
        { kind: "path", path: "src/index.ts" },
        { kind: "path", path: "src/deep/file.ts" },
      ],
    },
  });
  assert.deepEqual(decisions.map((value) => value === true), [true, true, false, true, false, true, false, false, false]);
});

test("knownRef-first keeps pathless exact symbol probes available", async () => {
  const config = baseConfig({ maxTurns: 2 });
  let blocked: boolean | undefined;
  const bindings = bindingsWith(async (_prompts, context, loopConfig) => {
    const call = { type: "toolCall" as const, id: "symbol", name: "rg", arguments: { pattern: "entry", literal: true, max_results: 10 } };
    blocked = (await loopConfig.beforeToolCall?.({
      assistantMessage: assistantText("", { content: [call], stopReason: "toolUse" }),
      toolCall: call,
      args: call.arguments,
      context,
    }))?.block;
    return [assistantText("done")];
  });
  await runPiSession({
    bindings,
    model: createModel(config),
    requestOptions: createRequestOptions(config),
    config,
    systemPrompt: "system",
    promptText: "prompt",
    tools: [],
    finalizationRequest: { ...baseRequest(), knownRefs: [{ kind: "symbol", symbol: "entry" }] },
  });
  assert.notEqual(blocked, true);
});

test("a repeated no-progress search batch is blocked before execution and redirected to a read", async () => {
  const config = baseConfig();
  const searchMessage = (id: string) => assistantText("", {
    content: [{ type: "toolCall" as const, id, name: "rg", arguments: { pattern: "entry" } }],
    stopReason: "toolUse",
  });
  const responses = [
    searchMessage("search-1"),
    searchMessage("search-2"),
    searchMessage("search-3"),
    assistantText("", {
      content: [{ type: "toolCall" as const, id: "read-1", name: "read", arguments: {} }],
      stopReason: "toolUse",
    }),
    submissionMessage(),
  ];
  let responseIndex = 0;
  let searchExecutions = 0;
  let sawRecoveryFeedback = false;
  const rgTool: AgentTool = {
    name: "rg",
    label: "Search",
    description: "Search fixture",
    parameters: Type.Object({ pattern: Type.String() }),
    execute: async () => {
      searchExecutions += 1;
      return {
        content: [{ type: "text" as const, text: "[rg path=.]\nsrc/index.ts:1:export const entry = true;" }],
        details: { tool: "rg", pattern: "entry", path: ".", noMatches: false, truncated: false, exitCode: 0 },
      };
    },
  };
  const observedReadTool: AgentTool = { ...readTool, execute: async () => observedReadResult };
  const bindings = fakeBindings(runAgentLoop, {
    streamSimple: (_model, context) => {
      sawRecoveryFeedback ||= JSON.stringify(context.messages).includes("Read one already discovered candidate path");
      const stream = createAssistantMessageEventStream();
      stream.end(responses[responseIndex++] ?? assistantText("unexpected response"));
      return stream;
    },
  });
  const result = await runPiSession({
    bindings,
    model: createModel(config),
    requestOptions: createRequestOptions(config),
    config,
    systemPrompt: "system",
    promptText: "prompt",
    tools: [rgTool, observedReadTool],
  });

  assert.equal(responseIndex, 5);
  assert.equal(searchExecutions, 2);
  assert.equal(sawRecoveryFeedback, true);
  assert.equal(result.metrics.blockedToolCalls, 1);
  assert.equal(result.metrics.finalizationReason, "coverage");
  assert.equal(result.canonicalResult?.status, "ready");
});

test("a text-only turn receives continuation feedback before repeated stagnation finalization", async () => {
  const config = baseConfig();
  const exploratory = assistantText("No new evidence yet.");
  let finalContext: AgentContext | undefined;
  let firstContinuationContext: AgentContext | undefined;
  let firstFeedback: AgentMessage | undefined;
  const bindings = bindingsWith(async (prompts, context, loopConfig, emit) => {
    let activeContext: AgentContext = { ...context, messages: [...prompts] };
    for (let turn = 1; turn <= 2; turn += 1) {
      await emit({ type: "turn_start" });
      const update = await loopConfig.prepareNextTurn?.({
        message: exploratory,
        context: activeContext,
        newMessages: [exploratory],
        toolResults: [],
      });
      if (update?.context) activeContext = update.context;
      if (turn === 1) firstContinuationContext = activeContext;
      await emit({ type: "turn_end", message: exploratory, toolResults: [] });
      if (turn === 1) {
        const followUp = await loopConfig.getFollowUpMessages?.() ?? [];
        firstFeedback = followUp[0];
        activeContext = { ...activeContext, messages: [...activeContext.messages, ...followUp] };
      }
    }
    finalContext = activeContext;
    return [...prompts, exploratory];
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

  assert.deepEqual(firstContinuationContext?.tools?.map((tool) => tool.name), ["read", "submit_evidence"]);
  assert.equal(firstFeedback?.role, "user");
  assert.match(typeof firstFeedback?.content === "string" ? firstFeedback.content : "", /no repository tool call or evidence submission/iu);
  assert.deepEqual(finalContext?.tools?.map((tool) => tool.name), ["submit_evidence"]);
  assert.equal(result.metrics.finalizationInjected, true);
  assert.equal(result.metrics.finalizationReason, "stagnation");
  assert.deepEqual(result.metrics.evidenceProgress.map((progress) => progress.newKeys), [[], []]);
});

test("invalid finalizer arguments receive one bounded correction turn", async () => {
  const config = baseConfig({ maxTurns: 3 });
  const exploratory = assistantText("explored");
  const invalid = assistantText("", {
    content: [{ type: "toolCall", id: "submit-invalid", name: "submit_evidence", arguments: {} }],
  });
  const invalidResult = {
    ...toolResult,
    toolCallId: "submit-invalid",
    toolName: "submit_evidence",
    content: [{ type: "text" as const, text: "Validation failed for tool submit_evidence." }],
    isError: true,
  };
  const corrected = submissionMessage();
  const bindings = fakeBindings(
    async (prompts, context, loopConfig, emit) => {
      let activeContext: AgentContext = { ...context, messages: [...prompts] };
      for (let turn = 1; turn <= 2; turn += 1) {
        await emit({ type: "turn_start" });
        const completed = { ...activeContext, messages: [...activeContext.messages, exploratory] };
        await emit({ type: "turn_end", message: exploratory, toolResults: [] });
        const update = await loopConfig.prepareNextTurn?.({ message: exploratory, toolResults: [], context: completed, newMessages: [exploratory] });
        activeContext = update?.context ?? completed;
        await loopConfig.shouldStopAfterTurn?.({ message: exploratory, toolResults: [], context: activeContext, newMessages: [exploratory] });
      }
      return [...prompts, exploratory];
    },
    {
      runAgentLoopContinue: async (context, loopConfig, emit) => {
        let activeContext: AgentContext = { ...context, messages: [...context.messages] };
        await emit({ type: "turn_start" });
        await emit({ type: "turn_end", message: invalid, toolResults: [invalidResult] });
        const invalidContext = { ...activeContext, messages: [...activeContext.messages, invalid, invalidResult] };
        const invalidUpdate = await loopConfig.prepareNextTurn?.({ message: invalid, toolResults: [invalidResult], context: invalidContext, newMessages: [invalid, invalidResult] });
        activeContext = invalidUpdate?.context ?? invalidContext;
        assert.equal(await loopConfig.shouldStopAfterTurn?.({ message: invalid, toolResults: [invalidResult], context: activeContext, newMessages: [invalid, invalidResult] }), false);

        await emit({ type: "turn_start" });
        const submit = activeContext.tools?.[0];
        const call = corrected.content[0];
        assert.ok(submit && call?.type === "toolCall");
        const submitted = await submit.execute(call.id, call.arguments);
        const correctedResult = {
          ...toolResult,
          toolCallId: call.id,
          toolName: call.name,
          content: submitted.content,
          details: submitted.details,
          isError: false,
        };
        await emit({ type: "turn_end", message: corrected, toolResults: [correctedResult] });
        const correctedContext = { ...activeContext, messages: [...activeContext.messages, corrected, correctedResult] };
        const correctedUpdate = await loopConfig.prepareNextTurn?.({ message: corrected, toolResults: [correctedResult], context: correctedContext, newMessages: [corrected, correctedResult] });
        activeContext = correctedUpdate?.context ?? correctedContext;
        assert.equal(await loopConfig.shouldStopAfterTurn?.({ message: corrected, toolResults: [correctedResult], context: activeContext, newMessages: [corrected, correctedResult] }), true);
        return [invalid, invalidResult, corrected, correctedResult];
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
    tools: [],
  });
  assert.equal(result.terminalFailure, null);
  assert.deepEqual(result.metrics.terminalFailureDetails, []);
  assert.equal(result.metrics.providerAttempts, 4);
  assert.equal(result.candidate?.summary, "Implementation found.");
});

test("finalizer context overflow fails locally without compacting the isolated packet", async () => {
  const config = baseConfig({ maxTurns: 3 });
  const exploratory = assistantText("explored");
  const overflow = overflowMessage();
  const bindings = fakeBindings(
    async (prompts, context, loopConfig, emit) => {
      let activeContext: AgentContext = { ...context, messages: [...prompts] };
      for (let turn = 1; turn <= 2; turn += 1) {
        await emit({ type: "turn_start" });
        const completed = { ...activeContext, messages: [...activeContext.messages, exploratory] };
        await emit({ type: "turn_end", message: exploratory, toolResults: [] });
        const update = await loopConfig.prepareNextTurn?.({ message: exploratory, toolResults: [], context: completed, newMessages: [exploratory] });
        activeContext = update?.context ?? completed;
        await loopConfig.shouldStopAfterTurn?.({ message: exploratory, toolResults: [], context: activeContext, newMessages: [exploratory] });
      }
      return [...prompts, exploratory];
    },
    {
      runAgentLoopContinue: async (_context, _loopConfig, emit) => {
        await emit({ type: "turn_start" });
        await emit({ type: "turn_end", message: overflow, toolResults: [] });
        return [overflow];
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
    tools: [],
  });
  assert.equal(result.terminalFailure, "context_budget");
  assert.equal(result.metrics.providerAttempts, 3);
  assert.equal(result.metrics.compactions, 0);
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

test("provider errors retain private HTTP status and structured connection category", async () => {
  const config = baseConfig({ providerRetryDelaysMs: [] });
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
        const failure = assistantText("", { stopReason: "error", errorMessage: '{"code":"ECONNRESET"}' });
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

test("bare OpenAI 400 errors are provider failures outside Cerebras", async () => {
  const config = baseConfig({ provider: "tokenrhythm", baseUrl: "https://tokenrhythm.studio/v1", providerRetryDelaysMs: [] });
  const failure = assistantText("", { stopReason: "error", errorMessage: "400 status code (no body)" });
  const observed: FreeContextRuntimeEvent[] = [];
  const bindings = bindingsWith(async (prompts, _context, _loopConfig, emit) => {
    await emit({ type: "turn_start" });
    await emit({ type: "turn_end", message: failure, toolResults: [] });
    return [...prompts, failure];
  });

  await assert.rejects(
    () => runIsolatedFinalizer({
      bindings,
      model: createModel(config),
      requestOptions: createRequestOptions(config),
      config,
      request: baseRequest(),
      observedReads: [{
        tool: "read",
        path: "src/index.ts",
        startLine: 1,
        endLine: 1,
        content: "1 export const entry = true;",
      }],
      tokenCounter,
      onEvent: (event) => { observed.push(event); },
    }),
    (error) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.statusCode, 400);
      assert.equal(error.category, "other");
      return true;
    },
  );
  const failedAttempt = observed.find((event) => event.type === "provider_attempt_failed");
  assert.ok(failedAttempt && failedAttempt.scope === "primary");
  assert.equal(failedAttempt.failure.reason, "fatal_http_status");
  assert.equal(failedAttempt.willRetry, false);
});

test("bare Cerebras 400 errors retain Pi context-overflow semantics", async () => {
  const config = baseConfig({ provider: "cerebras", baseUrl: "https://api.cerebras.ai/v1" });
  const failure = assistantText("", { stopReason: "error", errorMessage: "400 status code (no body)" });
  const bindings = bindingsWith(async (prompts, _context, _loopConfig, emit) => {
    await emit({ type: "turn_start" });
    await emit({ type: "turn_end", message: failure, toolResults: [] });
    return [...prompts, failure];
  });
  const result = await runIsolatedFinalizer({
    bindings,
    model: createModel(config),
    requestOptions: createRequestOptions(config),
    config,
    request: baseRequest(),
    observedReads: [{
      tool: "read",
      path: "src/index.ts",
      startLine: 1,
      endLine: 1,
      content: "1 export const entry = true;",
    }],
    tokenCounter,
  });
  assert.equal(result.terminalFailure, "context_budget");
});

test("transient provider failures retry the assistant turn without discarding completed tool results", async () => {
  const config = baseConfig({ providerRetryDelaysMs: [1, 2, 4] });
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
  const failedAttempt = observed.find((event) => event.type === "provider_attempt_failed");
  assert.ok(failedAttempt && failedAttempt.scope === "primary");
  assert.equal(failedAttempt.willRetry, true);
  assert.equal(failedAttempt.failure.reason, "retryable_provider_code");
  assert.deepEqual(failedAttempt.usage, busy.usage);
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
  assert.deepEqual(continuationContext?.tools?.map((tool) => tool.name), ["read", "submit_evidence"]);
  assert.equal(continuationContext?.messages.some((message) => message === overflow), false);
  assert.equal(
    continuationContext?.messages.some(
      (message) => message.role === "assistant" && bindings.isContextOverflow(message, config.contextWindow),
    ),
    false,
  );
  assert.equal(continuationContext?.messages[0]?.role, "compactionSummary");
  assert.equal(result.metrics.providerAttempts, 3);
  assert.equal(result.metrics.turns, 1);
  assert.equal(result.metrics.toolCalls, 1);
  assert.equal(result.metrics.blockedToolCalls, 1);
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
