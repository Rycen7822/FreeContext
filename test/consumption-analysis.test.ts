import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeFreeContextConsumption,
  collectParentRepositoryActions,
  type FreeContextConsumptionAuditContext,
  type ParentRepositoryActionEvent,
} from "../src/benchmark/consumption-analysis.js";
import type { FreeContextResult } from "../src/mcp/contracts.js";

function result(status: FreeContextResult["status"] = "ready"): FreeContextResult {
  return {
    status,
    summary: "Routing evidence found.",
    evidence: status === "not_found" || status === "failed" ? [] : [{
      role: "implementation",
      path: "src/router.ts",
      startLine: 10,
      endLine: 20,
      focusLine: 15,
      questionId: "implementation",
      excerpt: "export function route() {}",
      why: "Defines routing.",
    }],
    gaps: status === "partial" ? [{ questionId: "tests", reason: "Tests remain unresolved." }] : [],
    nextAction: status === "not_found"
      ? {
          kind: "exact_probe",
          reason: "Search directly.",
          recovery: {
            priorSessionId: "session-1",
          },
        }
      : status === "failed"
        ? { kind: "native_exploration", reason: "Continue native exploration." }
      : { kind: "consume_evidence", reason: "Use the evidence." },
    errorCode: status === "failed" ? "INTERNAL_ERROR" : null,
    sessionId: "session-1",
    sessionFile: "/logs/agent/freecontext-sessions/session-1.json",
  };
}

function action(
  sequence: number,
  overrides: Partial<ParentRepositoryActionEvent["action"]> = {},
  eventOverrides: Partial<Pick<ParentRepositoryActionEvent, "observationBatchId" | "observationBatchConcurrent">> = {},
): ParentRepositoryActionEvent {
  return {
    schemaVersion: "freecontext-parent-action-v1",
    taskId: "task-1",
    callId: "call-1",
    repetition: "r1",
    sequence,
    observationBatchId: null,
    observationBatchConcurrent: false,
    action: {
      kind: "read",
      path: "src/router.ts",
      startLine: 10,
      endLine: 20,
      broad: false,
      gapQuestionIds: [],
      ...overrides,
    },
    ...eventOverrides,
  };
}

function context(overrides: Partial<FreeContextConsumptionAuditContext> = {}): FreeContextConsumptionAuditContext {
  return {
    observationSource: "explicit_host_event",
    taskId: "task-1",
    callId: "call-1",
    repetition: "r1",
    episodeIndex: 1,
    invocationKind: "initial",
    windowStartedAfter: "2026-08-21T00:00:10.000Z",
    windowEndedBefore: null,
    windowObserved: true,
    exactDuplicate: false,
    ...overrides,
  };
}

test("collector accepts only explicit host action events for the selected call", () => {
  const raw = [
    "not-json",
    JSON.stringify({ payload: action(2, { kind: "search", path: null, startLine: null, endLine: null, broad: true }) }),
    JSON.stringify({
      schemaVersion: "freecontext-parent-action-v1",
      taskId: "task-1",
      callId: "call-1",
      repetition: "r1",
      sequence: 1,
      action: action(1).action,
    }),
    JSON.stringify({ ...action(3), callId: "other-call" }),
  ].join("\n");
  const actions = collectParentRepositoryActions(raw, "call-1");
  assert.deepEqual(actions.map(({ sequence }) => sequence), [1, 2]);
  assert.equal(actions[0]?.observationBatchId, null);
  assert.equal(actions[0]?.observationBatchConcurrent, false);
  assert.throws(
    () => collectParentRepositoryActions(`${JSON.stringify(action(1))}\n${JSON.stringify(action(1))}`, "call-1"),
    /Duplicate parent-action sequence/u,
  );
});

test("v7 audit accepts inline observed evidence without a native reread", () => {
  const audit = analyzeFreeContextConsumption(result(), [], context());
  assert.equal(audit.schemaVersion, "freecontext-consumption-audit-v7");
  assert.equal(audit.inlineEvidenceCount, 1);
  assert.equal(audit.inlineEvidenceProvenanceComplete, true);
  assert.equal(audit.nativeEvidenceRereadCount, 0);
  assert.equal(audit.firstRepositoryActionKind, null);
  assert.deepEqual(audit.failureReasons, []);

  const missingExcerpt = result();
  delete missingExcerpt.evidence[0]?.excerpt;
  const missingAudit = analyzeFreeContextConsumption(missingExcerpt, [], context());
  assert.equal(missingAudit.inlineEvidenceProvenanceComplete, false);
  assert.deepEqual(missingAudit.failureReasons, ["inline_evidence_provenance_missing"]);
});

test("v7 audit rejects pre-edit search beyond a consume_evidence nextAction", () => {
  const audit = analyzeFreeContextConsumption(result(), [
    action(1, {}, { observationBatchId: "cell-1" }),
    action(2, {}, { observationBatchId: "cell-2" }),
    action(3, { kind: "search", path: null, startLine: null, endLine: null }, { observationBatchId: "search-1" }),
  ], context());
  assert.equal(audit.nativeEvidenceRereadCount, 2);
  assert.equal(audit.firstRepositoryActionKind, "read");
  assert.equal(audit.preEditNativeExplorationCount, 1);
  assert.deepEqual(audit.failureReasons, ["pre_edit_handoff_scope_exceeded"]);
});

