import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BenchmarkMasterAgentContext } from "../src/benchmark/master-context.js";
import { exportMasterAgentContext } from "../src/benchmark/master-context.js";
import { serializeForModel } from "../src/mcp/contracts.js";
import { failedResult } from "../src/mcp/failure.js";
import type { McpSessionDocument } from "../src/mcp/session.js";
import { collectFreeContextTransportObservations, evaluateDelivery } from "../src/benchmark/delivery-observation.js";

const RUNTIME_SESSION = "/logs/agent/freecontext-sessions/call-001.json";

function v3Session(): McpSessionDocument {
  const request = {
    taskText: "locate the router",
    knownRefs: [{ kind: "path" as const, path: "src/router.ts" }],
    evidenceQuestions: [
      { id: "impl", role: "implementation" as const, question: "Where is the router?", required: true },
      { id: "tests", role: "test" as const, question: "How is it tested?", required: false },
    ],
  };
  const result = {
    status: "ready" as const,
    summary: "router found",
    evidence: [{
      role: "implementation" as const,
      path: "src/router.ts",
      startLine: 1,
      endLine: 2,
      focusLine: 1,
      questionId: "impl",
      why: "Defines the route.",
    }],
    gaps: [{ questionId: "tests", reason: "No test was found." }],
    nextAction: {
      kind: "read" as const,
      path: "src/router.ts",
      startLine: 1,
      endLine: 2,
      reason: "Read the route.",
    },
    errorCode: null,
    sessionId: "call-001",
    sessionFile: RUNTIME_SESSION,
  };
  const text = serializeForModel(result);
  return {
    schemaVersion: "freecontext-mcp-session-v3" as const,
    transport: "mcp" as const,
    startedAt: "2026-08-09T00:00:00.000Z",
    finishedAt: "2026-08-09T00:01:00.000Z",
    request,
    invocation: {
      invocationId: "invocation-001",
      callId: "call-001",
      workspaceRoot: "/workspace",
      workspaceRevision: "revision-1",
      sessionId: "call-001",
      sessionFile: RUNTIME_SESSION,
    },
    capture: null,
    runtimeEvents: [],
    result,
    serializedTextSha256: createHash("sha256").update(text).digest("hex"),
    terminalDecision: {
      invocationId: "invocation-001",
      winner: "worker",
      decidedAt: "2026-08-09T00:00:59.000Z",
      lateResultExpected: false,
      lateDiagnosticFile: null,
    },
    terminalError: null,
  };
}

function historicalV2Session() {
  const current = v3Session();
  return {
    ...current,
    schemaVersion: "freecontext-mcp-session-v2" as const,
    invocation: {
      taskId: "task-001",
      callId: current.invocation.callId,
      workspaceRoot: current.invocation.workspaceRoot,
      workspaceRevision: current.invocation.workspaceRevision,
      sessionId: current.invocation.sessionId,
      sessionFile: current.invocation.sessionFile,
    },
    terminalDecision: {
      callId: current.invocation.callId,
      winner: current.terminalDecision.winner,
      decidedAt: current.terminalDecision.decidedAt,
      lateResultExpected: current.terminalDecision.lateResultExpected,
      lateDiagnosticFile: current.terminalDecision.lateDiagnosticFile,
    },
  };
}

function legacySession() {
  return {
    schemaVersion: "freecontext-benchmark-session-v1" as const,
    capturedAt: "2026-08-09T00:00:00.000Z",
    invocation: {
      request: "locate the router",
      cwd: "/workspace",
      cliOutput: "SESSION_RECONSTRUCTION_MUST_NOT_BE_USED",
    },
    capture: { outcome: { status: "completed" } },
    runtimeEvents: [],
    terminalError: null,
  };
}

