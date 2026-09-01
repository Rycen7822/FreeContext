import assert from "node:assert/strict";
import test from "node:test";
import { adaptHistoricalInvocationProvenanceV1, collectInvocationProvenance, evaluateFreshInvocationGate } from "../src/benchmark/invocation-provenance.js";
import type { ObservedMcpCall } from "../src/benchmark/delivery-observation.js";
import { FreeContextRequestSchema, normalizeFreeContextContinuationRequest, normalizeFreeContextRequest, serializeForModel } from "../src/mcp/contracts.js";
import type { FreeContextRequest, FreeContextResult } from "../src/mcp/contracts.js";

function request(targetId: string, reentry?: FreeContextRequest["reentry"]): FreeContextRequest {
  return normalizeFreeContextRequest({
    taskText: "trace provenance",
    workUnit: { outcome: "edit", goal: "Implement the requested change." },
    evidenceQuestions: [{
      role: "implementation",
      question: reentry?.blockingGap.requiredFact ?? `Locate ${targetId}.`,
      required: true,
      target: { subject: { kind: "symbol", symbol: targetId } },
    }],
    knownRefs: [],
    ...(reentry ? { reentry } : {}),
  });
}

function result(requestValue: FreeContextRequest, status: FreeContextResult["status"], gap = false): FreeContextResult {
  const target = requestValue.evidenceQuestions[0]!.coverageTargets[0]!;
  const evidence = status === "not_found" || status === "failed" ? [] : [{
    id: "e1", role: "implementation" as const, path: "src/owner.ts", startLine: 1, endLine: 2, focusLine: 1,
    questionId: requestValue.evidenceQuestions[0]!.id, targetId: target.id, excerpt: "export const owner = true;", why: "Defines the owner.",
  }];
  const handoff = evidence.length > 0 ? {
    id: `handoff:${target.id}`,
    workUnit: requestValue.workUnit,
    evidenceIds: ["e1"],
    outcome: { kind: requestValue.workUnit.outcome, instruction: "Proceed with the edit." },
    addressedFacts: [{
      questionId: requestValue.evidenceQuestions[0]!.id,
      targetId: target.id,
      scope: target.subject,
      requiredFact: requestValue.evidenceQuestions[0]!.question,
    }],
    blockingGaps: gap ? [{ id: "gap:owner", targetId: target.id, kind: "source_unknown" as const, scope: target.subject, requiredFact: "Find the owner." }] : [],
  } : null;
  const subjectKey = target.subject.kind === "symbol"
    ? target.subject.symbol
    : target.subject.kind === "topic"
      ? target.subject.topic
      : target.subject.path;
  const sessionId = `session-${target.subject.kind}-${subjectKey}-${status}`;
  return {
    status,
    summary: "Trace result.",
    evidence,
    gaps: gap ? [{ questionId: "q1", targetId: target.id, reason: "The target remains unresolved." }] : [],
    ...(handoff ? { handoff } : { handoff: null }),
    nextAction: evidence.length > 0
      ? { kind: "consume_evidence" as const, reason: "Consume the evidence." }
      : status === "not_found"
        ? { kind: "exact_probe" as const, reason: "Probe exactly.", recovery: { priorSessionId: sessionId } }
        : { kind: "native_exploration" as const, reason: "Continue native exploration." },
    errorCode: status === "failed" ? "INVALID_REQUEST" as const : null,
    sessionId,
    sessionFile: `/logs/agent/freecontext-sessions/${target.id}.json`,
  };
}

function caller(requestValue: FreeContextRequest): unknown {
  if (requestValue.recovery) return { recovery: requestValue.recovery };
  return {
    taskText: requestValue.taskText,
    workUnit: requestValue.workUnit,
    knownRefs: requestValue.knownRefs,
    evidenceQuestions: requestValue.evidenceQuestions.map((question) => ({
      role: question.role,
      question: question.question,
      required: question.required,
      target: { subject: question.coverageTargets[0]!.subject },
    })),
    ...(requestValue.reentry ? { reentry: requestValue.reentry } : {}),
  };
}

function recoveryRequest(requestValue: FreeContextRequest, priorSessionId: string): FreeContextRequest {
  return FreeContextRequestSchema.parse({
    taskText: requestValue.taskText,
    workUnit: requestValue.workUnit,
    knownRefs: requestValue.knownRefs,
    evidenceQuestions: requestValue.evidenceQuestions,
    recovery: {
      priorSessionId,
      probePath: "src/owner.ts",
    },
  });
}

function call(callId: string, argumentsValue: unknown, structuredContent: unknown): ObservedMcpCall {
  return { source: "direct_mcp", callId, startedSeen: true, arguments: argumentsValue, text: "result", structuredContent };
}