test("consume_evidence allows two precise context reads while failed native fallback stays unrestricted", () => {
  const twoPreciseReads = analyzeFreeContextConsumption(result(), [
    action(1),
    action(2, { startLine: 21, endLine: 30 }),
  ], context());
  assert.deepEqual(twoPreciseReads.failureReasons, []);

  const threePreciseReads = analyzeFreeContextConsumption(result(), [
    action(1),
    action(2, { startLine: 21, endLine: 30 }),
    action(3, { startLine: 31, endLine: 40 }),
  ], context());
  assert.deepEqual(threePreciseReads.failureReasons, ["pre_edit_handoff_scope_exceeded"]);

  const failedNative = analyzeFreeContextConsumption(result("failed"), [
    action(1, { kind: "search", path: null, startLine: null, endLine: null, broad: true }),
    action(2, { kind: "search", path: null, startLine: null, endLine: null }),
    action(3, { path: "src/other.ts", startLine: 1, endLine: 5 }),
  ], context());
  assert.deepEqual(failedNative.failureReasons, []);
});

test("v7 audit applies pre-edit handoff and post-edit diagnostic boundaries", () => {
  const adjacent = analyzeFreeContextConsumption(result(), [
    action(1, { startLine: 21, endLine: 30 }),
  ], context());
  assert.deepEqual(adjacent.failureReasons, []);

  const exactProbe = analyzeFreeContextConsumption(result("not_found"), [
    action(1, { kind: "search", path: null, startLine: null, endLine: null }, { observationBatchId: "probe-1" }),
    action(2, { path: "src/candidate.ts", startLine: 1, endLine: 5 }),
  ], context());
  assert.deepEqual(exactProbe.failureReasons, []);

  const expandedProbe = analyzeFreeContextConsumption(result("not_found"), [
    action(1, { kind: "search", path: null, startLine: null, endLine: null }, { observationBatchId: "probe-1" }),
    action(2, { kind: "search", path: null, startLine: null, endLine: null }, { observationBatchId: "probe-2" }),
  ], context());
  assert.deepEqual(expandedProbe.failureReasons, ["pre_edit_handoff_scope_exceeded"]);

  const repeatedAdjacent = analyzeFreeContextConsumption(result(), [
    action(1, { startLine: 21, endLine: 30 }),
    action(2, { startLine: 31, endLine: 40 }),
  ], context());
  assert.deepEqual(repeatedAdjacent.failureReasons, []);

  const postEditExactDiagnostic = analyzeFreeContextConsumption(result(), [
    action(1),
    action(2, { kind: "edit", path: "src/router.ts", startLine: null, endLine: null }),
    action(3, { kind: "check", path: null, startLine: null, endLine: null }),
    action(4, { path: "test/exact-failure.test.ts", startLine: 40, endLine: 45 }),
  ], context());
  assert.deepEqual(postEditExactDiagnostic.failureReasons, []);
  assert.deepEqual(postEditExactDiagnostic.phases.map(({ phase }) => phase), ["pre_edit_handoff", "post_edit_diagnostic"]);

  const audit = analyzeFreeContextConsumption(result(), [
    action(1),
    action(2, { kind: "edit", path: "src/edited.ts", startLine: null, endLine: null }),
    action(3, { path: "src/edited.ts", startLine: 1, endLine: 5 }),
    action(4, { kind: "search", path: null, startLine: null, endLine: null }, { observationBatchId: "search-1" }),
    action(5, { kind: "search", path: null, startLine: null, endLine: null, broad: true }, { observationBatchId: "search-2" }),
    action(6, { path: "src/a.ts", startLine: 1, endLine: 5 }),
    action(7, { path: "src/b.ts", startLine: 1, endLine: 5 }),
    action(8, { path: "src/c.ts", startLine: 1, endLine: 5 }),
  ], context());
  assert.equal(audit.searchCount, 2);
  assert.equal(audit.searchBatchCount, 2);
  assert.equal(audit.broadSearchCount, 1);
  assert.equal(audit.distinctNonEvidenceReadPaths, 3);
  assert.equal(audit.editCount, 1);
  assert.equal(audit.preEditNativeExplorationCount, 0);
  assert.equal(audit.postEditNativeExplorationCount, 6);
  assert.deepEqual(audit.phases.map(({ phase, actionCount }) => [phase, actionCount]), [
    ["pre_edit_handoff", 1],
    ["post_edit_diagnostic", 7],
  ]);
  assert.deepEqual(audit.failureReasons, ["post_edit_cross_file_exploration_without_fc"]);

  const mixed = analyzeFreeContextConsumption(result(), [
    action(1, { path: "src/other.ts" }),
    action(2),
  ], context());
  assert.equal(mixed.preEditNativeExplorationCount, 1);
  assert.deepEqual(mixed.failureReasons, ["pre_edit_handoff_scope_exceeded"]);

  const external = analyzeFreeContextConsumption(result(), [action(1, {
    kind: "other",
    path: null,
    startLine: null,
    endLine: null,
    broad: true,
    externalSource: true,
  })], context());
  assert.equal(external.externalSourceCommandCount, 1);
  assert.deepEqual(external.failureReasons, ["task_solution_external_source"]);
});

