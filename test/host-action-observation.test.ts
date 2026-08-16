import assert from "node:assert/strict";
import test from "node:test";
import { analyzeFreeContextConsumption } from "../src/benchmark/consumption-analysis.js";
import { collectCompletedHostRepositoryActions } from "../src/benchmark/host-action-observation.js";
import { extractRepositoryActionsFromCode } from "../src/benchmark/shell-action-parser.js";
import type { FreeContextResult } from "../src/mcp/contracts.js";

const BOUNDARY = {
  completedAt: "2026-08-16T01:32:27.400Z",
  taskId: "task-1",
  callId: "2",
  repetition: "host-observed",
  gapQuestionIds: ["contract"],
} as const;

function record(timestamp: string, payload: Readonly<Record<string, unknown>>): string {
  return JSON.stringify({ timestamp, type: "response_item", payload });
}

function completedCell(source: string, output = "ok"): string {
  return [
    record("2026-08-16T01:32:30.000Z", {
      type: "custom_tool_call",
      name: "exec",
      call_id: "cell-1",
      input: source,
    }),
    record("2026-08-16T01:32:31.000Z", {
      type: "custom_tool_call_output",
      call_id: "cell-1",
      output,
    }),
  ].join("\n");
}

function partialResult(): FreeContextResult {
  return {
    status: "partial",
    summary: "Evidence found.",
    evidence: [{
      role: "implementation",
      path: "bandit/core/manager.py",
      startLine: 27,
      endLine: 28,
      focusLine: 27,
      questionId: "implementation",
      why: "Defines the behavior.",
    }],
    gaps: [{ questionId: "contract", reason: "The contract remains unresolved." }],
    nextAction: {
      kind: "read",
      path: "bandit/core/manager.py",
      startLine: 27,
      endLine: 28,
      reason: "Read the evidence.",
    },
    errorCode: null,
    sessionId: "session-1",
    sessionFile: "/logs/agent/freecontext-sessions/session-1.json",
  };
}

test("completed Codex cells yield ordered, evidence-addressable host actions", () => {
  const raw = completedCell(
    'const r = await tools.exec_command({cmd:"git status --short && sed -n \'1,45p\' bandit/core/manager.py && sed -n \'120,165p\' bandit/core/tester.py && rg -n \'nosec\' bandit tests",workdir:"/app"}); text(r.output);',
  );
  const observation = collectCompletedHostRepositoryActions(raw, BOUNDARY);
  assert.equal(observation.complete, true);
  assert.deepEqual(observation.actions.map(({ action }) => action), [
    {
      kind: "read",
      path: "bandit/core/manager.py",
      startLine: 1,
      endLine: 45,
      broad: false,
      gapQuestionIds: [],
    },
    {
      kind: "read",
      path: "bandit/core/tester.py",
      startLine: 120,
      endLine: 165,
      broad: false,
      gapQuestionIds: [],
    },
    {
      kind: "search",
      path: null,
      startLine: null,
      endLine: null,
      broad: false,
      gapQuestionIds: ["contract"],
    },
  ]);
  const audit = analyzeFreeContextConsumption(
    partialResult(),
    observation.actions,
    "completed_codex_tool_call",
  );
  assert.ok(audit);
  assert.equal(audit.observationSource, "completed_codex_tool_call");
  assert.equal(audit.firstActionEvidenceHit, true);
  assert.equal(audit.evidenceConsumed, true);
  assert.equal(audit.partialGapSearchCount, 1);
  assert.equal(audit.repeatedBroadSearch, false);
});

test("host observation stays unobserved for dynamic, failed, or concurrent cells", () => {
  const dynamic = completedCell(
    'const command = "sed -n \'1,45p\' bandit/core/manager.py"; await tools.exec_command({cmd:command});',
  );
  assert.equal(collectCompletedHostRepositoryActions(dynamic, BOUNDARY).complete, false);

  const failed = completedCell(
    'await tools.exec_command({cmd:"sed -n \'1,45p\' bandit/core/manager.py"});',
    "Script error: nested execution failed",
  );
  assert.equal(collectCompletedHostRepositoryActions(failed, BOUNDARY).complete, false);

  const rejectedPatch = completedCell(
    'const patch = "*** Begin Patch\\n*** Update File: a.py\\n*** End Patch"; await tools.apply_patch(patch);',
    "Script error: apply_patch verification failed",
  );
  assert.deepEqual(collectCompletedHostRepositoryActions(rejectedPatch, BOUNDARY), {
    complete: true,
    actions: [],
  });

  const concurrent = completedCell(
    'await Promise.all([tools.exec_command({cmd:"sed -n \'1,45p\' a.py"}),tools.exec_command({cmd:"sed -n \'1,45p\' b.py"})]);',
  );
  assert.equal(collectCompletedHostRepositoryActions(concurrent, BOUNDARY).complete, false);

  const incomplete = record("2026-08-16T01:32:30.000Z", {
    type: "custom_tool_call",
    name: "exec",
    call_id: "cell-1",
    input: 'await tools.exec_command({cmd:"sed -n \'1,45p\' bandit/core/manager.py"});',
  });
  assert.equal(collectCompletedHostRepositoryActions(incomplete, BOUNDARY).complete, false);
});

test("calls at or before the FreeContext completion boundary are excluded", () => {
  const raw = completedCell('await tools.exec_command({cmd:"sed -n \'1,45p\' bandit/core/manager.py"});')
    .replaceAll("2026-08-16T01:32:30.000Z", "2026-08-16T01:32:20.000Z");
  const observation = collectCompletedHostRepositoryActions(raw, BOUNDARY);
  assert.equal(observation.complete, true);
  assert.deepEqual(observation.actions, []);
});

test("search option values do not masquerade as repository paths", () => {
  const extracted = extractRepositoryActionsFromCode(
    'await tools.exec_command({cmd:"rg -g \'*.ts\' nosec src && rg -g \'*.ts\' nosec"});',
    [],
  );
  assert.equal(extracted.complete, true);
  assert.deepEqual(extracted.actions.map(({ broad }) => broad), [false, true]);
});

test("unsupported shell redirection fails closed", () => {
  const extracted = extractRepositoryActionsFromCode(
    'await tools.exec_command({cmd:"head -n 10 src/input.ts > /tmp/output"});',
    [],
  );
  assert.deepEqual(extracted, { complete: false, actions: [] });
});
