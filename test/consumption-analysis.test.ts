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
      why: "Defines routing.",
    }],
    gaps: status === "partial" ? [{ questionId: "tests", reason: "Tests remain unresolved." }] : [],
    nextAction: status === "not_found" || status === "failed"
      ? { kind: "direct_search", reason: "Search directly." }
      : { kind: "read", path: "src/router.ts", startLine: 10, endLine: 20, reason: "Read the evidence." },
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

test("v3 audit requires the first batch to consume every evidence span", () => {
  const audit = analyzeFreeContextConsumption(result(), [
    action(1, {}, { observationBatchId: "cell-1", observationBatchConcurrent: true }),
    action(2, {}, { observationBatchId: "cell-1", observationBatchConcurrent: true }),
  ], context());
  assert.equal(audit.schemaVersion, "freecontext-consumption-audit-v3");
  assert.equal(audit.firstRepositoryBatchSize, 2);
  assert.equal(audit.firstRepositoryBatchConcurrent, true);
  assert.equal(audit.firstRepositoryBatchReadOnly, true);
  assert.equal(audit.firstRepositoryBatchEvidenceOnly, true);
  assert.equal(audit.consumedEvidenceCount, 1);
  assert.equal(audit.allEvidenceConsumed, true);
  assert.deepEqual(audit.escapedExplorationReasons, []);
});

test("v3 audit detects full-window broad, second-batch, and third-path escapes", () => {
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
  assert.deepEqual(audit.escapedExplorationReasons, [
    "broad_search",
    "second_search_batch",
    "third_non_evidence_read_path",
  ]);
});

test("gap handoff and unobserved windows fail closed", () => {
  const gapAudit = analyzeFreeContextConsumption(result("partial"), [
    action(1),
    action(2, { kind: "search", path: null, startLine: null, endLine: null }),
  ], context({ followedByGapFollowup: true }));
  assert.deepEqual(gapAudit.escapedExplorationReasons, ["action_before_gap_followup"]);

  const unobserved = analyzeFreeContextConsumption(result(), [], context({
    invocationKind: "invalid",
    windowObserved: false,
    windowStartedAfter: null,
    windowFailureReasons: ["transport_correlation"],
  }));
  assert.equal(unobserved.actionCount, 0);
  assert.equal(unobserved.allEvidenceConsumed, false);
  assert.deepEqual(unobserved.escapedExplorationReasons, [
    "transport_correlation",
    "unobserved_window",
  ]);
  assert.throws(() => analyzeFreeContextConsumption(result(), [action(1)], {
    ...context(), windowObserved: false,
  }), /Unobserved window/u);
});