test("raw invocation provenance keeps rejected attempts and accepted descendants distinct", () => {
  const initial = request("owner");
  const notFound = result(initial, "not_found");
  const partial = result(initial, "partial", true);
  const reentryRequest = request("owner", {
    priorHandoff: partial.handoff!,
    blockingGap: {
      id: "gap:owner-child", targetId: "target:q1", kind: "verification_unknown",
      questionId: "q1",
      scope: { kind: "symbol", symbol: "owner" }, requiredFact: "Find the caller exposed by the focused edit.",
      derivation: { kind: "gap_concretization", parentGapId: "gap:owner" },
      origin: { kind: "edit", changedPaths: ["src/owner.ts"] },
    },
  });
  const ready = result(reentryRequest, "ready");
  const secondReentryRequest = request("final", {
    priorHandoff: ready.handoff!,
    blockingGap: {
      id: "gap:final", targetId: "target:q1", kind: "verification_unknown",
      questionId: "q1",
      scope: { kind: "symbol", symbol: "final" }, requiredFact: "Find the final owner.",
      derivation: { kind: "handoff_child", parentHandoffId: ready.handoff!.id },
      origin: { kind: "check", check: "run the focused check" },
    },
  });
  const finalResult = result(secondReentryRequest, "ready");
  const duplicateGapRequest = request("duplicate", {
    priorHandoff: partial.handoff!,
    blockingGap: {
      id: "gap:owner", targetId: "target:q1", kind: "verification_unknown",
      questionId: "q1",
      scope: { kind: "symbol", symbol: "owner" }, requiredFact: "Repeat the old gap.",
      derivation: { kind: "gap_concretization", parentGapId: "gap:owner" },
      origin: { kind: "edit", changedPaths: ["src/other.ts"] },
    },
  });
  const invalidInitial = caller(initial) as Record<string, unknown>;
  invalidInitial.evidenceQuestions = [{ role: "implementation", question: "Locate owner.", required: true, target: { subject: { kind: "symbol", symbol: "owner" }, coverageMode: "single" } }];
  const calls: ObservedMcpCall[] = [
    call("call-1", invalidInitial, null),
    call("call-2", caller(initial), notFound),
    call("call-3", caller(initial), partial),
    call("call-4", caller(duplicateGapRequest), { status: "failed", summary: "invalid", evidence: [], gaps: [], nextAction: { kind: "native_exploration", reason: "invalid" }, errorCode: "INVALID_REQUEST", sessionId: "call-4", sessionFile: null }),
    call("call-5", caller(reentryRequest), ready),
    call("call-6", caller(secondReentryRequest), finalResult),
  ];
  const sessions = [
    { callId: "call-2", request: initial, result: notFound, capture: { primary: { metrics: { providerAttempts: 1 } } } },
    { callId: "call-3", request: initial, result: partial, capture: { primary: { metrics: { providerAttempts: 1 } } } },
    { callId: "call-5", request: reentryRequest, result: ready, capture: { primary: { metrics: { providerAttempts: 1 } } } },
    { callId: "call-6", request: secondReentryRequest, result: finalResult, capture: { primary: { metrics: { providerAttempts: 1 } } } },
  ];
  const provenance = collectInvocationProvenance({ calls, sessions });
  assert.deepEqual(provenance.counts, {
    attemptedCalls: 6,
    schemaAcceptedCalls: 5,
    intrinsicAcceptedCalls: 4,
    chainAcceptedCalls: 3,
    committedCalls: 4,
    providerExecutedCalls: 4,
  });
  assert.deepEqual(provenance.attempts.map(({ schema, intrinsic, chain, committed }) => ({
    schema: schema.status,
    intrinsic: intrinsic.status,
    chain: chain.status,
    committed: committed.status,
  })), [
    { schema: "rejected", intrinsic: "not_evaluated", chain: "not_evaluated", committed: "not_evaluated" },
    { schema: "accepted", intrinsic: "accepted", chain: "accepted", committed: "accepted" },
    { schema: "accepted", intrinsic: "accepted", chain: "rejected", committed: "accepted" },
    { schema: "accepted", intrinsic: "rejected", chain: "not_evaluated", committed: "not_evaluated" },
    { schema: "accepted", intrinsic: "accepted", chain: "accepted", committed: "accepted" },
    { schema: "accepted", intrinsic: "accepted", chain: "accepted", committed: "accepted" },
  ]);
  assert.equal(provenance.attempts[4]?.invocationKind, "reentrant");
  assert.equal(provenance.attempts[4]?.continuationRelation, "gap_concretization");
  assert.deepEqual(provenance.attempts[4]?.chain.failureReasons, []);
  assert.ok((provenance.attempts[4]?.inheritedAncestryFailures.length ?? 0) > 0);
  assert.match(provenance.attempts[0]?.schema.failureReasons[0] ?? "", /^schema_rejection:/u);
  assert.equal(serializeForModel(notFound).includes("Recovery contract"), true);
  assert.equal(provenance.freshGate.accepted, false);
  assert.deepEqual(
    [...new Set(provenance.freshGate.failures.map(({ code }) => code))].sort(),
    ["chain_rejection", "correlation_mismatch", "inherited_ancestry_failure", "intrinsic_rejection", "schema_rejection"].sort(),
  );
  assert.equal(provenance.attempts[4]?.intrinsic.status, "accepted");
  assert.equal(provenance.attempts[4]?.chain.status, "accepted");
  assert.equal(provenance.attempts[5]?.continuationRelation, "handoff_child");
});

