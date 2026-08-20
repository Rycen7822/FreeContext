import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProviderError, SessionPersistenceError } from "../src/errors.js";
import {
  FREECONTEXT_ELIGIBILITY_POLICY,
  FREECONTEXT_HOST_ROUTE_METADATA,
  FreeContextResultSchema,
  SERVER_INSTRUCTIONS,
  serializeForModel,
  TOOL_DESCRIPTION,
} from "../src/mcp/contracts.js";
import type {
  FreeContextCallContext,
  FreeContextRequest,
  FreeContextResult,
} from "../src/mcp/contracts.js";
import { createTerminalStore, SINGLE_CALL_DEADLINE_MS } from "../src/mcp/lifecycle.js";
import type { DeadlineClock } from "../src/mcp/lifecycle.js";
import { createGatherContextHandler, InvocationContextError } from "../src/mcp/tool.js";
import type { ContextTokenCounter } from "../src/runtime/context-budget.js";
import type { RunExplorerOptions } from "../src/runtime/run.js";

const tokenCounter: ContextTokenCounter = {
  countBatch: async (texts) => texts.map(() => 0),
};

const request: FreeContextRequest = {
  taskText: "collect evidence",
  knownRefs: [{ kind: "path", path: "document.md" }],
  evidenceQuestions: [
    { id: "impl", role: "implementation", question: "Where is it implemented?", required: true },
    { id: "tests", role: "test", question: "How is it tested?", required: false },
  ],
};

function callContext(workspaceRoot: string, invocationId = "invocation-1", callId = "call-1"): FreeContextCallContext {
  return {
    invocationId,
    callId,
    workspaceRoot,
    workspaceRevision: "revision-1",
  };
}

function readyResult(options: RunExplorerOptions): Readonly<FreeContextResult> {
  return FreeContextResultSchema.parse({
    status: "ready",
    summary: "Validated summary.",
    evidence: [{
      role: "implementation",
      path: "document.md",
      startLine: 1,
      endLine: 2,
      focusLine: 1,
      questionId: "impl",
      why: "Defines the behavior.",
    }],
    gaps: [{ questionId: "tests", reason: "No test was found." }],
    nextAction: {
      kind: "read",
      path: "document.md",
      startLine: 1,
      endLine: 2,
      reason: "Read the first evidence span.",
    },
    errorCode: null,
    sessionId: options.invocation.sessionId,
    sessionFile: options.invocation.sessionFile,
  });
}

function outputOf(result: Awaited<ReturnType<ReturnType<typeof createGatherContextHandler>>>) {
  return FreeContextResultSchema.parse(result.structuredContent);
}

function manualDeadline(): Readonly<{ clock: DeadlineClock; expire: () => void }> {
  const controller = new AbortController();
  let expired = false;
  return Object.freeze({
    clock: {
      start: () => ({ signal: controller.signal, didExpire: () => expired, dispose: () => {} }),
    },
    expire: () => {
      expired = true;
      controller.abort(new Error("manual deadline"));
    },
  });
}

test("gather_context describes broad read delegation without claiming parent actions", () => {
  assert.equal(SINGLE_CALL_DEADLINE_MS, 285_000);
  assert.equal(FREECONTEXT_HOST_ROUTE_METADATA.policyId, FREECONTEXT_ELIGIBILITY_POLICY.id);
  assert.equal(FREECONTEXT_HOST_ROUTE_METADATA.gates, FREECONTEXT_ELIGIBILITY_POLICY.gates);
  for (const gate of FREECONTEXT_ELIGIBILITY_POLICY.gates) {
    assert.match(TOOL_DESCRIPTION, new RegExp(`Gate ${gate.order}:`, "u"));
    assert.ok(TOOL_DESCRIPTION.includes(gate.instruction));
  }
  for (const invariant of FREECONTEXT_ELIGIBILITY_POLICY.invariants) {
    assert.ok(TOOL_DESCRIPTION.includes(invariant));
  }
  assert.match(
    SERVER_INSTRUCTIONS,
    /public MCP request id and either an operator-configured absolute workspace root or exactly one public MCP file root/u,
  );
  assert.match(SERVER_INSTRUCTIONS, /Make exactly one call per task, await the same outer cell while pending, and never replay after any terminal result/u);
  assert.match(SERVER_INSTRUCTIONS, /partial result permits one targeted native search batch for its exact material gaps/u);
  assert.doesNotMatch(`${SERVER_INSTRUCTIONS}\n${TOOL_DESCRIPTION}`, /\b(?:commit|push|edit files)\b/u);
});

