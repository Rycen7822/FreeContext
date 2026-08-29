import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BenchmarkMasterAgentContext } from "../src/benchmark/master-context.js";
import { exportMasterAgentContext } from "../src/benchmark/master-context.js";
import {
  FREECONTEXT_ELIGIBILITY_POLICY,
  normalizeFreeContextRequest,
  serializeForModel,
} from "../src/mcp/contracts.js";
import type { FreeContextHandoff } from "../src/mcp/contracts.js";
import { failedResult } from "../src/mcp/failure.js";
import type { McpSessionDocument } from "../src/mcp/session.js";
import { collectFreeContextTransportObservations, evaluateDelivery } from "../src/benchmark/delivery-observation.js";

const RUNTIME_SESSION = "/logs/agent/freecontext-sessions/call-001.json";

function v3Session(): McpSessionDocument {
  const request = {
    taskText: "locate the router",
    workUnit: { outcome: "answer" as const, goal: "Locate the router." },
    knownRefs: [{ kind: "path" as const, path: "src/router.ts" }],
    evidenceQuestions: [
      { id: "impl", role: "implementation" as const, question: "Where is the router?", required: true, coverageTargets: [{ id: "router", subject: { kind: "symbol" as const, symbol: "router" }, factKind: "definition" as const, coverageMode: "single" as const }] },
      { id: "tests", role: "test" as const, question: "How is it tested?", required: false, coverageTargets: [{ id: "router-tests", subject: { kind: "symbol" as const, symbol: "router" }, factKind: "verification" as const, coverageMode: "single" as const }] },
    ],
  };
  const result = {
    status: "ready" as const,
    summary: "router found",
    evidence: [{
      id: "e1",
      role: "implementation" as const,
      path: "src/router.ts",
      startLine: 1,
      endLine: 2,
      focusLine: 1,
      questionId: "impl",
      targetId: "router",
      excerpt: "export const router = true;",
      why: "Defines the route.",
    }],
    gaps: [{ questionId: "tests", targetId: "router-tests", reason: "No test was found." }],
    handoff: {
      id: "handoff:invocation-001",
      workUnit: request.workUnit,
      evidenceIds: ["e1"],
      outcome: { kind: request.workUnit.outcome, instruction: "Answer with the verified router evidence." },
      blockingGaps: [],
    },
    nextAction: {
      kind: "consume_evidence" as const,
      reason: "Use the route evidence.",
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
  includeRejectedTransport = false,
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
      if (includeRejectedTransport) {
        events.push({
          timestamp: "2026-08-08T23:59:58.000Z",
          type: "response_item",
          payload: {
            type: "custom_tool_call",
            name: "exec",
            call_id: "outer-rejected",
            input: "const result = await tools.mcp__freecontext__gather_context({ questions: [] }); notify(\"slow\");",
            internal_chat_message_metadata_passthrough: metadata,
          },
        }, {
          timestamp: "2026-08-08T23:59:59.000Z",
          type: "response_item",
          payload: {
            type: "custom_tool_call_output",
            call_id: "outer-rejected",
            output: [{ type: "input_text", text: "MCP error -32602: Input validation error" }],
            internal_chat_message_metadata_passthrough: metadata,
          },
        });
      }
      events.push({
        timestamp: "2026-08-09T00:00:00.000Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "exec",
          call_id: "outer-001",
          input: "const gather = tools.mcp__freecontext__gather_context; const result = await gather({ taskText: \"x\" }); text(result);",
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
  events.push({ type: "other_context", payload: "after" }, {
    timestamp: "2026-08-09T00:00:20.000Z",
    type: "event_msg",
    payload: { type: "task_complete" },
  });
  const masterRaw = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
  const sessionRaw = `${JSON.stringify(session, null, 2)}\n`;
  await Promise.all([
    writeFile(path.join(sessionDir, "rollout.jsonl"), masterRaw, "utf8"),
    writeFile(path.join(freeContextDir, "call-001.json"), sessionRaw, "utf8"),
  ]);
  return { agentDir, masterRaw, sessionRaw };
}

test("master context exporter joins an aliased v3 call and ignores its late diagnostic", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "freecontext-master-"));
  try {
    const session = v3Session();
    const actualText = serializeForModel(session.result);
    const fixture = await createFixture(root, session, actualText, undefined, true, false, true);
    await writeFile(
      path.join(fixture.agentDir, "freecontext-sessions", "call-001.late.json"),
      `${JSON.stringify({ schemaVersion: "freecontext-late-result-v2" })}\n`,
      "utf8",
    );
    const outputPath = await exportMasterAgentContext({
      agentDir: fixture.agentDir,
      taskName: "TaskNameXXX",
      now: () => new Date("2026-08-09T01:00:00.000Z"),
    });
    const document = JSON.parse(await readFile(outputPath, "utf8")) as BenchmarkMasterAgentContext;
    const call = document.freeContextCalls[0];
    assert.equal(document.schemaVersion, "freecontext-master-agent-context-v4");
    assert.equal(document.invocationProvenance.schemaVersion, "freecontext-invocation-provenance-v2");
    assert.equal(document.invocationProvenance.freshGate.schemaVersion, "freecontext-fresh-invocation-gate-v2");
    assert.equal("semanticallyAcceptedCalls" in (document.invocationProvenance.counts ?? {}), false);
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
    assert.equal(call?.consumptionAudit?.inlineEvidenceProvenanceComplete, true);
    assert.equal(call?.handoffProvenanceComplete, true);
    assert.equal(call?.consumptionAudit?.broadSearchCount, 0);
    assert.equal(call?.invocationKind, "initial");
    assert.equal(call?.windowObserved, true);
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
      "freecontext-consumption-audit-v6",
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
    assert.equal(call?.consumptionAudit?.inlineEvidenceProvenanceComplete, true);
    assert.equal(call?.handoffProvenanceComplete, true);
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

test("persisted nested MCP completion is an authoritative FreeContext delivery", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "freecontext-mcp-end-master-"));
  try {
    const base = v3Session();
    const callerRequest = {
      taskText: base.request.taskText,
      workUnit: base.request.workUnit,
      knownRefs: base.request.knownRefs,
      evidenceQuestions: base.request.evidenceQuestions.map(({ role, question, required, coverageTargets }) => ({
        role,
        question,
        required,
        target: coverageTargets[0]!,
      })),
    };
    const request = normalizeFreeContextRequest(callerRequest);
    const result = {
      ...base.result,
      evidence: base.result.evidence.map((item) => ({ ...item, questionId: "q1" })),
      gaps: base.result.gaps.map((gap) => ({ ...gap, questionId: "q2" })),
    };
    const actualText = serializeForModel(result);
    const session = {
      ...base,
      request,
      result,
      serializedTextSha256: createHash("sha256").update(actualText).digest("hex"),
    };
    const fixture = await createFixture(root, session, null, undefined, false, true, false, false, true);
    const completion = {
      timestamp: "2026-08-09T00:00:12.000Z",
      type: "event_msg",
      payload: {
        type: "mcp_tool_call_end",
        call_id: "exec-completed-001",
        duration: { secs: 12, nanos: 0 },
        invocation: {
          server: "freecontext",
          tool: "gather_context",
          arguments: callerRequest,
        },
        result: {
          Ok: {
            content: [{ type: "text", text: actualText }],
            structuredContent: session.result,
          },
        },
      },
    };
    await writeFile(
      path.join(fixture.agentDir, "sessions", "2026", "08", "09", "rollout.jsonl"),
      `${JSON.stringify(completion)}\n${fixture.masterRaw}`,
      "utf8",
    );

    const outputPath = await exportMasterAgentContext({
      agentDir: fixture.agentDir,
      taskName: "nested-mcp-completion",
    });
    const document = JSON.parse(await readFile(outputPath, "utf8")) as BenchmarkMasterAgentContext;
    const call = document.freeContextCalls[0];
    assert.equal(call?.deliveryStatus, "matched");
    assert.equal(call?.sessionReferenceMatches, 1);
    assert.equal(call?.requestMatches, true);
    assert.equal(call?.structuredContentMatches, true);
    assert.equal(call?.handoffProvenanceComplete, true);
    assert.equal(call?.invocationKind, "initial");
    assert.equal(call?.windowObserved, true);
    assert.equal(document.freeContextTransport[0]?.terminalOutputSeen, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejected request transports do not invalidate a matched session window", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "freecontext-rejected-transport-"));
  try {
    const session = v3Session();
    const actualText = serializeForModel(session.result);
    const fixture = await createFixture(root, session, actualText, undefined, false, false, true, false, true, true);
    const outputPath = await exportMasterAgentContext({ agentDir: fixture.agentDir, taskName: "rejected-transport" });
    const document = JSON.parse(await readFile(outputPath, "utf8")) as BenchmarkMasterAgentContext;
    assert.equal(document.freeContextTransport.length, 2);
    assert.equal(document.freeContextTransport[0]?.terminalTextSha256, null);
    assert.equal(document.freeContextCalls[0]?.invocationKind, "initial");
    assert.equal(document.freeContextCalls[0]?.windowObserved, true);
    assert.deepEqual(document.freeContextCalls[0]?.consumptionAudit?.failureReasons, []);
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
    assert.equal(document.freeContextCalls[0]?.consumptionAudit?.inlineEvidenceProvenanceComplete, true);
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
    assert.equal(document.freeContextCalls[0]?.consumptionAudit?.inlineEvidenceProvenanceComplete, true);
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

test("historical not_found sessions without recovery are explicitly legacy", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "freecontext-master-legacy-not-found-"));
  try {
    const base = historicalV2Session();
    const legacyResult = {
      ...base.result,
      status: "not_found" as const,
      evidence: [],
      gaps: [{ questionId: "implementation", reason: "No observed evidence." }],
      handoff: null,
      nextAction: { kind: "exact_probe" as const, reason: "Probe the exact path." },
      errorCode: null,
      sessionFile: null,
    };
    const session = { ...base, result: legacyResult } as ReturnType<typeof historicalV2Session>;
    const fixture = await createFixture(root, session, null);
    const outputPath = await exportMasterAgentContext({
      agentDir: fixture.agentDir,
      taskName: "legacy-not-found",
      allowUnreferencedSessions: true,
    });
    const document = JSON.parse(await readFile(outputPath, "utf8")) as BenchmarkMasterAgentContext;
    assert.equal(document.freeContextCalls[0]?.status, "not_found");
    assert.equal(document.freeContextCalls[0]?.deliveryStatus, "missing");
    assert.equal(document.invocationProvenance.availability, "evidence_unavailable");
    assert.deepEqual(document.invocationProvenance.freshGate.failures.map(({ code }) => code), ["evidence_unavailable", "counts_unavailable"]);
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

test("two-call export assigns each completed host cell to one disjoint invocation window", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "freecontext-windowed-master-"));
  try {
    const agentDir = path.join(root, "agent");
    const sessionDir = path.join(agentDir, "sessions", "2026", "08", "21");
    const freeContextDir = path.join(agentDir, "freecontext-sessions");
    await Promise.all([mkdir(sessionDir, { recursive: true }), mkdir(freeContextDir, { recursive: true })]);
    const makeSession = (
      callId: string,
      questionId: string,
      evidencePath: string,
      startedAt: string,
      finishedAt: string,
      priorHandoff: Readonly<FreeContextHandoff> | null = null,
    ): McpSessionDocument => {
      const base = v3Session();
      const sessionFile = `/logs/agent/freecontext-sessions/${callId}.json`;
      const workUnit = priorHandoff?.workUnit ?? { outcome: "answer" as const, goal: `Locate ${questionId}.` };
      const target = { id: `${questionId}-target`, subject: { kind: "symbol" as const, symbol: questionId }, factKind: "location" as const, coverageMode: "single" as const };
      const request = {
        taskText: `locate ${questionId}`,
        workUnit,
        knownRefs: [],
        evidenceQuestions: [{
          id: questionId,
          role: "implementation" as const,
          question: `Where is ${questionId}?`,
          required: true,
          coverageTargets: [target],
        }],
        ...(priorHandoff ? {
          reentry: {
            priorHandoff,
            blockingGap: {
              id: `gap:${questionId}-target`,
              targetId: target.id,
              kind: "contract_unknown" as const,
              scope: target.subject,
              requiredFact: `Locate ${questionId} after consuming prior Evidence.`,
              origin: { kind: "evidence_consumption" as const, evidenceIds: [priorHandoff.evidenceIds[0]!] },
            },
          },
        } : {}),
      };
      const result = {
        ...base.result,
        evidence: [{
          ...base.result.evidence[0]!,
          path: evidencePath,
          questionId,
          targetId: `${questionId}-target`,
        }],
        gaps: [],
        handoff: {
          id: `handoff:invocation-${callId}`,
          workUnit,
          evidenceIds: ["e1"],
          outcome: { kind: workUnit.outcome, instruction: `Proceed with ${workUnit.goal}` },
          blockingGaps: [],
        },
        nextAction: { kind: "consume_evidence" as const, reason: "Use it." },
        sessionId: callId,
        sessionFile,
      };
      const serialized = serializeForModel(result);
      return {
        ...base,
        startedAt,
        finishedAt,
        request,
        invocation: {
          ...base.invocation,
          invocationId: `invocation-${callId}`,
          callId,
          sessionId: callId,
          sessionFile,
        },
        result,
        serializedTextSha256: createHash("sha256").update(serialized).digest("hex"),
        terminalDecision: {
          ...base.terminalDecision,
          invocationId: `invocation-${callId}`,
          decidedAt: finishedAt,
        },
      };
    };
    const firstSession = makeSession("call-001", "implementation", "src/router.ts", "2026-08-21T00:00:00.000Z", "2026-08-21T00:00:10.000Z");
    const sessions = [firstSession, makeSession(
      "call-002", "contract", "src/contract.ts", "2026-08-21T00:00:20.000Z", "2026-08-21T00:00:30.000Z", firstSession.result.handoff ?? null,
    )];
    const events: unknown[] = [];
    for (const [index, session] of sessions.entries()) {
      const second = index === 1;
      const startedAt = second ? "2026-08-21T00:00:20.000Z" : "2026-08-21T00:00:00.000Z";
      const completedAt = second ? "2026-08-21T00:00:30.000Z" : "2026-08-21T00:00:10.000Z";
      const readStartedAt = second ? "2026-08-21T00:00:32.000Z" : "2026-08-21T00:00:12.000Z";
      const readCompletedAt = second ? "2026-08-21T00:00:33.000Z" : "2026-08-21T00:00:13.000Z";
      const serialized = serializeForModel(session.result);
      const outerCallId = `outer-${index + 1}`;
      events.push({
        timestamp: startedAt,
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "exec",
          call_id: outerCallId,
          input: "const result = await tools.mcp__freecontext__gather_context({taskText: \"x\"}); notify(\"running\"); text(result);",
        },
      }, {
        timestamp: completedAt,
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: outerCallId,
          output: [
            { type: "input_text", text: "Script completed\n" },
            { type: "input_text", text: serialized },
          ],
        },
      }, {
        type: "item.started",
        item: {
          id: session.invocation.callId,
          type: "mcp_tool_call",
          server: "freecontext",
          tool: "gather_context",
          arguments: session.request,
          result: null,
          status: "in_progress",
        },
      }, {
        type: "item.completed",
        item: {
          id: session.invocation.callId,
          type: "mcp_tool_call",
          server: "freecontext",
          tool: "gather_context",
          arguments: session.request,
          result: {
            content: [{ type: "text", text: serialized }],
            structured_content: session.result,
          },
          status: "completed",
        },
      }, {
        timestamp: readStartedAt,
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "exec",
          call_id: `read-${index + 1}`,
          input: `await tools.exec_command({cmd:"sed -n '1,2p' ${session.result.evidence[0]!.path}"});`,
        },
      }, {
        timestamp: readCompletedAt,
        type: "response_item",
        payload: { type: "custom_tool_call_output", call_id: `read-${index + 1}`, output: "ok" },
      });
    }
    events.push({
      timestamp: "2026-08-21T00:00:40.000Z",
      type: "event_msg",
      payload: { type: "task_complete" },
    });
    await Promise.all([
      writeFile(path.join(sessionDir, "rollout.jsonl"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8"),
      ...sessions.map((session) => writeFile(
        path.join(freeContextDir, `${session.invocation.callId}.json`),
        `${JSON.stringify(session, null, 2)}\n`,
        "utf8",
      )),
    ]);

    const outputPath = await exportMasterAgentContext({ agentDir, taskName: "two-call-window" });
    const document = JSON.parse(await readFile(outputPath, "utf8")) as BenchmarkMasterAgentContext;
    assert.deepEqual(document.freeContextCalls.map(({ invocationKind, episodeIndex, consumptionAudit }) => ({
      invocationKind,
      episodeIndex,
      failures: consumptionAudit?.failureReasons,
    })), [
      { invocationKind: "initial", episodeIndex: 1, failures: [] },
      { invocationKind: "reentrant", episodeIndex: 2, failures: [] },
    ]);
    assert.deepEqual(document.freeContextCalls.map(({ windowEndedBefore }) => windowEndedBefore), [
      "2026-08-21T00:00:20.000Z",
      "2026-08-21T00:00:40.000Z",
    ]);
    assert.deepEqual(document.freeContextCalls.map(({ consumptionAudit }) => consumptionAudit?.actionCount), [1, 1]);
    assert.ok(document.freeContextCalls.every(({ consumptionAudit }) =>
      consumptionAudit?.inlineEvidenceProvenanceComplete));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("canonical Pier adapter registers direct MCP without legacy CLI wrappers", async () => {
  const source = await readFile(new URL("../benchmarks/deepswe/pier_codex_freecontext_agent.py", import.meta.url), "utf8");
  const freeContextConfig = await readFile(new URL("../benchmarks/deepswe/freecontext.toml", import.meta.url), "utf8");
  const treatmentPolicy = source.match(/EXPLICIT_FC_FIRST_POLICY = \(([\s\S]*?)\n\)/u)?.[1] ?? "";
  const controlPolicy = source.match(/EXPLICIT_NATIVE_ONLY_POLICY = \(([\s\S]*?)\n\)/u)?.[1] ?? "";
  assert.doesNotMatch(treatmentPolicy, /curl|wget|raw GitHub|npm view|npm pack/iu);
  assert.doesNotMatch(controlPolicy, /curl|wget|raw GitHub|npm view|npm pack/iu);
  for (const fragment of [
    "COMMON_TASK_EFFECT_POLICY = (",
    "Do not use web search, curl, wget, raw GitHub, remote git clone/ls-remote/fetch, npm view/pack",
    "EXPLICIT_FC_FIRST_POLICY = (",
    "First read the installed skill; next construct its legal caller args once",
    "construct its legal caller args once, using workUnit.outcome=edit for edits and 2-4 concrete single targets by default",
    "as the only tool call in that assistant batch/code cell",
    "during dispatch do no native or other tool work and never parallelize",
    "If a cell ID returns, exclusively call functions.wait with yield_time_ms=300000 until terminal",
    "On terminal consume inline Evidence, handoff, and nextAction directly; before the first edit/check do not repeat Evidence-covered reads or broad discovery",
    "Evidence should already be brief and self-contained (normally 8-24 lines); do not depend on post-hoc fitter trimming",
    "nearest existing owner/seam, caller, or test convention",
    "base Codex config already owns developer_instructions",
    "EXPLICIT_NATIVE_ONLY_POLICY = (",
  ]) assert.equal(source.includes(fragment), true, `explicit arm policy fragment drifted: ${fragment}`);
  for (const retired of [
    "complete unresolved question",
    "same-work-unit follow-up",
    "private acceptance receipt",
    "Do not search, list, or open an uncited path first",
  ]) assert.equal(source.includes(retired), false);
  for (const gate of FREECONTEXT_ELIGIBILITY_POLICY.gates) assert.equal(source.includes(gate.instruction), false);
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
    /FREECONTEXT_PROVIDER_CONFIG_PATH/u,
    /freecontext_config\.toml/u,
    /def _bundled_provider_base_url\(\) -> str:/u,
    /default_route/u,
    /model_ids = route\.get\("models"\)/u,
    /provider_id = model\.get\("provider"\)/u,
    /def _freecontext_provider_api_key\(\) -> str:/u,
    /FREECONTEXT_PROVIDER_API_KEY/u,
    /return f"\{COMMON_TASK_EFFECT_POLICY\}\\n\\n\{policy\}\\n\\n\[Upstream task instruction\]\\n\{instruction\}"/u,
    /developer_instructions = \{json\.dumps\(EXPLICIT_FC_FIRST_POLICY\)\}/u,
    /def _freecontext_config_toml\(self, base_config: str \| None\) -> str:/u,
    /base_text = base_config or ""/u,
    /parsed_base = tomllib\.loads\(base_text\) if base_text\.strip\(\) else \{\}/u,
    /tomllib\.loads\(combined\)/u,
    /self\._config_toml = self\._freecontext_config_toml\(original_config_toml\)/u,
    /await super\(\)\.run\(\s+instruction,/u,
    /compose_benchmark_instruction\(EXPLICIT_NATIVE_ONLY_POLICY, instruction\)/u,
    /command="git config --local user\.name 'DeepSWE Benchmark Agent'"/u,
    /command="git config --local user\.email 'benchmark-agent@local\.invalid'"/u,
  ]) assert.match(source, pattern);
  assert.doesNotMatch(source, /compose_benchmark_instruction\(EXPLICIT_FC_FIRST_POLICY, instruction\)/u);
  assert.equal(source.includes("git reset --mixed"), false);
  for (const legacy of ["_GUIDANCE", "freecontext explore", "_REMOTE_WRAPPER", "write_stdin"]) {
    assert.equal(source.includes(legacy), false, `legacy adapter surface remains: ${legacy}`);
  }
  for (const implicitRoot of ["$PWD", "FREECONTEXT_WORKSPACE_ROOT"]) {
    assert.equal(source.includes(implicitRoot), false, `implicit workspace root remains: ${implicitRoot}`);
  }
  assert.match(freeContextConfig, /^api = "openai"$/mu);
  assert.match(freeContextConfig, /^model_id = "deepseek-v4-flash-0731"$/mu);
  assert.match(freeContextConfig, /^credential_env = "FREECONTEXT_PROVIDER_API_KEY"$/mu);
  assert.doesNotMatch(source, /model_providers/u);
});
