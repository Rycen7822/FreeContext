import assert from "node:assert/strict";
import test from "node:test";
import { analyzeFreeContextConsumption } from "../src/benchmark/consumption-analysis.js";
import {
  collectCompletedDirectMcpRepositoryActions,
  collectCompletedHostRepositoryActions,
} from "../src/benchmark/host-action-observation.js";
import {
  extractRepositoryActionsFromCode,
  extractRepositoryActionsFromShellCommand,
} from "../src/benchmark/shell-action-parser.js";
import type { FreeContextResult } from "../src/mcp/contracts.js";

const BOUNDARY = {
  completedAt: "2026-08-16T01:32:27.400Z",
  endedBefore: null,
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
      excerpt: "class Manager:\n    pass",
      why: "Defines the behavior.",
    }],
    gaps: [{ questionId: "contract", reason: "The contract remains unresolved." }],
    nextAction: {
      kind: "consume_evidence",
      reason: "Use the evidence.",
    },
    errorCode: null,
    sessionId: "session-1",
    sessionFile: "/logs/agent/freecontext-sessions/session-1.json",
  };
}

const AUDIT_CONTEXT = {
  observationSource: "completed_codex_tool_call",
  taskId: "task-1",
  callId: "2",
  repetition: "host-observed",
  episodeIndex: 1,
  invocationKind: "initial",
  windowStartedAfter: BOUNDARY.completedAt,
  windowEndedBefore: null,
  windowObserved: true,
  exactDuplicate: false,
} as const;

test("completed Codex cells yield ordered, evidence-addressable host actions", () => {
  const raw = completedCell(
    'const r = await tools.exec_command({cmd:"git status --short && sed -n \'1,45p\' bandit/core/manager.py && sed -n \'120,165p\' bandit/core/tester.py && rg -n \'nosec\' bandit tests && python -m pytest tests",workdir:"/app"}); text(r.output);',
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
    {
      kind: "check",
      path: null,
      startLine: null,
      endLine: null,
      broad: false,
      gapQuestionIds: [],
    },
  ]);
  const audit = analyzeFreeContextConsumption(
    partialResult(),
    observation.actions,
    AUDIT_CONTEXT,
  );
  assert.equal(audit.observationSource, "completed_codex_tool_call");
  assert.equal(audit.inlineEvidenceProvenanceComplete, true);
  assert.equal(audit.nativeEvidenceRereadCount, 1);
  assert.equal(audit.searchCount, 1);
  assert.equal(audit.checkCount, 1);
  assert.equal(audit.preEditNativeExplorationCount, 2);
  assert.deepEqual(audit.failureReasons, ["pre_edit_handoff_scope_exceeded"]);
});

