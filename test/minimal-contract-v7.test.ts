import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { FreeContextResult } from "../src/mcp/contracts.js";
import { FreeContextCallerRequestSchema } from "../src/mcp/contracts.js";
import { createTerminalStore, type DeadlineClock } from "../src/mcp/lifecycle.js";
import { executeSingleCall } from "../src/mcp/single-call.js";
import { createGatherContextHandler } from "../src/mcp/tool.js";
import { compileFreeContextResult } from "../src/output/text-result.js";
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

test("the tracked skill routes the minimal direct request contract", async () => {
  const skill = await readFile(new URL("../skills/freecontext/SKILL.md", import.meta.url), "utf8");
  const metadata = await readFile(new URL("../skills/freecontext/agents/openai.yaml", import.meta.url), "utf8");
  assert.match(skill, /gather_context/);
  assert.doesNotMatch(skill, /sessionId|continuation/iu);
  assert.match(skill, /ordinary assistant text/iu);
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