test("gather_context runs one explorer and commits the exact canonical result", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "freecontext-mcp-tool-"));
  const workspace = path.join(root, "workspace");
  const sessions = path.join(root, "sessions");
  try {
    await mkdir(workspace);
    const signal = new AbortController().signal;
    let calls = 0;
    const explore = async (options: RunExplorerOptions): Promise<Readonly<FreeContextResult>> => {
      calls += 1;
      assert.equal(options.request.taskText, request.taskText);
      assert.deepEqual(options.invocation, {
        ...callContext(workspace),
        sessionId: options.invocation.sessionId,
        sessionFile: options.invocation.sessionFile,
      });
      assert.equal(options.dependencies?.tokenCounter, tokenCounter);
      assert.equal(options.signal?.aborted, false);
      await options.onEvent?.(
        { type: "turn_start" },
        { turnCount: 0, toolCallCount: 0, providerAttempts: 1 },
      );
      return readyResult(options);
    };
    const call = await createGatherContextHandler({
      tokenCounter,
      sessionDirectory: sessions,
      runExplorer: explore,
    })(request, callContext(workspace), signal);
    const output = outputOf(call);

    assert.equal(calls, 1);
    assert.equal(output.status, "ready");
    assert.equal((await readdir(sessions)).length, 1);
    assert.ok(output.sessionFile);
    const document = JSON.parse(await readFile(output.sessionFile, "utf8"));
    const visible = call.content[0];
    assert.ok(visible && visible.type === "text");
    assert.equal(visible.text, serializeForModel(output));
    assert.deepEqual(document.result, output);
    assert.equal(document.schemaVersion, "freecontext-mcp-session-v3");
    assert.equal(document.request.taskText, request.taskText);
    assert.equal(document.invocation.invocationId, "invocation-1");
    assert.equal(document.invocation.callId, "call-1");
    assert.equal(document.terminalDecision.winner, "worker");
    assert.equal(document.runtimeEvents.length, 1);
    assert.equal(
      document.serializedTextSha256,
      createHash("sha256").update(visible.text).digest("hex"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("gather_context normalizes an omitted knownRefs field to an empty array", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "freecontext-mcp-tool-"));
  const workspace = path.join(root, "workspace");
  const sessions = path.join(root, "sessions");
  try {
    await mkdir(workspace);
    let observed: Readonly<FreeContextRequest> | undefined;
    const call = await createGatherContextHandler({
      tokenCounter,
      sessionDirectory: sessions,
      runExplorer: async (options) => {
        observed = options.request;
        return readyResult(options);
      },
    })({ taskText: request.taskText, evidenceQuestions: request.evidenceQuestions }, callContext(workspace));
    assert.equal(outputOf(call).status, "ready");
    assert.deepEqual(observed?.knownRefs, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid input fails before reservation or provider execution", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "freecontext-mcp-tool-"));
  const workspace = path.join(root, "workspace");
  const sessions = path.join(root, "sessions");
  try {
    await mkdir(workspace);
    let calls = 0;
    const call = await createGatherContextHandler({
      tokenCounter,
      sessionDirectory: sessions,
      runExplorer: async (options) => {
        calls += 1;
        return readyResult(options);
      },
    })({ taskText: "missing questions", knownRefs: [], evidenceQuestions: [] }, callContext(workspace));
    const output = outputOf(call);
    assert.equal(calls, 0);
    assert.equal(output.status, "failed");
    assert.equal(output.errorCode, "INVALID_REQUEST");
    assert.equal(output.sessionFile, null);
    await assert.rejects(readdir(sessions), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invocation context failures preserve a safe typed reason before reservation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "freecontext-mcp-tool-"));
  const sessions = path.join(root, "sessions");
  try {
    const call = await createGatherContextHandler({
      tokenCounter,
      sessionDirectory: sessions,
      invocationContextProvider: () => {
        throw new InvocationContextError(
          "workspace_roots_unavailable",
          "The MCP host did not provide workspace roots.",
        );
      },
    })(request, {});
    const output = outputOf(call);
    assert.equal(output.status, "failed");
    assert.equal(output.errorCode, "INVALID_REQUEST");
    assert.equal(output.nextAction.reason, "The MCP host did not provide workspace roots.");
    assert.equal(output.sessionId, "unbound-invocation");
    assert.equal(output.sessionFile, null);
    assert.deepEqual(call._meta?.freecontext, {
      callContextBound: false,
      contextFailure: "workspace_roots_unavailable",
    });
    await assert.rejects(readdir(sessions), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unknown invocation context failures do not expose private details", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "freecontext-mcp-tool-"));
  const sessions = path.join(root, "sessions");
  try {
    const call = await createGatherContextHandler({
      tokenCounter,
      sessionDirectory: sessions,
      invocationContextProvider: () => {
        throw new Error("private host path and transport detail");
      },
    })(request, {});
    const output = outputOf(call);
    assert.equal(
      output.nextAction.reason,
      "The MCP host did not supply a valid FreeContext call context.",
    );
    assert.equal(JSON.stringify(call).includes("private host path"), false);
    assert.deepEqual(call._meta?.freecontext, {
      callContextBound: false,
      contextFailure: "invalid_call_context",
    });
    await assert.rejects(readdir(sessions), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("distinct invocations with the same transport call id each create one worker and session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "freecontext-mcp-tool-"));
  const workspace = path.join(root, "workspace");
  const sessions = path.join(root, "sessions");
  try {
    await mkdir(workspace);
    let calls = 0;
    const handler = createGatherContextHandler({
      tokenCounter,
      sessionDirectory: sessions,
      runExplorer: async (options) => { calls += 1; return readyResult(options); },
    });
    const first = outputOf(await handler(request, callContext(workspace)));
    const second = outputOf(await handler(request, callContext(workspace, "invocation-2", "call-1")));
    assert.equal(first.status, "ready");
    assert.equal(second.status, "ready");
    assert.notEqual(first.sessionFile, second.sessionFile);
    assert.equal(calls, 2);
    assert.equal((await readdir(sessions)).length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("provider, abort, and internal failures are classified and committed", async () => {
  const fixtures = [
    {
      error: new ProviderError("busy", { category: "server_error", statusCode: 503 }),
      aborted: false,
      code: "PROVIDER_RETRY_EXHAUSTED",
    },
    { error: new Error("private internal detail"), aborted: false, code: "INTERNAL_ERROR" },
  ] as const;
  for (const fixture of fixtures) {
    const root = await mkdtemp(path.join(os.tmpdir(), "freecontext-mcp-tool-"));
    const workspace = path.join(root, "workspace");
    const sessions = path.join(root, "sessions");
    try {
      await mkdir(workspace);
      const controller = new AbortController();
      if (fixture.aborted) controller.abort();
      const call = await createGatherContextHandler({
        tokenCounter,
        sessionDirectory: sessions,
        runExplorer: async () => { throw fixture.error; },
      })(request, callContext(workspace), controller.signal);
      const output = outputOf(call);
      assert.equal(output.status, "failed");
      assert.equal(output.errorCode, fixture.code);
      assert.ok(output.sessionFile);
      const document = JSON.parse(await readFile(output.sessionFile, "utf8"));
      assert.equal(document.result.errorCode, fixture.code);
      assert.equal(
        document.terminalError.message,
        fixture.error instanceof ProviderError ? fixture.error.message : "Unexpected internal failure.",
      );
      assert.doesNotMatch(JSON.stringify(call.structuredContent), /private internal detail|\b503\b|server_error/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("a pre-aborted call does not reserve a session or start a worker", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "freecontext-mcp-tool-"));
  const workspace = path.join(root, "workspace");
  const sessions = path.join(root, "sessions");
  try {
    await mkdir(workspace);
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    let reservations = 0;
    const call = await createGatherContextHandler({
      tokenCounter,
      sessionDirectory: sessions,
      runExplorer: async (options) => { calls += 1; return readyResult(options); },
      reserveSession: async () => { reservations += 1; throw new Error("unexpected reservation"); },
    })(request, callContext(workspace), controller.signal);
    const output = outputOf(call);
    assert.equal(calls, 0);
    assert.equal(reservations, 0);
    assert.equal(output.errorCode, "DEADLINE_EXCEEDED");
    assert.equal(output.sessionFile, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deadline compiles the latest candidate once and records a late worker result separately", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "freecontext-mcp-tool-"));
  const workspace = path.join(root, "workspace");
  const sessions = path.join(root, "sessions");
  try {
    await mkdir(workspace);
    await writeFile(path.join(workspace, "document.md"), "first\nsecond\n", "utf8");
    const deadline = manualDeadline();
    const backingStore = createTerminalStore();
    let markLateRecorded: (() => void) | undefined;
    const lateRecorded = new Promise<void>((resolve) => { markLateRecorded = resolve; });
    const terminalStore = {
      tryClaim: backingStore.tryClaim,
      recordLate: async (input: Parameters<typeof backingStore.recordLate>[0]) => {
        await backingStore.recordLate(input);
        markLateRecorded?.();
      },
    };
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let resolveLate: (() => void) | undefined;
    const handler = createGatherContextHandler({
      tokenCounter,
      sessionDirectory: sessions,
      deadlineClock: deadline.clock,
      terminalStore,
      runExplorer: async (options) => {
        const candidate = {
          summary: "candidate before deadline.",
          evidence: [{
            role: "implementation" as const,
            questionId: "impl",
            path: "document.md",
            startLine: 1,
            endLine: 2,
            focusLine: 1,
            why: "Defines the behavior.",
          }],
          gaps: [{ questionId: "tests", reason: "No test was found." }],
        };
        await options.onEvent?.(
          {
            type: "tool_execution_end",
            toolCallId: "read-1",
            toolName: "read",
            result: {
              content: [{ type: "text", text: "[read document.md:1-2]\n1 first\n2 second" }],
              details: { tool: "read", path: "document.md", startLine: 1, actualEndLine: 2, truncated: false },
            },
            isError: false,
          },
          { turnCount: 1, toolCallCount: 1, providerAttempts: 1 },
        );
        await options.onEvent?.(
          {
            type: "tool_execution_end",
            toolCallId: "submit-1",
            toolName: "submit_evidence",
            result: {
              content: [{ type: "text", text: "Evidence submission accepted." }],
              details: { tool: "submit_evidence", candidate },
              terminate: true,
            },
            isError: false,
          },
          { turnCount: 1, toolCallCount: 1, providerAttempts: 1 },
        );
        markStarted?.();
        await new Promise<void>((resolve) => { resolveLate = resolve; });
        return readyResult(options);
      },
    });
    const pending = handler(request, callContext(workspace));
    await started;
    deadline.expire();
    const call = await pending;
    const output = outputOf(call);
    assert.equal(output.status, "partial");
    assert.equal(output.errorCode, "DEADLINE_EXCEEDED");
    assert.equal(output.evidence[0]?.path, "document.md");
    assert.ok(output.sessionFile);
    const session = JSON.parse(await readFile(output.sessionFile, "utf8"));
    assert.equal(session.terminalDecision.winner, "deadline");
    assert.equal(session.terminalDecision.lateResultExpected, true);
    assert.ok(session.terminalDecision.lateDiagnosticFile);

    resolveLate?.();
    await lateRecorded;
    const late = JSON.parse(await readFile(session.terminalDecision.lateDiagnosticFile, "utf8"));
    assert.equal(late.schemaVersion, "freecontext-late-result-v2");
    assert.equal(late.settlement.kind, "result");
    assert.equal(late.terminalDecision.winner, "deadline");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an explorer cannot substitute another session identity", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "freecontext-mcp-tool-"));
  const workspace = path.join(root, "workspace");
  const sessions = path.join(root, "sessions");
  try {
    await mkdir(workspace);
    const call = await createGatherContextHandler({
      tokenCounter,
      sessionDirectory: sessions,
      runExplorer: async (options) => FreeContextResultSchema.parse({
        ...readyResult(options),
        sessionId: "substituted-session",
      }),
    })(request, callContext(workspace));
    const output = outputOf(call);
    assert.equal(output.status, "failed");
    assert.equal(output.errorCode, "INTERNAL_ERROR");
    assert.notEqual(output.sessionId, "substituted-session");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reservation and commit failures never return a false session pointer", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "freecontext-mcp-tool-"));
  const workspace = path.join(root, "workspace");
  try {
    await mkdir(workspace);
    let calls = 0;
    const explore = async (options: RunExplorerOptions): Promise<Readonly<FreeContextResult>> => {
      calls += 1;
      return readyResult(options);
    };
    const reservationFailure = await createGatherContextHandler({
      tokenCounter,
      sessionDirectory: path.join(workspace, "sessions"),
      runExplorer: explore,
    })(request, callContext(workspace));
    assert.equal(outputOf(reservationFailure).errorCode, "SESSION_PERSISTENCE_FAILED");
    assert.equal(outputOf(reservationFailure).sessionFile, null);
    assert.equal(calls, 0);

    const commitFailure = await createGatherContextHandler({
      tokenCounter,
      sessionDirectory: path.join(root, "sessions"),
      runExplorer: explore,
      commitSession: async () => {
        throw new SessionPersistenceError("write", { cause: new Error("private disk detail") });
      },
    })(request, callContext(workspace));
    const failed = outputOf(commitFailure);
    assert.equal(failed.errorCode, "SESSION_PERSISTENCE_FAILED");
    assert.equal(failed.sessionFile, null);
    assert.equal((commitFailure._meta?.freecontext as { persistenceStage?: string }).persistenceStage, "write");
    assert.doesNotMatch(JSON.stringify(commitFailure.content), /private disk detail/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