test("fresh invocation gate accepts a clean initial and typed reentry chain", () => {
  const initial = request("owner");
  const partial = result(initial, "partial", true);
  const reentryRequest = request("next", {
    priorHandoff: partial.handoff!,
    blockingGap: {
      id: "gap:next", targetId: "target:q1", kind: "verification_unknown",
      questionId: "q1",
      scope: { kind: "symbol", symbol: "next" }, requiredFact: "Find the next owner.",
      derivation: { kind: "gap_concretization", parentGapId: "gap:owner" },
      origin: { kind: "edit", changedPaths: ["src/owner.ts"] },
    },
  });
  const ready = result(reentryRequest, "ready");
  const provenance = collectInvocationProvenance({
    calls: [call("initial", caller(initial), partial), call("reentry", caller(reentryRequest), ready)],
    sessions: [
      { callId: "initial", request: initial, result: partial, capture: { primary: { metrics: { providerAttempts: 1 } } } },
      { callId: "reentry", request: reentryRequest, result: ready, capture: { primary: { metrics: { providerAttempts: 1 } } } },
    ],
  });
  assert.equal(provenance.freshGate.accepted, true);
  assert.deepEqual(provenance.freshGate.failures, []);
  assert.equal(provenance.attempts[0]?.correlation.status, "accepted");
});

test("provenance accepts an initial call followed by a compact continuation", () => {
  const initial = request("owner");
  const partial = result(initial, "partial", true);
  const compact = {
    reentry: {
      priorSessionId: partial.sessionId,
      question: {
        role: "implementation" as const,
        question: "Find the next owner.",
        target: { subject: { kind: "symbol" as const, symbol: "next" } },
      },
      origin: { kind: "edit" as const, changedPaths: ["src/owner.ts"] },
    },
  };
  const continuation = normalizeFreeContextContinuationRequest(compact.reentry, initial, partial.handoff!);
  const ready = result(continuation, "ready");
  const provenance = collectInvocationProvenance({
    calls: [call("initial", caller(initial), partial), call("compact", compact, ready)],
    sessions: [
      { callId: "initial", request: initial, result: partial, capture: { primary: { metrics: { providerAttempts: 1 } } } },
      { callId: "compact", request: continuation, result: ready, capture: { primary: { metrics: { providerAttempts: 1 } } } },
    ],
  });
  const second = provenance.attempts[1];
  assert.equal(second?.schema.status, "accepted");
  assert.equal(second?.intrinsic.status, "accepted");
  assert.equal(second?.chain.status, "accepted");
  assert.equal(second?.correlation.status, "accepted");
  assert.equal(second?.committed.status, "accepted");
  assert.equal(second?.providerExecuted.status, "accepted");
  assert.equal(second?.invocationKind, "reentrant");
  assert.equal(second?.continuationRelation, "handoff_child");
});

