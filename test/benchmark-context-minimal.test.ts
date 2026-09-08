import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FreeContextCallerRequestSchema } from "../src/mcp/contracts.js";
import { commitMcpSession, reserveMcpSession } from "../src/mcp/session.js";
import { createTerminalStore } from "../src/mcp/lifecycle.js";
import { exportMasterAgentContext } from "../src/benchmark/master-context.js";
import { analyzeBenchmarkCosts } from "../src/benchmark/cost-analysis.js";
import { loadCostTrial } from "../src/benchmark/cost-artifacts.js";

function currentCodexMcpCallEnd({
  rawCallId,
  request,
  sessionId,
  text,
  conflictingSessionId,
  eventType = "mcp_tool_call_end",
  includeSessionMeta = true,
  structuredSessionId,
}: Readonly<{
  rawCallId: string;
  request: Readonly<Record<string, unknown>>;
  sessionId: string;
  text: string;
  conflictingSessionId?: string;
  eventType?: "mcp_tool_call_begin" | "mcp_tool_call_end";
  includeSessionMeta?: boolean;
  structuredSessionId?: unknown;
}>): string {
  return JSON.stringify({
    type: "event_msg",
    payload: {
      type: eventType,
      call_id: rawCallId,
      invocation: {
        server: "freecontext",
        tool: "gather_context",
        arguments: request,
      },
      result: {
        Ok: {
          content: [{ type: "text", text }],
          ...(includeSessionMeta ? { _meta: { freecontext: { sessionId: structuredSessionId ?? sessionId } } } : {}),
          ...(conflictingSessionId ? { conflictingMeta: { _meta: { freecontext: { sessionId: conflictingSessionId } } } } : {}),
        },
      },
    },
  });
}

function completedNativeCodexMcpToolCall({
  rawCallId,
  request,
  sessionId,
  text,
}: Readonly<{
  rawCallId: string;
  request: Readonly<Record<string, unknown>>;
  sessionId: string;
  text: string;
}>): string {
  return JSON.stringify({
    type: "event_msg",
    payload: {
      type: "item_completed",
      item: {
        type: "McpToolCall",
        id: rawCallId,
        server: "freecontext",
        tool: "gather_context",
        arguments: request,
        result: {
          content: [{ type: "text", text }],
          _meta: { freecontext: { sessionId } },
          structured_content: null,
        },
        status: "completed",
        duration: 4,
      },
    },
  });
}

async function commitCompleteSession({
  workspaceRoot,
  sessionDirectory,
  callId,
  intent,
  summaryBypassed,
}: Readonly<{
  workspaceRoot: string;
  sessionDirectory: string;
  callId: string;
  intent: string;
  summaryBypassed?: true;
}>) {
  const reservation = await reserveMcpSession({
    request: FreeContextCallerRequestSchema.parse({ intent, output: "captured command output" }),
    invocationId: `invocation-${callId}`,
    callId,
    workspaceRoot,
    workspaceRevision: "unversioned",
    sessionDirectory,
    now: () => new Date("2026-09-02T00:00:00.000Z"),
  });
  const decision = createTerminalStore().tryClaim({
    invocationId: reservation.invocation.invocationId,
    winner: "worker",
    decidedAt: "2026-09-02T00:00:01.000Z",
    lateDiagnosticFile: null,
  });
  assert.ok(decision);
  await commitMcpSession({
    reservation,
    capture: null,
    runtimeEvents: [],
    result: {
      status: "complete",
      text: summaryBypassed ? "captured command output" : "ordinary answer",
      errorCode: null,
      sessionId: reservation.invocation.sessionId,
      sessionFile: reservation.invocation.sessionFile,
      ...(summaryBypassed === true ? { summaryBypassed } : {}),
    },
    terminalDecision: decision,
    terminalError: null,
    now: () => new Date("2026-09-02T00:00:02.000Z"),
  });
  return reservation;
}

