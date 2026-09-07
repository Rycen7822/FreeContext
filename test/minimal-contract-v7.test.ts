import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { runAgentLoop, runAgentLoopContinue } from "@earendil-works/pi-agent-core";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, Type } from "@earendil-works/pi-ai";
import type { FreeContextResult } from "../src/mcp/contracts.js";
import { FreeContextCallerRequestSchema, SERVER_INSTRUCTIONS, TOOL_DESCRIPTION } from "../src/mcp/contracts.js";
import { createTerminalStore, type DeadlineClock } from "../src/mcp/lifecycle.js";
import { executeSingleCall } from "../src/mcp/single-call.js";
import { createGatherContextHandler } from "../src/mcp/tool.js";
import { compileFreeContextResult } from "../src/output/text-result.js";
import { buildUserPrompt } from "../src/prompt.js";
import { FINALIZATION_SYSTEM_PROMPT } from "../src/runtime/finalization.js";
import { runPiSession } from "../src/runtime/pi-session.js";
import { createModel, createRequestOptions } from "../src/runtime/model.js";
import { runExplorer } from "../src/runtime/run.js";
import { createWorkspace } from "../src/tools/workspace.js";
import { assistantText, baseConfig, baseRouteConfig, fakeBindings } from "./helpers.js";

const invocation = {
  invocationId: "invocation-v7",
  callId: "call-v7",
  workspaceRoot: "/workspace",
  workspaceRevision: "revision-v7",
  sessionId: "session-v7",
  sessionFile: "/sessions/session-v7.json",
} as const;

test("the public request is only a question with optional hints", () => {
  const parsed = FreeContextCallerRequestSchema.parse({ question: "Trace this behavior", hints: "src/index.ts" });
  assert.deepEqual(Object.keys(parsed).sort(), ["hints", "question"]);
  assert.throws(() => FreeContextCallerRequestSchema.parse({ question: "Trace this behavior", sessionId: "s1" }));
  assert.throws(() => FreeContextCallerRequestSchema.parse({ question: "" }));
});

test("the tracked skill and tool keep the phase-aware minimal request contract", async () => {
  const skill = await readFile(new URL("../skills/freecontext/SKILL.md", import.meta.url), "utf8");
  const metadata = await readFile(new URL("../skills/freecontext/agents/openai.yaml", import.meta.url), "utf8");
  assert.match(skill, /gather_context/);
  assert.doesNotMatch(skill, /sessionId|continuation/iu);
  assert.match(skill, /ordinary assistant text/iu);
  assert.match(`${skill}\n${TOOL_DESCRIPTION}\n${SERVER_INSTRUCTIONS}`, /any phase/iu);
  assert.doesNotMatch(`${TOOL_DESCRIPTION}\n${SERVER_INSTRUCTIONS}`, /sessionId|continuation|typed reentry/iu);
  assert.match(metadata, /FreeContext/iu);
});

test("arbitrary worker text stays opaque and is not size or shape gated", async () => {
  const request = FreeContextCallerRequestSchema.parse({ question: "Trace this behavior" });
  const text = "plain answer\n" + "x".repeat(12_000);
  const result = await compileFreeContextResult(request, invocation, text, { errorCode: null });
  assert.equal(result.status, "complete");
  assert.equal(result.text, text);
});

