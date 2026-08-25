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
    taskText: "locate fixture evidence",
    workUnit: { outcome: "edit", goal: `Implement ${id}.` },
    knownRefs: knownPaths.map((path) => ({ kind: "path" as const, path })),
    evidenceQuestions: [{
      id,
      role: "implementation",
      question: `Where is ${id}?`,
      required: true,
      coverageTargets: [{
        id: `${id}-target`,
        subject: { kind: "symbol", symbol: id },
        factKind: "location",
        coverageMode: "single",
      }],
    }],
  };
}

function result(
  requestValue: FreeContextRequest,
  status: FreeContextResult["status"] = "ready",
  unresolvedTargetIds: readonly string[] = [],
): FreeContextResult {
  const firstQuestion = requestValue.evidenceQuestions[0]!;
  const firstTarget = firstQuestion.coverageTargets[0]!;
  const evidence = status === "not_found" || status === "failed" ? [] : [{
    id: "e1",
    role: "implementation" as const,
    path: `src/${firstTarget.id}.ts`,
    startLine: 1,
    endLine: 5,
    focusLine: 1,
    questionId: firstQuestion.id,
    targetId: firstTarget.id,
    why: "Defines the behavior.",
  }];
  return {
    status,
    summary: "Evidence found.",
    evidence,
    gaps: unresolvedTargetIds.flatMap((targetId) => {
      const question = requestValue.evidenceQuestions.find(({ coverageTargets }) => coverageTargets[0]?.id === targetId);
      return question ? [{ questionId: question.id, targetId, reason: "Not found yet." }] : [];
    }),
    handoff: evidence.length > 0 ? {
      id: `handoff:${firstQuestion.id}`,
      workUnit: requestValue.workUnit,
      evidenceIds: ["e1"],
      outcome: { kind: requestValue.workUnit.outcome, instruction: `Proceed with ${requestValue.workUnit.goal}` },
      blockingGaps: unresolvedTargetIds.flatMap((targetId) => {
        const question = requestValue.evidenceQuestions.find(({ coverageTargets }) => coverageTargets[0]?.id === targetId);
        const target = question?.coverageTargets[0];
        return question && target ? [{
          id: `gap:${targetId}`,
          targetId,
          kind: "source_unknown" as const,
          scope: target.subject,
          requiredFact: question.question,
        }] : [];
      }),
    } : null,
    nextAction: evidence[0]
      ? { kind: "consume_evidence", reason: "Use it." }
      : { kind: "exact_probe", reason: "Probe directly." },
    errorCode: status === "failed" ? "INTERNAL_ERROR" : null,
    sessionId: `session-${firstQuestion.id}`,
    sessionFile: `/logs/agent/freecontext-sessions/${firstQuestion.id}.json`,
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
  const implementation = request("implementation");
  const implementationResult = result(implementation);
  const tests = {
    ...request("tests"),
    workUnit: implementation.workUnit,
    reentry: {
      priorHandoff: implementationResult.handoff!,
      blockingGap: {
        id: "gap:tests-target",
        targetId: "tests-target",
        kind: "verification_unknown" as const,
        scope: { kind: "symbol" as const, symbol: "tests" },
        requiredFact: "Locate cross-file verification exposed by the edit.",
        origin: { kind: "edit" as const, changedPaths: ["src/implementation-target.ts"] },
      },
    },
  };
  const inputs = [
    input("call-2", tests, result(tests)),
    input("call-1", implementation, implementationResult),
  ];
  const transports = [
    transport("hash-call-1", "2026-08-21T00:00:00.000Z", "2026-08-21T00:00:10.000Z"),
    transport("hash-call-2", "2026-08-21T00:00:20.000Z", "2026-08-21T00:00:30.000Z"),
  ];
  const windows = buildFreeContextInvocationWindows(
    inputs,
    transports,
    ["2026-08-21T00:00:40.000Z"],
  );

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
    windowEndedBefore: "2026-08-21T00:00:40.000Z",
  }]);
  assert.ok(windows.every(({ windowObserved }) => windowObserved));

  for (const invalidBoundary of [
    [],
    [null],
    ["invalid"],
    ["2026-08-21T00:00:30.000Z"],
    ["2026-08-21T00:00:40.000Z", "2026-08-21T00:00:41.000Z"],
  ] as const) {
    const finalWindow = buildFreeContextInvocationWindows(inputs, transports, invalidBoundary).at(-1);
    assert.equal(finalWindow?.windowObserved, false);
    assert.equal(finalWindow?.windowEndedBefore, null);
    assert.deepEqual(finalWindow?.failureReasons, []);
  }
});

