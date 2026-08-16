import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeFreeContextConsumption,
  collectParentRepositoryActions,
} from "../src/benchmark/consumption-analysis.js";
import type { ParentRepositoryActionEvent } from "../src/benchmark/consumption-analysis.js";
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

test("audit detects targeted-first consumption and later repeated broad search", () => {
  const audit = analyzeFreeContextConsumption(result(), [
    action(1),
    action(2, { kind: "search", path: null, startLine: null, endLine: null, broad: true }),
    action(3, { kind: "search", path: null, startLine: null, endLine: null, broad: true }),
  ]);
  assert.ok(audit);
  assert.equal(audit.firstRepositoryAction?.kind, "read");
  assert.equal(audit.firstRepositoryBatchSize, 1);
  assert.equal(audit.firstRepositoryBatchConcurrent, false);
  assert.equal(audit.firstActionEvidenceHit, true);
  assert.equal(audit.evidenceConsumed, true);
  assert.equal(audit.firstEvidenceHitSequence, 1);
  assert.equal(audit.firstEditSequence, null);
  assert.equal(audit.broadSearchCount, 2);
  assert.equal(audit.repeatedBroadSearch, true);
  assert.equal(audit.preEditSearchCount, 2);
  assert.equal(audit.preEditSearchBatchCount, 2);
  assert.equal(audit.preEditBroadSearchCount, 2);
  assert.equal(audit.postEditSearchCount, 0);
});

test("audit treats a concurrent outer cell as one evidence-consumption batch", () => {
  const audit = analyzeFreeContextConsumption(result("partial"), [
    action(1, {}, { observationBatchId: "cell-1", observationBatchConcurrent: true }),
    action(2, {}, { observationBatchId: "cell-1", observationBatchConcurrent: true }),
    action(3, { kind: "search", path: null, startLine: null, endLine: null, gapQuestionIds: ["tests"] },
      { observationBatchId: "cell-2", observationBatchConcurrent: true }),
  ]);
  assert.ok(audit);
  assert.equal(audit.firstRepositoryBatchSize, 2);
  assert.equal(audit.firstRepositoryBatchConcurrent, true);
  assert.equal(audit.firstActionEvidenceHit, true);
  assert.equal(audit.partialGapSearchCount, 1);
  assert.equal(audit.preEditSearchBatchCount, 1);
});

test("audit requires every first-batch action to hit evidence and does not order peers within a batch", () => {
  const audit = analyzeFreeContextConsumption(result("partial"), [
    action(1, {}, { observationBatchId: "cell-1", observationBatchConcurrent: true }),
    action(2, { kind: "search", path: null, startLine: null, endLine: null, gapQuestionIds: ["tests"] },
      { observationBatchId: "cell-1", observationBatchConcurrent: true }),
  ]);
  assert.ok(audit);
  assert.equal(audit.firstActionEvidenceHit, false);
  assert.equal(audit.evidenceConsumed, true);
  assert.equal(audit.partialGapSearchCount, 0);
});

test("partial audit counts only named-gap searches after evidence consumption", () => {
  const audit = analyzeFreeContextConsumption(result("partial"), [
    action(1, { kind: "search", path: null, startLine: null, endLine: null, gapQuestionIds: ["tests"] }),
    action(2),
    action(3, { kind: "search", path: null, startLine: null, endLine: null, gapQuestionIds: ["tests"] }),
    action(4, { kind: "search", path: null, startLine: null, endLine: null, gapQuestionIds: ["unrelated"] }),
  ]);
  assert.ok(audit);
  assert.equal(audit.firstActionEvidenceHit, false);
  assert.equal(audit.evidenceConsumed, true);
  assert.equal(audit.partialGapSearchCount, 1);
  assert.equal(audit.preEditSearchCount, 3);
  assert.equal(audit.preEditSearchBatchCount, 3);
  assert.equal(audit.postEditSearchCount, 0);
});

test("audit separates conservative pre-edit search batches from post-edit diagnostics", () => {
  const audit = analyzeFreeContextConsumption(result("partial"), [
    action(1, {}, { observationBatchId: "cell-1" }),
    action(2, { kind: "search", path: null, startLine: null, endLine: null, gapQuestionIds: ["tests"] },
      { observationBatchId: "cell-2" }),
    action(3, { kind: "search", path: null, startLine: null, endLine: null, gapQuestionIds: ["tests"] },
      { observationBatchId: "cell-2" }),
    action(4, { kind: "edit" }, { observationBatchId: "cell-3" }),
    action(5, { kind: "search", path: null, startLine: null, endLine: null, gapQuestionIds: ["tests"] },
      { observationBatchId: "cell-3" }),
    action(6, { kind: "search", path: null, startLine: null, endLine: null, gapQuestionIds: ["tests"] },
      { observationBatchId: "cell-4" }),
    action(7, { kind: "search", path: null, startLine: null, endLine: null, broad: true },
      { observationBatchId: "cell-5" }),
  ]);
  assert.ok(audit);
  assert.equal(audit.firstEditSequence, 4);
  assert.equal(audit.partialGapSearchCount, 4);
  assert.equal(audit.preEditSearchCount, 3);
  assert.equal(audit.preEditSearchBatchCount, 2);
  assert.equal(audit.broadSearchCount, 1);
  assert.equal(audit.preEditBroadSearchCount, 0);
  assert.equal(audit.postEditSearchCount, 2);
});

test("absence of host events stays unobserved for every result status", () => {
  for (const status of ["ready", "partial", "not_found", "failed"] as const) {
    assert.equal(analyzeFreeContextConsumption(result(status), []), null);
  }
});
