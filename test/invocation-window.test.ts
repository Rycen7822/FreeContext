import assert from "node:assert/strict";
import test from "node:test";
import type { FreeContextRequest, FreeContextResult } from "../src/mcp/contracts.js";
import type { FreeContextTransportObservation } from "../src/benchmark/delivery-observation.js";
import {
  buildFreeContextInvocationWindows,
  type FreeContextInvocationWindowInput,
} from "../src/benchmark/invocation-window.js";

function request(id: string, knownPaths: readonly string[] = []): FreeContextRequest {
  return {
    taskText: `locate ${id}`,
    knownRefs: knownPaths.map((path) => ({ kind: "path" as const, path })),
    evidenceQuestions: [{
      id,
      role: "implementation",
      question: `Where is ${id}?`,
      required: true,
    }],
  };
}

function result(
  id: string,
  status: FreeContextResult["status"] = "ready",
  gapIds: readonly string[] = [],
): FreeContextResult {
  const evidence = status === "not_found" || status === "failed" ? [] : [{
    role: "implementation" as const,
    path: `src/${id}.ts`,
    startLine: 1,
    endLine: 5,
    focusLine: 1,
    questionId: id,
    why: "Defines the behavior.",
  }];
  return {
    status,
    summary: "Evidence found.",
    evidence,
    gaps: gapIds.map((questionId) => ({ questionId, reason: "Not found yet." })),
    nextAction: evidence[0]
      ? { kind: "read", path: evidence[0].path, startLine: 1, endLine: 5, reason: "Read it." }
      : { kind: "direct_search", reason: "Search directly." },
    errorCode: status === "failed" ? "INTERNAL_ERROR" : null,
    sessionId: `session-${id}`,
    sessionFile: `/logs/agent/freecontext-sessions/${id}.json`,
  };
}

function input(
  callId: string,
  requestValue: FreeContextRequest,
  resultValue: FreeContextResult,
  hash = `hash-${callId}`,
): FreeContextInvocationWindowInput {
  return { callId, request: requestValue, result: resultValue, serializedTextSha256: hash };
}

function transport(
  hash: string,
  startedAt: string,
  completedAt: string | null,
): FreeContextTransportObservation {
  return {
    schemaVersion: "freecontext-transport-observation-v1",
    turnId: null,
    outerCallId: `outer-${hash}`,
    cellId: `cell-${hash}`,
    reminderCount: 0,
    sameCellWaitCount: 0,
    waitYieldTimeMs: [],
    startedAt,
    completedAt,
    latencyMs: null,
    terminalTextSha256: hash,
    terminalOutputSeen: completedAt !== null,
  };
}

test("ordered invocations produce disjoint initial and reentrant windows", () => {
  const windows = buildFreeContextInvocationWindows([
    input("call-2", request("tests"), result("tests")),
    input("call-1", request("implementation"), result("implementation")),
  ], [
    transport("hash-call-1", "2026-08-21T00:00:00.000Z", "2026-08-21T00:00:10.000Z"),
    transport("hash-call-2", "2026-08-21T00:00:20.000Z", "2026-08-21T00:00:30.000Z"),
  ]);

  assert.deepEqual(windows.map(({ callId, invocationKind, episodeIndex, windowStartedAfter, windowEndedBefore }) => ({
    callId, invocationKind, episodeIndex, windowStartedAfter, windowEndedBefore,
  })), [{
    callId: "call-1",
    invocationKind: "initial",
    episodeIndex: 1,
    windowStartedAfter: "2026-08-21T00:00:10.000Z",
    windowEndedBefore: "2026-08-21T00:00:20.000Z",
  }, {
    callId: "call-2",
    invocationKind: "reentrant",
    episodeIndex: 2,
    windowStartedAfter: "2026-08-21T00:00:30.000Z",
    windowEndedBefore: null,
  }]);
  assert.ok(windows.every(({ windowObserved }) => windowObserved));
});

test("an exact partial gap set with prior evidence refs stays in one episode", () => {
  const initialRequest = {
    ...request("implementation"),
    evidenceQuestions: [
      ...request("implementation").evidenceQuestions,
      { ...request("tests").evidenceQuestions[0]!, minimumSpans: 1 },
    ],
  };
  const initialResult = result("implementation", "partial", ["tests"]);
  const windows = buildFreeContextInvocationWindows([
    input("call-1", initialRequest, initialResult),
    input("call-2", request("tests", ["src/implementation.ts"]), result("tests")),
  ], [
    transport("hash-call-1", "2026-08-21T00:00:00.000Z", "2026-08-21T00:00:10.000Z"),
    transport("hash-call-2", "2026-08-21T00:00:20.000Z", "2026-08-21T00:00:30.000Z"),
  ]);

  assert.equal(windows[1]?.invocationKind, "gap_followup");
  assert.equal(windows[1]?.episodeIndex, 1);
});