test("host observation stays unobserved for dynamic, failed, or incomplete cells", () => {
  const dynamic = completedCell(
    'const command = "sed -n \'1,45p\' bandit/core/manager.py"; await tools.exec_command({cmd:command});',
  );
  assert.equal(collectCompletedHostRepositoryActions(dynamic, BOUNDARY).complete, false);

  const failed = completedCell(
    'await tools.exec_command({cmd:"sed -n \'1,45p\' bandit/core/manager.py"});',
    "Script error: nested execution failed",
  );
  assert.equal(collectCompletedHostRepositoryActions(failed, BOUNDARY).complete, false);

  const syntaxRejected = [
    completedCell(
      'await tools.exec_command({cmd:"sed -n \'1,45p\' ignored.py"});',
      "Script failed\nScript error:\nSyntaxError: Invalid token",
    ),
    completedCell('await tools.exec_command({cmd:"sed -n \'1,45p\' observed.py"});')
      .replaceAll("2026-08-16T01:32:30.000Z", "2026-08-16T01:32:32.000Z")
      .replaceAll("2026-08-16T01:32:31.000Z", "2026-08-16T01:32:33.000Z")
      .replaceAll("cell-1", "cell-2"),
  ].join("\n");
  const syntaxObservation = collectCompletedHostRepositoryActions(syntaxRejected, BOUNDARY);
  assert.equal(syntaxObservation.complete, true);
  assert.deepEqual(syntaxObservation.actions.map(({ action }) => action.path), ["observed.py"]);

  const rejectedPatch = completedCell(
    'const patch = "*** Begin Patch\\n*** Update File: a.py\\n*** End Patch"; await tools.apply_patch(patch);',
    "Script error: apply_patch verification failed",
  );
  assert.deepEqual(collectCompletedHostRepositoryActions(rejectedPatch, BOUNDARY), {
    complete: true,
    actions: [],
  });

  const concurrent = completedCell(
    'await Promise.all([tools.exec_command({cmd:"sed -n \'27,28p\' bandit/core/manager.py"}),tools.exec_command({cmd:"sed -n \'27,28p\' bandit/core/manager.py"})]);',
  );
  const concurrentObservation = collectCompletedHostRepositoryActions(concurrent, BOUNDARY);
  assert.equal(concurrentObservation.complete, true);
  assert.equal(concurrentObservation.actions.length, 2);
  assert.ok(concurrentObservation.actions.every(({ observationBatchId }) => observationBatchId === "cell-1"));
  assert.ok(concurrentObservation.actions.every(({ observationBatchConcurrent }) => observationBatchConcurrent));
  const concurrentAudit = analyzeFreeContextConsumption(
    partialResult(),
    concurrentObservation.actions,
    AUDIT_CONTEXT,
  );
  assert.equal(concurrentAudit.inlineEvidenceProvenanceComplete, true);
  assert.equal(concurrentAudit.nativeEvidenceRereadCount, 2);

  const mapped = completedCell(`const cmds = [
    ["first", "sed -n '1,5p' first.py"],
    ["second", "rg -n 'target' src"]
  ];
  await Promise.all(cmds.map(async ([label, cmd]) => [label, await tools.exec_command({cmd})]));`);
  const mappedObservation = collectCompletedHostRepositoryActions(mapped, BOUNDARY);
  assert.equal(mappedObservation.complete, true);
  assert.deepEqual(mappedObservation.actions.map(({ action }) => action.kind), ["read", "search"]);
  assert.ok(mappedObservation.actions.every(({ observationBatchConcurrent }) => observationBatchConcurrent));

  const commandFirst = completedCell(`const cmds = [
    ["sed -n '1,5p' first.py", "/app"],
    ["rg -n 'target' src", "/app"]
  ];
  await Promise.all(cmds.map(async ([cmd, workdir]) => tools.exec_command({cmd, workdir})));`);
  const commandFirstObservation = collectCompletedHostRepositoryActions(commandFirst, BOUNDARY);
  assert.equal(commandFirstObservation.complete, true);
  assert.deepEqual(commandFirstObservation.actions.map(({ action }) => action.kind), ["read", "search"]);

  const pathMapped = completedCell([
    'const paths = ["first.py", "second.py"];',
    'const ranges = ["1,5", "7,9"];',
    "await Promise.all(paths.map((path, i) => tools.exec_command({cmd:`sed -n '${ranges[i]}p' ${path}`})));",
  ].join("\n"));
  const pathMappedObservation = collectCompletedHostRepositoryActions(pathMapped, BOUNDARY);
  assert.equal(pathMappedObservation.complete, true);
  assert.deepEqual(pathMappedObservation.actions.map(({ action }) => ({
    path: action.path,
    startLine: action.startLine,
    endLine: action.endLine,
  })), [
    { path: "first.py", startLine: 1, endLine: 5 },
    { path: "second.py", startLine: 7, endLine: 9 },
  ]);
  assert.ok(pathMappedObservation.actions.every(({ observationBatchConcurrent }) => observationBatchConcurrent));

  const incomplete = record("2026-08-16T01:32:30.000Z", {
    type: "custom_tool_call",
    name: "exec",
    call_id: "cell-1",
    input: 'await tools.exec_command({cmd:"sed -n \'1,45p\' bandit/core/manager.py"});',
  });
  assert.equal(collectCompletedHostRepositoryActions(incomplete, BOUNDARY).complete, false);

  const missingTimestamp = JSON.stringify({
    type: "response_item",
    payload: {
      type: "custom_tool_call",
      name: "exec",
      call_id: "cell-1",
      input: 'await tools.exec_command({cmd:"sed -n \'1,45p\' bandit/core/manager.py"});',
    },
  });
  assert.equal(collectCompletedHostRepositoryActions(missingTimestamp, BOUNDARY).complete, false);
});