test("typed reentry and unobserved windows fail closed", () => {
  const gapAudit = analyzeFreeContextConsumption(result("partial"), [
    action(1),
    action(2, { kind: "search", path: null, startLine: null, endLine: null }),
  ], context());
  assert.equal(gapAudit.preEditNativeExplorationCount, 1);
  assert.deepEqual(gapAudit.failureReasons, ["pre_edit_handoff_scope_exceeded"]);

  const prematureReentry = analyzeFreeContextConsumption(result(), [], context({ followedByReentrant: true }));
  assert.equal(prematureReentry.followedByReentrant, true);
  assert.equal(prematureReentry.editOrCheckObserved, false);
  assert.deepEqual(prematureReentry.failureReasons, ["reentry_without_typed_origin"]);
  assert.deepEqual(prematureReentry.phases.map(({ phase }) => phase), ["pre_edit_handoff", "reentry"]);
  const typedChild = analyzeFreeContextConsumption(result(), [], context({
    followedByReentrant: true,
    reentryOrigin: "evidence_consumption",
    followupRelation: "handoff_child",
  }));
  assert.deepEqual(typedChild.failureReasons, []);
  assert.equal(typedChild.followupRelation, "handoff_child");
  for (const kind of ["edit", "check"] as const) {
    const progressed = analyzeFreeContextConsumption(result(), [
      action(1, { kind, path: kind === "edit" ? "src/router.ts" : null, startLine: null, endLine: null }),
    ], context({ followedByReentrant: true }));
    assert.equal(progressed.followedByReentrant, true);
    assert.equal(progressed.editOrCheckObserved, true);
    assert.deepEqual(progressed.failureReasons, []);
  }

  const unobserved = analyzeFreeContextConsumption(result(), [], context({
    invocationKind: "invalid",
    windowObserved: false,
    windowStartedAfter: null,
    windowFailureReasons: ["transport_correlation"],
  }));
  assert.equal(unobserved.actionCount, 0);
  assert.equal(unobserved.inlineEvidenceProvenanceComplete, true);
  assert.deepEqual(unobserved.failureReasons, [
    "transport_correlation",
    "unobserved_window",
  ]);
  assert.throws(() => analyzeFreeContextConsumption(result(), [action(1)], {
    ...context(), windowObserved: false,
  }), /Unobserved window/u);
});

test("not_found recovery requires one bounded exact probe and no handoff", () => {
  const accepted = analyzeFreeContextConsumption(result("not_found"), [
    action(1, { path: "src/candidate.ts", startLine: 1, endLine: 5 }),
  ], context({ followedByRecovery: true, recoveryProbePath: "./src/candidate.ts" }));
  assert.equal(accepted.followedByRecovery, true);
  assert.equal(accepted.recoveryProbeAccepted, true);
  assert.deepEqual(accepted.failureReasons, []);

  const missing = analyzeFreeContextConsumption(result("not_found"), [], context({ followedByRecovery: true, recoveryProbePath: "src/candidate.ts" }));
  assert.equal(missing.recoveryProbeAccepted, false);
  assert.deepEqual(missing.failureReasons, ["not_found_recovery_probe_missing"]);

  const missingDeclaration = analyzeFreeContextConsumption(result("not_found"), [action(1, { path: "src/candidate.ts", startLine: 1, endLine: 5 })], context({ followedByRecovery: true }));
  assert.deepEqual(missingDeclaration.failureReasons, ["not_found_recovery_probe_path_missing"]);

  const mismatchedPath = analyzeFreeContextConsumption(result("not_found"), [action(1, { path: "src/other.ts", startLine: 1, endLine: 5 })], context({ followedByRecovery: true, recoveryProbePath: "src/candidate.ts" }));
  assert.deepEqual(mismatchedPath.failureReasons, ["not_found_recovery_probe_path_mismatch"]);

  const broad = analyzeFreeContextConsumption(result("not_found"), [
    action(1, { kind: "search", path: null, startLine: null, endLine: null, broad: true }),
  ], context({ followedByRecovery: true, recoveryProbePath: "src/candidate.ts" }));
  assert.deepEqual(broad.failureReasons, ["not_found_recovery_probe_scope_exceeded"]);

  for (const status of ["partial", "ready"] as const) {
    const afterHandoff = analyzeFreeContextConsumption(result(status), [action(1)], context({ followedByRecovery: true }));
    assert.deepEqual(afterHandoff.failureReasons, ["recovery_after_handoff"]);
  }
});