test("synthetic call ids require structured or unique exact session correlation evidence", () => {
  const initial = request("owner");
  const ready = result(initial, "ready");
  const runtimeSession = {
    callId: "runtime-call",
    request: initial,
    result: ready,
    capture: { primary: { metrics: { providerAttempts: 1 } } },
  };
  const attempt = (observed: ObservedMcpCall, sessions = [runtimeSession]) =>
    collectInvocationProvenance({ calls: [observed], sessions }).attempts[0];

  const structured = attempt({
    source: "direct_mcp",
    callId: "exec-structured",
    startedSeen: true,
    arguments: caller(initial),
    text: "terminal result",
    structuredContent: ready,
  });
  assert.equal(structured?.correlation.status, "accepted");

  const exactCallId = attempt({
    source: "direct_mcp",
    callId: "runtime-call",
    startedSeen: true,
    arguments: caller(initial),
    text: "terminal result",
    structuredContent: null,
  });
  assert.equal(exactCallId?.correlation.status, "accepted");

  const textBound = attempt({
    source: "direct_mcp",
    callId: "exec-text",
    startedSeen: true,
    arguments: caller(initial),
    text: `Status: ready\nSession: ${ready.sessionFile}`,
    structuredContent: null,
  });
  assert.equal(textBound?.correlation.status, "accepted");

  const secondResult = { ...ready, sessionId: "second-session", sessionFile: "/logs/agent/freecontext-sessions/second-session.json" };
  const ambiguous = attempt({
    source: "direct_mcp",
    callId: "exec-ambiguous",
    startedSeen: true,
    arguments: caller(initial),
    text: `Session: ${ready.sessionFile}\nSession: ${secondResult.sessionFile}`,
    structuredContent: null,
  }, [runtimeSession, { ...runtimeSession, callId: "second-runtime-call", result: secondResult }]);
  assert.deepEqual(ambiguous?.correlation, {
    status: "rejected",
    failureReasons: ["call_session_correlation_mismatch"],
  });

  const mismatched = attempt({
    source: "direct_mcp",
    callId: "exec-mismatched",
    startedSeen: true,
    arguments: caller(initial),
    text: `Session: ${ready.sessionFile}`,
    structuredContent: { ...ready, sessionId: "missing-session" },
  });
  assert.deepEqual(mismatched?.correlation, {
    status: "rejected",
    failureReasons: ["call_session_correlation_mismatch"],
  });
});

test("fresh gate rejects legacy and inconsistent provenance without inferring a pass", () => {
  const legacy = collectInvocationProvenance({ calls: [], sessions: [] });
  assert.equal(legacy.freshGate.accepted, false);
  assert.deepEqual(legacy.freshGate.failures.map(({ code }) => code), ["evidence_unavailable", "counts_unavailable"]);

  const initial = request("owner");
  const partial = result(initial, "partial", true);
  const snapshot = {
    availability: "observed" as const,
    counts: {
      attemptedCalls: 1,
      schemaAcceptedCalls: 1,
      intrinsicAcceptedCalls: 1,
      chainAcceptedCalls: 1,
      committedCalls: 1,
      providerExecutedCalls: 1,
    },
    attempts: [{
      attemptIndex: 1,
      callId: "call-1",
      schema: { status: "accepted" as const, failureReasons: [] },
      intrinsic: { status: "accepted" as const, failureReasons: [] },
      chain: { status: "accepted" as const, failureReasons: [] },
      correlation: { status: "accepted" as const, failureReasons: [] },
      committed: { status: "accepted" as const, failureReasons: [] },
      providerExecuted: { status: "accepted" as const, failureReasons: [] },
      resultContract: "current" as const,
      resultStatus: partial.status,
      invocationKind: "initial" as const,
      continuationRelation: null,
      inheritedAncestryFailures: [],
    }],
  };
  const mismatch = evaluateFreshInvocationGate({ ...snapshot, counts: { ...snapshot.counts, attemptedCalls: 2 } });
  assert.equal(mismatch.accepted, false);
  assert.equal(mismatch.failures[0]?.code, "counts_mismatch");
});

test("v3 separates failed-to-recovery chain rejection from intrinsic acceptance", () => {
  const initial = request("owner");
  const failed = result(initial, "failed");
  const recovery = recoveryRequest(initial, failed.sessionId);
  const partial = result(recovery, "partial", true);
  const provenance = collectInvocationProvenance({
    calls: [call("failed", caller(initial), failed), call("recovery", caller(recovery), partial)],
    sessions: [
      { callId: "failed", request: initial, result: failed, capture: { primary: { metrics: { providerAttempts: 1 } } } },
      { callId: "recovery", request: recovery, result: partial, capture: { primary: { metrics: { providerAttempts: 1 } } } },
    ],
  });
  assert.deepEqual(provenance.counts, {
    attemptedCalls: 2,
    schemaAcceptedCalls: 2,
    intrinsicAcceptedCalls: 2,
    chainAcceptedCalls: 1,
    committedCalls: 2,
    providerExecutedCalls: 2,
  });
  assert.equal(provenance.attempts[1]?.intrinsic.status, "accepted");
  assert.equal(provenance.attempts[1]?.chain.status, "rejected");
  assert.equal(provenance.attempts[1]?.chain.failureReasons[0], "recovery_requires_prior_not_found_without_handoff");
  assert.equal(provenance.freshGate.accepted, false);
  assert.equal(provenance.freshGate.failures.some(({ code }) => code === "chain_rejection"), true);
  assert.equal(provenance.freshGate.failures.some(({ code }) => code === "impossible_commit_state"), false);
});