test("the session id is visible in the ordinary MCP text content", async () => {
  const testRoot = await mkdtemp(path.join(process.cwd(), ".work", "fc-v7-visible-session-"));
  const workspaceRoot = path.join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  try {
    const handler = createGatherContextHandler({
      tokenCounter: { countBatch: async (texts) => texts.map((text) => text.length) },
      sessionDirectory: path.join(testRoot, "sessions"),
      invocationContextProvider: () => ({
        invocationId: "visible-invocation",
        callId: "visible-call",
        workspaceRoot,
        workspaceRevision: "revision-v7",
      }),
      runExplorer: async ({ invocation, onEvent, onSessionCapture }) => {
        await onEvent?.({ type: "message_start", message: assistantText("answer") }, { turnCount: 0, toolCallCount: 0, providerAttempts: 1 });
        await onSessionCapture?.({ primary: { messages: [assistantText("answer")] } } as unknown as Parameters<NonNullable<typeof onSessionCapture>>[0]);
        return {
          status: "complete",
          text: "answer",
          errorCode: null,
          sessionId: invocation.sessionId,
          sessionFile: invocation.sessionFile,
        };
      },
    });
    const result = await handler({ question: "answer this" }, {});
    const content = result.content[0];
    assert.equal(content?.type, "text");
    if (content?.type === "text") {
      assert.match(content.text, /answer\n\nSession: [^\n]+$/u);
      assert.match(content.text, /Session: [^\n]+$/u);
    }
    const sessionFileName = (await readdir(path.join(testRoot, "sessions"))).find((name) => name.endsWith(".json"));
    assert.ok(sessionFileName);
    const sessionDocument = JSON.parse(await readFile(path.join(testRoot, "sessions", sessionFileName), "utf8")) as {
      capture?: { primary?: { messages?: unknown[] } } | null;
      runtimeEvents?: unknown[];
    };
    assert.equal(sessionDocument.capture?.primary?.messages?.length, 1);
    assert.deepEqual(sessionDocument.runtimeEvents, []);
    const invalid = await handler({ question: "" }, {});
    const invalidContent = invalid.content[0];
    assert.equal(invalidContent?.type, "text");
    if (invalidContent?.type === "text") assert.doesNotMatch(invalidContent.text, /Session:/u);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("the router and explorer run one ordinary-text success path", async () => {
  const testRoot = await mkdtemp(path.join(process.cwd(), ".work", "fc-v7-run-"));
  const workspace = await createWorkspace(testRoot);
  try {
    const answer = assistantText("router answer");
    const result = await runExplorer({
      request: FreeContextCallerRequestSchema.parse({ question: "Trace the route" }),
      invocation: { ...invocation, workspaceRoot: workspace.root },
      dependencies: {
        routeConfig: baseRouteConfig([baseConfig({ contextCompactionEnabled: false })]),
        workspace,
        bindings: fakeBindings(async (prompts, _context, _loopConfig, emit) => {
          await emit({ type: "turn_end", message: answer, toolResults: [] });
          return [...prompts, answer];
        }),
        repositoryTools: { tools: [], names: [], executables: { rg: null, jq: null, bat: null } },
        systemPrompt: "terse system",
        tokenCounter: { countBatch: async (texts) => texts.map((text) => text.length) },
      },
    });
    assert.equal(result.status, "complete");
    assert.equal(result.text, "router answer");
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("the repository system prompt and hints reach the worker without relabeling leads", async () => {
  const testRoot = await mkdtemp(path.join(process.cwd(), ".work", "fc-v8-hints-"));
  const workspace = await createWorkspace(testRoot);
  const request = FreeContextCallerRequestSchema.parse({
    question: "Find untouched consumers and alternate paths after the changed parser seam.",
    hints: "Previously checked fact: parser behavior was read; lead path: src/parser.ts; changed path to check: src/lexer.ts.",
  });
  let receivedPrompt = "";
  let receivedSystemPrompt = "";
  try {
    const answer = assistantText("differential audit answer");
    const result = await runExplorer({
      request,
      invocation: { ...invocation, workspaceRoot: workspace.root },
      dependencies: {
        routeConfig: baseRouteConfig([baseConfig({ contextCompactionEnabled: false })]),
        workspace,
        bindings: fakeBindings(async (prompts, context, _loopConfig, emit) => {
          const firstPrompt = prompts[0];
          receivedPrompt = firstPrompt?.role === "user" && typeof firstPrompt.content === "string"
            ? firstPrompt.content
            : "";
          receivedSystemPrompt = context.systemPrompt;
          await emit({ type: "turn_end", message: answer, toolResults: [] });
          return [...prompts, answer];
        }),
        repositoryTools: { tools: [], names: [], executables: { rg: null, jq: null, bat: null } },
        tokenCounter: { countBatch: async (texts) => texts.map((text) => text.length) },
      },
    });
    assert.equal(result.status, "complete");
    const systemTemplate = await readFile(new URL("../prompts/explorer.md", import.meta.url), "utf8");
    assert.equal(receivedSystemPrompt, systemTemplate
      .replaceAll("{{WORKSPACE}}", workspace.root)
      .replaceAll("{{TOOLS}}", "")
      .replaceAll("{{OVERVIEW}}", "[empty workspace]")
      .trim());
    assert.equal(receivedPrompt, buildUserPrompt(request));
    assert.match(receivedPrompt, /Hints: Previously checked fact: parser behavior was read/iu);
    assert.doesNotMatch(receivedPrompt, /already-known findings|\bconfirmed:\b|\bverified:\b/iu);
    assert.match(receivedPrompt, /src\/parser\.ts.*src\/lexer\.ts/iu);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("MCP makes partial findings visibly incomplete while keeping complete answers unchanged", async () => {
  const testRoot = await mkdtemp(path.join(process.cwd(), ".work", "fc-v13-partial-"));
  const workspaceRoot = path.join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  try {
    for (const status of ["partial", "complete"] as const) {
      const handler = createGatherContextHandler({
        tokenCounter: { countBatch: async (texts) => texts.map((text) => text.length) },
        sessionDirectory: path.join(testRoot, "sessions"),
        invocationContextProvider: () => ({
          invocationId: `visible-${status}`, callId: `call-${status}`,
          workspaceRoot, workspaceRevision: "revision-v13",
        }),
        runExplorer: async ({ invocation }) => ({
          status, text: "src/file.ts:10 — confirmed fact.", errorCode: null,
          sessionId: invocation.sessionId, sessionFile: invocation.sessionFile,
        }),
      });
      const result = await handler({ question: "Trace this fact" }, {});
      const content = result.content[0];
      assert.equal(result.isError, undefined);
      assert.equal(content?.type, "text");
      if (content?.type !== "text") assert.fail("expected visible MCP text");
      assert.match(content.text, /src\/file\.ts:10 — confirmed fact\.\n\nSession: [^\n]+$/u);
      if (status === "partial") assert.match(content.text, /^FreeContext did not finish; partial notes follow\.\n\n/u);
      else assert.match(content.text, /^src\/file\.ts:10 — confirmed fact\./u);
    }
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("soft finalization is a prompt and provider errors preserve useful text", async () => {
  assert.match(FINALIZATION_SYSTEM_PROMPT, /stop using repository tools/);
  assert.match(FINALIZATION_SYSTEM_PROMPT, /ordinary assistant text/);
  const explorerPrompt = await readFile(new URL("../prompts/explorer.md", import.meta.url), "utf8");
  assert.match(explorerPrompt, /lead with the answer/iu);
  assert.match(explorerPrompt, /remove filler/iu);
  const config = baseConfig({ contextCompactionEnabled: false });
  const useful = assistantText("useful answer");
  const bindings = fakeBindings(async (_prompts, _context, _loopConfig, emit) => {
    await emit({ type: "message_start", message: useful });
    throw new Error("provider failed after useful text");
  });
  const result = await runPiSession({
    bindings,
    model: createModel(config),
    requestOptions: createRequestOptions(config),
    config,
    systemPrompt: "system",
    promptText: "question",
    tools: [],
    tokenCounter: { countBatch: async (texts) => texts.map((text) => text.length) },
  });
  assert.equal(result.text, "useful answer");
  assert.equal(result.terminalFailure, "provider");
});

test("provider retry checks soft finalization before its next request", async () => {
  let now = 0;
  let calls = 0;
  const contexts: Array<{ systemPrompt: string | undefined; messages: readonly unknown[]; tools: readonly unknown[] }> = [];
  const tool: AgentTool = {
    name: "read",
    label: "Read",
    description: "Read one bounded fact.",
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text", text: "fact" }], details: {} }),
  };
  const config = baseConfig({ contextCompactionEnabled: false, providerRetryDelaysMs: [1, 1, 1] });
  const bindings = fakeBindings(runAgentLoop, {
    runAgentLoopContinue,
    streamSimple: (_model, context) => {
      calls += 1;
      contexts.push({ systemPrompt: context.systemPrompt, messages: context.messages, tools: context.tools ?? [] });
      const stream = createAssistantMessageEventStream();
      if (calls <= 3) {
        if (calls === 1) now = 100;
        stream.end(assistantText("", { stopReason: "error", errorMessage: "Connection error" }));
      } else {
        stream.end(assistantText("concise current findings"));
      }
      return stream;
    },
  });
  const result = await runPiSession({
    bindings,
    model: createModel(config),
    requestOptions: createRequestOptions(config),
    config,
    systemPrompt: "system",
    promptText: "question",
    tools: [tool],
    tokenCounter: { countBatch: async (texts) => texts.map((text) => text.length) },
    softFinalizationMs: 50,
    clock: () => now,
  });
  assert.equal(calls, 4);
  assert.equal(result.text, "concise current findings");
  assert.equal(result.metrics.finalizationReason, "soft_deadline");
  assert.equal(contexts[0]?.systemPrompt, "system");
  assert.equal(contexts[0]?.tools.length, 1);
  assert.match(contexts[1]?.systemPrompt ?? "", /stop using repository tools/iu);
  for (const context of contexts.slice(1)) {
    assert.equal(context.tools.length, 0);
    assert.equal(context.messages.filter((message) => (
      typeof message === "object" && message !== null && "content" in message &&
      typeof (message as { content?: unknown }).content === "string" &&
      (message as { content: string }).content.startsWith("Exploration budget reached:")
    )).length, 1);
  }
});

test("soft finalization clears tools once and does not dispatch another tool", async () => {
  let now = 0;
  let calls = 0;
  let executed = 0;
  const contexts: Array<{ messages: readonly unknown[]; tools: readonly unknown[] }> = [];
  const tool: AgentTool = {
    name: "read",
    label: "Read",
    description: "Read one bounded fact.",
    parameters: Type.Object({}),
    execute: async () => {
      executed += 1;
      return { content: [{ type: "text", text: "fact" }], details: {} };
    },
  };
  const config = baseConfig({ contextCompactionEnabled: false, providerRetryDelaysMs: [] });
  const bindings = fakeBindings(runAgentLoop, {
    runAgentLoopContinue,
    streamSimple: (_model, context) => {
      calls += 1;
      contexts.push({ messages: context.messages, tools: context.tools ?? [] });
      const stream = createAssistantMessageEventStream();
      if (calls === 1) {
        now = 100;
        stream.end(assistantText("", {
          stopReason: "toolUse",
          content: [
            { type: "text", text: "Let me verify one more path." },
            { type: "toolCall", id: "call-1", name: "read", arguments: {} },
          ],
        }));
      } else {
        stream.end(assistantText("final findings"));
      }
      return stream;
    },
  });
  const result = await runPiSession({
    bindings,
    model: createModel(config),
    requestOptions: createRequestOptions(config),
    config,
    systemPrompt: "system",
    promptText: "question",
    tools: [tool],
    tokenCounter: { countBatch: async (texts) => texts.map((text) => text.length) },
    softFinalizationMs: 50,
    clock: () => now,
  });
  assert.equal(calls, 2);
  assert.equal(executed, 0);
  assert.equal(result.text, "final findings");
  assert.equal(result.metrics.finalizationReason, "soft_deadline");
  assert.equal(contexts[0]?.tools.length, 1);
  assert.equal(contexts[1]?.tools.length, 0);
  assert.equal(contexts[1]?.messages.filter((message) => (
    typeof message === "object" && message !== null && "role" in message && (message as { role?: unknown }).role === "user"
  )).length, 2);
});

test("exploration limits give tool commentary one bounded tool-free answer turn", async () => {
  for (const budget of [
    { maxTurns: 2, maxToolCalls: 10, reason: "turn_limit", requests: 3, executed: 4 },
    { maxTurns: 10, maxToolCalls: 3, reason: "tool_limit", requests: 3, executed: 3 },
    { maxTurns: 100, maxToolCalls: 100, reason: "turn_limit", requests: 24, executed: 46 },
  ]) {
    let requests = 0;
    let executed = 0;
    const config = baseConfig({ contextCompactionEnabled: false, providerRetryDelaysMs: [] });
    const result = await runPiSession({
      bindings: fakeBindings(runAgentLoop, {
        runAgentLoopContinue,
        streamSimple: (_model, context) => {
          requests += 1;
          assert.ok(requests <= budget.requests, "finalization must stay bounded");
          const stream = createAssistantMessageEventStream();
          if (requests < budget.requests) {
            stream.end(assistantText("", { stopReason: "toolUse", content: [
              { type: "text", text: "Let me verify the remaining paths." },
              ...[1, 2].map((index) => ({ type: "toolCall" as const, id: `${requests}-${index}`, name: "read", arguments: {} })),
            ] }));
          } else {
            assert.equal(context.tools?.length, 0);
            assert.match(context.systemPrompt ?? "", /stop using repository tools/iu);
            stream.end(assistantText("src/file.ts:10 — verified finding, limited to the queued path."));
          }
          return stream;
        },
      }),
      model: createModel(config), requestOptions: createRequestOptions(config), config,
      systemPrompt: "system", promptText: "question",
      tools: [{ name: "read", label: "Read", description: "Read a fact", parameters: Type.Object({}),
        execute: async () => { executed += 1; return { content: [{ type: "text", text: "fact" }], details: {} }; } }],
      tokenCounter: { countBatch: async (texts) => texts.map((text) => text.length) },
      maxTurns: budget.maxTurns, maxToolCalls: budget.maxToolCalls,
    });
    assert.equal(requests, budget.requests);
    assert.equal(executed, budget.executed);
    assert.equal(result.metrics.finalizationReason, budget.reason);
    assert.match(result.text, /verified finding/);
    assert.equal(result.completed, true);
  }
});

test("unsuccessful final answers preserve prior findings as partial without restarting exploration", async () => {
  for (const stopReason of ["toolUse", "length", "error", "aborted", "stop"] as const) {
    let requests = 0;
    const config = baseConfig({ contextCompactionEnabled: false, providerRetryDelaysMs: [1] });
    const result = await runPiSession({
      bindings: fakeBindings(runAgentLoop, {
        runAgentLoopContinue,
        streamSimple: (_model, context) => {
          requests += 1;
          assert.ok(requests <= 2, "no extra finalization or retry after preserved findings");
          const stream = createAssistantMessageEventStream();
          if (requests === 1) {
            stream.end(assistantText("", { stopReason: "toolUse", content: [
              { type: "text", text: "src/file.ts:10 — confirmed fact for the queued path." },
              { type: "toolCall", id: "read-1", name: "read", arguments: {} },
            ] }));
          } else {
            assert.equal(context.tools?.length, 0);
            stream.end(assistantText("", { stopReason, ...(stopReason === "toolUse" ? {
              content: [{ type: "toolCall", id: "read-2", name: "read", arguments: {} }],
            } : {}) }));
          }
          return stream;
        },
      }),
      model: createModel(config), requestOptions: createRequestOptions(config), config,
      systemPrompt: "system", promptText: "question", maxTurns: 1,
      tools: [{ name: "read", label: "Read", description: "Read a fact", parameters: Type.Object({}),
        execute: async () => ({ content: [{ type: "text", text: "fact" }], details: {} }) }],
      tokenCounter: { countBatch: async (texts) => texts.map((text) => text.length) },
    });
    assert.equal(requests, 2);
    assert.equal(result.metrics.toolCalls, 1);
    assert.equal(result.completed, false);
    assert.match(result.text, /confirmed fact/);
    assert.equal(result.terminalFailure, stopReason === "error" ? "provider" : stopReason === "aborted" ? "aborted" : null);
    const compiled = await compileFreeContextResult({ question: "question" }, invocation, result.text, {
      errorCode: null, completed: result.completed,
    });
    assert.equal(compiled.status, "partial");
    assert.equal(compiled.text, result.text);
  }
});

test("the outer hard deadline keeps text already streamed by the worker", async () => {
  const testRoot = await mkdtemp(path.join(process.cwd(), ".work", "fc-v7-deadline-"));
  const workspaceRoot = path.join(testRoot, "workspace");
  const sessionDirectory = path.join(testRoot, "sessions");
  await mkdir(workspaceRoot);
  let expire: () => void = () => undefined;
  const deadlineClock: DeadlineClock = {
    start: () => {
      const controller = new AbortController();
      let expired = false;
      expire = () => {
        expired = true;
        controller.abort(new Error("deadline"));
      };
      return { signal: controller.signal, didExpire: () => expired, dispose: () => undefined };
    },
  };
  try {
    const result = await executeSingleCall(
      { question: "stream an answer" },
      {
        invocationId: "deadline-invocation",
        callId: "deadline-call",
        workspaceRoot,
        workspaceRevision: "revision-v7",
      },
      undefined,
      {
        tokenCounter: { countBatch: async (texts) => texts.map((text) => text.length) },
        terminalStore: createTerminalStore(),
        deadlineClock,
        deadlineMs: 1,
        sessionDirectory,
        runExplorer: async ({ onEvent }) => {
          await onEvent?.({ type: "message_start", message: assistantText("streamed before deadline") }, { turnCount: 0, toolCallCount: 0, providerAttempts: 1 });
          expire();
          return await new Promise<Readonly<FreeContextResult>>(() => undefined);
        },
      },
    );
    assert.equal(result.result.status, "partial");
    assert.equal(result.result.text, "streamed before deadline");
    assert.equal(result.result.errorCode, "DEADLINE_EXCEEDED");
    assert.ok(result.result.sessionFile);
    const sessionDocument = JSON.parse(await readFile(result.result.sessionFile, "utf8")) as {
      capture: unknown;
      runtimeEvents: unknown[];
    };
    assert.equal(sessionDocument.capture, null);
    assert.ok(sessionDocument.runtimeEvents.length > 0);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});