test("exact replay and malformed gap follow-up are invalid without hiding their time windows", () => {
  const replay = request("implementation");
  const replayWindows = buildFreeContextInvocationWindows([
    input("call-1", replay, result("implementation")),
    input("call-2", {
      ...replay,
      evidenceQuestions: replay.evidenceQuestions.map((question) => ({ ...question, minimumSpans: 1 })),
    }, result("implementation")),
  ], [
    transport("hash-call-1", "2026-08-21T00:00:00.000Z", "2026-08-21T00:00:10.000Z"),
    transport("hash-call-2", "2026-08-21T00:00:20.000Z", "2026-08-21T00:00:30.000Z"),
  ]);
  assert.equal(replayWindows[1]?.invocationKind, "invalid");
  assert.equal(replayWindows[1]?.exactDuplicate, true);
  assert.equal(replayWindows[1]?.windowObserved, true);

  const gapWindows = buildFreeContextInvocationWindows([
    input("call-1", request("implementation"), result("implementation", "partial", ["tests"])),
    input("call-2", request("tests"), result("tests")),
  ], [
    transport("hash-call-1", "2026-08-21T00:00:00.000Z", "2026-08-21T00:00:10.000Z"),
    transport("hash-call-2", "2026-08-21T00:00:20.000Z", "2026-08-21T00:00:30.000Z"),
  ]);
  assert.equal(gapWindows[1]?.invocationKind, "invalid");
  assert.deepEqual(gapWindows[1]?.failureReasons, ["invalid_gap_followup"]);

  const expandedGapRequest = {
    ...request("tests", ["src/implementation.ts"]),
    evidenceQuestions: [
      ...request("tests", ["src/implementation.ts"]).evidenceQuestions,
      { id: "new-question", role: "caller" as const, question: "Who calls it?", required: false },
    ],
  };
  const expanded = buildFreeContextInvocationWindows([
    input("call-1", {
      ...request("implementation"),
      evidenceQuestions: [
        ...request("implementation").evidenceQuestions,
        ...request("tests").evidenceQuestions,
      ],
    }, result("implementation", "partial", ["tests"])),
    input("call-2", expandedGapRequest, result("tests")),
  ], [
    transport("hash-call-1", "2026-08-21T00:00:00.000Z", "2026-08-21T00:00:10.000Z"),
    transport("hash-call-2", "2026-08-21T00:00:20.000Z", "2026-08-21T00:00:30.000Z"),
  ]);
  assert.deepEqual(expanded[1]?.failureReasons, ["invalid_gap_followup"]);
});

test("reentrant invocations reject resolved question reuse and more than four new questions", () => {
  const timings = [
    transport("hash-call-1", "2026-08-21T00:00:00.000Z", "2026-08-21T00:00:10.000Z"),
    transport("hash-call-2", "2026-08-21T00:00:20.000Z", "2026-08-21T00:00:30.000Z"),
  ];
  const mixed = buildFreeContextInvocationWindows([
    input("call-1", request("implementation"), result("implementation")),
    input("call-2", {
      ...request("tests"),
      evidenceQuestions: [
        ...request("implementation").evidenceQuestions,
        ...request("tests").evidenceQuestions,
      ],
    }, result("tests")),
  ], timings);
  assert.equal(mixed[1]?.invocationKind, "invalid");
  assert.deepEqual(mixed[1]?.failureReasons, ["resolved_question_reuse"]);

  const tooMany = buildFreeContextInvocationWindows([
    input("call-1", request("implementation"), result("implementation")),
    input("call-2", {
      ...request("new-1"),
      evidenceQuestions: ["new-1", "new-2", "new-3", "new-4", "new-5"]
        .flatMap((id) => request(id).evidenceQuestions),
    }, result("new-1")),
  ], timings);
  assert.equal(tooMany[1]?.invocationKind, "invalid");
  assert.deepEqual(tooMany[1]?.failureReasons, ["invalid_reentrant_question_count"]);
});

test("missing transport evidence and overlapping invocations fail every window closed", () => {
  const inputs = [
    input("call-1", request("implementation"), result("implementation")),
    input("call-2", request("tests"), result("tests")),
  ];
  const missing = buildFreeContextInvocationWindows(inputs, [
    transport("hash-call-1", "2026-08-21T00:00:00.000Z", "2026-08-21T00:00:10.000Z"),
    transport("hash-call-2", "2026-08-21T00:00:20.000Z", null),
  ]);
  assert.ok(missing.every(({ windowObserved, invocationKind }) => !windowObserved && invocationKind === "invalid"));
  assert.deepEqual(missing[0]?.failureReasons, ["missing_transport_timestamp"]);

  const overlap = buildFreeContextInvocationWindows(inputs, [
    transport("hash-call-1", "2026-08-21T00:00:00.000Z", "2026-08-21T00:00:20.000Z"),
    transport("hash-call-2", "2026-08-21T00:00:10.000Z", "2026-08-21T00:00:30.000Z"),
  ]);
  assert.ok(overlap.every(({ windowObserved }) => !windowObserved));
  assert.deepEqual(overlap[0]?.failureReasons, ["overlapping_invocation"]);

  const duplicateCallId = buildFreeContextInvocationWindows([
    inputs[0]!,
    { ...inputs[1]!, callId: "call-1" },
  ], []);
  assert.deepEqual(duplicateCallId[0]?.failureReasons, ["duplicate_call_id"]);

  const orphan = buildFreeContextInvocationWindows(inputs, [
    transport("hash-call-1", "2026-08-21T00:00:00.000Z", "2026-08-21T00:00:10.000Z"),
    transport("hash-call-2", "2026-08-21T00:00:20.000Z", "2026-08-21T00:00:30.000Z"),
    transport("orphan", "2026-08-21T00:00:40.000Z", "2026-08-21T00:00:50.000Z"),
  ]);
  assert.deepEqual(orphan[0]?.failureReasons, ["orphan_transport"]);
});