test("direct MCP item observes an ordered contiguous read window without timestamps", () => {
  const sessionFile = "/logs/agent/freecontext-sessions/session-1.json";
  const mcp = { id: "mcp-1", type: "mcp_tool_call", server: "freecontext", tool: "gather_context" };
  const command = (id: string, path: string) => [
    { type: "item.started", item: { id, type: "command_execution", command: `/bin/bash -lc \"sed -n '27,28p' ${path}\"`, status: "in_progress" } },
    { type: "item.completed", item: { id, type: "command_execution", aggregated_output: "ok", exit_code: 0, status: "completed" } },
  ];
  const raw = [
    { type: "item.started", item: { ...mcp, result: null, status: "in_progress" } },
    { type: "item.completed", item: {
      ...mcp,
      result: { content: [{ type: "text", text: `Status: ready\nSession: ${sessionFile}` }] },
      status: "completed",
    } },
    ...command("cmd-1", "bandit/core/manager.py"),
    ...command("cmd-2", "bandit/core/tester.py"),
    { type: "item.started", item: { id: "mcp-2", type: "mcp_tool_call", server: "freecontext", tool: "gather_context", status: "in_progress" } },
  ].map((item) => JSON.stringify(item)).join("\n");
  const observation = collectCompletedDirectMcpRepositoryActions(raw, {
    sessionFile,
    taskId: "task-1",
    callId: "2",
    repetition: "host-observed",
    gapQuestionIds: [],
  });
  assert.equal(observation.complete, true);
  assert.deepEqual(observation.actions.map(({ action }) => action.path), [
    "bandit/core/manager.py",
    "bandit/core/tester.py",
  ]);
  assert.equal(new Set(observation.actions.map(({ observationBatchId }) => observationBatchId)).size, 1);
  assert.ok(observation.actions.every(({ observationBatchConcurrent }) => !observationBatchConcurrent));
});

test("direct MCP observation fails closed when a command crosses the ordered boundary", () => {
  const sessionFile = "/logs/agent/freecontext-sessions/session-1.json";
  const raw = [
    { type: "item.completed", item: {
      id: "mcp-1", type: "mcp_tool_call", server: "freecontext", tool: "gather_context",
      result: { content: [{ type: "text", text: `Status: ready\nSession: ${sessionFile}` }] }, status: "completed",
    } },
    { type: "item.started", item: {
      id: "cmd-1", type: "command_execution", command: "/bin/bash -lc \"sed -n '1,2p' bandit/core/manager.py\"", status: "in_progress",
    } },
    { type: "item.started", item: { id: "mcp-2", type: "mcp_tool_call", server: "freecontext", tool: "gather_context", status: "in_progress" } },
  ].map((item) => JSON.stringify(item)).join("\n");
  const observation = collectCompletedDirectMcpRepositoryActions(raw, {
    sessionFile,
    taskId: "task-1",
    callId: "2",
    repetition: "host-observed",
    gapQuestionIds: [],
  });
  assert.equal(observation.complete, false);
  assert.deepEqual(observation.actions, []);
});

test("read-only stderr suppression inside a shell substitution remains auditable", () => {
  const extracted = extractRepositoryActionsFromShellCommand(
    "sed -n '55,78p' plumbing/format/index/index.go; rg -n \\\"SetIndex\\\" $(go env GOPATH 2>/dev/null)/pkg/mod --glob '*.go'",
    [],
  );
  assert.equal(extracted.complete, true);
  assert.deepEqual(extracted.actions.map(({ kind }) => kind), ["read", "search"]);
});

test("calls at or before the FreeContext completion boundary are excluded", () => {
  const raw = completedCell('await tools.exec_command({cmd:"sed -n \'1,45p\' bandit/core/manager.py"});')
    .replaceAll("2026-08-16T01:32:30.000Z", "2026-08-16T01:32:20.000Z")
    .replaceAll("2026-08-16T01:32:31.000Z", "2026-08-16T01:32:21.000Z");
  const observation = collectCompletedHostRepositoryActions(raw, BOUNDARY);
  assert.equal(observation.complete, true);
  assert.deepEqual(observation.actions, []);
});

test("exclusive upper boundaries prevent suffix duplication and crossing cells fail closed", () => {
  const bounded = { ...BOUNDARY, endedBefore: "2026-08-16T01:32:32.000Z" };
  const raw = [
    completedCell('await tools.exec_command({cmd:"sed -n \'1,5p\' first.py"});'),
    completedCell('await tools.exec_command({cmd:"sed -n \'1,5p\' second.py"});')
      .replaceAll("2026-08-16T01:32:30.000Z", "2026-08-16T01:32:34.000Z")
      .replaceAll("2026-08-16T01:32:31.000Z", "2026-08-16T01:32:35.000Z")
      .replaceAll("cell-1", "cell-2"),
  ].join("\n");
  const observation = collectCompletedHostRepositoryActions(raw, bounded);
  assert.equal(observation.complete, true);
  assert.deepEqual(observation.actions.map(({ action }) => action.path), ["first.py"]);

  const crossingUpper = completedCell('await tools.exec_command({cmd:"sed -n \'1,5p\' first.py"});')
    .replaceAll("2026-08-16T01:32:31.000Z", "2026-08-16T01:32:32.000Z");
  assert.equal(collectCompletedHostRepositoryActions(crossingUpper, bounded).complete, false);

  const crossingLower = completedCell('await tools.exec_command({cmd:"sed -n \'1,5p\' first.py"});')
    .replaceAll("2026-08-16T01:32:30.000Z", "2026-08-16T01:32:27.000Z");
  assert.equal(collectCompletedHostRepositoryActions(crossingLower, bounded).complete, false);

  assert.deepEqual(collectCompletedHostRepositoryActions("", {
    ...BOUNDARY,
    endedBefore: BOUNDARY.completedAt,
  }), { complete: true, actions: [] });
});