function providerFailedV3Session(): McpSessionDocument {
  const base = v3Session();
  const result = failedResult({
    code: "PROVIDER_RETRY_EXHAUSTED",
    reason: "provider unavailable",
    sessionId: base.invocation.sessionId,
    sessionFile: base.invocation.sessionFile,
    request: base.request,
  });
  const usage = {
    input: 10,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    totalTokens: 10,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  return {
    ...base,
    runtimeEvents: [{
      event: {
        type: "provider_attempt_failed",
        scope: "primary",
        attempt: 4,
        willRetry: false,
        failure: {
          category: "server_error",
          retryable: true,
          source: "provider",
          reason: "retryable_provider_code",
          statusCode: 503,
          code: "SERVICE_BUSY",
          type: null,
        },
        usage,
      },
      state: { turnCount: 0, toolCallCount: 0, providerAttempts: 4 },
    }],
    result,
    serializedTextSha256: createHash("sha256").update(serializeForModel(result)).digest("hex"),
    terminalError: {
      name: "ProviderError",
      code: "PROVIDER_ERROR",
      message: "provider unavailable",
      category: "server_error",
      statusCode: 503,
    },
  };
}

async function createFixture(
  root: string,
  session: McpSessionDocument | ReturnType<typeof historicalV2Session> | ReturnType<typeof legacySession>,
  observedText: string | null,
  structuredContent?: unknown,
  includeDuplicate = false,
  startedOnly = false,
  includeTransport = false,
  includeDirectObservation = true,
  includeParentAction = true,
): Promise<Readonly<{ agentDir: string; masterRaw: string; sessionRaw: string }>> {
  const agentDir = path.join(root, "agent");
  const sessionDir = path.join(agentDir, "sessions", "2026", "08", "09");
  const freeContextDir = path.join(agentDir, "freecontext-sessions");
  await Promise.all([mkdir(sessionDir, { recursive: true }), mkdir(freeContextDir, { recursive: true })]);
  const events: unknown[] = [{ type: "other_context", payload: "before" }];
  if ((session.schemaVersion === "freecontext-mcp-session-v2" || session.schemaVersion === "freecontext-mcp-session-v3") &&
      (observedText !== null || startedOnly)) {
    if (includeTransport) {
      const metadata = { turn_id: "turn-001" };
      events.push({
        timestamp: "2026-08-09T00:00:00.000Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "exec",
          call_id: "outer-001",
          input: "const result = await tools.mcp__freecontext__gather_context({ taskText: \"x\" }); notify(\"slow\");",
          internal_chat_message_metadata_passthrough: metadata,
        },
      }, {
        timestamp: "2026-08-09T00:00:08.000Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: "outer-001",
          output: [{ type: "input_text", text: "FreeContext is still running. Do not call it again; wait for this cell until the terminal result." }],
          internal_chat_message_metadata_passthrough: metadata,
        },
      }, {
        timestamp: "2026-08-09T00:00:10.000Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: "outer-001",
          output: "Script running with cell ID cell-001\n",
          internal_chat_message_metadata_passthrough: metadata,
        },
      }, {
        timestamp: "2026-08-09T00:00:10.100Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "wait",
          call_id: "wait-001",
          arguments: JSON.stringify({ cell_id: "cell-001", yield_time_ms: 300_000, max_tokens: 10_000 }),
          internal_chat_message_metadata_passthrough: metadata,
        },
      }, {
        timestamp: "2026-08-09T00:00:12.000Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "wait-001",
          output: [{ type: "input_text", text: "Script completed\n" }, { type: "input_text", text: observedText ?? "failed" }],
          internal_chat_message_metadata_passthrough: metadata,
        },
      });
    }
    if (includeDirectObservation) {
      const item = {
        id: session.invocation.callId,
        type: "mcp_tool_call",
        server: "freecontext",
        tool: "gather_context",
        arguments: session.request,
      };
      events.push({
        type: "item.started",
        item: { ...item, result: null, status: "in_progress" },
      });
      if (observedText !== null) {
        events.push({
          type: "item.completed",
          item: {
            ...item,
            result: {
              content: [{ type: "text", text: observedText }],
              structured_content: structuredContent ?? session.result,
            },
            status: "completed",
          },
        });
      }
      if (includeDuplicate) {
        const duplicate = {
          id: "call-duplicate",
          type: "mcp_tool_call",
          server: "freecontext",
          tool: "gather_context",
          arguments: session.request,
        };
        events.push({ type: "item.started", item: { ...duplicate, result: null, status: "in_progress" } }, {
          type: "item.completed",
          item: {
            ...duplicate,
            status: "completed",
            result: {
              content: [{ type: "text", text: "Status: failed" }],
              structured_content: { status: "failed" },
            },
          },
        });
      }
    }
    if (includeParentAction) {
      events.push({
        schemaVersion: "freecontext-parent-action-v1",
        taskId: "task-001",
        callId: session.invocation.callId,
        repetition: "r1",
        sequence: 1,
        action: {
          kind: "read",
          path: "src/router.ts",
          startLine: 1,
          endLine: 2,
          broad: false,
          gapQuestionIds: [],
        },
      });
    } else {
      events.push({
        timestamp: "2026-08-09T00:00:13.000Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "exec",
          call_id: "parent-read-001",
          input: 'const r = await tools.exec_command({cmd:"sed -n \'1,20p\' src/router.ts",workdir:"/workspace"}); text(r.output);',
        },
      }, {
        timestamp: "2026-08-09T00:00:14.000Z",
        type: "response_item",
        payload: { type: "custom_tool_call_output", call_id: "parent-read-001", output: "router" },
      });
    }
  } else if (observedText !== null) {
    events.push({ type: "freecontext_tool_output", payload: observedText });
  }
  events.push({ type: "other_context", payload: "after" });
  const masterRaw = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
  const sessionRaw = `${JSON.stringify(session, null, 2)}\n`;
  await Promise.all([
    writeFile(path.join(sessionDir, "rollout.jsonl"), masterRaw, "utf8"),
    writeFile(path.join(freeContextDir, "call-001.json"), sessionRaw, "utf8"),
  ]);
  return { agentDir, masterRaw, sessionRaw };
}

