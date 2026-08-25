import assert from "node:assert/strict";
import test from "node:test";
import { adaptHistoricalInvocationProvenanceV1, collectInvocationProvenance, evaluateFreshInvocationGate } from "../src/benchmark/invocation-provenance.js";
import type { ObservedMcpCall } from "../src/benchmark/delivery-observation.js";
import { normalizeFreeContextRequest, serializeForModel } from "../src/mcp/contracts.js";
import type { FreeContextRequest, FreeContextResult } from "../src/mcp/contracts.js";

function request(targetId: string, reentry?: FreeContextRequest["reentry"]): FreeContextRequest {
  return normalizeFreeContextRequest({
    taskText: "trace provenance",
    workUnit: { outcome: "edit", goal: "Implement the requested change." },
    evidenceQuestions: [{
      role: "implementation",
      question: `Locate ${targetId}.`,
      required: true,
      target: { id: targetId, subject: { kind: "symbol", symbol: targetId }, factKind: "location", coverageMode: "single" },
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
    blockingGaps: gap ? [{ id: "gap:owner", targetId: target.id, kind: "source_unknown" as const, scope: target.subject, requiredFact: "Find the owner." }] : [],
  } : null;
  return {
    status,
    summary: "Trace result.",
    evidence,
    gaps: gap ? [{ questionId: "q1", targetId: target.id, reason: "The target remains unresolved." }] : [],
    ...(handoff ? { handoff } : { handoff: null }),
    nextAction: evidence.length > 0
      ? { kind: "consume_evidence" as const, reason: "Consume the evidence." }
      : { kind: "exact_probe" as const, reason: "Probe exactly.", ...(status === "not_found" ? { recovery: { requestKind: "not_found_recovery" as const, priorSessionId: `session-${target.id}-${status}`, workUnit: requestValue.workUnit, requiredProbe: "exact_probe" as const } } : {}) },
    errorCode: status === "failed" ? "INVALID_REQUEST" as const : null,
    sessionId: `session-${target.id}-${status}`,
    sessionFile: `/logs/agent/freecontext-sessions/${target.id}.json`,
  };
}

function caller(requestValue: FreeContextRequest): unknown {
  return {
    taskText: requestValue.taskText,
    workUnit: requestValue.workUnit,
    knownRefs: requestValue.knownRefs,
    ...(requestValue.recovery ? { recovery: requestValue.recovery } : {}),
    evidenceQuestions: requestValue.evidenceQuestions.map((question) => ({
      role: question.role,
      question: question.question,
      required: question.required,
      target: question.coverageTargets[0],
    })),
    ...(requestValue.reentry ? { reentry: requestValue.reentry } : {}),
  };
}

function recoveryRequest(requestValue: FreeContextRequest, priorSessionId: string): FreeContextRequest {
  return normalizeFreeContextRequest({
    ...(caller(requestValue) as Record<string, unknown>),
    recovery: {
      requestKind: "not_found_recovery",
      priorSessionId,
      priorWorkUnit: requestValue.workUnit,
      probe: { kind: "exact_probe", path: "src/owner.ts" },
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
  const reentryRequest = request("next", {
    priorHandoff: partial.handoff!,
    blockingGap: {
      id: "gap:next", targetId: "next", kind: "verification_unknown",
      scope: { kind: "symbol", symbol: "next" }, requiredFact: "Find the next owner.",
      origin: { kind: "edit", changedPaths: ["src/owner.ts"] },
    },
  });
  const ready = result(reentryRequest, "ready");
  const secondReentryRequest = request("final", {
    priorHandoff: ready.handoff!,
    blockingGap: {
      id: "gap:final", targetId: "final", kind: "verification_unknown",
      scope: { kind: "symbol", symbol: "final" }, requiredFact: "Find the final owner.",
      origin: { kind: "check", check: "run the focused check" },
    },
  });
  const finalResult = result(secondReentryRequest, "ready");
  const duplicateGapRequest = request("duplicate", {
    priorHandoff: partial.handoff!,
    blockingGap: {
      id: "gap:owner", targetId: "owner", kind: "verification_unknown",
      scope: { kind: "symbol", symbol: "owner" }, requiredFact: "Repeat the old gap.",
      origin: { kind: "edit", changedPaths: ["src/other.ts"] },
    },
  });
  const invalidInitial = caller(initial) as Record<string, unknown>;
  invalidInitial.evidenceQuestions = [{ role: "implementation", question: "Locate owner.", required: true, target: { id: "owner", subject: { kind: "symbol", symbol: "owner" }, factKind: "convention", coverageMode: "single" } }];
  const calls: ObservedMcpCall[] = [
    call("call-1", invalidInitial, null),
    call("call-2", caller(initial), notFound),
    call("call-3", caller(initial), partial),
    call("call-4", caller(duplicateGapRequest), { status: "failed", summary: "invalid", evidence: [], gaps: [], nextAction: { kind: "exact_probe", reason: "invalid" }, errorCode: "INVALID_REQUEST", sessionId: "call-4", sessionFile: null }),
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
  assert.deepEqual(provenance.attempts[4]?.chain.failureReasons, []);
  assert.ok((provenance.attempts[4]?.inheritedAncestryFailures.length ?? 0) > 0);
  assert.match(provenance.attempts[0]?.schema.failureReasons[0] ?? "", /^schema_rejection:/u);
  assert.equal(serializeForModel(notFound).includes("Recovery contract"), true);
  assert.equal(provenance.freshGate.accepted, false);
  assert.deepEqual(
    [...new Set(provenance.freshGate.failures.map(({ code }) => code))].sort(),
    ["chain_rejection", "inherited_ancestry_failure", "intrinsic_rejection", "schema_rejection"].sort(),
  );
  assert.equal(provenance.attempts[4]?.intrinsic.status, "accepted");
  assert.equal(provenance.attempts[4]?.chain.status, "accepted");
});

test("fresh invocation gate accepts a clean initial and typed reentry chain", () => {
  const initial = request("owner");
  const partial = result(initial, "partial", true);
  const reentryRequest = request("next", {
    priorHandoff: partial.handoff!,
    blockingGap: {
      id: "gap:next", targetId: "next", kind: "verification_unknown",
      scope: { kind: "symbol", symbol: "next" }, requiredFact: "Find the next owner.",
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
      inheritedAncestryFailures: [],
    }],
  };
  const mismatch = evaluateFreshInvocationGate({ ...snapshot, counts: { ...snapshot.counts, attemptedCalls: 2 } });
  assert.equal(mismatch.accepted, false);
  assert.equal(mismatch.failures[0]?.code, "counts_mismatch");
});

test("v2 separates failed-to-recovery chain rejection from intrinsic acceptance", () => {
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

test("v2 gate rejects impossible correlations without collapsing layer facts", () => {
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