test("overlapping outer cells retain call order and reused call ids fail closed", () => {
  const raw = [
    record("2026-08-16T01:32:30.000Z", {
      type: "custom_tool_call", name: "exec", call_id: "cell-1",
      input: 'await tools.exec_command({cmd:"sed -n \'1,5p\' first.py"});',
    }),
    record("2026-08-16T01:32:31.000Z", {
      type: "custom_tool_call", name: "exec", call_id: "cell-2",
      input: 'await tools.exec_command({cmd:"sed -n \'1,5p\' second.py"});',
    }),
    record("2026-08-16T01:32:32.000Z", { type: "custom_tool_call_output", call_id: "cell-2", output: "ok" }),
    record("2026-08-16T01:32:33.000Z", { type: "custom_tool_call_output", call_id: "cell-1", output: "ok" }),
  ].join("\n");
  const observation = collectCompletedHostRepositoryActions(raw, BOUNDARY);
  assert.equal(observation.complete, true);
  assert.deepEqual(observation.actions.map(({ action }) => action.path), ["first.py", "second.py"]);

  const reused = `${completedCell('await tools.exec_command({cmd:"sed -n \'1,5p\' first.py"});')}\n${completedCell(
    'await tools.exec_command({cmd:"sed -n \'1,5p\' second.py"});',
  ).replaceAll("2026-08-16T01:32:30.000Z", "2026-08-16T01:32:32.000Z")}`;
  assert.equal(collectCompletedHostRepositoryActions(reused, BOUNDARY).complete, false);
});

test("search option values do not masquerade as repository paths", () => {
  const extracted = extractRepositoryActionsFromCode(
    'await tools.exec_command({cmd:"rg -g \'*.ts\' nosec src && rg -g \'*.ts\' nosec"});',
    [],
  );
  assert.equal(extracted.complete, true);
  assert.deepEqual(extracted.actions.map(({ broad }) => broad), [false, true]);
});

test("completed path-only probes use their bounded output without hiding broad results", () => {
  const code = 'await tools.exec_command({cmd:"rg --files tests | rg \'(manager|utils|tester|nosec)\'"});';
  const onePath = collectCompletedHostRepositoryActions(
    completedCell(code, "Script completed\nOutput:\n\ntests/unit/core/test_manager.py\n"),
    BOUNDARY,
  );
  assert.deepEqual(onePath.actions.map(({ action }) => action.broad), [false, false]);

  const sevenPaths = collectCompletedHostRepositoryActions(
    completedCell(code, `Script completed\nOutput:\n\n${Array.from({ length: 7 }, (_, index) => `tests/test_${index}.py`).join("\n")}\n`),
    BOUNDARY,
  );
  assert.deepEqual(sevenPaths.actions.map(({ action }) => action.broad), [true, true]);
});

test("unsupported shell redirection fails closed", () => {
  const extracted = extractRepositoryActionsFromCode(
    'await tools.exec_command({cmd:"head -n 10 src/input.ts > /tmp/output"});',
    [],
  );
  assert.deepEqual(extracted, { complete: false, actions: [], concurrent: false });
});

test("task-solution external source commands share one direct classifier", () => {
  for (const command of [
    "curl https://raw.githubusercontent.com/example/project/main/file.ts",
    "git ls-remote https://github.com/example/project.git",
    "npm view example-package version",
  ]) {
    const extracted = extractRepositoryActionsFromShellCommand(command, []);
    assert.equal(extracted.complete, true);
    assert.equal(extracted.actions.some(({ externalSource }) => externalSource === true), true, command);
  }
  for (const command of ["rg symbol src", "git status --short", "npm test"]) {
    assert.equal(extractRepositoryActionsFromShellCommand(command, []).actions.some(({ externalSource }) => externalSource === true), false, command);
  }
});