test("benchmark context exports ordinary delivery and basic session timing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "freecontext-benchmark-context-"));
  const workspaceRoot = path.join(root, "workspace");
  const sessionDirectory = path.join(root, "freecontext-sessions");
  await mkdir(workspaceRoot);
  await mkdir(path.join(root, "sessions"));
  try {
    const reservation = await reserveMcpSession({
      request: FreeContextCallerRequestSchema.parse({ intent: "trace the route", output: "captured command output" }),
      invocationId: "invocation-context",
      callId: "call-context",
      workspaceRoot,
      workspaceRevision: "unversioned",
      sessionDirectory,
      now: () => new Date("2026-09-02T00:00:00.000Z"),
    });
    const decision = createTerminalStore().tryClaim({
      invocationId: reservation.invocation.invocationId,
      winner: "worker",
      decidedAt: "2026-09-02T00:00:01.000Z",
      lateDiagnosticFile: null,
    });
    assert.ok(decision);
    await commitMcpSession({
      reservation,
      capture: null,
      runtimeEvents: [],
      result: {
        status: "complete",
        text: "ordinary answer",
        errorCode: null,
        sessionId: reservation.invocation.sessionId,
        sessionFile: reservation.invocation.sessionFile,
      },
      terminalDecision: decision,
      terminalError: null,
      now: () => new Date("2026-09-02T00:00:02.000Z"),
    });
    await writeFile(path.join(root, "sessions", "master.jsonl"), [
      JSON.stringify({ type: "function_call", name: "gather_context", call_id: "call-context", arguments: JSON.stringify({ intent: "trace the route", output: "captured command output" }) }),
      JSON.stringify({ type: "function_call", name: "gather_context", call_id: "call-context", arguments: JSON.stringify({ intent: "trace the route", output: "captured command output" }) }),
      JSON.stringify({ type: "function_call_output", call_id: "call-context", output: `ordinary answer\n\nSession: ${reservation.invocation.sessionId}` }),
      "",
    ].join("\n"), "utf8");

    const outputPath = await exportMasterAgentContext({ agentDir: root, taskName: "task-context" });
    const exported = JSON.parse(await readFile(outputPath, "utf8")) as {
      schemaVersion: string;
      freeContextCalls: Array<Record<string, unknown>>;
      freeContextTransport: Array<Record<string, unknown>>;
    };
    assert.equal(exported.schemaVersion, "freecontext-master-agent-context-v4");
    assert.equal(exported.freeContextCalls.length, 1);
    assert.equal(exported.freeContextCalls[0]?.callId, "call-context");
    assert.equal(exported.freeContextCalls[0]?.outputToMasterAgent, `ordinary answer\n\nSession: ${reservation.invocation.sessionId}`);
    assert.equal(exported.freeContextCalls[0]?.fullSessionFile, `freecontext-sessions/${reservation.invocation.sessionId}.json`);
    assert.equal(exported.freeContextTransport[0]?.latencyMs, 2_000);

    await writeFile(path.join(root, "trajectory.json"), JSON.stringify({
      steps: [
        { source: "user", message: "trace the route" },
        { source: "agent", message: "done" },
      ],
      final_metrics: {},
    }), "utf8");
    const trial = await loadCostTrial({ taskId: "task-context", success: true, agentDir: root });
    assert.equal(trial.freeContextCalls, 1);
    assert.deepEqual(trial.subagentDelivered, [`ordinary answer\n\nSession: ${reservation.invocation.sessionId}`]);
    const report = await analyzeBenchmarkCosts(
      { schemaVersion: "freecontext-cost-input-v1", trials: [{ taskId: "task-context", success: true, agentDir: root }] },
      { countBatch: async (texts) => texts.map((text) => text.length) },
    );
    const population = report.population as { freeContextCalls: number };
    const aggregate = report.aggregate as { subagentDeliveredVisible: { total: number } };
    assert.equal(population.freeContextCalls, 1);
    assert.equal(aggregate.subagentDeliveredVisible.total, trial.subagentDelivered[0]?.length);

    await unlink(outputPath);
    const unreferenced = await reserveMcpSession({
      request: FreeContextCallerRequestSchema.parse({ intent: "unreferenced", output: "captured command output" }),
      invocationId: "invocation-unreferenced",
      callId: "call-unreferenced",
      workspaceRoot,
      workspaceRevision: "unversioned",
      sessionDirectory,
      now: () => new Date("2026-09-02T00:00:00.000Z"),
    });
    const unreferencedDecision = createTerminalStore().tryClaim({
      invocationId: unreferenced.invocation.invocationId,
      winner: "worker",
      decidedAt: "2026-09-02T00:00:01.000Z",
      lateDiagnosticFile: null,
    });
    assert.ok(unreferencedDecision);
    await commitMcpSession({
      reservation: unreferenced,
      capture: null,
      runtimeEvents: [],
      result: {
        status: "complete",
        text: "unreferenced answer",
        errorCode: null,
        sessionId: unreferenced.invocation.sessionId,
        sessionFile: unreferenced.invocation.sessionFile,
      },
      terminalDecision: unreferencedDecision,
      terminalError: null,
      now: () => new Date("2026-09-02T00:00:02.000Z"),
    });
    await assert.rejects(
      () => exportMasterAgentContext({ agentDir: root, taskName: "task-context", allowUnreferencedSessions: false }),
      /not referenced by a master-agent gather_context call/u,
    );
    const allowedPath = await exportMasterAgentContext({ agentDir: root, taskName: "task-context" });
    const allowed = JSON.parse(await readFile(allowedPath, "utf8")) as { freeContextCalls: Array<Record<string, unknown>> };
    assert.equal(allowed.freeContextCalls.length, 2);
    const orphan = allowed.freeContextCalls.find((call) => call.deliveryStatus === "unmatched");
    assert.equal(orphan?.fullSessionFile, `freecontext-sessions/${unreferenced.invocation.sessionId}.json`);
    assert.equal(orphan?.callId, null);
    assert.equal(orphan?.outputToMasterAgent, null);
    const withOrphan = await loadCostTrial({ taskId: "task-context", success: true, agentDir: root });
    assert.equal(withOrphan.freeContextCalls, 2);
    assert.deepEqual(withOrphan.subagentDelivered, trial.subagentDelivered);

    await unlink(allowedPath);
    await writeFile(path.join(root, "sessions", "master.jsonl"), [
      JSON.stringify({ type: "function_call", name: "gather_context", call_id: "call-context", arguments: JSON.stringify({ intent: "different request", output: "captured command output" }) }),
      "",
    ].join("\n"), "utf8");
    const mismatchOutputPath = await exportMasterAgentContext({ agentDir: root, taskName: "task-context", allowUnreferencedSessions: true });
    const mismatchExported = JSON.parse(await readFile(mismatchOutputPath, "utf8")) as {
      freeContextCalls: Array<Record<string, unknown>>;
    };
    const mismatchCall = mismatchExported.freeContextCalls.find((call) => call.fullSessionFile === `freecontext-sessions/${reservation.invocation.sessionId}.json`);
    assert.equal(mismatchCall?.callId, null);
    assert.equal(mismatchCall?.outputToMasterAgent, null);
    await unlink(mismatchOutputPath);

    await writeFile(path.join(root, "sessions", "master.jsonl"), [
      JSON.stringify({ type: "function_call", name: "gather_context", call_id: "call-context", arguments: JSON.stringify({ intent: "trace the route", output: "captured command output" }) }),
      JSON.stringify({ type: "function_call", name: "gather_context", call_id: "call-context", arguments: JSON.stringify({ intent: "different request", output: "captured command output" }) }),
      "",
    ].join("\n"), "utf8");
    await assert.rejects(
      () => exportMasterAgentContext({ agentDir: root, taskName: "task-context" }),
      /Conflicting raw FreeContext call records share call ID call-context/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("benchmark context correlates current Codex call-end records by delivered session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "freecontext-current-call-end-"));
  const workspaceRoot = path.join(root, "workspace");
  const sessionDirectory = path.join(root, "freecontext-sessions");
  await mkdir(workspaceRoot);
  await mkdir(path.join(root, "sessions"));
  try {
    const first = await commitCompleteSession({ workspaceRoot, sessionDirectory, callId: "2", intent: "same request" });
    const second = await commitCompleteSession({ workspaceRoot, sessionDirectory, callId: "3", intent: "same request", summaryBypassed: true });
    const firstText = `first answer\n\nSession: ${first.invocation.sessionId}`;
    const secondText = `captured command output\n\nSession: ${second.invocation.sessionId}`;
    const masterFile = path.join(root, "sessions", "master.jsonl");
    const firstCall = currentCodexMcpCallEnd({
      rawCallId: "exec-raw-1",
      request: { intent: "same request", output: "captured command output" },
      sessionId: first.invocation.sessionId,
      text: firstText,
    });
    const secondCall = currentCodexMcpCallEnd({
      rawCallId: "exec-raw-2",
      request: { intent: "same request", output: "captured command output" },
      sessionId: second.invocation.sessionId,
      text: secondText,
    });
    const beginCall = currentCodexMcpCallEnd({
      rawCallId: "exec-raw-1",
      request: { intent: "same request", output: "captured command output" },
      sessionId: first.invocation.sessionId,
      text: firstText,
      eventType: "mcp_tool_call_begin",
    });
    await writeFile(masterFile, `${beginCall}\n${firstCall}\n${firstCall}\n${secondCall}\n`, "utf8");

    const outputPath = await exportMasterAgentContext({ agentDir: root, taskName: "current-call-end" });
    const exported = JSON.parse(await readFile(outputPath, "utf8")) as {
      freeContextCalls: Array<Record<string, unknown>>;
    };
    assert.equal(exported.freeContextCalls.length, 2);
    const firstExport = exported.freeContextCalls.find((call) => call.fullSessionFile === `freecontext-sessions/${first.invocation.sessionId}.json`);
    const secondExport = exported.freeContextCalls.find((call) => call.fullSessionFile === `freecontext-sessions/${second.invocation.sessionId}.json`);
    assert.equal(firstExport?.callId, "exec-raw-1");
    assert.equal(firstExport?.outputToMasterAgent, firstText);
    assert.equal(firstExport?.summaryBypassed, undefined);
    assert.equal(secondExport?.callId, "exec-raw-2");
    assert.equal(secondExport?.outputToMasterAgent, secondText);
    assert.equal(secondExport?.summaryBypassed, true);
    assert.deepEqual(JSON.parse(secondExport?.promptToFreeContext as string), {
      intent: "same request",
      output: "captured command output",
    });

    const currentNegativeCases = [
      {
        rawCallId: "exec-current-missing-meta",
        text: firstText,
        options: { includeSessionMeta: false },
        allowUnreferenced: true,
      },
      {
        rawCallId: "exec-current-invalid-meta",
        text: firstText,
        options: { structuredSessionId: "" },
        allowUnreferenced: false,
        error: /Invalid structured FreeContext delivered session ID/u,
      },
      {
        rawCallId: "exec-current-bad-marker",
        text: `${firstText}\ntrailing text`,
        options: {},
        allowUnreferenced: true,
      },
    ] as const;
    for (const currentNegative of currentNegativeCases) {
      await unlink(outputPath).catch(() => undefined);
      await writeFile(masterFile, `${currentCodexMcpCallEnd({
        rawCallId: currentNegative.rawCallId,
        request: { intent: "same request", output: "captured command output" },
        sessionId: first.invocation.sessionId,
        text: currentNegative.text,
        ...currentNegative.options,
      })}\n`, "utf8");
      if (currentNegative.allowUnreferenced) {
        const negativeOutputPath = await exportMasterAgentContext({ agentDir: root, taskName: "current-call-end", allowUnreferencedSessions: true });
        const negativeExported = JSON.parse(await readFile(negativeOutputPath, "utf8")) as {
          freeContextCalls: Array<Record<string, unknown>>;
        };
        const firstNegative = negativeExported.freeContextCalls.find((call) => call.fullSessionFile === `freecontext-sessions/${first.invocation.sessionId}.json`);
        assert.equal(firstNegative?.callId, null);
        assert.equal(firstNegative?.deliveryStatus, "unmatched");
        assert.equal(firstNegative?.outputToMasterAgent, null);
        await unlink(negativeOutputPath);
      } else {
        await assert.rejects(
          () => exportMasterAgentContext({ agentDir: root, taskName: "current-call-end" }),
          currentNegative.error,
        );
      }
    }

    await unlink(outputPath).catch(() => undefined);
    await writeFile(masterFile, `${firstCall}\n${secondCall}\n${currentCodexMcpCallEnd({
      rawCallId: "exec-raw-duplicate",
      request: { intent: "same request", output: "captured command output" },
      sessionId: first.invocation.sessionId,
      text: firstText,
    })}\n`, "utf8");
    await assert.rejects(
      () => exportMasterAgentContext({ agentDir: root, taskName: "current-call-end" }),
      /Ambiguous current FreeContext gather_context call-end records/u,
    );

    await writeFile(masterFile, `${firstCall}\n${currentCodexMcpCallEnd({
      rawCallId: "exec-raw-1",
      request: { intent: "same request", output: "captured command output" },
      sessionId: first.invocation.sessionId,
      text: `conflicting answer\n\nSession: ${first.invocation.sessionId}`,
    })}\n`, "utf8");
    await assert.rejects(
      () => exportMasterAgentContext({ agentDir: root, taskName: "current-call-end" }),
      /Conflicting raw FreeContext call records share call ID exec-raw-1/u,
    );

    await writeFile(masterFile, `${currentCodexMcpCallEnd({
      rawCallId: "exec-raw-meta-conflict",
      request: { intent: "same request", output: "captured command output" },
      sessionId: first.invocation.sessionId,
      conflictingSessionId: second.invocation.sessionId,
      text: firstText,
    })}\n`, "utf8");
    await assert.rejects(
      () => exportMasterAgentContext({ agentDir: root, taskName: "current-call-end" }),
      /Conflicting structured FreeContext delivered session IDs/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("benchmark context correlates Codex 0.153.4 completed native MCP items", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "freecontext-native-mcp-item-"));
  const workspaceRoot = path.join(root, "workspace");
  const sessionDirectory = path.join(root, "freecontext-sessions");
  await mkdir(workspaceRoot);
  await mkdir(path.join(root, "sessions"));
  try {
    const reservation = await commitCompleteSession({
      workspaceRoot,
      sessionDirectory,
      callId: "fc-internal-call",
      intent: "redacted intent",
    });
    const text = `redacted answer\n\nSession: ${reservation.invocation.sessionId}`;
    const completedCall = completedNativeCodexMcpToolCall({
      rawCallId: "exec-native-call",
      request: { intent: "redacted intent", output: "captured command output" },
      sessionId: reservation.invocation.sessionId,
      text,
    });
    const startedCall = JSON.parse(completedCall) as {
      payload: { type: string; item: { status: string; result: unknown } };
    };
    startedCall.payload.type = "item_started";
    startedCall.payload.item.status = "in_progress";
    startedCall.payload.item.result = null;
    await writeFile(path.join(root, "sessions", "master.jsonl"), `${JSON.stringify(startedCall)}\n${completedCall}\n`, "utf8");

    const outputPath = await exportMasterAgentContext({ agentDir: root, taskName: "native-mcp-item" });
    const exported = JSON.parse(await readFile(outputPath, "utf8")) as {
      freeContextCalls: Array<Record<string, unknown>>;
    };
    assert.equal(exported.freeContextCalls.length, 1);
    assert.equal(exported.freeContextCalls[0]?.callId, "exec-native-call");
    assert.equal(exported.freeContextCalls[0]?.outputToMasterAgent, text);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