test("v3 gate rejects impossible correlations without collapsing layer facts", () => {
  const base = {
    attemptIndex: 1,
    callId: "synthetic",
    schema: { status: "accepted" as const, failureReasons: [] },
    intrinsic: { status: "accepted" as const, failureReasons: [] },
    chain: { status: "accepted" as const, failureReasons: [] },
    correlation: { status: "accepted" as const, failureReasons: [] },
    committed: { status: "accepted" as const, failureReasons: [] },
    providerExecuted: { status: "accepted" as const, failureReasons: [] },
    resultContract: "current" as const,
    resultStatus: "ready" as const,
    invocationKind: "initial" as const,
    continuationRelation: null,
    inheritedAncestryFailures: [],
  };
  const impossibleCommit = {
    ...base,
    intrinsic: { status: "rejected" as const, failureReasons: ["synthetic_intrinsic"] },
  };
  const commitGate = evaluateFreshInvocationGate({
    availability: "observed",
    counts: { attemptedCalls: 1, schemaAcceptedCalls: 1, intrinsicAcceptedCalls: 0, chainAcceptedCalls: 1, committedCalls: 1, providerExecutedCalls: 1 },
    attempts: [impossibleCommit],
  });
  assert.equal(commitGate.failures.some(({ code }) => code === "impossible_commit_state"), true);
  const impossibleProvider = {
    ...base,
    committed: { status: "not_evaluated" as const, failureReasons: [] },
  };
  const providerGate = evaluateFreshInvocationGate({
    availability: "observed",
    counts: { attemptedCalls: 1, schemaAcceptedCalls: 1, intrinsicAcceptedCalls: 1, chainAcceptedCalls: 1, committedCalls: 0, providerExecutedCalls: 1 },
    attempts: [impossibleProvider],
  });
  assert.equal(providerGate.failures.some(({ code }) => code === "impossible_provider_state"), true);

  const unavailableGate = evaluateFreshInvocationGate({
    availability: "observed",
    counts: { attemptedCalls: 1, schemaAcceptedCalls: 1, intrinsicAcceptedCalls: 0, chainAcceptedCalls: 1, committedCalls: 1, providerExecutedCalls: 1 },
    attempts: [{ ...base, intrinsic: { status: "evidence_unavailable" as const, failureReasons: ["missing_intrinsic_evidence"] } }],
  });
  assert.equal(unavailableGate.failures.some(({ code }) => code === "evidence_unavailable"), true);

  const correlationGate = evaluateFreshInvocationGate({
    availability: "observed",
    counts: { attemptedCalls: 1, schemaAcceptedCalls: 1, intrinsicAcceptedCalls: 1, chainAcceptedCalls: 1, committedCalls: 1, providerExecutedCalls: 1 },
    attempts: [{ ...base, correlation: { status: "rejected" as const, failureReasons: ["call_session_correlation_mismatch"] } }],
  });
  assert.equal(correlationGate.failures.some(({ code }) => code === "correlation_mismatch"), true);
});

test("v1 historical adapter preserves counts but leaves intrinsic and chain unknown", () => {
  const adapted = adaptHistoricalInvocationProvenanceV1({
    schemaVersion: "freecontext-invocation-provenance-v1",
    counts: { attemptedCalls: 7, schemaAcceptedCalls: 5, semanticallyAcceptedCalls: 4, committedCalls: 4, providerExecutedCalls: 4 },
    attempts: [{
      attemptIndex: 1,
      callId: "old-call",
      schemaAccepted: true,
      semanticallyAccepted: false,
      committed: true,
      providerExecuted: true,
      resultContract: "current",
      invocationKind: "reentrant",
      chainFailureReasons: ["prior_invocation_invalid"],
    }],
  });
  assert.equal(adapted.schemaVersion, "freecontext-invocation-provenance-v1-adapter");
  assert.deepEqual(adapted.legacyCounts, { attemptedCalls: 7, schemaAcceptedCalls: 5, semanticallyAcceptedCalls: 4, committedCalls: 4, providerExecutedCalls: 4 });
  assert.equal(adapted.attempts[0]?.schema.status, "accepted");
  assert.equal(adapted.attempts[0]?.intrinsic.status, "evidence_unavailable");
  assert.equal(adapted.attempts[0]?.chain.status, "evidence_unavailable");
  assert.deepEqual(adapted.attempts[0]?.inheritedAncestryFailures, ["prior_invocation_invalid"]);
});