test("not_found exact probe round-trips through recovery into typed reentry", () => {
  const initial = request("missing");
  const missing = result(initial, "not_found");
  const recovery = {
    ...request("missing-recovery"),
    workUnit: initial.workUnit,
    recovery: {
      requestKind: "not_found_recovery" as const,
      priorSessionId: missing.sessionId,
      priorWorkUnit: initial.workUnit,
      probe: { kind: "exact_probe" as const, path: "src/missing.ts" },
    },
  };
  const recovered = result(recovery, "partial", ["missing-recovery-target"]);
  const reentry = {
    ...request("verification"),
    workUnit: initial.workUnit,
    reentry: {
      priorHandoff: recovered.handoff!,
      blockingGap: {
        id: "gap:verification-target",
        targetId: "verification-target",
        kind: "verification_unknown" as const,
        scope: { kind: "symbol" as const, symbol: "verification" },
        requiredFact: "Locate the verification exposed by the recovery result.",
        origin: { kind: "evidence_consumption" as const, evidenceIds: ["e1"] },
      },
    },
  };
  const windows = buildFreeContextInvocationWindows(
    [
      input("call-initial", initial, missing),
      input("call-recovery", recovery, recovered),
      input("call-reentry", reentry, result(reentry)),
    ],
    [
      transport("hash-call-initial", "2026-08-21T00:00:00.000Z", "2026-08-21T00:00:10.000Z"),
      transport("hash-call-recovery", "2026-08-21T00:00:20.000Z", "2026-08-21T00:00:30.000Z"),
      transport("hash-call-reentry", "2026-08-21T00:00:40.000Z", "2026-08-21T00:00:50.000Z"),
    ],
  );
  assert.deepEqual(windows.map(({ invocationKind, attemptAccepted }) => ({ invocationKind, attemptAccepted })), [
    { invocationKind: "initial", attemptAccepted: true },
    { invocationKind: "recovery", attemptAccepted: true },
    { invocationKind: "reentrant", attemptAccepted: true },
  ]);
  assert.deepEqual(windows[2]?.failureReasons, []);
});

test("not_found recovery is one-shot and cannot follow a handoff", () => {
  const initial = request("missing");
  const missing = result(initial, "not_found");
  const recovery = {
    ...request("recovery"),
    workUnit: initial.workUnit,
    recovery: {
      requestKind: "not_found_recovery" as const,
      priorSessionId: missing.sessionId,
      priorWorkUnit: initial.workUnit,
      probe: { kind: "exact_probe" as const, path: "src/missing.ts" },
    },
  };
  const repeated = buildFreeContextInvocationWindows(
    [input("initial", initial, missing), input("recovery-1", recovery, missing), input("recovery-2", recovery, missing)],
    [
      transport("hash-initial", "2026-08-21T00:00:00.000Z", "2026-08-21T00:00:10.000Z"),
      transport("hash-recovery-1", "2026-08-21T00:00:20.000Z", "2026-08-21T00:00:30.000Z"),
      transport("hash-recovery-2", "2026-08-21T00:00:40.000Z", "2026-08-21T00:00:50.000Z"),
    ],
  );
  assert.deepEqual(repeated[2]?.failureReasons, ["recovery_already_used"]);

  const recovered = result(recovery, "ready");
  const afterHandoff = buildFreeContextInvocationWindows(
    [input("initial", initial, missing), input("recovery", recovery, recovered), input("recovery-2", recovery, missing)],
    [
      transport("hash-initial", "2026-08-21T00:00:00.000Z", "2026-08-21T00:00:10.000Z"),
      transport("hash-recovery", "2026-08-21T00:00:20.000Z", "2026-08-21T00:00:30.000Z"),
      transport("hash-recovery-2", "2026-08-21T00:00:40.000Z", "2026-08-21T00:00:50.000Z"),
    ],
  );
  assert.deepEqual(afterHandoff[2]?.failureReasons, ["recovery_requires_prior_not_found_without_handoff"]);
});