test("master context exporter joins v3 by session address and preserves the actual observation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "freecontext-master-"));
  try {
    const session = v3Session();
    const actualText = serializeForModel(session.result);
    const fixture = await createFixture(root, session, actualText, undefined, true, false, true);
    const outputPath = await exportMasterAgentContext({
      agentDir: fixture.agentDir,
      taskName: "TaskNameXXX",
      now: () => new Date("2026-08-09T01:00:00.000Z"),
    });
    const document = JSON.parse(await readFile(outputPath, "utf8")) as BenchmarkMasterAgentContext;
    const call = document.freeContextCalls[0];
    assert.equal(document.schemaVersion, "freecontext-master-agent-context-v3");
    assert.deepEqual(document.freeContextTransport, [{
      schemaVersion: "freecontext-transport-observation-v1",
      turnId: "turn-001",
      outerCallId: "outer-001",
      cellId: "cell-001",
      reminderCount: 1,
      sameCellWaitCount: 1,
      waitYieldTimeMs: [300_000],
      startedAt: "2026-08-09T00:00:00.000Z",
      completedAt: "2026-08-09T00:00:12.000Z",
      latencyMs: 12_000,
      terminalTextSha256: createHash("sha256").update(actualText).digest("hex"),
      terminalOutputSeen: true,
    }]);
    assert.equal(document.masterAgentContext[0]?.rawJsonl, fixture.masterRaw);
    assert.equal(call?.callId, "call-001");
    assert.equal(call?.outputToMasterAgent, actualText);
    assert.equal(call?.deliveryStatus, "matched");
    assert.equal(call?.callIdCorrelation, "unique");
    assert.equal(call?.sessionReferenceMatches, 1);
    assert.equal(call?.serializedTextSha256, call?.observedTextSha256);
    assert.equal(call?.requestMatches, true);
    assert.equal(call?.structuredContentMatches, true);
    assert.equal(call?.recoverableResult, null);
    assert.equal(call?.consumptionAudit?.observationSource, "explicit_host_event");
    assert.equal(call?.consumptionAudit?.firstActionEvidenceHit, true);
    assert.equal(call?.consumptionAudit?.evidenceConsumed, true);
    assert.equal(call?.consumptionAudit?.repeatedBroadSearch, false);
    assert.deepEqual(document.duplicateSemanticCalls, [{
      taskId: "task-001",
      callId: "call-duplicate",
      firstCallId: "call-001",
      duplicateOrdinal: 1,
      repetition: "r1",
    }]);
    const consumption = (await readFile(
      path.join(fixture.agentDir, "consumption-observations.jsonl"),
      "utf8",
    )).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(consumption.map(({ schemaVersion }) => schemaVersion), [
      "freecontext-consumption-audit-v2",
      "freecontext-duplicate-semantic-call-v1",
      "freecontext-transport-observation-v1",
    ]);
    assert.match(call?.promptToFreeContext ?? "", /evidenceQuestions/u);
    assert.equal(call?.fullSessionFile, "freecontext-sessions/call-001.json");
    assert.equal(call?.runtimeSessionFile, RUNTIME_SESSION);
    assert.equal(await readFile(path.join(fixture.agentDir, "freecontext-sessions", "call-001.json"), "utf8"), fixture.sessionRaw);
    assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
    const audit = (await readFile(path.join(fixture.agentDir, "delivery-observations.jsonl"), "utf8")).trim();
    const observation = JSON.parse(audit);
    assert.equal(observation.schemaVersion, "delivery-observation-v1");
    assert.equal(observation.callId, "call-001");
    assert.equal(observation.deliveryStatus, "matched");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("same-cell code-await output is the actual observation without a direct MCP item", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "freecontext-code-await-master-"));
  try {
    const base = v3Session();
    const session = {
      ...base,
      invocation: { ...base.invocation, callId: "cell-001" },
    };
    const actualText = serializeForModel(session.result);
    const fixture = await createFixture(root, session, actualText, undefined, false, false, true, false, false);
    const outputPath = await exportMasterAgentContext({
      agentDir: fixture.agentDir,
      taskName: "TaskNameXXX",
      now: () => new Date("2026-08-09T01:00:00.000Z"),
    });
    const document = JSON.parse(await readFile(outputPath, "utf8")) as BenchmarkMasterAgentContext;
    const call = document.freeContextCalls[0];
    assert.equal(call?.outputToMasterAgent, actualText);
    assert.equal(call?.deliveryStatus, "matched");
    assert.equal(call?.callIdCorrelation, "missing");
    assert.equal(call?.sessionReferenceMatches, 1);
    assert.equal(call?.consumptionAudit?.observationSource, "completed_codex_tool_call");
    assert.equal(call?.consumptionAudit?.firstActionEvidenceHit, true);
    assert.equal(call?.serializedTextSha256, call?.observedTextSha256);
    assert.equal(call?.requestMatches, null);
    assert.equal(call?.structuredContentMatches, null);
    assert.equal(call?.recoverableResult, null);
    assert.equal(document.freeContextTransport[0]?.terminalOutputSeen, true);
    assert.deepEqual(document.duplicateSemanticCalls, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("terminal text hash correlates a yielded cell when the MCP call id differs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "freecontext-hash-boundary-master-"));
  try {
    const session = v3Session();
    const actualText = serializeForModel(session.result);
    const fixture = await createFixture(root, session, actualText, undefined, false, false, true, false, false);
    const outputPath = await exportMasterAgentContext({
      agentDir: fixture.agentDir,
      taskName: "TaskNameXXX",
      now: () => new Date("2026-08-09T01:00:00.000Z"),
    });
    const document = JSON.parse(await readFile(outputPath, "utf8")) as BenchmarkMasterAgentContext;
    assert.notEqual(document.freeContextTransport[0]?.cellId, session.invocation.callId);
    assert.equal(document.freeContextTransport[0]?.terminalTextSha256, session.serializedTextSha256);
    assert.equal(document.freeContextCalls[0]?.consumptionAudit?.observationSource, "completed_codex_tool_call");
    assert.equal(document.freeContextCalls[0]?.consumptionAudit?.firstActionEvidenceHit, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fast code-await can correlate the completed outer exec call", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "freecontext-outer-await-master-"));
  try {
    const base = v3Session();
    const session = {
      ...base,
      invocation: { ...base.invocation, callId: "outer-001" },
    };
    const actualText = serializeForModel(session.result);
    const fixture = await createFixture(root, session, actualText, undefined, false, false, true, false, false);
    const outputPath = await exportMasterAgentContext({
      agentDir: fixture.agentDir,
      taskName: "TaskNameXXX",
      now: () => new Date("2026-08-09T01:00:00.000Z"),
    });
    const document = JSON.parse(await readFile(outputPath, "utf8")) as BenchmarkMasterAgentContext;
    assert.equal(document.freeContextCalls[0]?.consumptionAudit?.observationSource, "completed_codex_tool_call");
    assert.equal(document.freeContextCalls[0]?.consumptionAudit?.firstActionEvidenceHit, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("historical v2 sessions are read without rewriting their identity schema", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "freecontext-master-v2-"));
  try {
    const session = historicalV2Session();
    const actualText = serializeForModel(session.result);
    const fixture = await createFixture(root, session, actualText);
    const outputPath = await exportMasterAgentContext({
      agentDir: fixture.agentDir,
      taskName: "historical-v2",
      now: () => new Date("2026-08-09T01:00:00.000Z"),
    });
    const document = JSON.parse(await readFile(outputPath, "utf8")) as BenchmarkMasterAgentContext;
    assert.equal(document.freeContextCalls[0]?.deliveryStatus, "matched");
    assert.equal(document.freeContextCalls[0]?.sessionReferenceMatches, 1);
    assert.equal(
      await readFile(path.join(fixture.agentDir, "freecontext-sessions", "call-001.json"), "utf8"),
      fixture.sessionRaw,
    );
    assert.match(fixture.sessionRaw, /"freecontext-mcp-session-v2"/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session address stays primary when the transport call id is reused", () => {
  const first = v3Session();
  const secondResult = {
    ...first.result,
    sessionId: "call-002",
    sessionFile: "/logs/agent/freecontext-sessions/call-002.json",
  };
  const firstText = serializeForModel(first.result);
  const secondText = serializeForModel(secondResult);
  const calls = [{
    source: "direct_mcp" as const,
    callId: first.invocation.callId,
    startedSeen: true,
    arguments: first.request,
    text: firstText,
    structuredContent: first.result,
  }, {
    source: "direct_mcp" as const,
    callId: first.invocation.callId,
    startedSeen: true,
    arguments: first.request,
    text: secondText,
    structuredContent: secondResult,
  }];
  const firstDelivery = evaluateDelivery(
    calls,
    first.invocation.callId,
    first.request,
    first.result,
    createHash("sha256").update(firstText).digest("hex"),
  );
  const secondDelivery = evaluateDelivery(
    calls,
    first.invocation.callId,
    first.request,
    secondResult,
    createHash("sha256").update(secondText).digest("hex"),
  );

  assert.equal(firstDelivery.deliveryStatus, "matched");
  assert.equal(secondDelivery.deliveryStatus, "matched");
  assert.equal(firstDelivery.callIdCorrelation, "ambiguous");
  assert.equal(secondDelivery.callIdCorrelation, "ambiguous");
  assert.equal(firstDelivery.sessionReferenceMatches, 1);
  assert.equal(secondDelivery.sessionReferenceMatches, 1);
});

test("fast code-await transport completes without a reminder or wait", () => {
  const metadata = { turn_id: "turn-fast" };
  const raw = [{
    timestamp: "2026-08-09T00:00:00.000Z",
    type: "response_item",
    payload: {
      type: "custom_tool_call",
      name: "exec",
      call_id: "outer-fast",
      input: "notify(\"slow\"); const result = await tools.mcp__freecontext__gather_context(args);",
      internal_chat_message_metadata_passthrough: metadata,
    },
  }, {
    timestamp: "2026-08-09T00:00:07.999Z",
    type: "response_item",
    payload: {
      type: "custom_tool_call_output",
      call_id: "outer-fast",
      output: "Script completed\nterminal",
      internal_chat_message_metadata_passthrough: metadata,
    },
  }, {
    timestamp: "2026-08-09T00:00:08.000Z",
    type: "response_item",
    payload: {
      type: "function_call",
      name: "wait",
      call_id: "unrelated-wait",
      arguments: JSON.stringify({ cell_id: "another-cell", yield_time_ms: 300_000 }),
      internal_chat_message_metadata_passthrough: metadata,
    },
  }].map((event) => JSON.stringify(event)).join("\n");
  assert.deepEqual(collectFreeContextTransportObservations(raw), [{
    schemaVersion: "freecontext-transport-observation-v1",
    turnId: "turn-fast",
    outerCallId: "outer-fast",
    cellId: null,
    reminderCount: 0,
    sameCellWaitCount: 0,
    waitYieldTimeMs: [],
    startedAt: "2026-08-09T00:00:00.000Z",
    completedAt: "2026-08-09T00:00:07.999Z",
    latencyMs: 7_999,
    terminalTextSha256: null,
    terminalOutputSeen: true,
  }]);
});

test("v3 delivery mismatch and missing observation fail instead of reconstructing from session", async () => {
  for (const fixtureCase of ["mismatch", "missing"] as const) {
    const root = await mkdtemp(path.join(os.tmpdir(), "freecontext-master-"));
    try {
      const session = v3Session();
      const fixture = await createFixture(
        root,
        session,
        fixtureCase === "mismatch" ? "different text" : null,
      );
      await assert.rejects(
        exportMasterAgentContext({
          agentDir: fixture.agentDir,
          taskName: fixtureCase,
          allowUnreferencedSessions: true,
        }),
        fixtureCase === "mismatch" ? /does not match/u : /no actual observation/u,
      );
      const audit = JSON.parse(
        (await readFile(path.join(fixture.agentDir, "delivery-observations.jsonl"), "utf8")).trim(),
      );
      assert.equal(audit.deliveryStatus, fixtureCase);
      assert.equal(audit.recoverableResult.status, "ready");
      assert.equal(audit.outputToMasterAgent, fixtureCase === "mismatch" ? "different text" : null);
      assert.equal(audit.missingReturnCausalEvidence?.classification, fixtureCase === "missing" ? "harness" : undefined);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("missing delivery preserves both remote-provider and harness causal evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "freecontext-master-"));
  try {
    const fixture = await createFixture(root, providerFailedV3Session(), null, undefined, false, true);
    await assert.rejects(
      exportMasterAgentContext({ agentDir: fixture.agentDir, taskName: "mixed-missing" }),
      /no actual observation/u,
    );
    const audit = JSON.parse(
      (await readFile(path.join(fixture.agentDir, "delivery-observations.jsonl"), "utf8")).trim(),
    );
    assert.equal(audit.missingReturnCausalEvidence.classification, "mixed");
    assert.deepEqual(audit.missingReturnCausalEvidence.reasons, [
      "master_call_started_without_completion",
      "terminal_result_persisted",
      "terminal_provider_error",
      "provider_retry_exhausted_or_fatal",
    ]);
    assert.equal(audit.missingReturnCausalEvidence.providerFailures[0].failure.code, "SERVICE_BUSY");
    assert.equal(audit.missingReturnCausalEvidence.masterStartedSeen, true);
    assert.equal(JSON.stringify(audit.missingReturnCausalEvidence).includes("provider unavailable"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("v3 exporter rejects a session path that differs from its exported file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "freecontext-master-"));
  try {
    const session = v3Session();
    const mismatched = {
      ...session,
      result: { ...session.result, sessionFile: "/wrong/session.json" },
    };
    const fixture = await createFixture(root, mismatched, serializeForModel(mismatched.result));
    await assert.rejects(
      exportMasterAgentContext({ agentDir: fixture.agentDir, taskName: "path-mismatch" }),
      /path does not match exported file/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("historical benchmark sessions retain only an observation that actually appears in master JSONL", async () => {
  for (const observed of [true, false]) {
    const root = await mkdtemp(path.join(os.tmpdir(), "freecontext-master-"));
    try {
      const actualText = `compact output\n\nFreeContext full session: ${RUNTIME_SESSION}`;
      const fixture = await createFixture(root, legacySession(), observed ? actualText : null);
      const outputPath = await exportMasterAgentContext({
        agentDir: fixture.agentDir,
        taskName: "legacy",
        allowUnreferencedSessions: true,
      });
      const document = JSON.parse(await readFile(outputPath, "utf8")) as BenchmarkMasterAgentContext;
      const call = document.freeContextCalls[0];
      assert.equal(call?.deliveryStatus, observed ? "legacy_observed" : "missing");
      assert.equal(call?.outputToMasterAgent, observed ? actualText : null);
      assert.doesNotMatch(call?.outputToMasterAgent ?? "", /SESSION_RECONSTRUCTION_MUST_NOT_BE_USED/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("canonical Pier adapter registers direct MCP without legacy CLI wrappers", async () => {
  const source = await readFile(new URL("../benchmarks/deepswe/pier_codex_freecontext_agent.py", import.meta.url), "utf8");
  const freeContextConfig = await readFile(new URL("../benchmarks/deepswe/freecontext.toml", import.meta.url), "utf8");
  const explicitPolicies = `EXPLICIT_FC_FIRST_POLICY = (
    "[Benchmark arm policy: explicit_fc_first]\\n"
    "Before any repository exploration, use the installed FreeContext skill. "
    "The first tool cell must read only that SKILL.md; the next tool cell must call "
    "gather_context exactly once and wait for its terminal result. FreeContext must "
    "be the first repository exploration action. Do not use native repository reads "
    "or searches before it. Use four required outcome questions with implementation, "
    "caller, contract, and test minimumSpans of 2, 2, 1, and 1; do not split them into "
    "six shallow questions. For a partial result, read its evidence, then run one narrow "
    "native search batch for named gaps; never call FreeContext again."
)
EXPLICIT_NATIVE_ONLY_POLICY = (
    "[Benchmark arm policy: explicit_native_only]\\n"
    "FreeContext is disabled for this arm. Use native repository tools for exploration "
    "and do not invoke FreeContext."
)`;
  assert.equal(source.includes(explicitPolicies), true, "explicit arm policy text drifted");
  for (const pattern of [
    /\[mcp_servers\.freecontext\]/u,
    /enabled_tools = \["gather_context"\]/u,
    /tool_timeout_sec = 300/u,
    /bin\/freecontext-mcp\.mjs/u,
    /_REMOTE_WORKSPACE_ROOT = PurePosixPath\("\/app"\)/u,
    /args = \["--workspace-root", "\{_REMOTE_WORKSPACE_ROOT\.as_posix\(\)\}"\]/u,
    /--session-dir \{_REMOTE_SESSION_DIR\.as_posix\(\)\}/u,
    /--session-dir \{_REMOTE_SESSION_DIR\.as_posix\(\)\} \\"\$@\\"/u,
    /freecontext-benchmark-context\.mjs/u,
    /FREECONTEXT_PROVIDER_BOOTSTRAP_PROFILE/u,
    /return f"\{policy\}\\n\\n\[Upstream task instruction\]\\n\{instruction\}"/u,
    /compose_benchmark_instruction\(EXPLICIT_FC_FIRST_POLICY, instruction\)/u,
    /compose_benchmark_instruction\(EXPLICIT_NATIVE_ONLY_POLICY, instruction\)/u,
  ]) assert.match(source, pattern);
  for (const legacy of ["_GUIDANCE", "freecontext explore", "_REMOTE_WRAPPER", "write_stdin"]) {
    assert.equal(source.includes(legacy), false, `legacy adapter surface remains: ${legacy}`);
  }
  for (const implicitRoot of ["$PWD", "FREECONTEXT_WORKSPACE_ROOT"]) {
    assert.equal(source.includes(implicitRoot), false, `implicit workspace root remains: ${implicitRoot}`);
  }
  assert.match(freeContextConfig, /^api = "openai"$/mu);
  assert.match(freeContextConfig, /^model_id = "deepseek-v4-flash-0731"$/mu);
  assert.match(freeContextConfig, /^credential_env = "TOKENRHYTHM_API_KEY"$/mu);
});