test("a legal typed reentry stays accepted after an invalid ancestor", () => {
  const initial = request("implementation");
  const initialResult = result(initial);
  const invalid = request("invalid");
  const reentrant = {
    ...request("tests"),
    workUnit: initial.workUnit,
    reentry: {
      priorHandoff: initialResult.handoff!,
      blockingGap: {
        id: "gap:tests-target",
        targetId: "tests-target",
        kind: "verification_unknown" as const,
        scope: { kind: "symbol" as const, symbol: "tests" },
        requiredFact: "Locate the verification exposed by the edit.",
        origin: { kind: "edit" as const, changedPaths: ["src/implementation-target.ts"] },
      },
    },
  };
  const windows = buildFreeContextInvocationWindows(
    [
      input("call-initial", initial, initialResult),
      input("call-invalid", invalid, result(invalid)),
      input("call-reentry", reentrant, result(reentrant)),
    ],
    [
      transport("hash-call-initial", "2026-08-21T00:00:00.000Z", "2026-08-21T00:00:10.000Z"),
      transport("hash-call-invalid", "2026-08-21T00:00:20.000Z", "2026-08-21T00:00:30.000Z"),
      transport("hash-call-reentry", "2026-08-21T00:00:40.000Z", "2026-08-21T00:00:50.000Z"),
    ],
  );
  assert.equal(windows[1]?.attemptAccepted, false);
  assert.equal(windows[2]?.invocationKind, "reentrant");
  assert.equal(windows[2]?.attemptAccepted, true);
  assert.deepEqual(windows[2]?.failureReasons, []);
  assert.deepEqual(windows[2]?.chainFailureReasons, ["prior_invocation_invalid"]);
});

test("missing or rewritten reentry contracts fail closed", () => {
  const initialRequest = request("implementation");
  const initialResult = result(initialRequest, "partial", ["implementation-target"]);
  const noContract = { ...request("next"), workUnit: initialRequest.workUnit };
  const timings = [
    transport("hash-call-1", "2026-08-21T00:00:00.000Z", "2026-08-21T00:00:10.000Z"),
    transport("hash-call-2", "2026-08-21T00:00:20.000Z", "2026-08-21T00:00:30.000Z"),
  ];
  const missing = buildFreeContextInvocationWindows([
    input("call-1", initialRequest, initialResult),
    input("call-2", noContract, result(noContract)),
  ], timings);
  assert.deepEqual(missing[1]?.failureReasons, ["missing_reentry_contract"]);

  const rewritten = {
    ...initialRequest,
    reentry: {
      priorHandoff: initialResult.handoff!,
      blockingGap: {
        id: "gap:rewritten",
        targetId: "implementation-target",
        kind: "cross_file_unknown" as const,
        scope: initialRequest.evidenceQuestions[0]!.coverageTargets[0]!.subject,
        requiredFact: "Reword the existing gap.",
        origin: { kind: "evidence_consumption" as const, evidenceIds: ["e1"] },
      },
    },
  };
  const invalid = buildFreeContextInvocationWindows([
    input("call-1", initialRequest, initialResult),
    input("call-2", rewritten, result(rewritten)),
  ], timings);
  assert.deepEqual(invalid[1]?.failureReasons, ["invalid_reentry_contract"]);
});

test("missing transport evidence and overlapping invocations fail every window closed", () => {
  const implementation = request("implementation");
  const tests = request("tests");
  const inputs = [
    input("call-1", implementation, result(implementation)),
    input("call-2", tests, result(tests)),
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
